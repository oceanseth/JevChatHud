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
    this.balance = null; // last known credit balance (null = unknown)
    this.rendering = false;
  }

  config() {
    return this.getConfig() || {};
  }

  /** Track judged messages while enabled; keeps only the best candidate. */
  noteJudged(msg, judgment) {
    if (!this.timer || !judgment) return;
    if (judgment.kind === "toxic") return;
    const rel = judgment.relevancy ?? 0;
    if (!this.candidate || rel >= this.candidate.relevancy) {
      this.candidate = {
        username: msg.username,
        platform: msg.platform,
        text: msg.text,
        relevancy: rel,
      };
    }
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
    this.emitState();
  }

  get running() {
    return !!this.timer;
  }

  /**
   * One reading: render the window's best candidate, or skip when chat gave
   * us nothing judged since the last one. `force` substitutes a greeting so
   * the settings test button always produces a clip.
   */
  async tick({ force = false } = {}) {
    const cfg = this.config();
    if (this.rendering) return null;
    const candidate = this.candidate;
    this.candidate = null;
    if (!candidate && !force) return null;
    if (!cfg.maskyToken) return null;

    const pick = candidate || {
      username: "Jev Judge",
      platform: "hud",
      text: "Jev Judge here. The share window is connected — I will read your chat's most relevant message on schedule.",
      relevancy: 100,
    };

    this.rendering = true;
    this.emitState();
    try {
      const { url, line, creditsCharged } = await this.client.speak({
        token: cfg.maskyToken,
        ownerUserId: cfg.avatarOwnerUserId,
        avatarId: cfg.avatarId,
        text: force && !candidate ? pick.text : this.compose(pick),
      });
      if (creditsCharged != null && this.balance != null) {
        this.balance = Math.max(0, this.balance - creditsCharged);
      }
      this.onPlay({
        url,
        line,
        username: pick.username,
        platform: pick.platform,
        relevancy: pick.relevancy,
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
      // whole minutes of talking video the balance still buys
      talkingMinutes: this.balance == null ? null : talkingMinutes(this.balance),
    });
  }
}

module.exports = { Speaker, INTERVALS_MIN };
