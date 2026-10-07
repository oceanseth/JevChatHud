const { test } = require("node:test");
const assert = require("node:assert");
const { messageVisible, KINDS, KIND_CONFIDENCE_MIN } = require("../renderer/filter");
const { KIND_CRITERIA } = require("../src/judge");
const { Settings, DEFAULTS } = require("../src/settings");
const fs = require("fs");
const os = require("os");
const path = require("path");

const j = (kind, kindConfidence, relevancy, factuality) => ({ kind, kindConfidence, relevancy, factuality });

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

test("see all shows everything, judged or not", () => {
  const view = { seeAll: true, kinds: ["question"], threshold: 100 };
  assert.ok(messageVisible(null, view));
  assert.ok(messageVisible(j("chatter", 0.9, 0), view));
});

test("no tags selected: relevancy threshold curates, unjudged hidden", () => {
  const view = { seeAll: false, kinds: [], threshold: 55 };
  assert.ok(messageVisible(j("question", 0.9, 55), view));
  assert.ok(!messageVisible(j("question", 0.9, 54), view));
  assert.ok(!messageVisible(null, view));
});

test("tags selected: only selected kinds above 50% confidence show", () => {
  const view = { seeAll: false, kinds: ["question", "stream_issue"], threshold: 55 };
  assert.ok(messageVisible(j("question", 0.8, 10), view)); // relevancy ignored in tag mode
  assert.ok(messageVisible(j("stream_issue", 0.51, 100), view));
  assert.ok(!messageVisible(j("question", KIND_CONFIDENCE_MIN, 100), view)); // exactly 50% fails
  assert.ok(!messageVisible(j("hype", 0.99, 100), view)); // unselected kind hidden
  assert.ok(!messageVisible(null, view));
});

test("facts only: slider thresholds factuality instead of relevancy", () => {
  const view = { seeAll: false, kinds: [], threshold: 55, factsOnly: true };
  // an opinionated hype message with high relevancy is hidden...
  assert.ok(!messageVisible(j("hype", 0.9, 90, 10), view));
  // ...while a low-relevancy factual statement shows
  assert.ok(messageVisible(j("chatter", 0.9, 20, 80), view));
  assert.ok(messageVisible(j("feedback", 0.9, 0, 55), view)); // exactly at threshold
  assert.ok(!messageVisible(null, view));
});

test("facts only: judgments without a factuality score stay hidden", () => {
  // pre-factual-build judgment: factuality undefined, even threshold 0 hides it
  const old = { kind: "question", kindConfidence: 0.9, relevancy: 90 };
  assert.ok(!messageVisible(old, { seeAll: false, kinds: [], threshold: 0, factsOnly: true }));
  assert.ok(messageVisible(old, { seeAll: true, kinds: [], threshold: 0, factsOnly: true }));
});

test("facts only defers to see-all and tag mode, like the slider does", () => {
  const opinion = j("hype", 0.9, 90, 5);
  assert.ok(messageVisible(opinion, { seeAll: true, kinds: [], threshold: 55, factsOnly: true }));
  assert.ok(messageVisible(opinion, { seeAll: false, kinds: ["hype"], threshold: 55, factsOnly: true }));
});

test("factsOnly defaults off and persists like other view settings", () => {
  assert.equal(DEFAULTS.factsOnly, false);
});

test("tag mode surfaces kinds the relevancy slider would always hide", () => {
  // toxic/chatter score near-0 relevancy by rubric; tag mode must still show them
  const view = { seeAll: false, kinds: ["toxic"], threshold: 55 };
  assert.ok(messageVisible(j("toxic", 0.9, 0), view));
});
