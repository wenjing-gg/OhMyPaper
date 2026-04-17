const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deepxiv', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  refreshStatus: () => ipcRenderer.invoke('status:refresh'),
  tokenStatus: () => ipcRenderer.invoke('token:status'),
  saveToken: (token) => ipcRenderer.invoke('token:save', token),
  registerToken: () => ipcRenderer.invoke('token:register'),
  search: (payload) => ipcRenderer.invoke('papers:search', payload),
  trending: (payload) => ipcRenderer.invoke('papers:trending', payload),
  snapshot: (payload) => ipcRenderer.invoke('papers:snapshot', payload),
  section: (payload) => ipcRenderer.invoke('papers:section', payload),
  favoritesList: () => ipcRenderer.invoke('favorites:list'),
  favoritesToggle: (paper) => ipcRenderer.invoke('favorites:toggle', paper),
  favoriteRemove: (paperId) => ipcRenderer.invoke('favorites:remove', paperId),
  favoriteGroups: () => ipcRenderer.invoke('favorites:groups:list'),
  createFavoriteGroup: (name) => ipcRenderer.invoke('favorites:groups:create', name),
  renameFavoriteGroup: (payload) => ipcRenderer.invoke('favorites:groups:rename', payload),
  setFavoriteGroup: (payload) => ipcRenderer.invoke('favorites:setGroup', payload),
  importLocalPdf: (payload) => ipcRenderer.invoke('favorites:importLocalPdf', payload),
  historyList: () => ipcRenderer.invoke('history:list'),
  historyAdd: (payload) => ipcRenderer.invoke('history:add', payload),
  aiConfig: () => ipcRenderer.invoke('ai:config:get'),
  saveAiConfig: (payload) => ipcRenderer.invoke('ai:config:save', payload),
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  openPdfViewer: (payload) => ipcRenderer.invoke('pdf:openViewer', payload),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath)
});
