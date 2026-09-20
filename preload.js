const { contextBridge, ipcRenderer } = require("electron");

function on(channel) {
  return (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("hud", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  saveProfile: (profile) => ipcRenderer.invoke("profiles:save", profile),
  deleteProfile: (id) => ipcRenderer.invoke("profiles:delete", id),
  activateProfile: (id) => ipcRenderer.invoke("profile:activate", id),
  onMessage: on("chat:message"),
  onJudged: on("chat:judged"),
  onSourceStatus: on("source:status"),
  onJudgeStats: on("judge:stats"),
  onProfileActivated: on("profile:activated"),
});
