import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

// The only bridge into privileged code: fixed channels, fixed argument shapes.
// No generic invoke(), no ipcRenderer, no Node APIs. Secrets only flow in
// (pasted JSON, proxy password); nothing secret is ever returned.
contextBridge.exposeInMainWorld(
  'ugc',
  Object.freeze({
    // Account Bundles (Gate 3)
    listAccounts: () => ipcRenderer.invoke('accounts:list'),
    createAccount: (displayName: string, mode: string) => ipcRenderer.invoke('accounts:create', { displayName, mode }),
    updateAccount: (bundleId: string, displayName: string, mode: string) => ipcRenderer.invoke('accounts:update', { bundleId, displayName, mode }),
    setAccountProxy: (bundleId: string, proxy: unknown, keepCredentials: boolean) =>
      ipcRenderer.invoke('accounts:set-proxy', { bundleId, proxy, keepCredentials }),
    testAccountProxy: (bundleId: string) => ipcRenderer.invoke('accounts:test-proxy', { bundleId }),
    importSessionText: (profileId: string, text: string) => ipcRenderer.invoke('accounts:import-text', { profileId, text }),
    // Video generation
    saveCreative: (bundleId: string, prompt: string, settings: unknown) => ipcRenderer.invoke('generation:save-settings', { bundleId, prompt, settings }),
    startGeneration: (bundleId: string) => ipcRenderer.invoke('generation:start', { bundleId }),
    listGenerations: (bundleId: string) => ipcRenderer.invoke('generation:list', { bundleId }),
    revealVideo: (jobId: string) => ipcRenderer.invoke('generation:reveal', { jobId }),
    // Growth Intelligence
    growthView: (bundleId: string) => ipcRenderer.invoke('growth:view', { bundleId }),
    saveGrowthStrategy: (bundleId: string, strategy: unknown) => ipcRenderer.invoke('growth:save-strategy', { bundleId, strategy }),
    addReferenceCreator: (bundleId: string, handle: string, note: string) => ipcRenderer.invoke('growth:add-creator', { bundleId, handle, note }),
    removeReferenceCreator: (bundleId: string, creatorId: string) => ipcRenderer.invoke('growth:remove-creator', { bundleId, creatorId }),
    addReference: (bundleId: string, reference: unknown) => ipcRenderer.invoke('growth:add-reference', { bundleId, reference }),
    updateReference: (bundleId: string, referenceId: string, patch: unknown) => ipcRenderer.invoke('growth:update-reference', { bundleId, referenceId, patch }),
    removeReference: (bundleId: string, referenceId: string) => ipcRenderer.invoke('growth:remove-reference', { bundleId, referenceId }),
    importReferencesCsvText: (bundleId: string, text: string) => ipcRenderer.invoke('growth:import-csv-text', { bundleId, text }),
    importReferencesCsvFile: (bundleId: string) => ipcRenderer.invoke('growth:import-csv-file', { bundleId }),
    // Prompt Studio (Ternak Akun)
    studioView: (bundleId: string) => ipcRenderer.invoke('studio:view', { bundleId }),
    saveTemplate: (bundleId: string, template: unknown, baseKey: string | null) => ipcRenderer.invoke('studio:save-template', { bundleId, template, baseKey }),
    duplicateTemplate: (bundleId: string, templateKey: string) => ipcRenderer.invoke('studio:duplicate-template', { bundleId, templateKey }),
    saveTemplateConfig: (bundleId: string, templateKey: string, config: unknown) => ipcRenderer.invoke('studio:save-config', { bundleId, templateKey, config }),
    generatePrompts: (bundleId: string, templateKey: string) => ipcRenderer.invoke('studio:generate', { bundleId, templateKey }),
    updatePrompt: (bundleId: string, itemId: string, content: unknown) => ipcRenderer.invoke('studio:update-prompt', { bundleId, itemId, content }),
    promptAction: (bundleId: string, itemId: string, action: string) => ipcRenderer.invoke('studio:prompt-action', { bundleId, itemId, action }),
    regeneratePrompt: (bundleId: string, itemId: string) => ipcRenderer.invoke('studio:regenerate-prompt', { bundleId, itemId }),
    copyPrompt: (bundleId: string, itemId: string) => ipcRenderer.invoke('studio:copy-prompt', { bundleId, itemId }),
    generateVideoFromPrompt: (bundleId: string, itemId: string) => ipcRenderer.invoke('studio:generate-video', { bundleId, itemId }),
    linkPromptVideo: (bundleId: string, itemId: string, jobId: string) => ipcRenderer.invoke('studio:link-video', { bundleId, itemId, jobId }),
    addReferenceAsset: (bundleId: string, rightsConfirmed: boolean) => ipcRenderer.invoke('studio:add-reference', { bundleId, rightsConfirmed }),
    removeReferenceAsset: (bundleId: string, assetId: string) => ipcRenderer.invoke('studio:remove-reference', { bundleId, assetId }),
    revealReferenceAsset: (bundleId: string, assetId: string) => ipcRenderer.invoke('studio:reveal-reference', { bundleId, assetId }),
    savePreset: (bundleId: string, kind: string, name: string, text: string) => ipcRenderer.invoke('studio:save-preset', { bundleId, kind, name, text }),
    deletePreset: (bundleId: string, presetId: string) => ipcRenderer.invoke('studio:delete-preset', { bundleId, presetId }),
    copyCaption: (bundleId: string, itemId: string) => ipcRenderer.invoke('studio:copy-caption', { bundleId, itemId }),
    markPosted: (bundleId: string, itemId: string, postUrl: string | null) => ipcRenderer.invoke('studio:mark-posted', { bundleId, itemId, postUrl }),
    undoPosted: (bundleId: string, itemId: string) => ipcRenderer.invoke('studio:undo-posted', { bundleId, itemId }),
    productionBoard: () => ipcRenderer.invoke('studio:board', {}),
    setDailyTarget: (bundleId: string, target: number) => ipcRenderer.invoke('studio:set-target', { bundleId, target }),
    // Platform sessions
    getPlatform: () => ipcRenderer.invoke('poc:get-platform'),
    listProfiles: () => ipcRenderer.invoke('poc:list-profiles'),
    importCookies: (profileId: string) => ipcRenderer.invoke('poc:import-cookies', { profileId }),
    checkStatus: (profileId: string) => ipcRenderer.invoke('poc:check-status', { profileId }),
    confirmStatus: (profileId: string, observation: string) => ipcRenderer.invoke('poc:confirm-status', { profileId, observation }),
    openSite: (profileId: string, page: string) => ipcRenderer.invoke('poc:open-site', { profileId, page }),
    clearProfile: (profileId: string) => ipcRenderer.invoke('poc:clear-profile', { profileId }),
  }),
);
