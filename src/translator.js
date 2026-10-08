// On-device chat translation for the per-profile Language setting.
//
// Engine: M2M100-418M (int8 ONNX) through transformers.js, running in the
// main process on CPU — any-to-any across every language in LANGS, no cloud
// calls. Detection is eld (pure JS, tuned for short text). The ~480 MB model
// downloads once, like the whisper STT engine, into ~/.cache/jevchathud.
//
// Translation is best-effort everywhere: anything that fails (engine missing,
// unreliable detection, model error) resolves to null and the caller shows or
// speaks the original text. Chat must never wait on a translator.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { tokenizeMessage } = require("../renderer/emotes");

const MODEL = "Xenova/m2m100_418M";
const MODEL_MB = 480; // shown in the install prompt

// Dropdown languages: the intersection of what M2M100 translates and eld
// detects, trimmed to languages Twitch chats actually show up in.
const LANGS = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "nl", label: "Nederlands" },
  { code: "pl", label: "Polski" },
  { code: "cs", label: "Čeština" },
  { code: "sv", label: "Svenska" },
  { code: "da", label: "Dansk" },
  { code: "no", label: "Norsk" },
  { code: "fi", label: "Suomi" },
  { code: "el", label: "Ελληνικά" },
  { code: "hu", label: "Magyar" },
  { code: "ro", label: "Română" },
  { code: "ru", label: "Русский" },
  { code: "uk", label: "Українська" },
  { code: "tr", label: "Türkçe" },
  { code: "ar", label: "العربية" },
  { code: "he", label: "עברית" },
  { code: "hi", label: "हिन्दी" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "th", label: "ไทย" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "zh", label: "中文" },
];
const LANG_CODES = new Set(LANGS.map((l) => l.code));

// Localized "says" connector for composed readings ("<user> says: <text>"),
// so an avatar speaking Spanish doesn't announce chatters in English.
const SAYS = {
  en: "says:", es: "dice:", pt: "diz:", fr: "dit :", de: "sagt:", it: "dice:",
  nl: "zegt:", pl: "mówi:", cs: "říká:", sv: "säger:", da: "siger:",
  no: "sier:", fi: "sanoo:", el: "λέει:", hu: "mondja:", ro: "spune:",
  ru: "говорит:", uk: "каже:", tr: "diyor:", ar: "يقول:", he: "אומר:",
  hi: "कहते हैं:", id: "berkata:", vi: "nói:", th: "พูดว่า:",
  ja: "さん:", ko: "님:", zh: "说:",
};

const LINE_CACHE_MAX = 500; // translated fragments, keyed src|tgt|text
const MSG_MEMO_MAX = 300; // per-message results, keyed msg id
const QUEUE_LOW_MAX = 12; // busiest-chat guard: drop display translations past this

function defaultCacheDir() {
  return path.join(os.homedir(), ".cache", "jevchathud", "translator");
}

/** Real engine: dynamic imports because transformers.js and eld are ESM. */
async function loadRealEngine(cacheDir, onProgress) {
  const { pipeline, env } = await import("@huggingface/transformers");
  const { eld } = await import("eld/medium");
  env.cacheDir = cacheDir;
  const pipe = await pipeline("translation", MODEL, {
    dtype: "q8",
    progress_callback: (p) => {
      if (p?.status !== "progress" || !p.total) return;
      onProgress?.({ file: p.file, loaded: p.loaded, total: p.total });
    },
  });
  return {
    detect(text) {
      const r = eld.detect(String(text || ""));
      return { lang: r.language || "", reliable: !!r.isReliable() };
    },
    async translate(text, src, tgt) {
      const out = await pipe(text, { src_lang: src, tgt_lang: tgt });
      const t = Array.isArray(out) ? out[0]?.translation_text : out?.translation_text;
      return String(t || "").trim();
    },
  };
}

/** Coalesce tokenizeMessage output into [textRun | emote] in original order —
 * the tokenizer splits text word-by-word around emotes, and word-level MT is
 * garbage, so adjacent text segments translate as one run. */
function coalesceSegments(segments) {
  const runs = [];
  for (const seg of segments) {
    if (seg.type === "emote") {
      runs.push(seg);
    } else {
      const last = runs[runs.length - 1];
      if (last && last.type === "text") last.text += seg.text;
      else runs.push({ type: "text", text: seg.text });
    }
  }
  return runs;
}

class Translator {
  /**
   * @param {object} [opts]
   * @param {string} [opts.cacheDir]   model cache location
   * @param {(cacheDir, onProgress) => Promise<{detect, translate}>} [opts.loadEngine]  injectable for tests
   */
  constructor({ cacheDir, loadEngine } = {}) {
    this.cacheDir = cacheDir || defaultCacheDir();
    this.markerFile = path.join(this.cacheDir, "installed.json");
    this.loadEngine = loadEngine || loadRealEngine;
    this.engine = null;
    this.loadingPromise = null;
    this.installing = false;
    this.error = null;
    this.progress = null; // {file, loaded, total} of the current download
    this.onProgress = null; // set by main to forward install progress to the UI
    this.emoteByName = new Map();
    this.lineCache = new Map();
    this.msgMemo = new Map();
    this.jobs = [];
    this.working = false;
  }

  /** Model files are on disk (first successful load leaves a marker). */
  installed() {
    try {
      return fs.existsSync(this.markerFile);
    } catch {
      return false;
    }
  }

  status() {
    return {
      state: this.engine
        ? "ready"
        : this.installing
          ? "installing"
          : this.installed()
            ? "installed"
            : "absent",
      error: this.error,
      progress: this.progress,
      langs: LANGS,
      modelMB: MODEL_MB,
    };
  }

  setEmoteNames(map) {
    this.emoteByName = map || new Map();
  }

  /** One-time model download (or re-download after a wiped cache). */
  async install() {
    this.installing = true;
    this.error = null;
    try {
      await this.ensureLoaded();
      return this.status();
    } finally {
      this.installing = false;
    }
  }

  async ensureLoaded() {
    if (this.engine) return this.engine;
    if (!this.loadingPromise) {
      this.loadingPromise = this.loadEngine(this.cacheDir, (p) => {
        this.progress = p;
        this.onProgress?.(p);
      })
        .then((engine) => {
          this.engine = engine;
          this.progress = null;
          fs.mkdirSync(this.cacheDir, { recursive: true });
          fs.writeFileSync(this.markerFile, JSON.stringify({ model: MODEL, at: new Date().toISOString() }));
          return engine;
        })
        .catch((e) => {
          this.error = e.message || String(e);
          this.loadingPromise = null;
          throw e;
        });
    }
    return this.loadingPromise;
  }

  /** Serial job queue: one model, one translation at a time. Speaker jobs are
   * priority (they gate a paid render); display jobs are droppable. */
  _enqueue(fn, { priority = false } = {}) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject };
      if (priority) this.jobs.unshift(job);
      else this.jobs.push(job);
      this._drain();
    });
  }

  async _drain() {
    if (this.working) return;
    this.working = true;
    while (this.jobs.length) {
      const job = this.jobs.shift();
      try {
        job.resolve(await job.fn());
      } catch (e) {
        job.reject(e);
      }
    }
    this.working = false;
  }

  _cacheGet(key) {
    if (!this.lineCache.has(key)) return undefined;
    const v = this.lineCache.get(key);
    this.lineCache.delete(key);
    this.lineCache.set(key, v); // LRU bump
    return v;
  }

  _cacheSet(key, value) {
    this.lineCache.delete(key);
    this.lineCache.set(key, value);
    if (this.lineCache.size > LINE_CACHE_MAX) {
      this.lineCache.delete(this.lineCache.keys().next().value);
    }
  }

  async _translateRun(text, src, tgt) {
    const key = `${src}|${tgt}|${text}`;
    const hit = this._cacheGet(key);
    if (hit !== undefined) return hit;
    const out = await this.engine.translate(text, src, tgt);
    const value = out || text;
    this._cacheSet(key, value);
    return value;
  }

  /**
   * Translate a plain line into `tgt`. Resolves {text, src} or null when
   * translation isn't needed/possible (already in `tgt`, unreliable
   * detection, engine unavailable, busy queue without priority).
   */
  async translateText(text, tgt, { priority = false } = {}) {
    const line = String(text || "").trim();
    if (!line || !LANG_CODES.has(tgt) || !this.installed()) return null;
    if (!priority && this.jobs.length >= QUEUE_LOW_MAX) return null;
    let engine;
    try {
      engine = await this.ensureLoaded();
    } catch {
      return null;
    }
    const det = engine.detect(line);
    if (!det.lang || det.lang === tgt || !det.reliable) return null;
    try {
      const out = await this._enqueue(() => this._translateRun(line, det.lang, tgt), { priority });
      if (!out || out === line) return null;
      return { text: out, src: det.lang };
    } catch {
      return null;
    }
  }

  /**
   * Translate a chat message into `tgt`, preserving emotes: only the text
   * runs between emote tokens are translated. Memoized per message id so the
   * display swap and a later speaker reading share one model pass.
   *
   * Resolves {id, src, tgt, segments, text, spoken} or null (no translation).
   */
  translateMessage(msg, tgt) {
    const id = msg?.id;
    if (!id) return this._translateMessageNow(msg, tgt);
    const memo = this.msgMemo.get(id);
    if (memo && memo.tgt === tgt) return memo.promise;
    const promise = this._translateMessageNow(msg, tgt).catch(() => null);
    this.msgMemo.delete(id);
    this.msgMemo.set(id, { tgt, promise });
    if (this.msgMemo.size > MSG_MEMO_MAX) {
      this.msgMemo.delete(this.msgMemo.keys().next().value);
    }
    return promise;
  }

  async _translateMessageNow(msg, tgt) {
    if (!LANG_CODES.has(tgt) || !this.installed()) return null;
    const raw = String(msg?.text || "");
    if (!raw.trim()) return null;
    const runs = coalesceSegments(tokenizeMessage(raw, msg?.emotes, this.emoteByName));
    const textRuns = runs.filter((r) => r.type === "text" && r.text.trim());
    if (!textRuns.length) return null;
    if (this.jobs.length >= QUEUE_LOW_MAX) return null;
    let engine;
    try {
      engine = await this.ensureLoaded();
    } catch {
      return null;
    }
    const det = engine.detect(textRuns.map((r) => r.text.trim()).join(" "));
    if (!det.lang || det.lang === tgt || !det.reliable) return null;
    let changed = false;
    const segments = [];
    try {
      await this._enqueue(async () => {
        for (const run of runs) {
          if (run.type === "emote" || !run.text.trim()) {
            segments.push(run);
            continue;
          }
          const lead = run.text.match(/^\s*/)[0];
          const trail = run.text.match(/\s*$/)[0];
          const out = await this._translateRun(run.text.trim(), det.lang, tgt);
          if (out !== run.text.trim()) changed = true;
          segments.push({ type: "text", text: lead + out + trail });
        }
      });
    } catch {
      return null;
    }
    if (!changed) return null;
    const text = segments
      .map((s) => (s.type === "emote" ? s.name : s.text))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    return { id: msg.id, src: det.lang, tgt, segments, text, spoken: text };
  }

  /**
   * The line the speaker should read for a judged message: the memoized
   * display translation when it exists for this target, else a fresh
   * priority translation. Null = speak the original.
   */
  async spokenLine(id, text, tgt) {
    if (!LANG_CODES.has(tgt) || !this.installed()) return null;
    const memo = id ? this.msgMemo.get(id) : null;
    if (memo && memo.tgt === tgt) {
      const r = await memo.promise.catch(() => null);
      return r ? r.spoken || r.text : null;
    }
    const r = await this.translateText(text, tgt, { priority: true });
    return r ? r.text : null;
  }
}

module.exports = { Translator, LANGS, SAYS, MODEL, MODEL_MB };
