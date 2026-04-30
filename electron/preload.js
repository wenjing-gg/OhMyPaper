const { contextBridge, ipcRenderer } = require('electron');

const desktopApi = {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  refreshStatus: () => ipcRenderer.invoke('status:refresh'),
  tokenStatus: () => ipcRenderer.invoke('token:status'),
  saveToken: (token) => ipcRenderer.invoke('token:save', token),
  registerToken: () => ipcRenderer.invoke('token:register'),
  search: (payload) => ipcRenderer.invoke('papers:search', payload),
  trending: (payload) => ipcRenderer.invoke('papers:trending', payload),
  prefetchPdf: (payload) => ipcRenderer.invoke('pdf:prefetch', payload),
  resolvePdf: (payload) => ipcRenderer.invoke('pdf:resolve', payload),
  loadPdfDocument: (payload) => ipcRenderer.invoke('pdf:loadDocument', payload),
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
  onAiChatStream: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('ai:chat-stream', listener);
    return () => ipcRenderer.removeListener('ai:chat-stream', listener);
  },
  openPdfViewer: (payload) => ipcRenderer.invoke('pdf:openViewer', payload),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),
  onPdfPrefetchStatus: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('pdf:prefetch-status', listener);
    return () => ipcRenderer.removeListener('pdf:prefetch-status', listener);
  }
};

contextBridge.exposeInMainWorld('ohMyPaper', desktopApi);
contextBridge.exposeInMainWorld('deepxiv', desktopApi);
