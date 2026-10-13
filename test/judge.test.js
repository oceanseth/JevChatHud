const { test } = require("node:test");
const assert = require("node:assert");
const { Judge, RELEVANCE_LEVELS, MANIPULATION_LEVELS, TECHNIQUE_CRITERIA, KIND_CRITERIA, safetyFromAnswers } = require("../src/judge");
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

test("buildRequest asks the full battery per message in one forward pass", () => {
  const judge = makeJudge();
  const batch = [msg("a", "hi"), msg("b", "your audio is dead!")];
  const { state, questions } = judge.buildRequest(batch);

  assert.equal(state.messages.length, 2);
  assert.equal(state.stream_context, "Playing chess.");
  assert.deepEqual(
    Object.keys(questions).sort(),
    [
      "m0_kind", "m0_manip", "m0_outcome", "m0_relevance", "m0_technique",
      "m1_kind", "m1_manip", "m1_outcome", "m1_relevance", "m1_technique",
    ]
  );
  // Score criteria are the ordered rubrics, Choice criteria the label maps
  assert.equal(questions.m0_relevance.criteria.length, RELEVANCE_LEVELS.length);
  assert.equal(questions.m0_manip.criteria.length, MANIPULATION_LEVELS.length);
  assert.deepEqual(Object.keys(questions.m0_technique.criteria), Object.keys(TECHNIQUE_CRITERIA));
  assert.deepEqual(Object.keys(questions.m1_kind.criteria), Object.keys(KIND_CRITERIA));
  assert.equal(questions.m0_outcome.type, "noul");
  // instructions reference the right state path
  assert.match(questions.m1_relevance.instructions, /`messages\[1\]`/);
  assert.match(questions.m1_manip.instructions, /`messages\[1\]`/);
  assert.match(questions.m1_outcome.instructions, /`messages\[1\]`/);
  assert.match(questions.m1_technique.instructions, /`messages\[1\]`/);
  // no mic transcript → no streamer_speech in state or instructions
  assert.ok(!("streamer_speech" in state));
  assert.doesNotMatch(questions.m0_relevance.instructions, /streamer_speech/);
});

test("buildRequest carries recent streamer speech as relevancy context", () => {
  const judge = makeJudge({ getSpeech: () => "okay chat I'm going for the no-hit boss run now" });
  const { state, questions } = judge.buildRequest([msg("a", "you got this!")]);
  assert.equal(state.streamer_speech, "okay chat I'm going for the no-hit boss run now");
  assert.match(questions.m0_relevance.instructions, /`streamer_speech`/);
  // the manipulation rubric judges the message alone — speech context stays out
  assert.doesNotMatch(questions.m0_manip.instructions, /streamer_speech/);
});

test("safety sums the manipulation rubric (double weight) with the outcome probe", () => {
  // straight talk, no steering: fully safe
  assert.equal(safetyFromAnswers({ score: 0 }, { noul: 0 }), 100);
  // maximum manipulation, certain steering: fully unsafe
  assert.equal(safetyFromAnswers({ score: 3 }, { noul: 1 }), 0);
  // pure call-to-action with zero manipulation stays mostly safe
  assert.equal(safetyFromAnswers({ score: 0 }, { noul: 1 }), 67);
  // persuasion techniques (rung 2) with likely steering
  assert.equal(safetyFromAnswers({ score: 2 }, { noul: 0.8 }), 100 - Math.round(((2 / 3) * 2 + 0.8) / 3 * 100));
});

test("judgeBatch maps answers back to message ids and normalizes score", async () => {
  const judged = {};
  const judge = makeJudge({ onJudged: (id, j) => (judged[id] = j) });
  judge.client = {
    systemOne: async ({ questions }) => {
      assert.equal(Object.keys(questions).length, 10);
      return {
        model: "jev-1.13.0",
        answers: {
          m0_relevance: { type: "score", score: 0.3, confidence: 0.9 },
          m0_manip: { type: "score", score: 0.15, confidence: 0.85 },
          m0_outcome: { type: "noul", noul: 0.1 },
          m0_technique: { type: "choice", choice: "none", confidence: 0.9 },
          m0_kind: { type: "choice", choice: "chatter", confidence: 0.8 },
          m1_relevance: { type: "score", score: 3, confidence: 0.95 },
          m1_manip: { type: "score", score: 2.7, confidence: 0.9 },
          m1_outcome: { type: "noul", noul: 0.9 },
          m1_technique: { type: "choice", choice: "coercion", confidence: 0.84 },
          m1_kind: { type: "choice", choice: "toxic", confidence: 0.97 },
        },
        usage: { input_tokens: 500, output_tokens: 8 },
      };
    },
  };
  await judge.judgeBatch([msg("a", "lol"), msg("b", "unban him or this chat is done with you")]);

  assert.equal(judged.a.relevancy, 10); // 0.3/3 * 100
  assert.equal(judged.a.safety, 100 - Math.round(((0.15 / 3) * 2 + 0.1) / 3 * 100));
  assert.equal(judged.a.safetyConfidence, 0.85);
  assert.equal(judged.a.manipulation, 5); // 0.15/3 * 100
  assert.equal(judged.a.technique, "none");
  assert.equal(judged.a.kind, "chatter");
  assert.equal(judged.b.relevancy, 100); // 3/3 * 100
  assert.equal(judged.b.safety, 100 - Math.round(((2.7 / 3) * 2 + 0.9) / 3 * 100));
  assert.equal(judged.b.technique, "coercion");
  assert.equal(judged.b.techniqueConfidence, 0.84);
  assert.equal(judged.b.outcome, 0.9);
  assert.equal(judged.b.kind, "toxic");
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

test("preview judges a draft without it entering context or the judged count", async () => {
  const judge = makeJudge();
  judge.recent.push(msg("prior", "earlier chat"));
  judge.client = {
    systemOne: async ({ state, questions }) => {
      // The draft rides the same context a real send would be judged against.
      assert.equal(state.recent_chat.length, 1);
      assert.equal(state.messages.length, 1);
      assert.equal(state.messages[0].text, "is the audio desynced?");
      assert.equal(Object.keys(questions).length, 5);
      return {
        answers: {
          m0_relevance: { type: "score", score: 3, confidence: 0.95 },
          m0_manip: { type: "score", score: 0.3, confidence: 0.8 },
          m0_outcome: { type: "noul", noul: 0.2 },
          m0_technique: { type: "choice", choice: "none", confidence: 0.92 },
          m0_kind: { type: "choice", choice: "stream_issue", confidence: 0.9 },
        },
        usage: { input_tokens: 400, output_tokens: 4 },
      };
    },
  };
  const j = await judge.preview(msg("draft", "is the audio desynced?"));
  assert.equal(j.relevancy, 100);
  assert.equal(j.safety, 100 - Math.round(((0.3 / 3) * 2 + 0.2) / 3 * 100));
  assert.equal(j.kind, "stream_issue");
  assert.equal(j.kindConfidence, 0.9);
  // The draft is not chat: context window untouched, judged count unchanged.
  assert.equal(judge.recent.length, 1);
  assert.equal(judge.stats.judged, 0);
  // But the request still costs money, and the stats say so.
  assert.equal(judge.stats.requests, 1);
  assert.equal(judge.stats.inputTokens, 400);
  assert.ok(judge.stats.costUsd > 0);
});

test("preview returns null without a key and on API error", async () => {
  const noKey = makeJudge({ getConfig: () => ({ typesafeApiKey: "" }) });
  assert.equal(await noKey.preview(msg("d", "hello")), null);
  assert.equal(noKey.stats.requests, 0);

  const judge = makeJudge();
  judge.client = { systemOne: async () => { throw new Error("503 unavailable"); } };
  assert.equal(await judge.preview(msg("d", "hello")), null);
  assert.equal(judge.stats.errors, 1);
  assert.match(judge.stats.lastError, /503/);
  assert.equal(judge.client, null); // fresh client on the next request
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
