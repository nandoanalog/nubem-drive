const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nubemDrive', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  chooseFolders: () => ipcRenderer.invoke('folders:choose'),
  cloudFolders: () => ipcRenderer.invoke('folders:cloud'),
  removeFolder: (id) => ipcRenderer.invoke('folders:remove', id),
  setFolderMode: (id, mode) => ipcRenderer.invoke('folders:set-mode', id, mode),
  toggleFolderSync: (id) => ipcRenderer.invoke('folders:toggle-sync', id),
  revealFolder: (folderPath) => ipcRenderer.invoke('folders:reveal', folderPath),
  createPairCode: (relayUrl) => ipcRenderer.invoke('pairing:create-code', relayUrl),
  joinPairing: (relayUrl, code) => ipcRenderer.invoke('pairing:join', relayUrl, code),
  shareVault: (id, relayUrl) => ipcRenderer.invoke('vaults:share', id, relayUrl),
  refreshPairing: () => ipcRenderer.invoke('pairing:refresh'),
  resetPairing: () => ipcRenderer.invoke('pairing:reset'),
  browseRemoteFolder: (folderId, relativePath) => ipcRenderer.invoke('remote:browse', folderId, relativePath),
  downloadRemoteFile: (folderId, relativePath) => ipcRenderer.invoke('remote:download', folderId, relativePath),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
});
