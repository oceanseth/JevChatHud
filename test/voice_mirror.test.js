const { test } = require("node:test");
const assert = require("node:assert");
const { VoiceMirror, splitSentences, packLines, MAX_IN_FLIGHT, MAX_JOBS } = require("../src/voice_mirror");
const { MaskyError, PRICING } = require("../src/masky");

test("splitSentences hands back complete sentences and keeps the fragment", () => {
  assert.deepEqual(splitSentences("Hello there. How are"), {
    sentences: ["Hello there."],
    rest: "How are",
  });
  assert.deepEqual(splitSentences("One! Two? Three."), {
    sentences: ["One!", "Two?", "Three."],
    rest: "",
  });
  assert.deepEqual(splitSentences("no end yet"), { sentences: [], rest: "no end yet" });
  // closing quotes ride along with their sentence
  assert.deepEqual(splitSentences('I said "go." then left'), {
    sentences: ['I said "go."'],
    rest: "then left",
  });
});

/**
 * A fake Masky client whose speak() resolves under test control, so render
 * completion order can be forced out of spoken order.
 */
function makeClient() {
  const calls = [];
  return {
    calls,
    speak(opts) {
      const call = { opts };
      call.promise = new Promise((resolve, reject) => {
        call.resolve = (url) => resolve({ url, line: opts.text, creditsCharged: 0.1 });
        call.reject = reject;
      });
      calls.push(call);
      return call.promise;
    },
  };
}

function makeMirror({ cfg, client }) {
  const events = { plays: [], states: [], spent: 0 };
  const mirror = new VoiceMirror({
    getConfig: () => cfg,
    onPlay: (p) => events.plays.push(p),
    onState: (s) => events.states.push(s),
    onSpent: () => events.spent++,
    client,
  });
  return { mirror, events };
}

const CFG = {
  alwaysOn: true,
  alwaysOnPersonality: false,
  alwaysOnAvatar: { avatarId: "av1", ownerUserId: "owner1", name: "Me", imageUrl: "https://img/x.png" },
  maskyToken: "mky_test",
  videoQuality: "medium",
};

const tick = () => new Promise((r) => setImmediate(r));

test("packLines keeps one breath together and splits only at the char cap", () => {
  assert.deepEqual(packLines(["No.", "I don't do drugs."]), ["No. I don't do drugs."]);
  const big = "x".repeat(300) + ".";
  assert.deepEqual(packLines([big, big]), [big, big]); // 602 chars can't be one render
  assert.deepEqual(packLines([]), []);
  // exactly at the cap still packs
  const a = "a".repeat(200) + ".";
  const b = "b".repeat(PRICING.maxChars - a.length - 2) + ".";
  assert.deepEqual(packLines([a, b]), [`${a} ${b}`]);
});

test("one turn's sentences render as a single clip", () => {
  const client = makeClient();
  const { mirror } = makeMirror({ cfg: { ...CFG }, client });
  mirror.addSpeech("No. I don't do drugs.");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].opts.text, "No. I don't do drugs.");
});

test("sentences dispatch immediately and play back in spoken order", async () => {
  const client = makeClient();
  const { mirror, events } = makeMirror({ cfg: { ...CFG }, client });

  mirror.addSpeech("First sentence.");
  mirror.addSpeech("Second sentence.");
  assert.equal(client.calls.length, 2); // both rendering at once, no waiting

  // The second render lands first — it must wait for the first to play.
  client.calls[1].resolve("url-2");
  await tick();
  assert.equal(events.plays.length, 0);

  client.calls[0].resolve("url-1");
  await tick();
  assert.equal(events.plays.length, 1);
  assert.equal(events.plays[0].url, "url-1");

  mirror.notePlaybackDone();
  assert.equal(events.plays.length, 2);
  assert.equal(events.plays[1].url, "url-2");
  assert.equal(events.spent, 2);
});

test("speak carries the avatar, quality, pinned still and literal mode", async () => {
  const client = makeClient();
  const { mirror } = makeMirror({ cfg: { ...CFG }, client });
  mirror.addSpeech("Hello world.");
  const { opts } = client.calls[0];
  assert.equal(opts.avatarId, "av1");
  assert.equal(opts.ownerUserId, "owner1");
  assert.equal(opts.text, "Hello world.");
  assert.equal(opts.output, "video");
  assert.equal(opts.quality, "medium");
  assert.equal(opts.avatarImageUrl, "https://img/x.png");
  assert.equal(opts.textMode, "literal");
});

test("the personality checkbox flips textMode", async () => {
  const client = makeClient();
  const { mirror } = makeMirror({ cfg: { ...CFG, alwaysOnPersonality: true }, client });
  mirror.addSpeech("Hello world.");
  assert.equal(client.calls[0].opts.textMode, "personality");
});

test("a trailing fragment waits for more speech instead of rendering", () => {
  const client = makeClient();
  const { mirror } = makeMirror({ cfg: { ...CFG }, client });
  mirror.addSpeech("I was thinking about");
  assert.equal(client.calls.length, 0);
  mirror.addSpeech("the game. And then");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].opts.text, "I was thinking about the game.");
  mirror.flushFragment(); // the lull timer fired: the dangling words speak too
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].opts.text, "And then");
});

test("renders cap in flight and failed renders never block the queue", async () => {
  const client = makeClient();
  const { mirror, events } = makeMirror({ cfg: { ...CFG }, client });
  for (const t of ["One.", "Two.", "Three.", "Four.", "Five."]) mirror.addSpeech(t);
  assert.equal(client.calls.length, MAX_IN_FLIGHT);
  // speech past the in-flight cap coalesced into one trailing pending job
  assert.equal(mirror.jobs.length, MAX_IN_FLIGHT + 1);
  assert.equal(mirror.jobs[MAX_IN_FLIGHT].line, "Four. Five.");

  client.calls[0].reject(new MaskyError("render failed"));
  await tick();
  // the failure freed a slot for the coalesced tail
  assert.equal(client.calls.length, MAX_IN_FLIGHT + 1);
  assert.equal(client.calls[MAX_IN_FLIGHT].opts.text, "Four. Five.");

  client.calls[1].resolve("url-two");
  await tick();
  // sentence one failed, so sentence two plays — spoken order among survivors
  assert.equal(events.plays.length, 1);
  assert.equal(events.plays[0].url, "url-two");
});

test("backpressure sheds the oldest unpaid line, never a started render", () => {
  const client = makeClient();
  const { mirror } = makeMirror({ cfg: { ...CFG }, client });
  // near-cap lines can't coalesce, so each is its own job
  const big = (i) => `Line ${i} ${"x".repeat(480)}.`;
  for (let i = 0; i < MAX_JOBS; i++) mirror.addSpeech(big(i));
  assert.equal(mirror.jobs.length, MAX_JOBS);
  const oldestPending = mirror.jobs.find((j) => j.status === "pending").line;

  mirror.addSpeech(big(99));
  assert.equal(mirror.jobs.length, MAX_JOBS);
  assert.ok(!mirror.jobs.some((j) => j.line === oldestPending));
  assert.equal(mirror.jobs[mirror.jobs.length - 1].line, big(99));
  // every started render survived
  assert.equal(mirror.jobs.filter((j) => j.status === "rendering").length, MAX_IN_FLIGHT);
});

test("inactive config ignores speech entirely", () => {
  const client = makeClient();
  const off = { ...CFG, alwaysOn: false };
  const { mirror } = makeMirror({ cfg: off, client });
  mirror.addSpeech("Hello there.");
  assert.equal(client.calls.length, 0);

  const noAvatar = { ...CFG, alwaysOnAvatar: null };
  const { mirror: m2 } = makeMirror({ cfg: noAvatar, client });
  m2.addSpeech("Hello there.");
  assert.equal(client.calls.length, 0);
});

test("stop discards the queue and orphans in-flight renders", async () => {
  const client = makeClient();
  const { mirror, events } = makeMirror({ cfg: { ...CFG }, client });
  mirror.addSpeech("One.");
  mirror.addSpeech("Two.");
  assert.equal(client.calls.length, 2);
  mirror.stop();
  assert.equal(mirror.jobs.length, 0);
  client.calls[0].resolve("url-late");
  await tick();
  assert.equal(events.plays.length, 0); // a render finishing after stop never plays
  assert.equal(mirror.rendering, 0);
});

test("errors surface in state and clear on the next success", async () => {
  const client = makeClient();
  const { mirror, events } = makeMirror({ cfg: { ...CFG }, client });
  mirror.addSpeech("One.");
  client.calls[0].reject(new MaskyError("insufficient credits", { status: 402 }));
  await tick();
  const errored = events.states[events.states.length - 1];
  assert.equal(errored.error.code, "insufficient_credits");

  mirror.addSpeech("Two.");
  client.calls[1].resolve("url-2");
  await tick();
  const after = events.states[events.states.length - 1];
  assert.equal(after.error, null);
});
