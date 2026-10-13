const { test } = require("node:test");
const assert = require("node:assert");
const { messageVisible, KINDS, KIND_CONFIDENCE_MIN } = require("../renderer/filter");
const { KIND_CRITERIA } = require("../src/judge");
const { Settings, DEFAULTS } = require("../src/settings");
const fs = require("fs");
const os = require("os");
const path = require("path");

const j = (kind, kindConfidence, relevancy, safety) => ({ kind, kindConfidence, relevancy, safety });

test("KINDS mirrors the judge's KIND_CRITERIA", () => {
  assert.deepEqual([...KINDS].sort(), Object.keys(KIND_CRITERIA).sort());
});

test("kindFilter persists through Settings.update", () => {
  assert.deepEqual(DEFAULTS.kindFilter, []);
});

test("appearance defaults merge over a partial saved config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevhud-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ appearance: { fontSize: 16 } }));
  const s = new Settings(dir);
  assert.equal(s.get().appearance.fontSize, 16);
  assert.equal(s.get().appearance.fontFamily, DEFAULTS.appearance.fontFamily);
  assert.equal(s.get().appearance.density, DEFAULTS.appearance.density);
});

test("filtering off (Jev's eyes closed) shows everything, judged or not", () => {
  const view = { filtering: false, kinds: ["question"], relevancyMin: 100, safetyMin: 100 };
  assert.ok(messageVisible(null, view));
  assert.ok(messageVisible(j("chatter", 0.9, 0, 0), view));
});

test("no tags selected: relevancy threshold curates, unjudged hidden", () => {
  const view = { filtering: true, kinds: [], relevancyMin: 55, safetyMin: 0 };
  assert.ok(messageVisible(j("question", 0.9, 55), view));
  assert.ok(!messageVisible(j("question", 0.9, 54), view));
  assert.ok(!messageVisible(null, view));
});

test("tags selected: only selected kinds above 50% confidence show", () => {
  const view = { filtering: true, kinds: ["question", "stream_issue"], relevancyMin: 55, safetyMin: 0 };
  assert.ok(messageVisible(j("question", 0.8, 10), view)); // sliders ignored in tag mode
  assert.ok(messageVisible(j("stream_issue", 0.51, 100), view));
  assert.ok(!messageVisible(j("question", KIND_CONFIDENCE_MIN, 100), view)); // exactly 50% fails
  assert.ok(!messageVisible(j("hype", 0.99, 100), view)); // unselected kind hidden
  assert.ok(!messageVisible(null, view));
});

test("dual sliders AND together; a slider at 0 is no constraint", () => {
  // safety-only curation: relevancy 0, safety 55 — blocks manipulation alone
  let view = { filtering: true, kinds: [], relevancyMin: 0, safetyMin: 55 };
  assert.ok(!messageVisible(j("hype", 0.9, 90, 10), view)); // manipulative bait hidden
  assert.ok(messageVisible(j("chatter", 0.9, 20, 80), view)); // low-rel straight talk shows
  assert.ok(messageVisible(j("feedback", 0.9, 0, 55), view)); // exactly at threshold

  // both active: must pass BOTH — "on-topic AND not working on you"
  view = { filtering: true, kinds: [], relevancyMin: 50, safetyMin: 70 };
  assert.ok(messageVisible(j("feedback", 0.9, 60, 80), view));
  assert.ok(!messageVisible(j("feedback", 0.9, 60, 69), view)); // safety fails
  assert.ok(!messageVisible(j("feedback", 0.9, 49, 95), view)); // relevancy fails

  // relevancy at 0 with safety at 0: every judged message shows
  view = { filtering: true, kinds: [], relevancyMin: 0, safetyMin: 0 };
  assert.ok(messageVisible(j("chatter", 0.9, 0, 0), view));
  assert.ok(!messageVisible(null, view)); // but unjudged still needs eyes-closed
});

test("safety threshold: judgments without a safety score stay hidden", () => {
  // pre-safety-build judgment: safety undefined fails any safetyMin > 0
  const old = { kind: "question", kindConfidence: 0.9, relevancy: 90 };
  assert.ok(!messageVisible(old, { filtering: true, kinds: [], relevancyMin: 0, safetyMin: 1 }));
  assert.ok(messageVisible(old, { filtering: true, kinds: [], relevancyMin: 55, safetyMin: 0 }));
  assert.ok(messageVisible(old, { filtering: false, kinds: [], relevancyMin: 0, safetyMin: 100 }));
});

test("tag mode surfaces kinds the sliders would always hide", () => {
  // toxic/chatter score near-0 relevancy by rubric; tag mode must still show them
  const view = { filtering: true, kinds: ["toxic"], relevancyMin: 55, safetyMin: 70 };
  assert.ok(messageVisible(j("toxic", 0.9, 0, 0), view));
});

test("defaults: Jev filters, safety slider idle at 0, judgement replies off", () => {
  assert.equal(DEFAULTS.jevFiltering, true);
  assert.equal(DEFAULTS.safetyThreshold, 0);
  assert.equal(DEFAULTS.judgementReplies, false);
  assert.equal(DEFAULTS.mic.enabled, false);
});

test("legacy config migrates: seeAll inverts, old factual slider does NOT carry over", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevhud-"));
  fs.writeFileSync(
    path.join(dir, "config.json"),
    // a v0.6 config that had the factual slider up — safety measures something
    // different, so it must restart at 0 (show more, never silently hide)
    JSON.stringify({ seeAll: true, factualThreshold: 62, relevancyThreshold: 40 })
  );
  const s = new Settings(dir);
  assert.equal(s.get().jevFiltering, false); // seeAll:true → eyes closed
  assert.equal(s.get().safetyThreshold, 0); // factual position deliberately dropped
  assert.equal(s.get().relevancyThreshold, 40);
  assert.ok(!("seeAll" in s.get()));
  assert.ok(!("factualThreshold" in s.get()));
  // stale keys don't come back through save()
  s.save();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.ok(!("seeAll" in raw) && !("factualThreshold" in raw) && !("factsOnly" in raw));
});

test("legacy v0.5 factsOnly key is dropped and the relevancy slider survives", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevhud-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ seeAll: false, factsOnly: true, relevancyThreshold: 45 }));
  const s = new Settings(dir);
  assert.equal(s.get().jevFiltering, true);
  assert.equal(s.get().relevancyThreshold, 45);
  assert.equal(s.get().safetyThreshold, 0);
  assert.ok(!("factsOnly" in s.get()));
});
