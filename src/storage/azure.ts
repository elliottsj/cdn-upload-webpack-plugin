import * as AzureStorage from 'azure-storage';
import bind from 'bind.ts';
import { difference, pickBy } from 'lodash';
import * as mime from 'mime';
import * as os from 'os';
import * as path from 'path';
import * as Rx from 'rxjs';
import {
  catchError,
  count,
  ignoreElements,
  map,
  mergeMap,
  publish,
  reduce,
  retry,
  tap,
  toArray,
} from 'rxjs/operators';
import { Compiler, Plugin } from 'webpack';

const weblog = require('webpack-log');

/**
 * http://azure.github.io/azure-storage-node/global.html#createBlobService__anchor
 */

export type AzureBlobServiceEnvironment = {};
export type AzureBlobServiceConnectionString = {
  connectionString: string;
};
export type AzureBlobServiceAccountAndKey = {
  storageAccount: string;
  storageAccessKey: string;
  host?: string | AzureStorage.StorageHost;
};

export type AzureConnectionOptions =
  | AzureBlobServiceEnvironment
  | AzureBlobServiceConnectionString
  | AzureBlobServiceAccountAndKey;

export interface IAzureOptions {
  connection?: AzureConnectionOptions;
  containerName: string;
  prefix: string;
}

function isConnectionString(
  options: AzureConnectionOptions,
): options is AzureBlobServiceConnectionString {
  return (<AzureBlobServiceConnectionString>options).connectionString !== undefined;
}
function isAccountAndKey(
  options: AzureConnectionOptions,
): options is AzureBlobServiceAccountAndKey {
  return (<AzureBlobServiceAccountAndKey>options).storageAccount !== undefined;
}

function connectBlobService(options: IAzureOptions) {
  // Connect to Azure using one of the provided connection methods
  if (options.connection && isConnectionString(options.connection)) {
    return AzureStorage.createBlobService(options.connection.connectionString);
  }
  if (options.connection && isAccountAndKey(options.connection)) {
    return AzureStorage.createBlobService(
      options.connection.storageAccount,
      options.connection.storageAccessKey,
      options.connection.host,
    );
  }
  return AzureStorage.createBlobService();
}

interface IAsset {
  emitted: boolean;
  source(): string | Buffer;
}

enum StatusType {
  CreatingContainer,
  ListingBlobs,
  ListingBlobsDone,
  CreatingBlobs,
  CreatingBlob,
  FailedCreatingBlob,
  UploadDone,
  PruningBlob,
  FailedPruningBlob,
  PruneDone,
  AllDone,
}

type CreatingContainerStatus = {
  type: StatusType.CreatingContainer;
  containerName: string;
  containerUrl: string;
};

type ListingBlobsStatus = {
  type: StatusType.ListingBlobs;
  containerName: string;
  prefix: string;
};

type ListingBlobsDoneStatus = {
  type: StatusType.ListingBlobsDone;
  count: number;
};

type CreatingBlobsStatus = {
  type: StatusType.CreatingBlobs;
  count: number;
  containerName: string;
  prefix: string;
};

type CreatingBlobStatus = {
  type: StatusType.CreatingBlob;
  count: number;
  index: number;
  containerName: string;
  prefix: string;
  name: string;
};

type FailedCreatingBlobStatus = {
  type: StatusType.FailedCreatingBlob;
  containerName: string;
  prefix: string;
  name: string;
};

type UploadDoneStatus = {
  type: StatusType.UploadDone;
  count: number;
};

type PruningBlobStatus = {
  type: StatusType.PruningBlob;
  count: number;
  index: number;
  containerName: string;
  prefix: string;
  name: string;
};

type FailedPruningBlobStatus = {
  type: StatusType.FailedPruningBlob;
  containerName: string;
  prefix: string;
  name: string;
};

type PruneDoneStatus = {
  type: StatusType.PruneDone;
  count: number;
};

type AllDoneStatus = {
  type: StatusType.AllDone;
};

type Status =
  | CreatingContainerStatus
  | ListingBlobsStatus
  | ListingBlobsDoneStatus
  | CreatingBlobsStatus
  | CreatingBlobStatus
  | FailedCreatingBlobStatus
  | UploadDoneStatus
  | PruningBlobStatus
  | FailedPruningBlobStatus
  | PruneDoneStatus
  | AllDoneStatus;

type Report = {
  containerName: string;
  containerUrl: string;
  prefix: string;
  azureCount: number;
  creatingCount: number;
  uploadedCount: number;
  prunedCount: number;
  failedUploads: string[];
  failedDeletes: string[];
};

function statusToString(status: Status) {
  if (status.type === StatusType.CreatingContainer) {
    return `creating Azure blob container '${status.containerName}'`;
  }
  if (status.type === StatusType.ListingBlobs) {
    return `listing blobs under '${status.containerName}/${status.prefix}'`;
  }
  if (status.type === StatusType.ListingBlobsDone) {
    return `found ${status.count} blobs`;
  }
  if (status.type === StatusType.CreatingBlobs) {
    return `creating ${status.count} blobs under ${status.containerName}/${status.prefix}`;
  }
  if (status.type === StatusType.CreatingBlob) {
    return `creating blob (${status.index + 1}/${status.count}) '${status.containerName}/${
      status.prefix
    }/${status.name}'`;
  }
  if (status.type === StatusType.FailedCreatingBlob) {
    return `failed '${status.containerName}/${status.prefix}/${status.name}'; trying again`;
  }
  if (status.type === StatusType.UploadDone) {
    return `uploaded ${status.count} assets`;
  }
  if (status.type === StatusType.PruningBlob) {
    return `pruning '${status.containerName}/${status.prefix}/${status.name}'`;
  }
  if (status.type === StatusType.FailedPruningBlob) {
    return `delete failed '${status.containerName}/${status.prefix}/${status.name}'; trying again`;
  }
  if (status.type === StatusType.PruneDone) {
    return `pruned ${status.count} extraneous assets`;
  }
}

/**
 * Given a blob name and a prefix, return the blob name with the prefix omitted,
 * also omitting the delimiting '/'.
 * @param name the name of a blob
 * @param prefix the prefix to omit from the name
 */
function withoutPrefix(name: string, prefix: string) {
  return name.startsWith(prefix) ? name.substring((prefix + '/').length) : name;
}

/**
 * Create a function which uploads emitted webpack assets to Azure (▲), prunes extraneous assets on
 * Azure which are no longer present in the set of webpack assets (▽), and returns an observable
 * which logs events which occur in the upload & prune process.
 *
 *              .───────────.    .───────────.
 *           ,─'  webpack    ',─'    CDN      '─.
 *         ,'     assets    ,'  `.   assets      `.
 *       ,'               ,'      `.               `.
 *      ;       .───────────.       :                :
 *      │    ,─' emitted │   '─.    │                │
 *      │   ;    assets  │  ▲   :   │      ▽         │
 *      :   :            :      ;   ;                ;
 *       ╲   ╲      ▲     ╲    ╱   ╱                ╱
 *        `.  '─.          `,─'  ,'               ,'
 *          `.   `─────────' `.,'               ,'
 *            '─.           ,─''─.           ,─'
 *               `─────────'      `─────────'
 */
function createAzureUpload(
  blobService: AzureStorage.BlobService,
  options: IAzureOptions,
): (assets: { [assetName: string]: IAsset }) => Rx.Observable<Status> {
  /*
   * Created transformed BlobService methods which return an Observable instead of taking a callback.
   */
  const listBlobsSegmentedWithPrefix: (
    container: string,
    prefix: string,
    currentToken: AzureStorage.common.ContinuationToken,
    options: AzureStorage.BlobService.ListBlobsSegmentedRequestOptions,
  ) => Rx.Observable<
    [AzureStorage.BlobService.ListBlobsResult, AzureStorage.ServiceResponse]
  > = Rx.bindNodeCallback(bind(blobService.listBlobsSegmentedWithPrefix, blobService));
  const createContainerIfNotExists: (
    container: string,
    options: AzureStorage.BlobService.CreateContainerOptions,
  ) => Rx.Observable<
    [AzureStorage.BlobService.ContainerResult, AzureStorage.ServiceResponse]
  > = Rx.bindNodeCallback(bind(blobService.createContainerIfNotExists, blobService));
  const createBlockBlobFromText: (
    container: string,
    blob: string,
    text: string | Buffer,
    options: AzureStorage.BlobService.CreateBlobRequestOptions,
  ) => Rx.Observable<
    [AzureStorage.BlobService.BlobResult, AzureStorage.ServiceResponse]
  > = Rx.bindNodeCallback(bind(blobService.createBlockBlobFromText, blobService));
  const deleteBlob = Rx.bindNodeCallback(bind(blobService.deleteBlob, blobService));
  const getContainerUrl = bind(blobService.getUrl, blobService);

  /**
   * A version of `listBlobsSegmentedWithPrefix` which emits *all* blobs, not just the first page.
   */
  function listAllBlobsSegmentedWithPrefix(
    container: string,
    prefix: string,
    currentToken: AzureStorage.common.ContinuationToken,
    options: AzureStorage.BlobService.ListBlobsSegmentedRequestOptions,
  ): Rx.Observable<AzureStorage.BlobService.BlobResult> {
    return listBlobsSegmentedWithPrefix(container, prefix, currentToken, options).pipe(
      mergeMap(([result, _]) =>
        Rx.concat(
          result.entries,
          result.continuationToken
            ? listAllBlobsSegmentedWithPrefix(container, prefix, result.continuationToken, options)
            : Rx.empty(),
        ),
      ),
    );
  }

  return (assets: { [assetName: string]: IAsset }) =>
    Rx.Observable.create((observer: Rx.Observer<Status>) => {
      const assetNames = Object.keys(assets);
      const emittedAssetNames = Object.keys(pickBy(assets, asset => asset.emitted));
      observer.next({
        type: StatusType.CreatingContainer,
        containerName: options.containerName,
        containerUrl: getContainerUrl(options.containerName),
      });
      createContainerIfNotExists(options.containerName, {
        publicAccessLevel: 'blob',
      })
        .pipe(
          mergeMap(() => {
            observer.next({
              type: StatusType.ListingBlobs,
              containerName: options.containerName,
              prefix: options.prefix,
            });
            return listAllBlobsSegmentedWithPrefix(
              options.containerName,
              options.prefix,
              null,
              {},
            ).pipe(
              map(blob => blob.name),
              map(blobName => withoutPrefix(blobName, options.prefix)),
            );
          }),
          toArray(),
          mergeMap(azureBlobNames => {
            observer.next({
              type: StatusType.ListingBlobsDone,
              count: azureBlobNames.length,
            });
            // Upload newly-emitted assets, overwriting any existing Azure blobs with the same name
            observer.next({
              type: StatusType.CreatingBlobs,
              count: emittedAssetNames.length,
              containerName: options.containerName,
              prefix: options.prefix,
            });
            return Rx.from(emittedAssetNames).pipe(
              mergeMap(
                (assetName, index) => {
                  observer.next({
                    type: StatusType.CreatingBlob,
                    count: emittedAssetNames.length,
                    index: index,
                    containerName: options.containerName,
                    prefix: options.prefix,
                    name: assetName,
                  });
                  return createBlockBlobFromText(
                    options.containerName,
                    `${options.prefix}/${assetName}`,
                    assets[assetName].source(),
                    {
                      contentSettings: {
                        cacheControl: 'public, max-age=0',
                        contentType: mime.getType(assetName),
                      },
                      parallelOperationThreadCount: 50,
                    },
                  ).pipe(
                    catchError(error => {
                      observer.next({
                        type: StatusType.FailedCreatingBlob,
                        containerName: options.containerName,
                        prefix: options.prefix,
                        name: assetName,
                      });
                      throw error;
                    }),
                    retry(5),
                  );
                },
                null,
                50,
              ),
              count(),
              tap(uploadedCount => {
                observer.next({
                  type: StatusType.UploadDone,
                  count: uploadedCount,
                });
              }),
              mergeMap(() => {
                // Prune extraneous Azure blobs
                const extraneousBlobs = difference(azureBlobNames, assetNames);
                return Rx.from(extraneousBlobs).pipe(
                  mergeMap(
                    (blobName, index) => {
                      observer.next({
                        type: StatusType.PruningBlob,
                        count: extraneousBlobs.length,
                        index: index,
                        containerName: options.containerName,
                        prefix: options.prefix,
                        name: blobName,
                      });
                      return deleteBlob(
                        options.containerName,
                        `${options.prefix}/${blobName}`,
                        {},
                      ).pipe(
                        catchError(error => {
                          observer.next({
                            type: StatusType.FailedPruningBlob,
                            containerName: options.containerName,
                            prefix: options.prefix,
                            name: blobName,
                          });
                          throw error;
                        }),
                        retry(5),
                      );
                    },
                    null,
                    100,
                  ),
                );
              }),
              count(),
              tap(prunedCount => {
                observer.next({
                  type: StatusType.PruneDone,
                  count: prunedCount,
                });
              }),
              ignoreElements(),
            );
          }),
        )
        .subscribe({
          next() {
            observer.next({
              type: StatusType.AllDone,
            });
          },
          complete() {
            observer.complete();
          },
          error(err: any) {
            observer.error(err);
          },
        });
    });
}

function collectReport(report: Report, status: Status): Report {
  if (status.type === StatusType.CreatingContainer) {
    return {
      ...report,
      containerName: status.containerName,
      containerUrl: status.containerUrl,
    };
  }
  if (status.type === StatusType.ListingBlobs) {
    return {
      ...report,
      prefix: status.prefix,
    };
  }
  if (status.type === StatusType.ListingBlobsDone) {
    return {
      ...report,
      azureCount: status.count,
    };
  }
  if (status.type === StatusType.CreatingBlobs) {
    return {
      ...report,
      creatingCount: status.count,
    };
  }
  if (status.type === StatusType.CreatingBlob) {
    return report;
  }
  if (status.type === StatusType.FailedCreatingBlob) {
    return {
      ...report,
      failedUploads: [...(report.failedUploads || []), status.name],
    };
  }
  if (status.type === StatusType.UploadDone) {
    return {
      ...report,
      uploadedCount: status.count,
    };
  }
  if (status.type === StatusType.PruningBlob) {
    return report;
  }
  if (status.type === StatusType.FailedPruningBlob) {
    return {
      ...report,
      failedDeletes: [...(report.failedDeletes || []), status.name],
    };
  }
  if (status.type === StatusType.PruneDone) {
    return {
      ...report,
      prunedCount: status.count,
    };
  }
  return report;
}

export default class AzurePlugin implements Plugin {
  private options: IAzureOptions;
  private blobService: AzureStorage.BlobService;
  private upload: (assets: { [assetName: string]: IAsset }) => Rx.Observable<Status>;

  constructor(options: IAzureOptions) {
    this.options = options;
    this.blobService = connectBlobService(options);
    this.upload = createAzureUpload(this.blobService, options);
  }

  public apply(compiler: Compiler) {
    const log = weblog({ name: 'CdnUploadPlugin' });

    compiler.hooks.afterEmit.tapAsync(
      {
        name: 'CdnUploadPlugin',
        context: true,
      } as any,
      (context, compilation, callback) => {
        const reportProgress = context && (context as any).reportProgress;
        const upload$ = publish()(this.upload(compilation.assets));

        upload$.subscribe({
          next(status: Status) {
            if (reportProgress) {
              reportProgress(0.98, `upload: ${statusToString(status)}`);
            }
          },
        });

        upload$.pipe(reduce(collectReport, {})).subscribe({
          next(report: Report) {
            log.info(`Completed upload to ${report.containerUrl}`);
            log.info(`${report.uploadedCount} assets uploaded`);
            log.info(`${report.prunedCount} extraneous assets pruned`);
            if (report.failedUploads && report.failedUploads.length > 0) {
              log.warn(`Failed to upload ${report.failedUploads.length} assets`);
            }
            if (report.failedDeletes && report.failedDeletes.length > 0) {
              log.warn(`Failed to prune ${report.failedDeletes.length} assets`);
            }
          },
          complete() {
            callback(null);
          },
          error(err: any) {
            callback(err);
          },
        });

        upload$.connect();
      },
    );
  }

  public getPublicPath() {
    return this.blobService.getUrl(this.options.containerName, this.options.prefix);
  }
}
