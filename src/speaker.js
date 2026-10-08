// The "Jev speaks" scheduler: on a cadence, pick the most relevant judged
// message since the last reading and render the configured Masky avatar
// speaking it, for the OBS-shareable transparent window.
//
// Policy choices live here, not in the model: the candidate is the highest
// relevancy score seen in the window (ties -> newest), toxic-tagged messages
// are never read aloud on stream, and an empty window skips the reading
// (no render, no spend).
const { MaskyClient, MaskyError, talkingMinutes } = require("./masky");

const INTERVALS_MIN = [1, 5, 10];

// "Read with user avatars": how long one username→avatar lookup stays good.
// Long enough that an active chatter costs one API call per stream segment,
// short enough that enrolling a voice on Masky mid-stream gets noticed.
const USER_AVATAR_TTL_MS = 10 * 60000;
const USER_AVATAR_CACHE_MAX = 500;

class Speaker {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig   speaker config block from settings
   * @param {(payload) => void} opts.onPlay  a clip is ready: {url, line, username, platform, relevancy}
   * @param {(state) => void} opts.onState   see emitState()
   * @param {(err) => void} opts.onError     {code, message}
   * @param {MaskyClient} [opts.client]      injectable for tests
   */
  constructor({ getConfig, onPlay, onState, onError, client }) {
    this.getConfig = getConfig;
    this.onPlay = onPlay;
    this.onState = onState;
    this.onError = onError;
    this.client = client || new MaskyClient();
    this.timer = null;
    this.candidate = null; // best judged message since last reading
    this.latest = null; // newest judged message (continuous "speak latest" mode)
    this.lastSpokenKey = null; // dedupe: never re-read the same message back to back
    this.balance = null; // last known credit balance (null = unknown)
    this.rendering = false;
    this.playing = false; // a finished clip is still on screen / in the speakers
    this.playTimer = null; // safety: never let a lost "done" stall continuous mode
    this.userAvatarCache = new Map(); // username → {avatar|null, at} (negatives cached too)
  }

  config() {
    return this.getConfig() || {};
  }

  /** Track judged messages while enabled; keeps only the best candidate. */
  noteJudged(msg, judgment) {
    if (!this.timer || !judgment) return;
    if (judgment.kind === "toxic") return;
    const rel = judgment.relevancy ?? 0;
    // Chat messages carry {user: {name}, source: {type}} (see
    // src/sources/*), not flat username/platform fields.
    const pick = {
      username: msg.user?.name || "a viewer",
      platform: msg.source?.type || "",
      text: msg.text,
      relevancy: rel,
      key: msg.id || `${msg.user?.name || ""}:${msg.text}`,
    };
    if (!this.candidate || rel >= this.candidate.relevancy) this.candidate = pick;
    this.latest = pick;
    // Continuous mode: an idle speaker reads the newest message immediately.
    if (this.config().speakLatest) this.maybeSpeakLatest();
  }

  start() {
    const cfg = this.config();
    this.stop();
    if (!cfg.enabled || !cfg.maskyToken) return;
    const min = INTERVALS_MIN.includes(cfg.intervalMin) ? cfg.intervalMin : 1;
    this.timer = setInterval(() => this.tick(), min * 60000);
    if (this.timer.unref) this.timer.unref();
    this.refreshBalance();
    this.emitState();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.candidate = null;
    this.latest = null;
    this.playing = false;
    clearTimeout(this.playTimer);
    this.playTimer = null;
    this.emitState();
  }

  get running() {
    return !!this.timer;
  }

  /**
   * One cadence reading: render the window's best candidate, or skip when
   * chat gave us nothing judged since the last one. `force` substitutes a
   * greeting so the settings test button always produces a clip. In
   * continuous "speak latest" mode the cadence is inert — readings are
   * driven by new messages and playback completion instead.
   */
  async tick({ force = false } = {}) {
    const cfg = this.config();
    if (cfg.speakLatest && !force) return null;
    if (this.rendering) return null;
    const candidate = this.candidate;
    this.candidate = null;
    if (!candidate && !force) return null;

    const pick = candidate || {
      username: "Jev Judge",
      platform: "hud",
      text: "Jev Judge here. The share window is connected — I will read your chat's most relevant message on schedule.",
      relevancy: 100,
    };
    return this.render(pick, { verbatim: force && !candidate });
  }

  /**
   * Continuous mode: read the newest judged message, unless we're mid-render,
   * a clip is still playing, or it's the one we just read. Called when a new
   * message lands (idle case) and when playback finishes (chained case).
   */
  maybeSpeakLatest() {
    if (!this.running || this.rendering || this.playing) return null;
    const pick = this.latest;
    if (!pick || pick.key === this.lastSpokenKey) return null;
    return this.render(pick);
  }

  /** Playback finished in the renderer — in continuous mode, chain the next. */
  notePlaybackDone() {
    this.playing = false;
    clearTimeout(this.playTimer);
    this.playTimer = null;
    if (this.running && this.config().speakLatest) this.maybeSpeakLatest();
  }

  /** Render one reading and hand the finished clip to the player. */
  async render(pick, { verbatim = false } = {}) {
    const cfg = this.config();
    if (!cfg.maskyToken) return null;
    this.rendering = true;
    this.emitState();
    try {
      const output = cfg.audioOnly ? "audio" : "video";
      const reading = await this.readingPlan(pick, cfg, verbatim);
      const { url, line, creditsCharged } = await this.client.speak({
        token: cfg.maskyToken,
        ownerUserId: reading.ownerUserId,
        avatarId: reading.avatarId,
        text: reading.text,
        output,
        // The streamer pays for the render, so their quality pick applies to
        // every video reading — including other chatters' avatars. Always
        // sent explicitly: it must also override an avatar's own default.
        quality: output === "video" ? (cfg.videoQuality === "medium" ? "medium" : "high") : undefined,
        avatarImageUrl: reading.avatarImageUrl || undefined,
      });
      if (creditsCharged != null && this.balance != null) {
        this.balance = Math.max(0, this.balance - creditsCharged);
      }
      if (pick.key) this.lastSpokenKey = pick.key;
      this.playing = true;
      // The player reports done (clip ended / errored); if that report is
      // ever lost (window closed mid-read), recover instead of stalling.
      clearTimeout(this.playTimer);
      this.playTimer = setTimeout(() => this.notePlaybackDone(), 180000);
      if (this.playTimer.unref) this.playTimer.unref();
      this.onPlay({
        url,
        line,
        username: pick.username,
        platform: pick.platform,
        relevancy: pick.relevancy,
        audio: output === "audio",
      });
      this.refreshBalance();
      return url;
    } catch (err) {
      const code = err instanceof MaskyError ? err.code : "masky_error";
      if (err instanceof MaskyError && err.availableCredits != null) {
        this.balance = err.availableCredits;
      }
      this.onError({ code, message: err.message });
      return null;
    } finally {
      this.rendering = false;
      this.emitState();
    }
  }

  compose(pick) {
    return `${pick.username} says: ${pick.text}`;
  }

  /**
   * Which avatar reads this message, and what it says. Default: the
   * configured avatar reading "<user> says: <text>". With "read with user
   * avatars" on, a chatter whose Twitch name exists on Masky with a
   * voice-ready avatar reads their own message — spoken verbatim, no
   * "says" preamble, because the avatar *is* them. Only real chat
   * messages qualify (pick.key); test greetings always use the
   * configured avatar.
   */
  async readingPlan(pick, cfg, verbatim) {
    const fallback = {
      ownerUserId: cfg.avatarOwnerUserId,
      avatarId: cfg.avatarId,
      text: verbatim ? pick.text : this.compose(pick),
    };
    if (!cfg.readUserAvatars || verbatim || !pick.key) return fallback;
    const own = await this.userAvatar(pick.username, cfg.maskyToken);
    if (!own) return fallback;
    return {
      ownerUserId: own.ownerUserId,
      avatarId: own.avatarId,
      text: pick.text,
      // The chatter's chosen stream-identity still, when they set one.
      avatarImageUrl: own.imageUrl || null,
    };
  }

  /**
   * Cached username→avatar lookup, negatives included — chat repeats the
   * same handles constantly and most of them are not on Masky. A failed
   * lookup reads as "not on Masky" for this reading (and is cached, so a
   * flaky API can't double the spend-path latency for long).
   */
  async userAvatar(username, token) {
    const key = String(username || "").trim().toLowerCase();
    if (!key) return null;
    const hit = this.userAvatarCache.get(key);
    if (hit && Date.now() - hit.at < USER_AVATAR_TTL_MS) return hit.avatar;
    let avatar = null;
    try {
      avatar = await this.client.lookupUserAvatar(token, key);
    } catch {
      avatar = null;
    }
    this.userAvatarCache.delete(key);
    if (this.userAvatarCache.size >= USER_AVATAR_CACHE_MAX) {
      this.userAvatarCache.delete(this.userAvatarCache.keys().next().value);
    }
    this.userAvatarCache.set(key, { avatar, at: Date.now() });
    return avatar;
  }

  /** Non-fatal: the balance endpoint may not be deployed yet (returns null). */
  async refreshBalance() {
    const cfg = this.config();
    if (!cfg.maskyToken) return null;
    try {
      const n = await this.client.balance(cfg.maskyToken, cfg.avatarOwnerUserId);
      if (n != null) this.balance = n;
      this.emitState();
      return n;
    } catch {
      return null;
    }
  }

  emitState() {
    this.onState({
      enabled: this.running,
      speaking: this.rendering,
      balance: this.balance,
      // whole minutes of talking the balance still buys, at the active mode's rate
      talkingMinutes:
        this.balance == null
          ? null
          : talkingMinutes(this.balance, this.config().audioOnly ? "audio" : "video"),
    });
  }
}

module.exports = { Speaker, INTERVALS_MIN };
