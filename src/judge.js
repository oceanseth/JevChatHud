// Jev judge: batches incoming chat messages and asks TypeSafe for structured
// judgments. One request carries the whole batch (speculative fan-out): per
// message a Score for attention-worthiness and a Choice for the message kind.
// Code owns the policy: the HUD's relevancy slider thresholds the raw scores.
const { TypeSafeClient, score, choice } = require("@typesafe-ai/sdk");

const FLUSH_MS = 1200;
const MAX_BATCH = 8;
const MAX_INFLIGHT = 2;
const RECENT_CONTEXT = 12; // prior messages included as conversational context
const PRICE_PER_MTOK = 0.042;

// Ordered rubric, indexed from zero. Expected score / 3 * 100 = relevancy.
const RELEVANCE_LEVELS = [
  "Routine chatter the streamer can ignore: greetings, emote spam, generic hype, copypasta, or talk between chatters that needs nothing from the streamer.",
  "Mildly interesting: light small talk or a passing comment the streamer could acknowledge, but nothing is lost by skipping it.",
  "Worth noticing soon: a genuine question, concrete feedback, a viewer sharing something personal, or information relevant to what the streamer is doing.",
  "Needs the streamer now: a direct question the viewer is waiting on, a report that the stream itself is broken (no audio, frozen video, wrong scene), a raid or large donation, a safety issue, or other time-sensitive information.",
];

const KIND_CRITERIA = {
  question: "A direct question addressed to the streamer.",
  stream_issue: "Reports a technical problem with the stream itself: no audio, lag, frozen video, wrong scene.",
  feedback: "Concrete feedback, a suggestion, or useful information about the content or gameplay.",
  personal: "A viewer sharing something personal or emotionally significant.",
  hype: "Hype, praise, emotes, or a generic reaction.",
  chatter: "Small talk, or conversation aimed at other chatters rather than the streamer.",
  toxic: "Insults, harassment, spam, or bait the streamer should not engage with.",
};

class Judge {
  /**
   * @param {object} opts
   * @param {() => {typesafeApiKey: string, model: string}} opts.getConfig
   * @param {() => {name: string, context: string}|null} opts.getProfile
   * @param {(id: string, judgment: object|null) => void} opts.onJudged
   * @param {(stats: object) => void} opts.onStats
   */
  constructor({ getConfig, getProfile, onJudged, onStats }) {
    this.getConfig = getConfig;
    this.getProfile = getProfile;
    this.onJudged = onJudged;
    this.onStats = onStats;
    this.queue = [];
    this.recent = []; // rolling window of already-seen messages for context
    this.inflight = 0;
    this.timer = null;
    this.stats = { judged: 0, requests: 0, errors: 0, inputTokens: 0, costUsd: 0, lastError: null };
  }

  enqueue(msg) {
    this.queue.push(msg);
    if (this.queue.length >= MAX_BATCH) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.queue.length || this.inflight >= MAX_INFLIGHT) return;
    const batch = this.queue.splice(0, MAX_BATCH);
    this.judgeBatch(batch);
    if (this.queue.length) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  buildRequest(batch) {
    const profile = this.getProfile() || {};
    const state = {
      setting:
        "You are watching the live chat of a livestream. The streamer wants to know which messages deserve their personal attention while they perform.",
      stream_context: profile.context || "No extra context provided by the streamer.",
      recent_chat: this.recent.map((m) => ({ user: m.user.name, text: m.text })),
      messages: batch.map((m) => ({
        platform: m.source.type,
        user: m.user.name,
        text: m.text,
      })),
    };
    const questions = {};
    batch.forEach((m, i) => {
      questions[`m${i}_relevance`] = score(
        `Considering \`stream_context\` and \`recent_chat\`, how much does chat message \`messages[${i}]\` deserve the streamer's personal attention right now?`,
        RELEVANCE_LEVELS
      );
      questions[`m${i}_kind`] = choice(
        `What kind of message is \`messages[${i}]\`?`,
        KIND_CRITERIA
      );
    });
    return { state, questions };
  }

  async judgeBatch(batch) {
    const config = this.getConfig();
    if (!config.typesafeApiKey) {
      for (const m of batch) this.onJudged(m.id, null);
      this.stats.lastError = "no TypeSafe API key configured";
      this.onStats(this.stats);
      return;
    }
    this.inflight++;
    try {
      const client = this.client || (this.client = new TypeSafeClient({ apiKey: config.typesafeApiKey }));
      const { state, questions } = this.buildRequest(batch);
      const response = await client.systemOne({
        state,
        model: config.model || "jev-latest",
        questions,
      });
      batch.forEach((m, i) => {
        const rel = response.answers[`m${i}_relevance`];
        const kind = response.answers[`m${i}_kind`];
        const maxLevel = RELEVANCE_LEVELS.length - 1;
        this.onJudged(m.id, {
          relevancy: Math.round((rel.score / maxLevel) * 100),
          relevanceConfidence: rel.confidence,
          kind: kind.choice,
          kindConfidence: kind.confidence,
        });
      });
      this.stats.judged += batch.length;
      this.stats.requests++;
      const inputTokens = response.usage?.input_tokens || 0;
      this.stats.inputTokens += inputTokens;
      this.stats.costUsd += (inputTokens / 1e6) * PRICE_PER_MTOK;
    } catch (err) {
      // API key changes should produce a fresh client on the next batch
      this.client = null;
      this.stats.errors++;
      this.stats.lastError = String(err.message || err);
      for (const m of batch) this.onJudged(m.id, null);
    } finally {
      this.inflight--;
      for (const m of batch) {
        this.recent.push(m);
        if (this.recent.length > RECENT_CONTEXT) this.recent.shift();
      }
      this.onStats(this.stats);
      if (this.queue.length) this.flush();
    }
  }

  reset() {
    clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.recent = [];
    this.client = null;
  }
}

module.exports = { Judge, RELEVANCE_LEVELS, KIND_CRITERIA };
