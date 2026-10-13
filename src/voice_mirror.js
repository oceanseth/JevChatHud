// "Always on": the stream-identity avatar speaks what the streamer says.
// Mic transcript turns (the same local STT feed that gives the judge its
// streamer_speech context) arrive here while the feature is enabled; complete
// sentences are dispatched to Masky avatar-speak renders immediately — several
// in flight at once, so the avatar chases the streamer's voice instead of
// waiting for each clip to finish — and finished clips play back in spoken
// order in the always-on avatar window.
//
// Batching: sentences that arrive in the same transcription window (one mic
// chunk — i.e. the same breath) render as ONE clip, packed up to the server's
// character cap. "No. I don't do drugs." is one reading, not two. Speech that
// lands while renders are already in flight coalesces into the trailing
// pending job instead of fanning out more requests.
//
// Money rules: a render is charged when requested, so a job that has started
// rendering is never dropped. Backpressure only ever sheds *pending* sentences
// (oldest first — when we're hopelessly behind, recent speech matters more
// than a backlog of old lines).
const { MaskyClient, MaskyError, PRICING } = require("./masky");

const MAX_IN_FLIGHT = 3; // concurrent renders; more buys spend spikes + 429s
const MAX_JOBS = 8; // pending+rendering+ready cap before pending lines shed
const FRAGMENT_FLUSH_MS = 7000; // trailing words with no sentence end speak after this
const MIN_CHARS = 2; // ignore stray one-character fragments
const PLAY_SAFETY_MS = 180000; // never let a lost "done" stall the queue

/**
 * Split the rolling buffer into complete sentences plus the trailing
 * fragment. "Complete" = ends in . ! ? … (with closing quotes allowed).
 */
function splitSentences(buffer) {
  const sentences = [];
  let rest = String(buffer || "");
  const re = /^[\s]*([^.!?…]*[.!?…]+["')\]]*)/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    const line = m[1].trim();
    if (line) sentences.push(line);
    rest = rest.slice(m[0].length);
  }
  return { sentences, rest: rest.replace(/^\s+/, "") };
}

/**
 * Pack one turn's sentences into as few renders as fit the server cap —
 * sentences spoken in the same breath belong in the same clip.
 */
function packLines(sentences) {
  const groups = [];
  for (const s of sentences) {
    const last = groups[groups.length - 1];
    if (last != null && last.length + 1 + s.length <= PRICING.maxChars) {
      groups[groups.length - 1] = `${last} ${s}`;
    } else {
      groups.push(s);
    }
  }
  return groups;
}

class VoiceMirror {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig  speaker config block from settings
   * @param {(payload) => void} opts.onPlay  a clip's turn came up: {url, line}
   * @param {(state) => void} opts.onState  see emitState()
   * @param {() => void} [opts.onSpent]    a render was charged (refresh balances)
   * @param {MaskyClient} [opts.client]    injectable for tests
   */
  constructor({ getConfig, onPlay, onState, onSpent, client }) {
    this.getConfig = getConfig;
    this.onPlay = onPlay;
    this.onState = onState || (() => {});
    this.onSpent = onSpent || (() => {});
    this.client = client || new MaskyClient();
    this.gen = 0; // bumped by stop(): in-flight renders from a dead run are discarded
    this.buffer = "";
    this.flushTimer = null;
    this.jobs = []; // {status: pending|rendering|ready|failed, line, url}
    this.rendering = 0;
    this.playing = false;
    this.playTimer = null;
    this.lastError = null;
  }

  config() {
    return this.getConfig() || {};
  }

  /** The feature is on and able to render. */
  active() {
    const cfg = this.config();
    return !!(cfg.alwaysOn && cfg.maskyToken && cfg.alwaysOnAvatar?.avatarId);
  }

  /** A transcribed mic turn arrived. Complete sentences dispatch immediately. */
  addSpeech(text) {
    if (!this.active()) return;
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.buffer = this.buffer ? `${this.buffer} ${clean}` : clean;
    const { sentences, rest } = splitSentences(this.buffer);
    this.buffer = rest;
    for (const line of packLines(sentences)) this.enqueue(line);
    // Whatever trails the last sentence end speaks on its own after a lull —
    // people don't always land on punctuation, and whisper doesn't either.
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.buffer) {
      this.flushTimer = setTimeout(() => this.flushFragment(), FRAGMENT_FLUSH_MS);
      if (this.flushTimer.unref) this.flushTimer.unref();
    }
  }

  flushFragment() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const line = this.buffer.trim();
    this.buffer = "";
    if (line && this.active()) this.enqueue(line);
  }

  enqueue(line) {
    if (line.length < MIN_CHARS) return;
    // Renders already in flight? New speech joins the trailing unsent job
    // (one longer clip) rather than fanning out another render per chunk.
    const tail = this.jobs[this.jobs.length - 1];
    if (tail && tail.status === "pending" && tail.line.length + 1 + line.length <= PRICING.maxChars) {
      tail.line = `${tail.line} ${line}`;
      this.emitState();
      return;
    }
    // Over the cap: shed the oldest line that hasn't started rendering (not
    // yet paid for). All jobs committed? Then the new line is the one to drop.
    if (this.jobs.length >= MAX_JOBS) {
      const i = this.jobs.findIndex((j) => j.status === "pending");
      if (i === -1) return;
      this.jobs.splice(i, 1);
    }
    this.jobs.push({ status: "pending", line, url: null });
    this.pump();
    this.emitState();
  }

  /** Start renders for pending jobs, oldest first, up to the concurrency cap. */
  pump() {
    for (const job of this.jobs) {
      if (this.rendering >= MAX_IN_FLIGHT) return;
      if (job.status !== "pending") continue;
      job.status = "rendering";
      this.rendering++;
      void this.render(job);
    }
  }

  async render(job) {
    const gen = this.gen;
    const cfg = this.config();
    const avatar = cfg.alwaysOnAvatar || {};
    try {
      const { url, creditsCharged } = await this.client.speak({
        token: cfg.maskyToken,
        ownerUserId: avatar.ownerUserId || undefined,
        avatarId: avatar.avatarId,
        text: job.line,
        output: "video",
        // The streamer's quality pick applies here like any other reading.
        quality: cfg.videoQuality === "medium" ? "medium" : "high",
        avatarImageUrl: avatar.imageUrl || undefined,
        // "use personality": the avatar reinterprets the line through its
        // personality prompt instead of speaking it verbatim.
        textMode: cfg.alwaysOnPersonality ? "personality" : "literal",
      });
      if (gen !== this.gen) return; // stopped while rendering: discard
      job.status = "ready";
      job.url = url;
      this.lastError = null;
      if (creditsCharged != null) this.onSpent();
    } catch (err) {
      if (gen !== this.gen) return;
      job.status = "failed";
      this.lastError = {
        code: err instanceof MaskyError ? err.code : "masky_error",
        message: err.message || String(err),
      };
    } finally {
      if (gen === this.gen) {
        this.rendering--;
        this.pump();
        this.playNext();
        this.emitState();
      }
    }
  }

  /** Spoken order is sacred: only the head of the queue may play. */
  playNext() {
    if (this.playing) return;
    while (this.jobs[0]?.status === "failed") this.jobs.shift();
    const head = this.jobs[0];
    if (!head || head.status !== "ready") return;
    this.jobs.shift();
    this.playing = true;
    clearTimeout(this.playTimer);
    this.playTimer = setTimeout(() => this.notePlaybackDone(), PLAY_SAFETY_MS);
    if (this.playTimer.unref) this.playTimer.unref();
    this.onPlay({ url: head.url, line: head.line });
    this.emitState();
  }

  /** The avatar window finished (or failed) the current clip. */
  notePlaybackDone() {
    this.playing = false;
    clearTimeout(this.playTimer);
    this.playTimer = null;
    this.playNext();
    this.emitState();
  }

  /** Slider off / logout: forget everything, discard in-flight renders. */
  stop() {
    this.gen++;
    this.buffer = "";
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    clearTimeout(this.playTimer);
    this.playTimer = null;
    this.jobs = [];
    this.rendering = 0;
    this.playing = false;
    this.lastError = null;
    this.emitState();
  }

  emitState() {
    this.onState({
      queued: this.jobs.length,
      rendering: this.rendering,
      playing: this.playing,
      error: this.lastError,
    });
  }
}

module.exports = { VoiceMirror, splitSentences, packLines, MAX_IN_FLIGHT, MAX_JOBS, FRAGMENT_FLUSH_MS };
