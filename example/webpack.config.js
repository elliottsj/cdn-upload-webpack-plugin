'use strict';

const CdnUploadPlugin = require('..');

module.exports = {
  entry: './index.js',
  mode: 'development',
  output: {
    filename: 'bundle.js',
  },
  plugins: [
    new CdnUploadPlugin.Azure({
      connection: {
        storageAccount: process.env.STORAGE_ACCOUNT,
        storageAccessKey: process.env.STORAGE_ACCESS_KEY,
      },
      containerName: 'files',
      prefix: 'my/test/folder',
    }),
  ],
};
