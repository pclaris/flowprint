const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('flowprintAPI', {
  platform: process.platform,
  version: '1.0.0'
});