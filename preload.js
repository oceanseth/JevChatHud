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
  getUserProfile: (platform, name) => ipcRenderer.invoke("user:profile", { platform, name }),
  requestMicAccess: () => ipcRenderer.invoke("mic:access"),
  sttStatus: () => ipcRenderer.invoke("stt:status"),
  sttChunk: (pcm) => ipcRenderer.invoke("stt:chunk", pcm),
  sttTest: (pcm) => ipcRenderer.invoke("stt:test", pcm),
  speakerUpdate: (patch) => ipcRenderer.invoke("speaker:update", patch),
  speakerLogin: () => ipcRenderer.invoke("speaker:login"),
  speakerVerifyToken: (token) => ipcRenderer.invoke("speaker:verify-token", token),
  speakerAvatars: () => ipcRenderer.invoke("speaker:avatars"),
  speakerTest: () => ipcRenderer.invoke("speaker:test"),
  speakerState: () => ipcRenderer.invoke("speaker:state"),
  speakerArrange: (on) => ipcRenderer.invoke("speaker:arrange", on),
  onMessage: on("chat:message"),
  onJudged: on("chat:judged"),
  onSourceStatus: on("source:status"),
  onJudgeStats: on("judge:stats"),
  onProfileActivated: on("profile:activated"),
  onOpenSettings: on("ui:open-settings"),
  onSpeakerState: on("speaker:state"),
  onSpeakerError: on("speaker:error"),
  onSpeakerPlayed: on("speaker:played"),
});
