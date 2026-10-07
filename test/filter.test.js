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

test("filtering off (Jev's eyes closed) shows everything, judged or not", () => {
  const view = { filtering: false, kinds: ["question"], relevancyMin: 100, factualMin: 100 };
  assert.ok(messageVisible(null, view));
  assert.ok(messageVisible(j("chatter", 0.9, 0, 0), view));
});

test("no tags selected: relevancy threshold curates, unjudged hidden", () => {
  const view = { filtering: true, kinds: [], relevancyMin: 55, factualMin: 0 };
  assert.ok(messageVisible(j("question", 0.9, 55), view));
  assert.ok(!messageVisible(j("question", 0.9, 54), view));
  assert.ok(!messageVisible(null, view));
});

test("tags selected: only selected kinds above 50% confidence show", () => {
  const view = { filtering: true, kinds: ["question", "stream_issue"], relevancyMin: 55, factualMin: 0 };
  assert.ok(messageVisible(j("question", 0.8, 10), view)); // sliders ignored in tag mode
  assert.ok(messageVisible(j("stream_issue", 0.51, 100), view));
  assert.ok(!messageVisible(j("question", KIND_CONFIDENCE_MIN, 100), view)); // exactly 50% fails
  assert.ok(!messageVisible(j("hype", 0.99, 100), view)); // unselected kind hidden
  assert.ok(!messageVisible(null, view));
});

test("dual sliders AND together; a slider at 0 is no constraint", () => {
  // factual-only curation (old "facts only" mode): relevancy 0, factual 55
  let view = { filtering: true, kinds: [], relevancyMin: 0, factualMin: 55 };
  assert.ok(!messageVisible(j("hype", 0.9, 90, 10), view)); // opinionated hype hidden
  assert.ok(messageVisible(j("chatter", 0.9, 20, 80), view)); // low-rel factual shows
  assert.ok(messageVisible(j("feedback", 0.9, 0, 55), view)); // exactly at threshold

  // both active: must pass BOTH — "on-topic AND verifiable"
  view = { filtering: true, kinds: [], relevancyMin: 50, factualMin: 70 };
  assert.ok(messageVisible(j("feedback", 0.9, 60, 80), view));
  assert.ok(!messageVisible(j("feedback", 0.9, 60, 69), view)); // factual fails
  assert.ok(!messageVisible(j("feedback", 0.9, 49, 95), view)); // relevancy fails

  // relevancy at 0 with factual at 0: every judged message shows
  view = { filtering: true, kinds: [], relevancyMin: 0, factualMin: 0 };
  assert.ok(messageVisible(j("chatter", 0.9, 0, 0), view));
  assert.ok(!messageVisible(null, view)); // but unjudged still needs eyes-closed
});

test("factual threshold: judgments without a factuality score stay hidden", () => {
  // pre-factual-build judgment: factuality undefined fails any factualMin > 0
  const old = { kind: "question", kindConfidence: 0.9, relevancy: 90 };
  assert.ok(!messageVisible(old, { filtering: true, kinds: [], relevancyMin: 0, factualMin: 1 }));
  assert.ok(messageVisible(old, { filtering: true, kinds: [], relevancyMin: 55, factualMin: 0 }));
  assert.ok(messageVisible(old, { filtering: false, kinds: [], relevancyMin: 0, factualMin: 100 }));
});

test("tag mode surfaces kinds the sliders would always hide", () => {
  // toxic/chatter score near-0 relevancy by rubric; tag mode must still show them
  const view = { filtering: true, kinds: ["toxic"], relevancyMin: 55, factualMin: 70 };
  assert.ok(messageVisible(j("toxic", 0.9, 0, 0), view));
});

test("defaults: Jev filters, factual slider idle at 0", () => {
  assert.equal(DEFAULTS.jevFiltering, true);
  assert.equal(DEFAULTS.factualThreshold, 0);
  assert.equal(DEFAULTS.mic.enabled, false);
});

test("v0.5 config migrates: seeAll inverts, factsOnly becomes the factual slider", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevhud-"));
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ seeAll: true, factsOnly: true, relevancyThreshold: 62 })
  );
  const s = new Settings(dir);
  assert.equal(s.get().jevFiltering, false); // seeAll:true → eyes closed
  assert.equal(s.get().factualThreshold, 62); // facts-only slider position carries over
  assert.equal(s.get().relevancyThreshold, 0); // old mode ignored relevancy
  assert.ok(!("seeAll" in s.get()));
  assert.ok(!("factsOnly" in s.get()));
  // stale keys don't come back through save()
  s.save();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.ok(!("seeAll" in raw) && !("factsOnly" in raw));
});

test("v0.5 config without facts-only keeps its relevancy slider", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevhud-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ seeAll: false, factsOnly: false, relevancyThreshold: 45 }));
  const s = new Settings(dir);
  assert.equal(s.get().jevFiltering, true);
  assert.equal(s.get().relevancyThreshold, 45);
  assert.equal(s.get().factualThreshold, 0);
});
