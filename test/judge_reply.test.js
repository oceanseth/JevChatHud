const { test } = require("node:test");
const assert = require("node:assert");
const { judgementReplyText, ReplyThrottle, TECHNIQUE_LABELS } = require("../src/judge_reply");
const { TECHNIQUE_CRITERIA } = require("../src/judge");

test("TECHNIQUE_LABELS covers every judge technique except none", () => {
  const keys = Object.keys(TECHNIQUE_CRITERIA).filter((k) => k !== "none");
  assert.deepEqual(Object.keys(TECHNIQUE_LABELS).sort(), keys.sort());
});

test("reply names the technique when the judge is confident in one", () => {
  const text = judgementReplyText("viewer42", {
    safety: 18,
    manipulation: 85,
    outcome: 0.9,
    technique: "coercion",
    techniqueConfidence: 0.8,
  });
  assert.match(text, /^@viewer42 /);
  assert.match(text, /safety 18\/100/);
  assert.match(text, /guilt, shame, or pressure tactics/);
  assert.match(text, /steer people toward an outcome/);
  assert.match(text, /not a verdict/);
  assert.ok(text.length <= 500);
});

test("reply falls back to the manipulation rung without a confident technique", () => {
  // low-confidence technique: fall back to the rubric rung name
  const lowConf = judgementReplyText("v", {
    safety: 30, manipulation: 70, outcome: 0.2, technique: "loaded_language", techniqueConfidence: 0.4,
  });
  assert.match(lowConf, /persuasion techniques/);
  assert.doesNotMatch(lowConf, /loaded \/ triggering/);
  // technique "none" but still blocked by the slider: same fallback
  const none = judgementReplyText("v", {
    safety: 40, manipulation: 100, outcome: 0.1, technique: "none", techniqueConfidence: 0.9,
  });
  assert.match(none, /coercive or manipulative pressure/);
  // no steering note below the 0.6 outcome bar
  assert.doesNotMatch(none, /steer people/);
});

test("reply never exceeds Twitch's 500-char cap", () => {
  const text = judgementReplyText("x".repeat(480), {
    safety: 0, manipulation: 100, outcome: 1, technique: "false_logic", techniqueConfidence: 0.9,
  });
  assert.ok(text.length <= 500);
});

test("throttle: one reply per user per cooldown, with a global gap", () => {
  let now = 0;
  const t = new ReplyThrottle({ perUserMs: 120000, globalMs: 15000, nowImpl: () => now });
  assert.ok(t.allow("Alice"));
  assert.ok(!t.allow("alice")); // same user, case-insensitive, inside cooldown
  now = 10000;
  assert.ok(!t.allow("bob")); // global gap still closed
  now = 16000;
  assert.ok(t.allow("bob")); // global gap open, new user
  now = 130000;
  assert.ok(!t.allow("bob")); // bob's own cooldown (16000 + 120000) still running
  now = 140000;
  assert.ok(t.allow("alice")); // alice's cooldown expired
});
