const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { Settings } = require("./src/settings");
const { SourceManager } = require("./src/sources");
const { Judge } = require("./src/judge");

let win = null;
let settings = null;
let sources = null;
let judge = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 780,
    minWidth: 340,
    minHeight: 420,
    title: "JevChatHud",
    backgroundColor: "#0e0e12",
    alwaysOnTop: settings.get().alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function activateProfile(profileId) {
  const profile = settings.profile(profileId);
  settings.update({ activeProfileId: profile ? profile.id : null });
  judge.reset();
  sources.activate(profile);
  send("profile:activated", profile ? profile.id : null);
}

app.whenReady().then(() => {
  settings = new Settings(app.getPath("userData"));

  judge = new Judge({
    getConfig: () => settings.get(),
    getProfile: () => settings.profile(settings.get().activeProfileId),
    onJudged: (id, judgment) => send("chat:judged", { id, judgment }),
    onStats: (stats) => send("judge:stats", stats),
  });

  sources = new SourceManager({
    onMessage: (msg) => {
      send("chat:message", msg);
      judge.enqueue(msg);
    },
    onStatus: (status) => send("source:status", status),
  });

  ipcMain.handle("settings:get", () => settings.get());
  ipcMain.handle("settings:update", (_e, patch) => {
    const updated = settings.update(patch);
    if ("alwaysOnTop" in patch && win) win.setAlwaysOnTop(!!patch.alwaysOnTop);
    return updated;
  });
  ipcMain.handle("profiles:save", (_e, profile) => settings.saveProfile(profile));
  ipcMain.handle("profiles:delete", (_e, id) => {
    if (settings.get().activeProfileId === id) activateProfile(null);
    settings.deleteProfile(id);
    return settings.get();
  });
  ipcMain.handle("profile:activate", (_e, id) => activateProfile(id));

  createWindow();

  // Resume the last active profile on launch.
  const last = settings.get().activeProfileId;
  if (last) activateProfile(last);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  sources?.stopAll();
  app.quit();
});
