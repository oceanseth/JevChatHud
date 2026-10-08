// Twitch login + chat send for the HUD composer.
//
// Desktop login is the device-code grant (no client secret, no registered
// loopback redirect). The client id is the public Masky Twitch application —
// the same one masky.ai already ships — because that app has the device-code
// grant enabled. Consent on twitch.tv therefore names Masky. A dedicated
// JevChatHud client id can replace CLIENT_ID later without changing the flow.
//
// Sending uses Helix POST /chat/messages (scope user:write:chat). Reading the
// channel's current game uses the same user token; category is what the
// manage-identity popup uses to list community avatars.
const CLIENT_ID = "sgb17aslo6gesnetuqfnf6qql6jrae";
const SCOPES = "user:write:chat";
const DEVICE_URL = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const HELIX = "https://api.twitch.tv/helix";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function form(body) {
  return new URLSearchParams(body).toString();
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

function helixHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "client-id": CLIENT_ID,
  };
}

/** Twitch channel the active profile is ingesting, or "". */
function activeTwitchChannel(settings) {
  const profile = (settings?.profiles || []).find((p) => p.id === settings.activeProfileId);
  const src = (profile?.sources || []).find((s) => s.type === "twitch" && s.channel);
  if (!src) return "";
  return String(src.channel).replace(/^#/, "").trim().toLowerCase();
}

/** What the renderer is allowed to see. The access token stays in main. */
function publicTwitch(tw) {
  const token = tw?.accessToken || "";
  const userId = tw?.userId || "";
  return {
    connected: !!(token && userId),
    login: tw?.login || "",
    displayName: tw?.displayName || tw?.login || "",
    userId,
    profileImageUrl: tw?.profileImageUrl || "",
  };
}

async function startDeviceFlow({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(DEVICE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ client_id: CLIENT_ID, scopes: SCOPES }),
  });
  const data = await readJson(res);
  if (!res.ok || !data.device_code) {
    throw new Error(data.message || `Twitch login failed (${res.status})`);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresInSec: Number(data.expires_in) || 1800,
    intervalSec: Number(data.interval) || 5,
  };
}

/**
 * Poll until the user approves the device code, then return {accessToken}.
 * `sleepImpl` is injectable so tests don't wait on Twitch's interval.
 */
async function pollDeviceToken(deviceCode, {
  fetchImpl = fetch,
  sleepImpl = sleep,
  intervalSec = 5,
  expiresInSec = 1800,
  signal,
} = {}) {
  let waitMs = Math.max(1, intervalSec) * 1000;
  const deadline = Date.now() + expiresInSec * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("login cancelled");
    await sleepImpl(waitMs);
    if (signal?.aborted) throw new Error("login cancelled");
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = await readJson(res);
    if (res.ok && data.access_token) return { accessToken: data.access_token, scope: data.scope || "" };
    const message = data.message || "";
    if (message === "authorization_pending") continue;
    if (message === "slow_down") {
      waitMs += 5000;
      continue;
    }
    throw new Error(message || `Twitch login failed (${res.status})`);
  }
  throw new Error("login timed out");
}

async function validateToken(token, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(VALIDATE_URL, {
    headers: { authorization: `OAuth ${token}` },
  });
  const data = await readJson(res);
  if (!res.ok || !data.user_id) throw new Error(data.message || "Twitch token was rejected");
  return { login: data.login || "", userId: data.user_id, clientId: data.client_id || "" };
}

async function helixGet(path, token, fetchImpl) {
  const res = await fetchImpl(`${HELIX}${path}`, { headers: helixHeaders(token) });
  const data = await readJson(res);
  if (!res.ok) throw new Error(data.message || `Twitch ${res.status}`);
  return data;
}

/** login, display name, and profile image for the token's own user. */
async function identityFromToken(token, { fetchImpl = fetch } = {}) {
  const valid = await validateToken(token, { fetchImpl });
  let displayName = valid.login;
  let profileImageUrl = "";
  try {
    const data = await helixGet(`/users?id=${encodeURIComponent(valid.userId)}`, token, fetchImpl);
    const me = (data.data || [])[0];
    if (me) {
      displayName = me.display_name || displayName;
      profileImageUrl = me.profile_image_url || "";
    }
  } catch {
    // validate already proved the token; a missing profile image is cosmetic
  }
  return {
    accessToken: token,
    login: valid.login,
    displayName,
    userId: valid.userId,
    profileImageUrl,
  };
}

async function userByLogin(token, login, fetchImpl) {
  const data = await helixGet(`/users?login=${encodeURIComponent(login)}`, token, fetchImpl);
  return (data.data || [])[0] || null;
}

async function broadcasterIdFor(token, login, { fetchImpl = fetch } = {}) {
  const user = await userByLogin(token, login, fetchImpl);
  return user?.id || "";
}

/**
 * The channel's current category. A live stream wins; otherwise the category
 * set on the channel (what Twitch shows while the stream is offline).
 */
async function channelCategory(token, login, { fetchImpl = fetch } = {}) {
  const user = await userByLogin(token, login, fetchImpl);
  if (!user) return { broadcasterId: "", gameName: "" };
  const streams = await helixGet(`/streams?user_id=${encodeURIComponent(user.id)}`, token, fetchImpl);
  const live = (streams.data || [])[0];
  if (live && live.game_name) return { broadcasterId: user.id, gameName: live.game_name };
  try {
    const channels = await helixGet(
      `/channels?broadcaster_id=${encodeURIComponent(user.id)}`,
      token,
      fetchImpl,
    );
    const ch = (channels.data || [])[0];
    return { broadcasterId: user.id, gameName: ch?.game_name || "" };
  } catch {
    return { broadcasterId: user.id, gameName: "" };
  }
}

/** Send one chat line as the logged-in user. Throws with Twitch's reason. */
async function sendChatMessage({ token, broadcasterId, senderId, message, fetchImpl = fetch }) {
  const text = String(message || "").trim();
  if (!text) throw new Error("Say something first");
  if (text.length > 500) throw new Error("Twitch messages are limited to 500 characters");
  const res = await fetchImpl(`${HELIX}/chat/messages`, {
    method: "POST",
    headers: { ...helixHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      message: text,
    }),
  });
  const data = await readJson(res);
  if (res.status === 401) throw new Error("Twitch login expired — connect again in Settings");
  if (!res.ok) throw new Error(data.message || `Twitch didn't accept that (${res.status})`);
  const row = (data.data || [])[0] || {};
  if (row.is_sent === false) {
    throw new Error(row.drop_reason?.message || row.drop_reason?.code || "Twitch didn't deliver that message");
  }
  return { messageId: row.message_id || "" };
}

/**
 * Watches sent messages for their public echo. Helix's message_id is the
 * same UUID the channel's IRC broadcast carries in its `id` tag, so a sent
 * message whose id comes back on the HUD's *anonymous* reader was provably
 * public — and one that never comes back was accepted by Twitch but silently
 * hidden from the channel (anti-spam shadow-hold), a failure the sender
 * cannot otherwise distinguish from success.
 */
class DeliveryWatch {
  constructor({ timeoutMs = 10000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    this.timeoutMs = timeoutMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.pending = new Map();
  }

  /** Call after a successful send; onMissing fires if no echo arrives in time. */
  expect(messageId, info, onMissing) {
    if (!messageId) return;
    this.cancel(messageId);
    const timer = this.setTimeoutImpl(() => {
      this.pending.delete(messageId);
      onMissing(info);
    }, this.timeoutMs);
    this.pending.set(messageId, { info, timer });
  }

  /** Call with every reader message id; returns the send's info on a match. */
  observe(messageId) {
    const entry = this.pending.get(messageId);
    if (!entry) return null;
    this.clearTimeoutImpl(entry.timer);
    this.pending.delete(messageId);
    return entry.info;
  }

  cancel(messageId) {
    const entry = this.pending.get(messageId);
    if (!entry) return;
    this.clearTimeoutImpl(entry.timer);
    this.pending.delete(messageId);
  }
}

module.exports = {
  CLIENT_ID,
  SCOPES,
  DeliveryWatch,
  activeTwitchChannel,
  publicTwitch,
  startDeviceFlow,
  pollDeviceToken,
  validateToken,
  identityFromToken,
  channelCategory,
  broadcasterIdFor,
  sendChatMessage,
};
