# cdn-upload-webpack-plugin
A webpack plugin which incrementally uploads assets to a CDN upon build completion.

### Features
* Incremental upload: when using webpack in watch mode (or webpack-dev-server/webpack-dev-middleware), only newly-emitted assets are uploaded.
* Prune extraneous assets: assets on the CDN which are no longer present in the webpack build are deleted.
* Currently supports:
  * Microsoft Azure Blob storage

### Installation

```shell
npm install cdn-upload-webpack-plugin --save-dev
```

### Usage

```js
const CdnDeployPlugin = require('cdn-upload-webpack-plugin');

module.exports = {
    entry: './index.js',
    output: {
        filename: 'bundle.js'
    },
    plugins: [
        new CdnUploadPlugin.Azure({
            // Leave `connection` undefined to use environment variables
            // AZURE_STORAGE_CONNECTION_STRING / AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_ACCESS_KEY
            // i.e. http://azure.github.io/azure-storage-node/global.html#createBlobService__anchor
            // Or define as:
            connection: {
                connectionString: '<your connection string>'
            },
            // or
            connection: {
                storageAccount: '<your storage account>',
                storageAccessKey: '<your access key>'
            },
            // The name of the container on Azure, which will be created if it doesn't exist
            containerName: 'files',
            // The filename prefix to be used for all uploaded assets
            prefix: 'my/test/folder'
        }),
        CdnUploadPlugin.Progress()
    ]
};
```

Run webpack, and you should see upload progress logs e.g.
```
[23:31:33] webpack (95%) - emitting
[23:31:33] webpack (98%) - upload: creating Azure blob container 'files'
[23:31:34] webpack (98%) - upload: listing blobs under 'files/my/test/folder'
[23:31:34] webpack (98%) - upload: creating blob (1/1) 'files/my/test/folder/bundle.js'
[23:31:34] webpack (98%) - upload: uploaded 1 assets
[23:31:34] webpack (98%) - upload: pruned 0 extraneous assets
[23:31:34] webpack (100%)
```
