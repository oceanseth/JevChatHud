const { contextBridge, ipcRenderer } = require("electron");

function on(channel) {
  return (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("avatar", {
  done: () => ipcRenderer.send("avatar:done"),
  arrangeDone: () => ipcRenderer.send("avatar:arrange-done"),
  setSize: (width, height) => ipcRenderer.send("avatar:set-size", { width, height }),
  onStill: on("avatar:still"),
  onPlay: on("avatar:play"),
  onArrange: on("avatar:arrange"),
  onChroma: on("avatar:chroma"),
});
