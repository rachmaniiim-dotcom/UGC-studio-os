import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

// The only bridge into privileged code: fixed channels, fixed argument shapes.
// No generic invoke(), no ipcRenderer, no Node APIs.
contextBridge.exposeInMainWorld(
  'ugc',
  Object.freeze({
    listProfiles: () => ipcRenderer.invoke('poc:list-profiles'),
    importCookies: (profileId: string) => ipcRenderer.invoke('poc:import-cookies', { profileId }),
    checkStatus: (profileId: string) => ipcRenderer.invoke('poc:check-status', { profileId }),
    openSite: (profileId: string, page: string) => ipcRenderer.invoke('poc:open-site', { profileId, page }),
    clearProfile: (profileId: string) => ipcRenderer.invoke('poc:clear-profile', { profileId }),
  }),
);
