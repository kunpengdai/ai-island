const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('island', {
  action: (action, value) => ipcRenderer.invoke('island:action', action, value),
  onState: callback => { const listener = (_, data) => callback(data); ipcRenderer.on('island:state', listener); return () => ipcRenderer.removeListener('island:state', listener); },
  onChime: callback => { const listener = (_, data) => callback(data); ipcRenderer.on('island:chime', listener); return () => ipcRenderer.removeListener('island:chime', listener); }
});
