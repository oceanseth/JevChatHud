const { test } = require("node:test");
const assert = require("node:assert");
const { Judge, RELEVANCE_LEVELS, KIND_CRITERIA } = require("../src/judge");
const { Settings } = require("../src/settings");
const fs = require("fs");
const os = require("os");
const path = require("path");

function makeJudge(overrides = {}) {
  return new Judge({
    getConfig: () => ({ typesafeApiKey: "test", model: "jev-latest" }),
    getProfile: () => ({ name: "test", context: "Playing chess." }),
    onJudged: () => {},
    onStats: () => {},
    ...overrides,
  });
}

function msg(id, text, user = "viewer") {
  return { id, text, user: { name: user }, source: { type: "twitch", label: "#chan" }, ts: Date.now() };
}

test("buildRequest asks one Score and one Choice per message", () => {
  const judge = makeJudge();
  const batch = [msg("a", "hi"), msg("b", "your audio is dead!")];
  const { state, questions } = judge.buildRequest(batch);

  assert.equal(state.messages.length, 2);
  assert.equal(state.stream_context, "Playing chess.");
  assert.deepEqual(Object.keys(questions).sort(), ["m0_kind", "m0_relevance", "m1_kind", "m1_relevance"]);
  // Score criteria are the ordered relevance levels, Choice criteria the kinds
  assert.equal(questions.m0_relevance.criteria.length, RELEVANCE_LEVELS.length);
  assert.deepEqual(Object.keys(questions.m1_kind.criteria), Object.keys(KIND_CRITERIA));
  // instructions reference the right state path
  assert.match(questions.m1_relevance.instructions, /`messages\[1\]`/);
});

test("judgeBatch maps answers back to message ids and normalizes score", async () => {
  const judged = {};
  const judge = makeJudge({ onJudged: (id, j) => (judged[id] = j) });
  judge.client = {
    systemOne: async ({ questions }) => {
      assert.equal(Object.keys(questions).length, 4);
      return {
        model: "jev-1.13.0",
        answers: {
          m0_relevance: { type: "score", score: 0.3, confidence: 0.9 },
          m0_kind: { type: "choice", choice: "chatter", confidence: 0.8 },
          m1_relevance: { type: "score", score: 3, confidence: 0.95 },
          m1_kind: { type: "choice", choice: "stream_issue", confidence: 0.97 },
        },
        usage: { input_tokens: 500, output_tokens: 8 },
      };
    },
  };
  await judge.judgeBatch([msg("a", "lol"), msg("b", "NO AUDIO")]);

  assert.equal(judged.a.relevancy, 10); // 0.3/3 * 100
  assert.equal(judged.a.kind, "chatter");
  assert.equal(judged.b.relevancy, 100); // 3/3 * 100
  assert.equal(judged.b.kind, "stream_issue");
  assert.equal(judge.stats.inputTokens, 500);
  assert.ok(judge.stats.costUsd > 0);
});

test("judgeBatch without api key marks messages unjudged", async () => {
  const judged = {};
  const judge = makeJudge({
    getConfig: () => ({ typesafeApiKey: "" }),
    onJudged: (id, j) => (judged[id] = j),
  });
  await judge.judgeBatch([msg("a", "hello")]);
  assert.equal(judged.a, null);
  assert.match(judge.stats.lastError, /no TypeSafe API key/);
});

test("judgeBatch API error marks batch unjudged and records error", async () => {
  const judged = {};
  const judge = makeJudge({ onJudged: (id, j) => (judged[id] = j) });
  judge.client = { systemOne: async () => { throw new Error("429 rate limited"); } };
  await judge.judgeBatch([msg("a", "hi")]);
  assert.equal(judged.a, null);
  assert.equal(judge.stats.errors, 1);
  assert.match(judge.stats.lastError, /429/);
});

test("settings: profiles round-trip and active profile clears on delete", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevhud-"));
  const s = new Settings(dir);
  const p = s.saveProfile({ name: "Test", context: "ctx", sources: [{ type: "twitch", channel: "x" }] });
  assert.ok(p.id);
  assert.ok(p.sources[0].id);
  s.update({ activeProfileId: p.id });

  const reloaded = new Settings(dir);
  assert.equal(reloaded.get().activeProfileId, p.id);
  assert.equal(reloaded.profile(p.id).name, "Test");

  reloaded.deleteProfile(p.id);
  assert.equal(reloaded.get().activeProfileId, null);
  assert.equal(reloaded.profile(p.id), null);
});
