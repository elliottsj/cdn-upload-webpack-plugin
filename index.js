const azure = require('azure-storage');
const getRepoInfo = require('git-repo-info');
const difference = require('lodash/difference');
const os = require('os');
const path = require('path');
const pify = require('pify');
const Rx = require('rxjs/Rx');

function getFolderName() {
    const username = process.env.USERNAME || process.env.LOGNAME || process.env.USER || process.env.LNAME;
    const deployWorkingDirectory = path.resolve(process.cwd());
    let key = 'Dev-' + username + '-' + os.hostname() + deployWorkingDirectory.replace(/[^A-Za-z0-9]/gi, '-') + '-' + getRepoInfo().branch;
    return key.toLowerCase();
}

class DeployPlugin {
    constructor() {
        const blobService = azure.createBlobService(
            'resourceseng',
            'secretkey'
        );
        this.createContainerIfNotExists = Rx.Observable.bindNodeCallback(blobService.createContainerIfNotExists.bind(blobService));
        this.listBlobsSegmentedWithPrefix = Rx.Observable.bindNodeCallback(blobService.listBlobsSegmentedWithPrefix.bind(blobService));
        this.createBlockBlobFromText = Rx.Observable.bindNodeCallback(blobService.createBlockBlobFromText.bind(blobService));
        this.deleteBlob = Rx.Observable.bindNodeCallback(blobService.deleteBlob.bind(blobService));
    }

    apply(compiler) {
        compiler.plugin('after-emit', (compilation, callback) => {
            const assetNames = Object.keys(compilation.assets);

            // Create the container if it doesn't exist
            console.log('Creating Azure blob container \'files\'');
            this.createContainerIfNotExists('files', { publicAccessLevel: 'blob' })
                .mergeMap(() => {
                    console.log(`Listing blob directories under 'files/${getFolderName()}'`);
                    return this.listBlobsSegmentedWithPrefix('files', getFolderName(), null, {})
                        .map(([result, response]) => {
                            return result.entries
                                .map(blob => blob.name)
                                .map(blobName => blobName.replace(getFolderName() + '/', ''))
                        });
                })
                .mergeMap(azureBlobNames => {
                    const missingAssets = difference(assetNames, azureBlobNames);
                    return Rx.Observable.from(missingAssets)
                        .mergeMap(assetName => {
                            // Upload assets missing from Azure
                            console.log(`Creating blob 'files/${path.join(getFolderName(), assetName)}'`);
                            debugger;
                            return this.createBlockBlobFromText(
                                'files',
                                path.join(getFolderName(), assetName),
                                compilation.assets[assetName].source(),
                                {}
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
                            return Rx.Observable.from(extraneousBlobs).map(blobName => {
                                console.log(`Pruning 'files/${path.join(getFolderName(), blobName)}'`);
                                return this.deleteBlob('files', path.join(getFolderName(), blobName), {});
                            });
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
