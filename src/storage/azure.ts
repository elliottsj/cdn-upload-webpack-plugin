import { Observable, Observer } from '@reactivex/rxjs';
import * as AzureStorage from 'azure-storage';
import bind from 'bind.ts';
import { difference, pickBy } from 'lodash';
import * as mime from 'mime';
import * as os from 'os';
import * as path from 'path';
import { Compiler, Plugin } from 'webpack';

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
  return (
    (<AzureBlobServiceConnectionString>options).connectionString !== undefined
  );
}
function isAccountAndKey(
  options: AzureConnectionOptions,
): options is AzureBlobServiceAccountAndKey {
  return (<AzureBlobServiceAccountAndKey>options).storageAccount !== undefined;
}

interface IAsset {
  emitted: boolean;
  source(): string | Buffer;
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
 *           ,─'  all        ',─'    CDN      '─.
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
  options: IAzureOptions,
): (assets: { [assetName: string]: IAsset }) => Observable<string> {
  // Connect to Azure using one of the provided connection methods
  let blobService;
  if (options.connection && isConnectionString(options.connection)) {
    blobService = AzureStorage.createBlobService(
      options.connection.connectionString,
    );
  } else if (options.connection && isAccountAndKey(options.connection)) {
    blobService = AzureStorage.createBlobService(
      options.connection.storageAccount,
      options.connection.storageAccessKey,
      options.connection.host,
    );
  } else {
    blobService = AzureStorage.createBlobService();
  }

  /*
     * Created transformed BlobService methods which return an Observable instead of taking a callback.
     */
  const listBlobsSegmentedWithPrefix: (
    container: string,
    prefix: string,
    currentToken: AzureStorage.common.ContinuationToken,
    options: AzureStorage.BlobService.ListBlobsSegmentedRequestOptions,
  ) => Observable<
    AzureStorage.BlobService.ListBlobsResult
  > = Observable.bindNodeCallback(
    bind(blobService.listBlobsSegmentedWithPrefix, blobService),
    (result, response) => result,
  );
  const createContainerIfNotExists: (
    container: string,
    options: AzureStorage.BlobService.CreateContainerOptions,
  ) => Observable<
    AzureStorage.BlobService.ContainerResult
  > = Observable.bindNodeCallback(
    bind(blobService.createContainerIfNotExists, blobService),
    (result, response) => result,
  );
  const createBlockBlobFromText: (
    container: string,
    blob: string,
    text: string | Buffer,
    options: AzureStorage.BlobService.CreateBlobRequestOptions,
  ) => Observable<
    AzureStorage.BlobService.BlobResult
  > = Observable.bindNodeCallback(
    bind(blobService.createBlockBlobFromText, blobService),
    (result, response) => result,
  );
  const deleteBlob = Observable.bindNodeCallback(
    bind(blobService.deleteBlob, blobService),
  );

  /**
   * A version of `listBlobsSegmentedWithPrefix` which emits *all* blobs, not just the first page.
   */
  function listAllBlobsSegmentedWithPrefix(
    container: string,
    prefix: string,
    currentToken: AzureStorage.common.ContinuationToken,
    options: AzureStorage.BlobService.ListBlobsSegmentedRequestOptions,
  ): Observable<AzureStorage.BlobService.BlobResult> {
    return listBlobsSegmentedWithPrefix(
      container,
      prefix,
      currentToken,
      options,
    ).mergeMap(result =>
      Observable.concat(
        result.entries,
        result.continuationToken
          ? listAllBlobsSegmentedWithPrefix(
              container,
              prefix,
              result.continuationToken,
              options,
            )
          : Observable.empty<AzureStorage.BlobService.BlobResult>(),
      ),
    );
  }

  return (assets: { [assetName: string]: IAsset }) =>
    Observable.create((observer: Observer<string>) => {
      const assetNames = Object.keys(assets);
      const emittedAssetNames = Object.keys(
        pickBy(assets, asset => asset.emitted),
      );
      observer.next(
        `upload: creating Azure blob container '${options.containerName}'`,
      );
      createContainerIfNotExists(options.containerName, {
        publicAccessLevel: 'blob',
      })
        .mergeMap(() => {
          observer.next(
            `upload: listing blobs under '${options.containerName}/${
              options.prefix
            }'`,
          );
          return listAllBlobsSegmentedWithPrefix(
            options.containerName,
            options.prefix,
            null,
            {},
          )
            .map(blob => blob.name)
            .map(blobName => withoutPrefix(blobName, options.prefix));
        })
        .toArray()
        .mergeMap(azureBlobNames => {
          // Upload newly-emitted assets, overwriting any existing Azure blobs with the same name
          return Observable.from(emittedAssetNames)
            .mergeMap(
              (assetName, index) => {
                observer.next(
                  `upload: creating blob (${index + 1}/${
                    emittedAssetNames.length
                  }) '${options.containerName}/${options.prefix}/${assetName}'`,
                );
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
                )
                  .catch(error => {
                    observer.next(
                      `upload: failed '${options.containerName}/${
                        options.prefix
                      }/${assetName}'; trying again`,
                    );
                    throw error;
                  })
                  .retry(5);
              },
              null,
              50,
            )
            .count()
            .do(uploadedCount => {
              observer.next(`upload: uploaded ${uploadedCount} assets`);
            })
            .mergeMap(() => {
              // Prune extraneous Azure blobs
              const extraneousBlobs = difference(azureBlobNames, assetNames);
              return Observable.from(extraneousBlobs).mergeMap(
                blobName => {
                  observer.next(
                    `upload: pruning '${options.containerName}/${
                      options.prefix
                    }/${blobName}'`,
                  );
                  return deleteBlob(
                    options.containerName,
                    `${options.prefix}/${blobName}`,
                    {},
                  )
                    .catch(error => {
                      observer.next(
                        `upload: delete failed '${options.containerName}/${
                          options.prefix
                        }/${blobName}'; trying again`,
                      );
                      throw error;
                    })
                    .retry(5);
                },
                null,
                100,
              );
            })
            .count()
            .do(prunedCount => {
              observer.next(`upload: pruned ${prunedCount} extraneous assets`);
            })
            .ignoreElements();
        })
        .subscribe({
          next() {
            observer.next('upload: done');
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

export default class AzurePlugin implements Plugin {
  private upload: (
    assets: { [assetName: string]: IAsset },
  ) => Observable<string>;

  constructor(options: IAzureOptions) {
    this.upload = createAzureUpload(options);
  }

  public apply(compiler: Compiler) {
    compiler.hooks.afterEmit.tapAsync(
      {
        name: 'CdnUploadPlugin',
        context: true,
      } as any,
      (context, compilation, callback) => {
        const reportProgress = context && (context as any).reportProgress;
        this.upload(compilation.assets).subscribe({
          next(message: string) {
            if (reportProgress) {
              reportProgress(0.98, message);
            }
          },
          complete() {
            callback(null);
          },
          error(err: any) {
            callback(err);
          },
        });
      },
    );
  }
}
