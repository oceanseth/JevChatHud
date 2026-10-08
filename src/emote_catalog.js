// Load the emote catalog the HUD uses to paint 7TV/BTTV/FFZ names as images
// and to fill the composer picker. Twitch-official emotes in *incoming* IRC
// don't need this (the `emotes` tag has ids); Helix is only for the picker
// plus name lookup when a logged-in user is present.
const { broadcasterIdFor, helixGet } = require("./twitch_auth");

const UA = { "user-agent": "JevChatHud/0.2 (emotes)" };

function emptyCatalog(channel = "") {
  return { channel, groups: [] };
}

async function readJson(url, fetchImpl, extraHeaders) {
  const res = await fetchImpl(url, { headers: { ...UA, ...(extraHeaders || {}) } });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

function settled(promise) {
  return promise.then((value) => ({ ok: true, value })).catch((err) => ({ ok: false, err }));
}

function asHttps(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

function collect7tv(set, source) {
  const emotes = [];
  for (const item of set?.emotes || []) {
    const id = item.data?.id || item.id;
    const name = item.name;
    if (!id || !name) continue;
    emotes.push({ id: String(id), name, url: `https://cdn.7tv.app/emote/${id}/2x.webp`, source });
  }
  return emotes;
}

function collectBttv(list, source) {
  const emotes = [];
  for (const row of list || []) {
    if (!row?.id || !row.code) continue;
    emotes.push({
      id: String(row.id),
      name: row.code,
      url: `https://cdn.betterttv.net/emote/${row.id}/2x`,
      source,
    });
  }
  return emotes;
}

function collectFfz(payload, source, { allSets = false } = {}) {
  const emotes = [];
  const seen = new Set();
  const sets = payload?.sets || {};
  const keys = allSets || !payload?.default_sets ? Object.keys(sets) : payload.default_sets.map(String);
  for (const key of keys) {
    const set = sets[key] || sets[String(key)];
    for (const row of set?.emoticons || []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const url = asHttps(row.urls?.["2"] || row.urls?.["1"] || row.urls?.["4"] || "");
      if (!row.name || !url) continue;
      emotes.push({ id: String(row.id), name: row.name, url, source });
    }
  }
  return emotes;
}

function helixEmote(row) {
  const animated = (row.format || []).includes("animated");
  const url = animated
    ? `https://static-cdn.jtvnw.net/emoticons/v2/${row.id}/animated/dark/2.0`
    : row.images?.url_2x || `https://static-cdn.jtvnw.net/emoticons/v2/${row.id}/default/dark/2.0`;
  return { id: String(row.id), name: row.name, url, source: "twitch" };
}

async function helixEmotes(token, { broadcasterId, fetchImpl }) {
  if (!token) return { global: [], channel: [] };
  const global = await helixGet("/chat/emotes/global", token, fetchImpl);
  let channel = { data: [] };
  if (broadcasterId) {
    try {
      channel = await helixGet(`/chat/emotes?broadcaster_id=${encodeURIComponent(broadcasterId)}`, token, fetchImpl);
    } catch {
      channel = { data: [] };
    }
  }
  return {
    global: (global.data || []).filter((r) => r?.id && r.name).map(helixEmote),
    channel: (channel.data || []).filter((r) => r?.id && r.name).map(helixEmote),
  };
}

async function twitchIdFromIvr(login, fetchImpl) {
  const data = await readJson(
    `https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(login)}`,
    fetchImpl,
  );
  const row = Array.isArray(data) ? data[0] : data;
  return row?.id ? String(row.id) : "";
}

/**
 * Fetch every provider we can. One failing host must not blank the catalog.
 * Group order is paint-and-picker priority: channel sets beat globals.
 */
async function loadEmoteCatalog({
  channel = "",
  token = "",
  fetchImpl = fetch,
} = {}) {
  const login = String(channel || "").replace(/^#/, "").trim().toLowerCase();
  const groups = [];

  const global7 = settled(readJson("https://7tv.io/v3/emote-sets/global", fetchImpl));
  const globalBttv = settled(readJson("https://api.betterttv.net/3/cached/emotes/global", fetchImpl));
  const globalFfz = settled(readJson("https://api.frankerfacez.com/v1/set/global", fetchImpl));
  const roomFfz = login
    ? settled(readJson(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(login)}`, fetchImpl))
    : Promise.resolve({ ok: false, value: null });
  const helixId = token && login
    ? settled(broadcasterIdFor(token, login, { fetchImpl }))
    : Promise.resolve({ ok: false, value: "" });

  const [g7, gBttv, gFfz, room, helixUser] = await Promise.all([
    global7, globalBttv, globalFfz, roomFfz, helixId,
  ]);

  let twitchId = helixUser.ok ? helixUser.value : "";
  if (!twitchId && room.ok) twitchId = room.value?.room?.twitch_id ? String(room.value.room.twitch_id) : "";
  if (!twitchId && login) {
    const ivr = await settled(twitchIdFromIvr(login, fetchImpl));
    if (ivr.ok) twitchId = ivr.value;
  }

  const channel7 = twitchId
    ? settled(readJson(`https://7tv.io/v3/users/twitch/${encodeURIComponent(twitchId)}`, fetchImpl))
    : Promise.resolve({ ok: false, value: null });
  const channelBttv = twitchId
    ? settled(readJson(`https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(twitchId)}`, fetchImpl))
    : Promise.resolve({ ok: false, value: null });
  const helix = settled(helixEmotes(token, { broadcasterId: twitchId, fetchImpl }));

  const [c7, cBttv, hx] = await Promise.all([channel7, channelBttv, helix]);

  function add(id, label, emotes) {
    if (emotes?.length) groups.push({ id, label, emotes });
  }

  if (c7.ok) add("7tv-channel", "Channel · 7TV", collect7tv(c7.value?.emote_set, "7tv"));
  if (cBttv.ok) {
    add("bttv-channel", "Channel · BTTV", [
      ...collectBttv(cBttv.value?.channelEmotes, "bttv"),
      ...collectBttv(cBttv.value?.sharedEmotes, "bttv"),
    ]);
  }
  if (room.ok) add("ffz-channel", "Channel · FFZ", collectFfz(room.value, "ffz", { allSets: true }));
  if (hx.ok) add("twitch-channel", "Channel · Twitch", hx.value.channel);
  if (hx.ok) add("twitch-global", "Twitch", hx.value.global);
  if (g7.ok) add("7tv-global", "7TV", collect7tv(g7.value, "7tv"));
  if (gBttv.ok) add("bttv-global", "BTTV", collectBttv(gBttv.value, "bttv"));
  if (gFfz.ok) add("ffz-global", "FFZ", collectFfz(gFfz.value, "ffz"));

  return { channel: login, groups };
}

module.exports = {
  emptyCatalog,
  loadEmoteCatalog,
  collect7tv,
  collectBttv,
  collectFfz,
};
