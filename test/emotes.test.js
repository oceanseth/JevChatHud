const { test } = require("node:test");
const assert = require("node:assert");
const {
  parseIrcEmotes,
  twitchEmoteUrl,
  tokenizeMessage,
  nameMapFromGroups,
  insertEmoteName,
  serializeComposeParts,
} = require("../renderer/emotes");
const { twitchMessage, parseTags } = require("../src/sources/twitch");
const { loadEmoteCatalog, collect7tv, collectBttv, collectFfz } = require("../src/emote_catalog");

test("parseIrcEmotes reads id/range pairs including repeats", () => {
  assert.deepEqual(parseIrcEmotes("25:0-4,12-16/1902:6-10"), [
    { id: "25", start: 0, end: 4 },
    { id: "1902", start: 6, end: 10 },
    { id: "25", start: 12, end: 16 },
  ]);
  assert.deepEqual(parseIrcEmotes(""), []);
  assert.deepEqual(parseIrcEmotes("emotesv2_abc:0-6"), [{ id: "emotesv2_abc", start: 0, end: 6 }]);
});

test("twitchMessage attaches IRC emote ranges from tags", () => {
  const tags = parseTags("display-name=Ada;color=#ff0000;emotes=25:6-10;id=msg1;tmi-sent-ts=1");
  const msg = twitchMessage({
    tags,
    prefix: "ada!ada@ada.tmi.twitch.tv",
    text: "hello Kappa",
    channel: "sodapoppin",
  });
  assert.equal(msg.user.name, "Ada");
  assert.equal(msg.text, "hello Kappa");
  assert.deepEqual(msg.emotes, [{ id: "25", start: 6, end: 10 }]);
  assert.equal(msg.source.label, "#sodapoppin");
});

test("tokenizeMessage paints IRC ranges as Twitch CDN images", () => {
  const segs = tokenizeMessage("hello Kappa!", [{ id: "25", start: 6, end: 10 }], new Map());
  assert.deepEqual(segs, [
    { type: "text", text: "hello " },
    { type: "emote", name: "Kappa", url: twitchEmoteUrl("25"), source: "twitch", id: "25" },
    { type: "text", text: "!" },
  ]);
});

test("tokenizeMessage replaces 7TV names like modCheck and leaves other text", () => {
  const byName = nameMapFromGroups([
    {
      id: "7tv-global",
      emotes: [{ id: "60ab", name: "modCheck", url: "https://cdn.7tv.app/emote/60ab/2x.webp", source: "7tv" }],
    },
  ]);
  const segs = tokenizeMessage("wait modCheck lol", [], byName);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].text, "wait ");
  assert.equal(segs[1].type, "emote");
  assert.equal(segs[1].name, "modCheck");
  assert.equal(segs[2].text, " lol");
});

test("tokenizeMessage does not match emote names inside words", () => {
  const byName = nameMapFromGroups([
    { emotes: [{ id: "1", name: "Pog", url: "https://x/pog", source: "7tv" }] },
  ]);
  const segs = tokenizeMessage("PogChamp", [], byName);
  assert.deepEqual(segs, [{ type: "text", text: "PogChamp" }]);
});

test("IRC ranges win over a same-named third-party emote", () => {
  const byName = nameMapFromGroups([
    { emotes: [{ id: "7", name: "Kappa", url: "https://cdn.7tv.app/emote/7/2x.webp", source: "7tv" }] },
  ]);
  const segs = tokenizeMessage("Kappa", [{ id: "25", start: 0, end: 4 }], byName);
  assert.equal(segs[0].url, twitchEmoteUrl("25"));
  assert.equal(segs[0].source, "twitch");
});

test("nameMapFromGroups keeps the first (channel) hit", () => {
  const map = nameMapFromGroups([
    { emotes: [{ id: "ch", name: "catJAM", url: "https://channel", source: "7tv" }] },
    { emotes: [{ id: "g", name: "catJAM", url: "https://global", source: "7tv" }] },
  ]);
  assert.equal(map.get("catJAM").url, "https://channel");
});

test("insertEmoteName pads with spaces around the caret", () => {
  assert.deepEqual(insertEmoteName("hello", "modCheck", 5, 5), {
    value: "hello modCheck",
    caret: 14,
  });
  assert.deepEqual(insertEmoteName("hello ", "modCheck", 6, 6), {
    value: "hello modCheck",
    caret: 14,
  });
  assert.deepEqual(insertEmoteName("ab", "Kappa", 1, 1), {
    value: "a Kappa b",
    caret: 8,
  });
});

test("serializeComposeParts flattens the rich composer to wire text", () => {
  // plain text passes through untouched
  assert.equal(serializeComposeParts([{ type: "text", text: "hello there" }]), "hello there");
  // emote names get forced whitespace boundaries so they stay tokens
  assert.equal(
    serializeComposeParts([
      { type: "text", text: "gg" },
      { type: "emote", name: "Clap2" },
      { type: "text", text: "wow" },
    ]),
    "gg Clap2 wow",
  );
  // existing whitespace is respected — no double spaces
  assert.equal(
    serializeComposeParts([
      { type: "text", text: "gg " },
      { type: "emote", name: "Clap2" },
      { type: "text", text: " wow" },
    ]),
    "gg Clap2 wow",
  );
  // consecutive emotes, leading emote, trailing emote
  assert.equal(
    serializeComposeParts([
      { type: "emote", name: "Kappa" },
      { type: "emote", name: "modCheck" },
    ]),
    "Kappa modCheck",
  );
  // blank text and nameless emotes are skipped
  assert.equal(
    serializeComposeParts([
      { type: "text", text: "" },
      { type: "emote", name: "  " },
      { type: "emote", name: "Kappa" },
    ]),
    "Kappa",
  );
  assert.equal(serializeComposeParts([]), "");
  assert.equal(serializeComposeParts(null), "");
});

test("collectors map 7TV/BTTV/FFZ payloads to CDN urls", () => {
  const stv = collect7tv(
    { emotes: [{ id: "set1", name: "modCheck", data: { id: "60abf171870d317bef23d399" } }] },
    "7tv",
  );
  assert.equal(stv[0].name, "modCheck");
  assert.equal(stv[0].url, "https://cdn.7tv.app/emote/60abf171870d317bef23d399/2x.webp");

  const bttv = collectBttv([{ id: "abc", code: "catJAM", imageType: "gif" }], "bttv");
  assert.equal(bttv[0].url, "https://cdn.betterttv.net/emote/abc/2x");

  const ffz = collectFfz(
    { sets: { "1": { emoticons: [{ id: 9, name: "OMEGALUL", urls: { "2": "//cdn.frankerfacez.com/emote/9/2" } }] } } },
    "ffz",
    { allSets: true },
  );
  assert.equal(ffz[0].url, "https://cdn.frankerfacez.com/emote/9/2");
});

test("loadEmoteCatalog still returns globals when a channel host 404s", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("emote-sets/global")) {
      return {
        ok: true,
        json: async () => ({ emotes: [{ name: "glorp", data: { id: "60ab" } }] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const catalog = await loadEmoteCatalog({ channel: "nobody", fetchImpl });
  assert.equal(catalog.channel, "nobody");
  const names = nameMapFromGroups(catalog.groups);
  assert.equal(names.get("glorp").source, "7tv");
});

test("loadEmoteCatalog paints channel 7TV names without a Twitch login", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("api.ivr.fi")) {
      return { ok: true, json: async () => [{ id: "26301881", login: "sodapoppin" }] };
    }
    if (url.includes("7tv.io/v3/users/twitch/26301881")) {
      return {
        ok: true,
        json: async () => ({
          emote_set: {
            emotes: [{ name: "modCheck", data: { id: "01F6FTE8B80008E39HFFQJ7MWS" } }],
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const catalog = await loadEmoteCatalog({ channel: "sodapoppin", fetchImpl });
  const names = nameMapFromGroups(catalog.groups);
  assert.equal(names.get("modCheck").url, "https://cdn.7tv.app/emote/01F6FTE8B80008E39HFFQJ7MWS/2x.webp");
  assert.equal(names.get("modCheck").source, "7tv");
});

test("loadEmoteCatalog maps Helix global and channel emotes when a token is present", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/helix/users?login=")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "42" }] }) };
    }
    if (url.includes("/helix/chat/emotes/global")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "25", name: "Kappa", images: { url_2x: "https://static-cdn.jtvnw.net/kappa" }, format: ["static"] }],
        }),
      };
    }
    if (url.includes("/helix/chat/emotes?broadcaster_id=")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "99", name: "coolCat", format: ["animated"] }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const catalog = await loadEmoteCatalog({ channel: "soda", token: "tok", fetchImpl });
  const names = nameMapFromGroups(catalog.groups);
  assert.equal(names.get("coolCat").url, "https://static-cdn.jtvnw.net/emoticons/v2/99/animated/dark/2.0");
  assert.equal(names.get("Kappa").source, "twitch");
});
