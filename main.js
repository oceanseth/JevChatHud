const { app, BrowserWindow, Menu, ipcMain, systemPreferences, shell, dialog } = require("electron");
const path = require("path");
const { Settings } = require("./src/settings");
const { SourceManager } = require("./src/sources");
const { Judge } = require("./src/judge");
const { UserStats } = require("./src/user_stats");
const { Transcriber } = require("./src/stt");
const winstall = require("./src/whisper_install");
const { Speaker } = require("./src/speaker");
const { MaskyClient } = require("./src/masky");
const { maskyLogin } = require("./src/masky_login");

// In a packaged build macOS reads the name from Info.plist; this covers dev
// (dock, notifications, userData path stays "jevchathud" via package.json name).
app.setName("JevChatHud");

let win = null;
let shareWin = null;
let settings = null;
let sources = null;
let judge = null;
let userStats = null;
let transcriber = null;
let speaker = null;
let arranging = false;
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
  // The share overlay has no chrome of its own; it lives and dies with the HUD.
  win.on("closed", () => {
    win = null;
    if (shareWin && !shareWin.isDestroyed()) shareWin.close();
  });
}

// The OBS-shareable Jev-speaks overlay: transparent and click-through while
// idle so nothing shows on stream between readings. Mouse events only wake
// up in arrange mode (positioning from settings).
function createShareWindow() {
  if (shareWin && !shareWin.isDestroyed()) return shareWin;
  const saved = settings.get().speaker.shareBounds;
  shareWin = new BrowserWindow({
    width: saved?.width || 360,
    height: saved?.height || 440,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: "Jev Speaks",
    webPreferences: {
      preload: path.join(__dirname, "preload-share.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  shareWin.setAlwaysOnTop(true, "screen-saver");
  shareWin.setIgnoreMouseEvents(true);
  shareWin.loadFile(path.join(__dirname, "renderer", "share.html"));
  shareWin.webContents.on("did-finish-load", () => {
    shareWin.webContents.send("share:chroma", settings.get().speaker.chroma);
  });
  const saveBounds = () => {
    if (!shareWin || shareWin.isDestroyed()) return;
    settings.update({ speaker: { ...settings.get().speaker, shareBounds: shareWin.getBounds() } });
  };
  shareWin.on("moved", saveBounds);
  shareWin.on("resized", saveBounds);
  shareWin.on("closed", () => { shareWin = null; });
  return shareWin;
}

function syncSpeaker() {
  const cfg = settings.get().speaker;
  if (cfg.enabled && cfg.maskyToken) {
    createShareWindow();
    speaker.start();
  } else {
    speaker.stop();
    if (!arranging && shareWin && !shareWin.isDestroyed()) shareWin.close();
  }
  if (shareWin && !shareWin.isDestroyed()) {
    shareWin.webContents.send("share:chroma", cfg.chroma);
  }
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
  transcriber = new Transcriber({ ...(settings.get().mic || {}), userData: app.getPath("userData") });

  judge = new Judge({
    getConfig: () => settings.get(),
    getProfile: () => settings.profile(settings.get().activeProfileId),
    getSpeech: () => transcriber.recentSpeech(),
    onJudged: (id, judgment) => {
      // Fold the judgment into the user's lifetime stats before notifying the
      // renderer, so a profile refresh triggered by this event sees it.
      const msg = awaitingJudgment.get(id);
      if (msg) {
        awaitingJudgment.delete(id);
        userStats.recordJudgment(msg, judgment);
        speaker.noteJudged(msg, judgment);
      }
      send("chat:judged", { id, judgment });
    },
    onStats: (stats) => send("judge:stats", stats),
  });

  speaker = new Speaker({
    getConfig: () => settings.get().speaker,
    onPlay: (payload) => {
      const w = createShareWindow();
      if (w.webContents.isLoading()) {
        w.webContents.once("did-finish-load", () => w.webContents.send("share:play", payload));
      } else {
        w.webContents.send("share:play", payload);
      }
      send("speaker:played", payload);
    },
    onState: (state) => send("speaker:state", state),
    onError: (err) => send("speaker:error", err),
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

  // "Jev speaks" share window + Masky account plumbing.
  const maskyClient = new MaskyClient();
  // Backfill the connected identity for tokens stored before the avatar
  // picture existed in settings (OAuth-sourced tokens resolve via userinfo).
  {
    const sp = settings.get().speaker;
    if (sp.maskyToken && !sp.maskyAccountPicture) {
      maskyClient.userinfo(sp.maskyToken).then((who) => {
        if (!who || (!who.name && !who.picture)) return;
        const cur = settings.get().speaker;
        if (!cur.maskyToken) return; // logged out in the meantime
        settings.update({
          speaker: {
            ...cur,
            maskyAccountName: who.name || cur.maskyAccountName,
            maskyAccountPicture: who.picture || "",
          },
        });
        send("speaker:identity", {
          maskyAccountName: settings.get().speaker.maskyAccountName,
          maskyAccountPicture: settings.get().speaker.maskyAccountPicture,
        });
      });
    }
  }
  ipcMain.handle("speaker:update", (_e, patch) => {
    settings.update({ speaker: { ...settings.get().speaker, ...patch } });
    syncSpeaker();
    return settings.get().speaker;
  });
  ipcMain.handle("speaker:login", async () => {
    const { accessToken, avatar } = await maskyLogin({ openExternal: shell.openExternal });
    settings.update({
      speaker: {
        ...settings.get().speaker,
        maskyToken: accessToken,
        maskyAccountName: avatar?.name || "",
        maskyAccountPicture: avatar?.picture || "",
      },
    });
    syncSpeaker();
    speaker.refreshBalance();
    return { connected: true, accountName: avatar?.name || "" };
  });
  ipcMain.handle("speaker:verify-token", async (_e, token) => {
    // A pasted token is verified by listing the account's avatars — cheap,
    // read-only, and proves both auth and the avatars:read/generate grant.
    const avatars = await maskyClient.listAvatars(token);
    // OAuth-issued tokens resolve to an identity (name + picture); raw
    // pasted keys don't, and that's fine — the UI degrades to a plain label.
    const who = await maskyClient.userinfo(token);
    settings.update({
      speaker: {
        ...settings.get().speaker,
        maskyToken: token,
        maskyAccountName: who?.name || "",
        maskyAccountPicture: who?.picture || "",
      },
    });
    syncSpeaker();
    speaker.refreshBalance();
    return { connected: true, avatars };
  });
  ipcMain.handle("speaker:logout", () => {
    settings.update({
      speaker: {
        ...settings.get().speaker,
        maskyToken: "",
        maskyAccountName: "",
        maskyAccountPicture: "",
      },
    });
    speaker.balance = null; // a new login must not inherit the old account's balance
    syncSpeaker(); // no token -> stops the schedule and closes the share window
    return settings.get().speaker;
  });
  ipcMain.handle("speaker:avatars", async () => {
    const token = settings.get().speaker.maskyToken;
    return token ? maskyClient.listAvatars(token) : [];
  });
  ipcMain.handle("speaker:test", () => speaker.tick({ force: true }));
  ipcMain.handle("speaker:state", () => speaker.emitState());
  ipcMain.handle("speaker:arrange", (_e, on) => {
    arranging = !!on;
    const w = createShareWindow();
    w.setIgnoreMouseEvents(!arranging);
    w.webContents.send("share:arrange", arranging);
    if (arranging) w.focus();
    else syncSpeaker(); // closes the window again if the feature is off
  });
  ipcMain.on("share:done", () => send("speaker:played-done"));

  // Mic / local STT. Payloads are Float32Array PCM chunks (16kHz mono) from
  // the renderer's capture; structured clone may hand them over as views.
  const toFloat32 = (p) =>
    p instanceof Float32Array
      ? p
      : ArrayBuffer.isView(p)
        ? new Float32Array(p.buffer, p.byteOffset, Math.floor(p.byteLength / 4))
        : new Float32Array(p);
  ipcMain.handle("mic:access", async () => {
    if (process.platform !== "darwin") return true;
    try {
      return await systemPreferences.askForMediaAccess("microphone");
    } catch {
      return true; // MAS-style restriction failure: let getUserMedia decide
    }
  });
  ipcMain.handle("stt:status", () => transcriber.available());
  ipcMain.handle("stt:chunk", async (_e, pcm) => {
    const res = await transcriber.transcribe(toFloat32(pcm));
    if (res.text) transcriber.record(res.text);
    return res;
  });
  ipcMain.handle("stt:test", (_e, pcm) => transcriber.transcribe(toFloat32(pcm)));

  // Guided whisper setup (Settings → Microphone). After any install step the
  // transcriber re-resolves in place so the rolling transcript survives.
  const sttSetupStatus = () =>
    winstall.status({ userData: app.getPath("userData"), config: settings.get().mic || {} });
  const sttRefresh = () => transcriber.setPaths(settings.get().mic || {});
  // A successful install must not stay shadowed by a stale manual override —
  // drop the override so autodetection finds the artifact that was just put
  // in place (managed engine dir / model cache / brew prefix).
  const sttClearOverride = (key) => {
    const mic = { ...(settings.get().mic || {}) };
    if (mic[key]) {
      delete mic[key];
      settings.update({ mic });
    }
  };
  let sttInstallBusy = false;
  const installProgress = (kind) => (p) => send("stt:install-progress", { kind, ...p });
  ipcMain.handle("stt:setup-status", () => sttSetupStatus());
  ipcMain.handle("stt:install-model", async (_e, id) => {
    if (sttInstallBusy) return { error: "an install is already running" };
    sttInstallBusy = true;
    try {
      await winstall.downloadModel(id, { onProgress: installProgress("model") });
      sttClearOverride("whisperModel");
      sttRefresh();
      return sttSetupStatus();
    } catch (err) {
      return { error: String(err.message || err) };
    } finally {
      sttInstallBusy = false;
    }
  });
  ipcMain.handle("stt:install-bin", async () => {
    if (sttInstallBusy) return { error: "an install is already running" };
    sttInstallBusy = true;
    try {
      if (process.platform === "darwin") {
        await winstall.brewInstall({ onLog: (line) => send("stt:install-progress", { kind: "brew", line }) });
      } else {
        await winstall.downloadBinary({ userData: app.getPath("userData"), onProgress: installProgress("bin") });
      }
      sttClearOverride("whisperBin");
      sttRefresh();
      return sttSetupStatus();
    } catch (err) {
      return { error: String(err.message || err) };
    } finally {
      sttInstallBusy = false;
    }
  });
  ipcMain.handle("stt:locate", async (_e, which) => {
    const isBin = which === "bin";
    const res = await dialog.showOpenDialog(win, {
      title: isBin ? "Locate whisper-cli" : "Locate a ggml whisper model (.bin)",
      properties: ["openFile", "showHiddenFiles"],
      filters: isBin ? [] : [{ name: "ggml model", extensions: ["bin"] }],
    });
    if (res.canceled || !res.filePaths[0]) return sttSetupStatus();
    const mic = { ...(settings.get().mic || {}) };
    mic[isBin ? "whisperBin" : "whisperModel"] = res.filePaths[0];
    settings.update({ mic });
    sttRefresh();
    return sttSetupStatus();
  });

  createWindow();

  // Resume the last active profile on launch.
  const last = settings.get().activeProfileId;
  if (last) activateProfile(last);
  syncSpeaker();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  sources?.stopAll();
  speaker?.stop();
  userStats?.save();
  app.quit();
});
