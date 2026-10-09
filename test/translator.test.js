const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Translator, LANGS, SAYS } = require("../src/translator");

function tmpCache() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jev-translator-"));
}

function fakeEngine({ detectLang = "es", reliable = true } = {}) {
  const calls = [];
  return {
    calls,
    loadEngine: async () => ({
      detect: () => ({ lang: detectLang, reliable }),
      translate: async (text, src, tgt) => {
        calls.push({ text, src, tgt });
        return `[${tgt}]${text}`;
      },
    }),
  };
}

function makeTranslator(opts = {}) {
  const eng = fakeEngine(opts);
  const dir = tmpCache();
  fs.writeFileSync(path.join(dir, "installed.json"), "{}"); // model "on disk"
  const t = new Translator({ cacheDir: dir, loadEngine: eng.loadEngine });
  return { t, eng };
}

test("every dropdown language has a localized says connector", () => {
  for (const { code } of LANGS) assert.ok(SAYS[code], `SAYS missing for ${code}`);
});

test("no model on disk -> translation is a quiet no-op", async () => {
  const eng = fakeEngine();
  const t = new Translator({ cacheDir: tmpCache(), loadEngine: eng.loadEngine });
  assert.equal(t.installed(), false);
  assert.equal(t.status().state, "absent");
  assert.equal(await t.translateText("hola amigos", "en"), null);
  assert.equal(await t.translateMessage({ id: "m1", text: "hola amigos" }, "en"), null);
  assert.equal(eng.calls.length, 0);
});

test("install loads the engine and leaves the installed marker", async () => {
  const eng = fakeEngine();
  const dir = tmpCache();
  const t = new Translator({ cacheDir: dir, loadEngine: eng.loadEngine });
  const st = await t.install();
  assert.equal(st.state, "ready");
  assert.ok(fs.existsSync(path.join(dir, "installed.json")));
});

test("already in the target language or unreliable detection -> null", async () => {
  const same = makeTranslator({ detectLang: "en" });
  assert.equal(await same.t.translateText("good one", "en"), null);
  const shaky = makeTranslator({ detectLang: "es", reliable: false });
  assert.equal(await shaky.t.translateText("hmm", "en"), null);
  assert.equal(same.eng.calls.length + shaky.eng.calls.length, 0);
});

test("translateText translates and caches repeated lines", async () => {
  const { t, eng } = makeTranslator();
  const r1 = await t.translateText("hola amigos", "en");
  assert.deepEqual(r1, { text: "[en]hola amigos", src: "es" });
  const r2 = await t.translateText("hola amigos", "en");
  assert.equal(r2.text, "[en]hola amigos");
  assert.equal(eng.calls.length, 1); // second hit came from the cache
});

test("translateMessage translates around emotes, never through them", async () => {
  const { t, eng } = makeTranslator();
  t.setEmoteNames(new Map([["Kappa", { name: "Kappa", url: "https://cdn/k.webp", source: "7tv", id: "1" }]]));
  const r = await t.translateMessage({ id: "m1", text: "hola amigos Kappa que risa" }, "en");
  assert.equal(r.src, "es");
  assert.equal(r.tgt, "en");
  // emote segment survives untranslated, text runs around it are translated
  const emotes = r.segments.filter((s) => s.type === "emote");
  assert.equal(emotes.length, 1);
  assert.equal(emotes[0].name, "Kappa");
  assert.ok(!eng.calls.some((c) => c.text.includes("Kappa")));
  assert.equal(r.text, "[en]hola amigos Kappa [en]que risa");
  assert.equal(r.spoken, r.text);
});

test("per-message results are memoized and shared with the speaker", async () => {
  const { t, eng } = makeTranslator();
  const msg = { id: "m7", text: "hola amigos" };
  const [a, b] = await Promise.all([t.translateMessage(msg, "en"), t.translateMessage(msg, "en")]);
  assert.equal(a.text, "[en]hola amigos");
  assert.equal(b.text, "[en]hola amigos");
  assert.equal(eng.calls.length, 1);
  // the speaker's line reuses the memo — still one engine pass
  assert.equal(await t.spokenLine("m7", "hola amigos", "en"), "[en]hola amigos");
  assert.equal(eng.calls.length, 1);
});

test("spokenLine without a memo translates with priority", async () => {
  const { t, eng } = makeTranslator();
  assert.equal(await t.spokenLine(null, "hola amigos", "en"), "[en]hola amigos");
  assert.equal(eng.calls.length, 1);
});

test("a flooded queue drops display translations instead of queueing forever", async () => {
  const { t } = makeTranslator();
  await t.ensureLoaded();
  t.working = true; // simulate a busy engine
  t.jobs = new Array(12).fill({ fn: async () => {}, resolve() {}, reject() {} });
  assert.equal(await t.translateText("hola amigos", "en"), null);
  assert.equal(await t.translateMessage({ id: "x", text: "hola amigos" }, "en"), null);
  t.jobs = [];
  t.working = false;
});

test("a dead engine host is forgotten and respawned on the next line", async () => {
  const dir = tmpCache();
  fs.writeFileSync(path.join(dir, "installed.json"), "{}");
  let loads = 0;
  let exitCb = null;
  const t = new Translator({
    cacheDir: dir,
    loadEngine: async (cacheDir, onProgress, onExit) => {
      loads++;
      exitCb = onExit;
      return {
        detect: () => ({ lang: "es", reliable: true }),
        translate: async (text, src, tgt) => `[${tgt}#${loads}]${text}`,
      };
    },
  });
  assert.equal((await t.translateText("hola amigos", "en")).text, "[en#1]hola amigos");
  exitCb(); // the utility process died
  assert.equal(t.engine, null);
  assert.equal((await t.translateText("adios amigos", "en")).text, "[en#2]adios amigos");
  assert.equal(loads, 2);
});

test("messages that are only emotes or whitespace are left alone", async () => {
  const { t, eng } = makeTranslator();
  t.setEmoteNames(new Map([["Kappa", { name: "Kappa", url: "u", source: "7tv", id: "1" }]]));
  assert.equal(await t.translateMessage({ id: "m1", text: "Kappa Kappa" }, "en"), null);
  assert.equal(await t.translateMessage({ id: "m2", text: "   " }, "en"), null);
  assert.equal(eng.calls.length, 0);
});
