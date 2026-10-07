const { test } = require("node:test");
const assert = require("node:assert");
const { speakableLine, lineCost, talkingMinutes, PRICING, MaskyError } = require("../src/masky");
const { Speaker, INTERVALS_MIN } = require("../src/speaker");

test("speakableLine collapses whitespace and respects the server max", () => {
  assert.equal(speakableLine("  hello   world \n"), "hello world");
  const long = "x".repeat(900);
  const line = speakableLine(long);
  assert.ok(line.length <= PRICING.maxChars);
  assert.ok(line.endsWith("…"));
});

test("lineCost matches masky's turnCost formula", () => {
  // 30 chars -> 2 estimated seconds -> flat + 2 * perSecond
  assert.ok(Math.abs(lineCost("x".repeat(30)) - (0.001 + 2 * 0.0265)) < 1e-9);
  // minimum of 1 second
  assert.ok(Math.abs(lineCost("hi") - (0.001 + 0.0265)) < 1e-9);
});

test("talkingMinutes converts balance to whole minutes of video", () => {
  assert.equal(talkingMinutes(0), 0);
  assert.equal(talkingMinutes(null), 0);
  // 1 credit ≈ 37s of video -> 0 whole minutes; 2 credits -> 1 minute
  assert.equal(talkingMinutes(1), 0);
  assert.equal(talkingMinutes(2), 1);
  assert.equal(talkingMinutes(1.59), 1);
});

test("supported intervals are exactly 1, 5, 10 minutes", () => {
  assert.deepEqual(INTERVALS_MIN, [1, 5, 10]);
});

function makeSpeaker({ cfg, client }) {
  const events = { plays: [], states: [], errors: [] };
  const speaker = new Speaker({
    getConfig: () => cfg,
    onPlay: (p) => events.plays.push(p),
    onState: (s) => events.states.push(s),
    onError: (e) => events.errors.push(e),
    client,
  });
  return { speaker, events };
}

const baseCfg = {
  enabled: true,
  intervalMin: 1,
  maskyToken: "mky_test",
  avatarOwnerUserId: "twitch:11867613",
  avatarId: "Ev1WizD5smJnxHWJXEHZ",
};

const fakeClient = (overrides = {}) => ({
  speak: async ({ text }) => ({ url: "https://signed/video.mp4", line: text, creditsCharged: 0.1 }),
  balance: async () => 5,
  ...overrides,
});

test("speaker keeps the best candidate and never reads toxic messages", () => {
  const { speaker } = makeSpeaker({ cfg: baseCfg, client: fakeClient() });
  speaker.start();
  speaker.noteJudged({ user: { name: "a" }, source: { type: "twitch" }, text: "meh" }, { relevancy: 10, kind: "chatter" });
  speaker.noteJudged({ user: { name: "b" }, source: { type: "twitch" }, text: "good q" }, { relevancy: 80, kind: "question" });
  speaker.noteJudged({ user: { name: "c" }, source: { type: "twitch" }, text: "slur" }, { relevancy: 95, kind: "toxic" });
  speaker.noteJudged({ user: { name: "d" }, source: { type: "twitch" }, text: "late tie" }, { relevancy: 80, kind: "question" });
  // ties go to the newest message
  assert.equal(speaker.candidate.username, "d");
  speaker.stop();
});

test("a candidate missing its user name never reads 'undefined says'", () => {
  const { speaker } = makeSpeaker({ cfg: baseCfg, client: fakeClient() });
  speaker.start();
  speaker.noteJudged({ text: "who made this?" }, { relevancy: 60, kind: "question" });
  assert.equal(speaker.candidate.username, "a viewer");
  assert.equal(speaker.compose(speaker.candidate), "a viewer says: who made this?");
  speaker.stop();
});

test("candidates are ignored while stopped", () => {
  const { speaker } = makeSpeaker({ cfg: { ...baseCfg, enabled: false }, client: fakeClient() });
  speaker.start(); // enabled=false -> no timer
  assert.equal(speaker.running, false);
  speaker.noteJudged({ user: { name: "a" }, source: { type: "t" }, text: "x" }, { relevancy: 99, kind: "question" });
  assert.equal(speaker.candidate, null);
});

test("tick renders the candidate, prefixes the author, and clears the window", async () => {
  const spoken = [];
  const client = fakeClient({
    speak: async ({ text, ownerUserId, avatarId }) => {
      spoken.push({ text, ownerUserId, avatarId });
      return { url: "https://signed/v.mp4", line: text, creditsCharged: 0.1 };
    },
  });
  const { speaker, events } = makeSpeaker({ cfg: baseCfg, client });
  speaker.start();
  speaker.noteJudged({ user: { name: "viewer1" }, source: { type: "twitch" }, text: "is this the new patch?" }, { relevancy: 70, kind: "question" });
  const url = await speaker.tick();
  assert.equal(url, "https://signed/v.mp4");
  assert.equal(spoken[0].text, "viewer1 says: is this the new patch?");
  assert.equal(spoken[0].ownerUserId, baseCfg.avatarOwnerUserId);
  assert.equal(spoken[0].avatarId, baseCfg.avatarId);
  assert.equal(events.plays.length, 1);
  assert.equal(speaker.candidate, null);
  // empty window -> next tick skips without rendering
  assert.equal(await speaker.tick(), null);
  assert.equal(spoken.length, 1);
  speaker.stop();
});

test("forced tick (test button) renders a greeting with an empty window", async () => {
  const { speaker, events } = makeSpeaker({ cfg: baseCfg, client: fakeClient() });
  speaker.start();
  const url = await speaker.tick({ force: true });
  assert.ok(url);
  assert.equal(events.plays.length, 1);
  speaker.stop();
});

test("insufficient credits surfaces the balance from the 402 and errors out", async () => {
  const client = fakeClient({
    speak: async () => {
      throw new MaskyError("Not enough credits", { status: 402, availableCredits: 0.01, requiredCredits: 0.05 });
    },
    balance: async () => null,
  });
  const { speaker, events } = makeSpeaker({ cfg: baseCfg, client });
  speaker.start();
  speaker.noteJudged({ user: { name: "a" }, source: { type: "t" }, text: "x" }, { relevancy: 50, kind: "question" });
  const url = await speaker.tick();
  assert.equal(url, null);
  assert.equal(events.errors[0].code, "insufficient_credits");
  assert.equal(speaker.balance, 0.01);
  speaker.stop();
});

test("successful render decrements the local balance by creditsCharged", async () => {
  const { speaker } = makeSpeaker({
    cfg: baseCfg,
    client: fakeClient({ balance: async () => null }), // no balance endpoint yet
  });
  speaker.start();
  speaker.balance = 1.0;
  speaker.noteJudged({ user: { name: "a" }, source: { type: "t" }, text: "x" }, { relevancy: 50, kind: "question" });
  await speaker.tick();
  assert.ok(Math.abs(speaker.balance - 0.9) < 1e-9);
  speaker.stop();
});

test("audio-only mode renders output:audio and flags the play payload", async () => {
  const spoken = [];
  const client = fakeClient({
    speak: async ({ text, output }) => {
      spoken.push({ text, output });
      return { url: "https://signed/a.mp3", line: text, creditsCharged: 0.01 };
    },
  });
  const { speaker, events } = makeSpeaker({ cfg: { ...baseCfg, audioOnly: true }, client });
  speaker.start();
  speaker.noteJudged({ user: { name: "v" }, source: { type: "twitch" }, text: "hey" }, { relevancy: 60, kind: "chatter" });
  await speaker.tick();
  assert.equal(spoken[0].output, "audio");
  assert.equal(events.plays[0].audio, true);
  assert.equal(events.plays[0].url, "https://signed/a.mp3");
  speaker.stop();
});

test("video mode keeps output:video and audio:false", async () => {
  const spoken = [];
  const client = fakeClient({
    speak: async ({ text, output }) => {
      spoken.push({ output });
      return { url: "https://signed/v.mp4", line: text, creditsCharged: 0.1 };
    },
  });
  const { speaker, events } = makeSpeaker({ cfg: baseCfg, client });
  speaker.start();
  speaker.noteJudged({ user: { name: "v" }, source: { type: "twitch" }, text: "hey" }, { relevancy: 60, kind: "chatter" });
  await speaker.tick();
  assert.equal(spoken[0].output, "video");
  assert.equal(events.plays[0].audio, false);
  speaker.stop();
});

test("speak-latest reads a new message immediately while idle", async () => {
  const spoken = [];
  const client = fakeClient({
    speak: async ({ text }) => {
      spoken.push(text);
      return { url: "https://signed/v.mp4", line: text, creditsCharged: 0.1 };
    },
  });
  const { speaker } = makeSpeaker({ cfg: { ...baseCfg, speakLatest: true }, client });
  speaker.start();
  speaker.noteJudged({ id: "m1", user: { name: "v1" }, source: { type: "twitch" }, text: "first" }, { relevancy: 10, kind: "chatter" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(spoken, ["v1 says: first"]);
  speaker.stop();
});

test("speak-latest waits for playback, then chains to the newest unspoken message", async () => {
  const spoken = [];
  const client = fakeClient({
    speak: async ({ text }) => {
      spoken.push(text);
      return { url: "https://signed/v.mp4", line: text, creditsCharged: 0.1 };
    },
  });
  const { speaker } = makeSpeaker({ cfg: { ...baseCfg, speakLatest: true }, client });
  speaker.start();
  speaker.noteJudged({ id: "m1", user: { name: "v1" }, source: { type: "twitch" }, text: "first" }, { relevancy: 10, kind: "chatter" });
  await new Promise((r) => setImmediate(r));
  assert.equal(speaker.playing, true);
  // two more land while the first is still playing — only the newest survives
  speaker.noteJudged({ id: "m2", user: { name: "v2" }, source: { type: "twitch" }, text: "second" }, { relevancy: 10, kind: "chatter" });
  speaker.noteJudged({ id: "m3", user: { name: "v3" }, source: { type: "twitch" }, text: "third" }, { relevancy: 10, kind: "chatter" });
  assert.deepEqual(spoken, ["v1 says: first"]);
  speaker.notePlaybackDone();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(spoken, ["v1 says: first", "v3 says: third"]);
  // playback of m3 ends with nothing new -> stays silent (no re-read)
  speaker.notePlaybackDone();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(spoken, ["v1 says: first", "v3 says: third"]);
  speaker.stop();
});

test("speak-latest never reads toxic messages and dedupes by message id", async () => {
  const spoken = [];
  const client = fakeClient({
    speak: async ({ text }) => {
      spoken.push(text);
      return { url: "https://signed/v.mp4", line: text, creditsCharged: 0.1 };
    },
  });
  const { speaker } = makeSpeaker({ cfg: { ...baseCfg, speakLatest: true }, client });
  speaker.start();
  speaker.noteJudged({ id: "m1", user: { name: "v" }, source: { type: "twitch" }, text: "slur" }, { relevancy: 90, kind: "toxic" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(spoken, []);
  speaker.noteJudged({ id: "m2", user: { name: "v" }, source: { type: "twitch" }, text: "ok" }, { relevancy: 10, kind: "chatter" });
  await new Promise((r) => setImmediate(r));
  speaker.notePlaybackDone();
  // the same judged message arriving again is never re-read
  speaker.noteJudged({ id: "m2", user: { name: "v" }, source: { type: "twitch" }, text: "ok" }, { relevancy: 10, kind: "chatter" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(spoken, ["v says: ok"]);
  speaker.stop();
});

test("the cadence tick is inert in speak-latest mode", async () => {
  const spoken = [];
  const client = fakeClient({
    speak: async ({ text }) => {
      spoken.push(text);
      return { url: "https://signed/v.mp4", line: text, creditsCharged: 0.1 };
    },
  });
  const { speaker } = makeSpeaker({ cfg: { ...baseCfg, speakLatest: true }, client });
  speaker.start();
  speaker.playing = true; // mid-playback: a cadence tick must not double-read
  speaker.noteJudged({ id: "m1", user: { name: "v" }, source: { type: "twitch" }, text: "x" }, { relevancy: 99, kind: "question" });
  assert.equal(await speaker.tick(), null);
  assert.deepEqual(spoken, []);
  speaker.stop();
});

test("talkingMinutes uses the cheaper audio rate for audio-only balances", () => {
  // 1 credit: 0 whole minutes of video, but 11 minutes of audio (0.0015/s)
  assert.equal(talkingMinutes(1), 0);
  assert.equal(talkingMinutes(1, "audio"), 11);
});

test("read with user avatars: a chatter on Masky reads their own message, verbatim", async () => {
  const speaks = [];
  const lookups = [];
  const client = fakeClient({
    speak: async (args) => {
      speaks.push(args);
      return { url: "https://signed/v.mp4", line: args.text, creditsCharged: 0.1 };
    },
    lookupUserAvatar: async (_t, name) => {
      lookups.push(name);
      return name === "chatfan" ? { ownerUserId: "twitch:42", avatarId: "self", name: "ChatFan" } : null;
    },
  });
  const cfg = { ...baseCfg, readUserAvatars: true };
  const { speaker, events } = makeSpeaker({ cfg, client });
  speaker.start();
  speaker.noteJudged(
    { id: "m1", user: { name: "ChatFan" }, source: { type: "twitch" }, text: "great run!" },
    { relevancy: 80, kind: "chatter" },
  );
  await speaker.tick();
  // their avatar, their words — no "ChatFan says:" preamble
  assert.equal(speaks.length, 1);
  assert.equal(speaks[0].avatarId, "self");
  assert.equal(speaks[0].ownerUserId, "twitch:42");
  assert.equal(speaks[0].text, "great run!");
  assert.deepEqual(lookups, ["chatfan"]);
  // the HUD caption still names the chatter
  assert.equal(events.plays[0].username, "ChatFan");
  speaker.stop();
});

test("read with user avatars: chatters not on Masky fall back to the configured avatar + preamble", async () => {
  const speaks = [];
  const client = fakeClient({
    speak: async (args) => {
      speaks.push(args);
      return { url: "u", line: args.text, creditsCharged: 0 };
    },
    lookupUserAvatar: async () => null,
  });
  const { speaker } = makeSpeaker({ cfg: { ...baseCfg, readUserAvatars: true }, client });
  speaker.start();
  speaker.noteJudged(
    { id: "m2", user: { name: "rando" }, source: { type: "twitch" }, text: "hi" },
    { relevancy: 50, kind: "chatter" },
  );
  await speaker.tick();
  assert.equal(speaks[0].avatarId, baseCfg.avatarId);
  assert.equal(speaks[0].text, "rando says: hi");
  speaker.stop();
});

test("read with user avatars: lookups are cached per username, negatives included", async () => {
  let lookups = 0;
  const client = fakeClient({
    lookupUserAvatar: async () => {
      lookups++;
      return null;
    },
  });
  const { speaker } = makeSpeaker({ cfg: { ...baseCfg, readUserAvatars: true }, client });
  speaker.start();
  for (const id of ["a1", "a2", "a3"]) {
    speaker.noteJudged(
      { id, user: { name: "Regular" }, source: { type: "twitch" }, text: `msg ${id}` },
      { relevancy: 60, kind: "chatter" },
    );
    await speaker.tick();
  }
  assert.equal(lookups, 1);
  speaker.stop();
});

test("read with user avatars: a failed lookup falls back instead of killing the reading", async () => {
  const speaks = [];
  const client = fakeClient({
    speak: async (args) => {
      speaks.push(args);
      return { url: "u", line: args.text, creditsCharged: 0 };
    },
    lookupUserAvatar: async () => {
      throw new Error("masky 500");
    },
  });
  const { speaker, events } = makeSpeaker({ cfg: { ...baseCfg, readUserAvatars: true }, client });
  speaker.start();
  speaker.noteJudged(
    { id: "m3", user: { name: "x" }, source: { type: "twitch" }, text: "yo" },
    { relevancy: 70, kind: "chatter" },
  );
  await speaker.tick();
  assert.equal(events.errors.length, 0);
  assert.equal(speaks[0].avatarId, baseCfg.avatarId);
  speaker.stop();
});

test("read with user avatars: the test greeting never triggers a lookup", async () => {
  let lookups = 0;
  const client = fakeClient({
    lookupUserAvatar: async () => {
      lookups++;
      return { ownerUserId: "u", avatarId: "a" };
    },
  });
  const { speaker } = makeSpeaker({ cfg: { ...baseCfg, readUserAvatars: true }, client });
  speaker.start();
  await speaker.tick({ force: true });
  assert.equal(lookups, 0);
  speaker.stop();
});
