'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  oneSignalDirect: {
    config:            ()        => ipcRenderer.invoke('onesignalDirect:config'),
    listSubscriptions: (opts)    => ipcRenderer.invoke('onesignalDirect:listSubscriptions', opts),
    preview:           (options) => ipcRenderer.invoke('onesignalDirect:preview', options),
    send:              (options) => ipcRenderer.invoke('onesignalDirect:send', options),
    previewBulk:       (options) => ipcRenderer.invoke('onesignalDirect:previewBulk', options),
    sendBulk:          (options) => ipcRenderer.invoke('onesignalDirect:sendBulk', options),
    pauseBulk:         ()        => ipcRenderer.invoke('onesignalDirect:pauseBulk'),
    resumeBulk:        ()        => ipcRenderer.invoke('onesignalDirect:resumeBulk'),
    retryFailed:       ()        => ipcRenderer.invoke('onesignalDirect:retryFailed'),
    bulkJob:           ()        => ipcRenderer.invoke('onesignalDirect:bulkJob'),
    clearBulk:         ()        => ipcRenderer.invoke('onesignalDirect:clearBulk'),
    onLog:             (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('onesignalDirect:log', handler);
      return () => ipcRenderer.removeListener('onesignalDirect:log', handler);
    }
  }
});
