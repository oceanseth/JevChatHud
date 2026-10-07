const { contextBridge, ipcRenderer } = require("electron");

function on(channel) {
  return (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("share", {
  done: () => ipcRenderer.send("share:done"),
  onPlay: on("share:play"),
  onArrange: on("share:arrange"),
  onChroma: on("share:chroma"),
});
