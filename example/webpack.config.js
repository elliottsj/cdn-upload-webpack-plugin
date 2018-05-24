'use strict';

const CdnUploadPlugin = require('..');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const path = require('path');

const azureUploadPlugin = new CdnUploadPlugin.Azure({
  connection: {
    storageAccount: process.env.STORAGE_ACCOUNT,
    storageAccessKey: process.env.STORAGE_ACCESS_KEY,
  },
  containerName: 'files',
  prefix: 'my/test/folder',
});

debugger;
module.exports = {
  entry: './index.js',
  mode: 'development',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
    publicPath: azureUploadPlugin.getPublicPath(),
  },
  plugins: [azureUploadPlugin, new HtmlWebpackPlugin()],
  devServer: {
    contentBase: path.resolve(__dirname, 'dist'),
  },
};
