const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { UserStats, userKey, MAX_SAMPLES } = require("../src/user_stats");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jevhud-users-"));
}

function msg(name, text, { platform = "twitch", ts = Date.now(), color } = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    text,
    ts,
    user: { name, color },
    source: { type: platform, label: "#chan" },
  };
}

test("userKey is platform-scoped and case-insensitive", () => {
  assert.equal(userKey("twitch", "PogChamp"), "twitch:pogchamp");
  assert.notEqual(userKey("twitch", "bob"), userKey("youtube", "bob"));
});

test("recordMessage tracks first seen, counts, and recent samples", () => {
  const stats = new UserStats(tmpDir());
  stats.recordMessage(msg("Alice", "first", { ts: 1000 }));
  stats.recordMessage(msg("alice", "second", { ts: 2000, color: "#f0f" }));
  for (let i = 0; i < MAX_SAMPLES + 3; i++) stats.recordMessage(msg("ALICE", `spam ${i}`, { ts: 3000 + i }));

  const p = stats.get("twitch", "aLiCe");
  assert.equal(p.firstSeenTs, 1000); // first seen never moves
  assert.equal(p.messages, MAX_SAMPLES + 5);
  assert.equal(p.name, "ALICE"); // latest display casing wins
  assert.equal(p.color, "#f0f");
  assert.equal(p.samples.length, MAX_SAMPLES);
  assert.equal(p.samples.at(-1).text, `spam ${MAX_SAMPLES + 2}`);
});

test("judgments aggregate into per-kind percentages and avg relevancy", () => {
  const stats = new UserStats(tmpDir());
  const judgments = [
    ["hi", { relevancy: 10, kind: "chatter" }],
    ["you suck", { relevancy: 0, kind: "toxic" }],
    ["trash streamer", { relevancy: 5, kind: "toxic" }],
    ["what's your setup?", { relevancy: 65, kind: "question" }],
  ];
  for (const [text, judgment] of judgments) {
    const m = msg("Troll", text);
    stats.recordMessage(m);
    stats.recordJudgment(m, judgment);
  }
  // one more seen but never judged (API error path passes judgment: null)
  const unjudged = msg("Troll", "zzz");
  stats.recordMessage(unjudged);
  stats.recordJudgment(unjudged, null);

  const p = stats.get("twitch", "troll");
  assert.equal(p.messages, 5);
  assert.equal(p.judged, 4);
  assert.equal(p.kindPct.toxic, 50); // "how toxic is this user on average"
  assert.equal(p.kindPct.question, 25);
  assert.equal(p.kinds.toxic, 2);
  assert.equal(p.avgRelevancy, 20);
});

test("unknown users return null; zero-judged users have null avgRelevancy", () => {
  const stats = new UserStats(tmpDir());
  assert.equal(stats.get("twitch", "nobody"), null);
  stats.recordMessage(msg("Lurker", "hello"));
  const p = stats.get("twitch", "lurker");
  assert.equal(p.avgRelevancy, null);
  assert.deepEqual(p.kindPct, {});
});

test("stats persist across instances via save()", () => {
  const dir = tmpDir();
  const stats = new UserStats(dir);
  const m = msg("Alice", "is the audio ok?", { ts: 42 });
  stats.recordMessage(m);
  stats.recordJudgment(m, { relevancy: 90, kind: "stream_issue" });
  stats.save();

  const reloaded = new UserStats(dir);
  const p = reloaded.get("twitch", "alice");
  assert.equal(p.firstSeenTs, 42);
  assert.equal(p.messages, 1);
  assert.equal(p.kindPct.stream_issue, 100);
});
