const azure = require('azure-storage');
const getRepoInfo = require('git-repo-info');
const difference = require('lodash/difference');
const mime = require('mime');
const os = require('os');
const path = require('path');
const pify = require('pify');
const Rx = require('rxjs/Rx');

function getFolderName() {
    const username = process.env.USERNAME || process.env.LOGNAME || process.env.USER || process.env.LNAME;
    const deployWorkingDirectory = path.resolve('app-min');
    let key = 'Dev-' + username + '-' + os.hostname() + deployWorkingDirectory.replace(/[^A-Za-z0-9]/gi, '-') + '-' + getRepoInfo().branch;
    return key.toLowerCase();
}

class DeployPlugin {
    constructor() {
        const blobService = azure.createBlobService(
            'resourceseng',
            'secretkey'
        );
        this.listBlobsSegmentedWithPrefix = Rx.Observable.bindNodeCallback(blobService.listBlobsSegmentedWithPrefix.bind(blobService));
        this.createContainerIfNotExists = Rx.Observable.bindNodeCallback(blobService.createContainerIfNotExists.bind(blobService));
        this.createBlockBlobFromText = Rx.Observable.bindNodeCallback(blobService.createBlockBlobFromText.bind(blobService));
        this.deleteBlob = Rx.Observable.bindNodeCallback(blobService.deleteBlob.bind(blobService));
    }

    list(container, prefix, currentToken, options) {
        return this.listBlobsSegmentedWithPrefix(container, prefix, currentToken, options)
            .mergeMap(([result, response]) => {
                debugger;
                const blobs = result.entries;
                const next$ = result.continuationToken
                    ? this.list(container, prefix, result.continuationToken, options)
                    : Rx.Observable.empty();

                return Rx.Observable.concat(
                    blobs,
                    next$
                );
            });
    }

    apply(compiler) {
        compiler.plugin('after-emit', (compilation, callback) => {
            const assetNames = Object.keys(compilation.assets);

            // Create the container if it doesn't exist
            console.log('Creating Azure blob container \'files\'');
            this.createContainerIfNotExists('files', { publicAccessLevel: 'blob' })
                .mergeMap(() => {
                    console.log(`Listing blobs under 'files/${getFolderName()}'`);
                    return this.list('files', getFolderName(), null, {})
                        .map(blob => blob.name)
                        .map(blobName => blobName.replace(getFolderName() + '/', ''));
                })
                .toArray()
                .mergeMap(azureBlobNames => {
                    const missingAssets = difference(assetNames, azureBlobNames);
                    return Rx.Observable.from([...missingAssets, 'odbonedrive.json'])
                        .mergeMap(assetName => {
                            // Upload assets missing from Azure
                            console.log(`Creating blob 'files/${path.join(getFolderName(), assetName)}'`);
                            debugger;
                            return this.createBlockBlobFromText(
                                'files',
                                path.join(getFolderName(), assetName),
                                compilation.assets[assetName].source(),
                                {
                                    cacheControl: 'public, max-age=0',
                                    contentType: mime.lookup(assetName),
                                    parallelOperationThreadCount: 50
                                }
                            ).catch(error => {
                                console.log(`Upload failed 'files/${path.join(getFolderName(), assetName)}'; trying again`);
                                throw error;
                            }).retry(5);
                        }, null, 100)
                        .count()
                        .do((uploadedCount) => {
                            console.log(`Uploaded ${uploadedCount} assets`);
                        })
                        .mergeMap(() => {
                            // Prune extraneous Azure blobs
                            debugger;
                            const extraneousBlobs = difference(azureBlobNames, assetNames);
                            return Rx.Observable.from(extraneousBlobs).mergeMap(blobName => {
                                console.log(`Pruning 'files/${path.join(getFolderName(), blobName)}'`);
                                return this.deleteBlob(
                                    'files',
                                    path.join(getFolderName(), blobName),
                                    {}
                                ).catch(error => {
                                    console.log(`Delete failed 'files/${path.join(getFolderName(), blobName)}'; trying again`);
                                    throw error;
                                }).retry(5);
                            }, null, 100);
                        })
                        .count()
                        .do((prunedCount) => {
                            console.log(`Pruned ${prunedCount} extraneous assets`);
                        })
                        .ignoreElements();
                })
                .subscribe(value => {
                    debugger;
                }, error => {
                    callback(error);
                }, () => {
                    debugger;
                    console.log('done');
                    callback(null);
                });
        });
    }
}

module.exports = DeployPlugin;
