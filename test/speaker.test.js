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
  speaker.noteJudged({ username: "a", platform: "twitch", text: "meh" }, { relevancy: 10, kind: "chatter" });
  speaker.noteJudged({ username: "b", platform: "twitch", text: "good q" }, { relevancy: 80, kind: "question" });
  speaker.noteJudged({ username: "c", platform: "twitch", text: "slur" }, { relevancy: 95, kind: "toxic" });
  speaker.noteJudged({ username: "d", platform: "twitch", text: "late tie" }, { relevancy: 80, kind: "question" });
  // ties go to the newest message
  assert.equal(speaker.candidate.username, "d");
  speaker.stop();
});

test("candidates are ignored while stopped", () => {
  const { speaker } = makeSpeaker({ cfg: { ...baseCfg, enabled: false }, client: fakeClient() });
  speaker.start(); // enabled=false -> no timer
  assert.equal(speaker.running, false);
  speaker.noteJudged({ username: "a", platform: "t", text: "x" }, { relevancy: 99, kind: "question" });
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
  speaker.noteJudged({ username: "viewer1", platform: "twitch", text: "is this the new patch?" }, { relevancy: 70, kind: "question" });
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
  speaker.noteJudged({ username: "a", platform: "t", text: "x" }, { relevancy: 50, kind: "question" });
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
  speaker.noteJudged({ username: "a", platform: "t", text: "x" }, { relevancy: 50, kind: "question" });
  await speaker.tick();
  assert.ok(Math.abs(speaker.balance - 0.9) < 1e-9);
  speaker.stop();
});
