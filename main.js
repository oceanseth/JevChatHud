const { app, BrowserWindow, Menu, ipcMain, systemPreferences, shell, dialog, screen } = require("electron");
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
const {
  activeTwitchChannel,
  publicTwitch,
  startDeviceFlow,
  pollDeviceToken,
  identityFromToken,
  channelCategory,
  broadcasterIdFor,
  sendChatMessage,
  DeliveryWatch,
} = require("./src/twitch_auth");
const { emptyCatalog, loadEmoteCatalog } = require("./src/emote_catalog");

// In a packaged build macOS reads the name from Info.plist; this covers dev
// (dock, notifications, userData path stays "jevchathud" via package.json name).
app.setName("JevChatHud");

let win = null;
let shareWin = null;
let settings = null;

/** Settings for the renderer. The Twitch access token stays in main. */
function settingsForClient() {
  const data = settings.get();
  const tw = data.twitch || {};
  return {
    ...data,
    twitch: {
      login: tw.login || "",
      displayName: tw.displayName || tw.login || "",
      userId: tw.userId || "",
      profileImageUrl: tw.profileImageUrl || "",
    },
  };
}

let sources = null;
let judge = null;
const deliveryWatch = new DeliveryWatch();
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
  shareWin.on("moved", saveShareBounds);
  shareWin.on("resized", saveShareBounds);
  shareWin.on("closed", () => {
    shareWin = null;
    shareInteractive = false;
    sharePollStop();
  });
  return shareWin;
}

function saveShareBounds() {
  if (!shareWin || shareWin.isDestroyed()) return;
  settings.update({ speaker: { ...settings.get().speaker, shareBounds: shareWin.getBounds() } });
}

// While a reading is on screen the card is a drag region, so the streamer can
// grab it and move the window. The window still has to be click-through the
// rest of the time, so a cursor poll flips interactivity only while the
// pointer is actually over the window. Arrange mode pins it interactive.
let sharePoll = null;
let shareInteractive = false;

function shareSetInteractive(on) {
  if (!shareWin || shareWin.isDestroyed() || shareInteractive === on) return;
  shareInteractive = on;
  shareWin.setIgnoreMouseEvents(!on);
}

function sharePollStart() {
  if (sharePoll) return;
  sharePoll = setInterval(() => {
    if (!shareWin || shareWin.isDestroyed() || arranging) return;
    // "mouseclicks pass through to application": never go interactive, so
    // clicks over the overlay always land on the window underneath.
    if (settings.get().speaker.clickThrough) {
      shareSetInteractive(false);
      return;
    }
    const p = screen.getCursorScreenPoint();
    const b = shareWin.getBounds();
    const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    shareSetInteractive(inside);
  }, 150);
}

function sharePollStop() {
  clearInterval(sharePoll);
  sharePoll = null;
  if (!arranging) shareSetInteractive(false);
}

function syncSpeaker() {
  const cfg = settings.get().speaker;
  if (cfg.enabled && cfg.maskyToken) {
    // Audio-only mode never pops the window — readings play in the HUD itself.
    if (cfg.audioOnly) {
      if (!arranging && shareWin && !shareWin.isDestroyed()) shareWin.close();
    } else {
      createShareWindow();
    }
    speaker.start();
  } else {
    speaker.stop();
    if (!arranging && shareWin && !shareWin.isDestroyed()) shareWin.close();
  }
  if (shareWin && !shareWin.isDestroyed()) {
    shareWin.webContents.send("share:chroma", cfg.chroma);
  }
}

let emotesRefresh = async () => {};

function activateProfile(profileId) {
  const profile = settings.profile(profileId);
  settings.update({ activeProfileId: profile ? profile.id : null });
  judge.reset();
  sources.activate(profile);
  send("profile:activated", profile ? profile.id : null);
  emotesRefresh();
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

  // Audio-only readings play inside the HUD window (no popup at all);
  // video readings go to the transparent share window.
  const playReading = (payload) => {
    if (payload.audio) {
      send("speaker:play-audio", payload);
    } else {
      const w = createShareWindow();
      if (w.webContents.isLoading()) {
        w.webContents.once("did-finish-load", () => w.webContents.send("share:play", payload));
      } else {
        w.webContents.send("share:play", payload);
      }
      sharePollStart();
    }
    send("speaker:played", payload);
  };

  speaker = new Speaker({
    getConfig: () => settings.get().speaker,
    onPlay: playReading,
    onState: (state) => send("speaker:state", state),
    onError: (err) => send("speaker:error", err),
  });

  sources = new SourceManager({
    onMessage: (msg) => {
      // A composer send echoing back on the anonymous reader proves the
      // channel broadcast it publicly — the strongest "it really went
      // through" signal Twitch offers.
      const sent = deliveryWatch.observe(msg.id);
      if (sent) send("twitch:delivery", { state: "delivered", channel: sent.channel, messageId: msg.id });
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

  ipcMain.handle("settings:get", () => settingsForClient());
  ipcMain.handle("settings:update", (_e, patch) => {
    // Twitch credentials are written only by the device-code handlers below.
    // A renderer patch must not be able to round-trip a redacted twitch
    // object back over the stored access token.
    const safe = { ...(patch || {}) };
    delete safe.twitch;
    settings.update(safe);
    if ("alwaysOnTop" in safe && win) win.setAlwaysOnTop(!!safe.alwaysOnTop);
    return settingsForClient();
  });
  ipcMain.handle("profiles:save", (_e, profile) => settings.saveProfile(profile));
  ipcMain.handle("profiles:delete", (_e, id) => {
    if (settings.get().activeProfileId === id) activateProfile(null);
    settings.deleteProfile(id);
    return settingsForClient();
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
  // The settings test button plays the bundled sample reading (no Masky
  // render, no credits): it demos exactly where and how readings appear —
  // including audio-only mode, where only the clip's sound plays in the HUD.
  ipcMain.handle("speaker:test", () => {
    const url = "assets/test-reading.mp4";
    playReading({
      url,
      line: "This is the location chat readings will appear in. You can control the size and location of the window in settings.",
      username: "Jev Judge",
      platform: "hud",
      relevancy: 100,
      audio: !!settings.get().speaker.audioOnly,
    });
    return url;
  });
  // "create avatar" under the own-avatar picker: deep-link into the user's
  // masky.ai admin console (the #create hash pops the naming dialog there);
  // without a resolvable account, land on masky.ai itself.
  ipcMain.handle("speaker:create-avatar", async () => {
    const token = settings.get().speaker.maskyToken;
    let url = "https://masky.ai/";
    if (token) {
      try {
        const slug = await maskyClient.ownerSlug(token);
        if (slug) url = `https://masky.ai/${encodeURIComponent(slug)}/admin#create`;
      } catch {
        // token rejected / offline — the landing page is still the right door
      }
    }
    shell.openExternal(url);
    return url;
  });

  // Twitch account for the chat composer (sending), distinct from the Masky
  // token that pays for renders. Device-code login opens twitch.tv/activate;
  // the poll finishes in the background and pushes twitch:status.
  let twitchLoginGen = 0;
  const twitchView = () => publicTwitch(settings.get().twitch);
  ipcMain.handle("twitch:status", () => twitchView());
  ipcMain.handle("twitch:login", async () => {
    const gen = ++twitchLoginGen;
    const flow = await startDeviceFlow();
    shell.openExternal(flow.verificationUri);
    send("twitch:pending", { userCode: flow.userCode, verificationUri: flow.verificationUri });
    pollDeviceToken(flow.deviceCode, {
      intervalSec: flow.intervalSec,
      expiresInSec: flow.expiresInSec,
    })
      .then(async (tok) => {
        if (gen !== twitchLoginGen) return;
        const who = await identityFromToken(tok.accessToken);
        if (gen !== twitchLoginGen) return;
        settings.update({ twitch: who });
        send("twitch:status", twitchView());
        emotesRefresh();
      })
      .catch((err) => {
        if (gen !== twitchLoginGen) return;
        send("twitch:status", { ...twitchView(), error: err.message || "Twitch login failed" });
      });
    return { userCode: flow.userCode, verificationUri: flow.verificationUri };
  });
  ipcMain.handle("twitch:logout", () => {
    twitchLoginGen += 1;
    settings.update({
      twitch: { accessToken: "", login: "", displayName: "", userId: "", profileImageUrl: "" },
    });
    const view = twitchView();
    send("twitch:status", view);
    emotesRefresh();
    return view;
  });
  ipcMain.handle("twitch:send", async (_e, text) => {
    const tw = settings.get().twitch;
    if (!tw.accessToken || !tw.userId) throw new Error("Log in with Twitch in Settings first");
    const channel = activeTwitchChannel(settings.get());
    if (!channel) throw new Error("This profile has no Twitch channel");
    const broadcasterId = await broadcasterIdFor(tw.accessToken, channel);
    if (!broadcasterId) throw new Error(`Twitch channel #${channel} was not found`);
    const result = await sendChatMessage({
      token: tw.accessToken,
      broadcasterId,
      senderId: tw.userId,
      message: text,
    });
    // Helix accepting a message is not delivery — anti-spam can hide it from
    // everyone but the sender with no error anywhere. Watch the reader for
    // the public echo and tell the composer which of the two happened.
    deliveryWatch.expect(result.messageId, { channel }, () =>
      send("twitch:delivery", { state: "missing", channel, messageId: result.messageId }),
    );
    return { ...result, channel };
  });

  // 7TV / BTTV / FFZ / Helix catalog for painting names as images and the picker.
  let emoteCatalog = emptyCatalog();
  let emoteGen = 0;
  emotesRefresh = async () => {
    const gen = ++emoteGen;
    const channel = activeTwitchChannel(settings.get());
    const tw = settings.get().twitch || {};
    try {
      const catalog = await loadEmoteCatalog({
        channel,
        token: tw.accessToken || "",
      });
      if (gen !== emoteGen) return;
      emoteCatalog = catalog;
      send("emotes:catalog", catalog);
    } catch {
      if (gen !== emoteGen) return;
    }
  };
  ipcMain.handle("emotes:get", () => emoteCatalog);

  // Manage-identity popup: the viewer's own avatars plus community avatars
  // enabled for the watched channel's current game. All Masky calls stay in
  // main so the bearer token never has to be fetched from the renderer.
  async function loadCommunity(token, channel) {
    if (!channel) return { channel: "", gameName: "", avatars: [], reason: "no-channel" };
    const tw = settings.get().twitch;
    if (!tw.accessToken) return { channel, gameName: "", avatars: [], reason: "no-twitch" };
    let gameName = "";
    try {
      gameName = (await channelCategory(tw.accessToken, channel)).gameName || "";
    } catch (err) {
      return { channel, gameName: "", avatars: [], reason: "category-failed", error: err.message };
    }
    if (!gameName) return { channel, gameName: "", avatars: [], reason: "no-category" };
    const listed = await maskyClient.listCommunityAvatars(token, gameName);
    return {
      channel,
      gameName,
      avatars: listed.avatars,
      reason: listed.unavailable ? "unavailable" : "",
    };
  }
  ipcMain.handle("identity:load", async () => {
    const token = settings.get().speaker.maskyToken;
    const channel = activeTwitchChannel(settings.get());
    if (!token) {
      return { connected: false, avatars: [], streamIdentity: null, community: { channel, gameName: "", avatars: [], reason: "no-masky" } };
    }
    const [avatars, streamIdentity, community] = await Promise.all([
      maskyClient.listAvatars(token),
      maskyClient.getStreamIdentity(token),
      loadCommunity(token, channel),
    ]);
    return { connected: true, avatars, streamIdentity, community };
  });
  ipcMain.handle("identity:images", async (_e, { avatarId, ownerUserId } = {}) => {
    const token = settings.get().speaker.maskyToken;
    if (!token) throw new Error("Connect Masky in Settings first");
    return maskyClient.listAvatarImages(token, avatarId, ownerUserId || "");
  });
  ipcMain.handle("identity:save", async (_e, body) => {
    const token = settings.get().speaker.maskyToken;
    if (!token) throw new Error("Connect Masky in Settings first");
    return { streamIdentity: await maskyClient.setStreamIdentity(token, body || {}) };
  });

  ipcMain.handle("speaker:state", () => speaker.emitState());
  ipcMain.handle("speaker:arrange", (_e, on) => {
    arranging = !!on;
    const w = createShareWindow();
    shareInteractive = arranging;
    w.setIgnoreMouseEvents(!arranging);
    // A freshly created window is still loading — a send now would be lost.
    if (w.webContents.isLoading()) {
      w.webContents.once("did-finish-load", () => w.webContents.send("share:arrange", arranging));
    } else {
      w.webContents.send("share:arrange", arranging);
    }
    if (arranging) w.focus();
    else syncSpeaker(); // closes the window again if the feature is off
  });
  // The ✕ on the share window itself: save the placement and leave arrange mode.
  ipcMain.on("share:arrange-done", () => {
    arranging = false;
    if (shareWin && !shareWin.isDestroyed()) {
      saveShareBounds();
      shareInteractive = false;
      shareWin.setIgnoreMouseEvents(true);
      shareWin.webContents.send("share:arrange", false);
    }
    syncSpeaker();
    send("speaker:arranged", false);
  });
  // The resize grip in arrange mode drives the window size from the renderer.
  let shareSizeSave = null;
  ipcMain.on("share:set-size", (_e, size) => {
    if (!shareWin || shareWin.isDestroyed()) return;
    const width = Math.max(220, Math.round(Number(size?.width) || 0));
    const height = Math.max(260, Math.round(Number(size?.height) || 0));
    shareWin.setSize(width, height);
    clearTimeout(shareSizeSave);
    shareSizeSave = setTimeout(saveShareBounds, 400);
  });
  ipcMain.on("share:done", () => {
    sharePollStop();
    speaker.notePlaybackDone();
    send("speaker:played-done");
  });
  // Audio-only readings report completion from the HUD renderer instead.
  ipcMain.on("speaker:audio-done", () => speaker.notePlaybackDone());

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
  // The rolling transcript exactly as the judge will receive it (context peek).
  ipcMain.handle("stt:recent", () => transcriber.recentSpeech());
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
  else emotesRefresh();
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
