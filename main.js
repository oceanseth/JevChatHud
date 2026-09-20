const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const path = require("path");
const { Settings } = require("./src/settings");
const { SourceManager } = require("./src/sources");
const { Judge } = require("./src/judge");
const { UserStats } = require("./src/user_stats");

// In a packaged build macOS reads the name from Info.plist; this covers dev
// (dock, notifications, userData path stays "jevchathud" via package.json name).
app.setName("JevChatHud");

let win = null;
let settings = null;
let sources = null;
let judge = null;
let userStats = null;
// Messages awaiting judgment, so a judgment can be attributed to its user.
const awaitingJudgment = new Map();
const AWAITING_MAX = 2000;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const settingsItem = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => send("ui:open-settings"),
  };
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            settingsItem,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [settingsItem, { type: "separator" }, isMac ? { role: "close" } : { role: "quit" }],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
  app.setAboutPanelOptions({
    applicationName: "JevChatHud",
    applicationVersion: app.getVersion(),
    credits: "Chat curation judged by TypeSafe Jev.",
  });
  buildMenu();
  // Dev runs use Electron's own bundle icon; give the dock ours.
  if (process.platform === "darwin" && !app.isPackaged) {
    try { app.dock.setIcon(path.join(__dirname, "assets", "icon-1024.png")); } catch {}
  }

  settings = new Settings(app.getPath("userData"));
  userStats = new UserStats(app.getPath("userData"));

  judge = new Judge({
    getConfig: () => settings.get(),
    getProfile: () => settings.profile(settings.get().activeProfileId),
    onJudged: (id, judgment) => {
      // Fold the judgment into the user's lifetime stats before notifying the
      // renderer, so a profile refresh triggered by this event sees it.
      const msg = awaitingJudgment.get(id);
      if (msg) {
        awaitingJudgment.delete(id);
        userStats.recordJudgment(msg, judgment);
      }
      send("chat:judged", { id, judgment });
    },
    onStats: (stats) => send("judge:stats", stats),
  });

  sources = new SourceManager({
    onMessage: (msg) => {
      userStats.recordMessage(msg);
      awaitingJudgment.set(msg.id, msg);
      if (awaitingJudgment.size > AWAITING_MAX) {
        awaitingJudgment.delete(awaitingJudgment.keys().next().value);
      }
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
  ipcMain.handle("user:profile", (_e, { platform, name }) => userStats.get(platform, name));

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
  userStats?.save();
  app.quit();
});
