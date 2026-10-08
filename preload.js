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
  sttRecent: () => ipcRenderer.invoke("stt:recent"),
  sttChunk: (pcm) => ipcRenderer.invoke("stt:chunk", pcm),
  sttTest: (pcm) => ipcRenderer.invoke("stt:test", pcm),
  sttSetupStatus: () => ipcRenderer.invoke("stt:setup-status"),
  sttInstallModel: (id) => ipcRenderer.invoke("stt:install-model", id),
  sttInstallBin: () => ipcRenderer.invoke("stt:install-bin"),
  sttLocate: (which) => ipcRenderer.invoke("stt:locate", which),
  onSttInstallProgress: on("stt:install-progress"),
  speakerUpdate: (patch) => ipcRenderer.invoke("speaker:update", patch),
  speakerLogin: () => ipcRenderer.invoke("speaker:login"),
  speakerVerifyToken: (token) => ipcRenderer.invoke("speaker:verify-token", token),
  speakerLogout: () => ipcRenderer.invoke("speaker:logout"),
  speakerAvatars: () => ipcRenderer.invoke("speaker:avatars"),
  speakerTest: () => ipcRenderer.invoke("speaker:test"),
  speakerState: () => ipcRenderer.invoke("speaker:state"),
  speakerArrange: (on) => ipcRenderer.invoke("speaker:arrange", on),
  speakerCreateAvatar: () => ipcRenderer.invoke("speaker:create-avatar"),
  speakerAudioDone: () => ipcRenderer.send("speaker:audio-done"),
  onSpeakerPlayAudio: on("speaker:play-audio"),
  onSpeakerArranged: on("speaker:arranged"),
  onMessage: on("chat:message"),
  onJudged: on("chat:judged"),
  onSourceStatus: on("source:status"),
  onJudgeStats: on("judge:stats"),
  onProfileActivated: on("profile:activated"),
  onOpenSettings: on("ui:open-settings"),
  onSpeakerState: on("speaker:state"),
  onSpeakerIdentity: on("speaker:identity"),
  onSpeakerError: on("speaker:error"),
  onSpeakerPlayed: on("speaker:played"),
  twitchStatus: () => ipcRenderer.invoke("twitch:status"),
  twitchLogin: () => ipcRenderer.invoke("twitch:login"),
  twitchLogout: () => ipcRenderer.invoke("twitch:logout"),
  twitchSend: (text) => ipcRenderer.invoke("twitch:send", text),
  onTwitchPending: on("twitch:pending"),
  onTwitchStatus: on("twitch:status"),
  onTwitchDelivery: on("twitch:delivery"),
  emotesGet: () => ipcRenderer.invoke("emotes:get"),
  onEmotes: on("emotes:catalog"),
  identityLoad: () => ipcRenderer.invoke("identity:load"),
  identityImages: (avatarId, ownerUserId) => ipcRenderer.invoke("identity:images", { avatarId, ownerUserId }),
  identitySave: (body) => ipcRenderer.invoke("identity:save", body),
});
