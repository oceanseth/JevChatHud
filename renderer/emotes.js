// Twitch + third-party emote parsing, kept isomorphic so the renderer and
// tests share the same rules. Catalog fetching (network) lives in src/.
//
// Incoming Twitch IRC already tells us official emote ranges (`emotes` tag).
// Everything else — 7TV (modCheck), BTTV, FFZ, and the picker — is a name
// lookup against the catalog main pushes down.

function twitchEmoteUrl(id, format = "default") {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(String(id))}/${format}/dark/2.0`;
}

/** IRCv3 `emotes` tag → [{id, start, end}] sorted by start. End is inclusive. */
function parseIrcEmotes(raw) {
  if (!raw) return [];
  const out = [];
  for (const part of String(raw).split("/")) {
    if (!part) continue;
    const colon = part.indexOf(":");
    if (colon < 1) continue;
    const id = part.slice(0, colon);
    for (const range of part.slice(colon + 1).split(",")) {
      const dash = range.indexOf("-");
      if (dash < 0) continue;
      const start = Number(range.slice(0, dash));
      const end = Number(range.slice(dash + 1));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start < 0) continue;
      out.push({ id, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

function nameMapFromGroups(groups) {
  const map = new Map();
  for (const group of groups || []) {
    for (const emote of group.emotes || []) {
      if (emote?.name && emote.url && !map.has(emote.name)) map.set(emote.name, emote);
    }
  }
  return map;
}

function pushTextSegments(segments, text, byName) {
  if (!text) return;
  if (!byName || byName.size === 0) {
    segments.push({ type: "text", text });
    return;
  }
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    const emote = !/^\s+$/.test(part) ? byName.get(part) : null;
    if (emote) {
      segments.push({
        type: "emote",
        name: emote.name,
        url: emote.url,
        source: emote.source,
        id: emote.id,
      });
    } else {
      const prev = segments[segments.length - 1];
      if (prev && prev.type === "text") prev.text += part;
      else segments.push({ type: "text", text: part });
    }
  }
}

/**
 * Split a chat line into text/emote runs.
 * IRC ranges (Twitch official) win; remaining whole tokens look up `byName`
 * (7TV / BTTV / FFZ / Helix). Positions are Unicode code points, matching TMI.
 */
function tokenizeMessage(text, ircEmotes, byName) {
  const chars = [...String(text || "")];
  const segments = [];
  const ranges = [...(ircEmotes || [])].filter(
    (e) => e && Number.isFinite(e.start) && Number.isFinite(e.end) && e.end >= e.start && e.start < chars.length,
  );
  let i = 0;
  for (const em of ranges) {
    if (em.start < i) continue;
    pushTextSegments(segments, chars.slice(i, em.start).join(""), byName);
    const name = chars.slice(em.start, em.end + 1).join("");
    segments.push({
      type: "emote",
      name,
      url: twitchEmoteUrl(em.id),
      source: "twitch",
      id: em.id,
    });
    i = em.end + 1;
  }
  pushTextSegments(segments, chars.slice(i).join(""), byName);
  return segments;
}

/**
 * Flatten the rich composer back to the wire text Twitch expects.
 * Parts are {type:"text", text} | {type:"emote", name} in document order.
 * Emote names must stay whitespace-separated tokens or other clients render
 * them as plain text, so boundaries are forced even when the user typed
 * flush against an emote image.
 */
function serializeComposeParts(parts) {
  let out = "";
  let needsBoundary = false;
  for (const part of parts || []) {
    if (part?.type === "emote") {
      const name = String(part.name || "").trim();
      if (!name) continue;
      if (out && !/\s$/.test(out)) out += " ";
      out += name;
      needsBoundary = true;
    } else if (part?.type === "text") {
      const text = String(part.text || "");
      if (!text) continue;
      if (needsBoundary && !/^\s/.test(text)) out += " ";
      out += text;
      needsBoundary = false;
    }
  }
  return out;
}

/** Insert an emote code at a caret range, with surrounding spaces. */
function insertEmoteName(value, emoteName, start, end) {
  const src = String(value || "");
  const name = String(emoteName || "").trim();
  if (!name) return { value: src, caret: src.length };
  const from = Math.max(0, Math.min(start ?? src.length, src.length));
  const to = Math.max(from, Math.min(end ?? from, src.length));
  const before = src.slice(0, from);
  const after = src.slice(to);
  const padLeft = before && !/\s$/.test(before) ? " " : "";
  const padRight = after && !/^\s/.test(after) ? " " : "";
  const inserted = padLeft + name + padRight;
  return { value: before + inserted + after, caret: (before + inserted).length };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    twitchEmoteUrl,
    parseIrcEmotes,
    nameMapFromGroups,
    tokenizeMessage,
    insertEmoteName,
    serializeComposeParts,
  };
}
