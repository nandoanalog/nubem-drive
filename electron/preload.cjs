const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nubemDrive', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  chooseFolders: () => ipcRenderer.invoke('folders:choose'),
  setFolderMode: (id, mode) => ipcRenderer.invoke('folders:set-mode', id, mode),
  toggleFolderSync: (id) => ipcRenderer.invoke('folders:toggle-sync', id),
  revealFolder: (folderPath) => ipcRenderer.invoke('folders:reveal', folderPath),
  createPairCode: (relayUrl) => ipcRenderer.invoke('pairing:create-code', relayUrl),
  joinPairing: (relayUrl, code) => ipcRenderer.invoke('pairing:join', relayUrl, code),
  refreshPairing: () => ipcRenderer.invoke('pairing:refresh'),
  resetPairing: () => ipcRenderer.invoke('pairing:reset'),
});
