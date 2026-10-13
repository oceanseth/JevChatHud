// Jev judge: batches incoming chat messages and asks TypeSafe for structured
// judgments. One request carries the whole batch (speculative fan-out): per
// message a Score for attention-worthiness, a safety battery (manipulation
// Score + outcome Noul + technique Choice, summed into one safety score), and
// a Choice for the message kind — all in a single forward pass. Code owns the
// policy: the HUD's sliders threshold the raw scores; sliding never re-runs
// inference.
const { TypeSafeClient, score, choice, noul } = require("@typesafe-ai/sdk");

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

// Ordered manipulation rubric, indexed from zero — the heart of the safety
// lens. Framing follows the persuasion/manipulation literature: the SemEval-
// 2023 Task 3 persuasion-technique taxonomy (23 techniques under 6 coarse
// families), MAFALDA's unified fallacy taxonomy (NAACL 2024), and MentalManip
// (ACL 2024) for coercive manipulation in dialogue. The research's key
// empirical lesson: detectors are reliable at the coarse level and shaky at
// fine technique names — so the score carries the policy and the technique
// Choice below is presented as a hypothesis, never a verdict.
const MANIPULATION_LEVELS = [
  "Straight talk: a plain statement, question, or reaction with no rhetorical pressure beyond its content.",
  "Rhetorical slant: opinionated framing, one-sided emphasis, or mild exaggeration — ordinary persuasion that is transparent about being persuasion.",
  "Persuasion techniques at work: loaded or triggering language, a smuggled presupposition, strategic ambiguity, a bogus appeal to fear, authority, or the crowd, or a recognizable logical fallacy doing real argumentative work.",
  "Coercive or manipulative: threats, pressure, guilt or shame leverage, gaslighting, bait engineered to provoke a pile-on, or a constructed narrative built to force an outcome or obscure the truth.",
];

// Fallacy / persuasion-technique families, condensed from SemEval-2023's six
// families plus MentalManip's coercion taxonomy. One Choice per message names
// the DOMINANT family — coarse on purpose; fine-grained fallacy naming is
// where detectors (humans included) stop agreeing.
const TECHNIQUE_CRITERIA = {
  none: "No technique: a plain statement, question, reaction, or transparent opinion arguing in good faith.",
  loaded_language: "Manipulative wording: emotionally loaded or triggering words, exaggeration, fear or outrage bait chosen to provoke a reaction rather than inform.",
  reputation_attack: "Attack on reputation: name-calling, smears, mockery, guilt by association, or attacking the person instead of the point.",
  false_logic: "Faulty logic dressed as reasoning: false dilemma, strawman, causal oversimplification, or a bogus appeal to authority or popularity.",
  distraction: "Distraction: dodging the actual point with whataboutism, a red herring, or an abrupt topic shift.",
  presupposition: "Smuggled assumption: states something indirectly by presupposing it, e.g. a loaded question whose premise was never established.",
  vagueness: "Strategic vagueness: weasel words, undefined quantifiers, or claims kept too slippery to ever pin down or verify.",
  coercion: "Coercive pressure: guilt-tripping, shaming, threats, intimidation, gaslighting, or playing the victim to force compliance.",
  call_to_action: "Outcome push: pressuring the streamer or audience to do something — follow, raid, donate, ban, boycott — rather than saying something.",
};

// The safety battery's parts sum into one 0-100 safety score (100 = straight
// talk, 0 = coercive manipulation certain to be steering): the manipulation
// rubric carries double weight, the outcome-seeking probability the rest.
// The technique Choice names the flag but never moves the number.
function safetyFromAnswers(manip, outcome) {
  const manipRisk = manip.score / (MANIPULATION_LEVELS.length - 1);
  const risk = (manipRisk * 2 + outcome.noul) / 3;
  return 100 - Math.round(risk * 100);
}

const KIND_CRITERIA = {
  question: "A direct question addressed to the streamer.",
  stream_issue: "Reports a technical problem with the stream itself: no audio, lag, frozen video, wrong scene.",
  feedback: "Concrete feedback, a suggestion, or useful information about the content or gameplay.",
  personal: "A viewer sharing something personal or emotionally significant.",
  hype: "Hype, praise, emotes, or a generic reaction.",
  chatter: "Small talk, or conversation aimed at other chatters rather than the streamer.",
  toxic: "Insults, harassment, spam, or bait the streamer should not engage with.",
};

// Raw answers for `messages[i]` → the judgment object the HUD consumes.
function judgmentFromAnswers(answers, i) {
  const rel = answers[`m${i}_relevance`];
  const manip = answers[`m${i}_manip`];
  const outcome = answers[`m${i}_outcome`];
  const technique = answers[`m${i}_technique`];
  const kind = answers[`m${i}_kind`];
  return {
    relevancy: Math.round((rel.score / (RELEVANCE_LEVELS.length - 1)) * 100),
    relevanceConfidence: rel.confidence,
    safety: safetyFromAnswers(manip, outcome),
    safetyConfidence: manip.confidence,
    manipulation: Math.round((manip.score / (MANIPULATION_LEVELS.length - 1)) * 100),
    outcome: outcome.noul,
    technique: technique.choice,
    techniqueConfidence: technique.confidence,
    kind: kind.choice,
    kindConfidence: kind.confidence,
  };
}

class Judge {
  /**
   * @param {object} opts
   * @param {() => {typesafeApiKey: string, model: string}} opts.getConfig
   * @param {() => {name: string, context: string}|null} opts.getProfile
   * @param {() => string} [opts.getSpeech] recent streamer speech (mic STT), "" if none
   * @param {(id: string, judgment: object|null) => void} opts.onJudged
   * @param {(stats: object) => void} opts.onStats
   */
  constructor({ getConfig, getProfile, getSpeech, onJudged, onStats }) {
    this.getConfig = getConfig;
    this.getProfile = getProfile;
    this.getSpeech = getSpeech || (() => "");
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
    // When the mic is listening, the streamer's recent speech is the sharpest
    // relevancy context there is: "relevant to what I'm talking about right
    // now". It rides along as state; omitted entirely when there is none.
    const speech = (this.getSpeech() || "").trim();
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
    if (speech) state.streamer_speech = speech;
    const contextRefs = speech
      ? "`stream_context`, `streamer_speech` (what the streamer has said out loud in the last minute), and `recent_chat`"
      : "`stream_context` and `recent_chat`";
    const questions = {};
    batch.forEach((m, i) => {
      questions[`m${i}_relevance`] = score(
        `Considering ${contextRefs}, how much does chat message \`messages[${i}]\` deserve the streamer's personal attention right now?`,
        RELEVANCE_LEVELS
      );
      questions[`m${i}_manip`] = score(
        `How manipulative is chat message \`messages[${i}]\` in how it tries to work on the streamer or audience? Judge the rhetorical mechanics, not whether you agree with it. Stream chat is dense with sarcasm, memes, and copypasta — ironic or meme text is not manipulation.`,
        MANIPULATION_LEVELS
      );
      questions[`m${i}_outcome`] = noul(
        `Is chat message \`messages[${i}]\` trying to get the streamer or audience to do, believe, or feel something specific beyond its literal content?`
      );
      questions[`m${i}_technique`] = choice(
        `Which persuasion or manipulation technique family, if any, is dominant in chat message \`messages[${i}]\`?`,
        TECHNIQUE_CRITERIA
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
      batch.forEach((m, i) => this.onJudged(m.id, judgmentFromAnswers(response.answers, i)));
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

  /**
   * Judge one drafted message the streamer is about to send — the composer's
   * pre-send preview. Runs outside the batch pipeline: the draft sees the same
   * recent-chat/speech context a real send would, but is not chat itself, so
   * it never enters `recent` and never counts as judged. Returns the judgment,
   * or null when no key is configured or the request fails (both recorded in
   * stats like any other judge outcome).
   */
  async preview(msg) {
    const config = this.getConfig();
    if (!config.typesafeApiKey) return null;
    try {
      const client = this.client || (this.client = new TypeSafeClient({ apiKey: config.typesafeApiKey }));
      const { state, questions } = this.buildRequest([msg]);
      const response = await client.systemOne({
        state,
        model: config.model || "jev-latest",
        questions,
      });
      this.stats.requests++;
      const inputTokens = response.usage?.input_tokens || 0;
      this.stats.inputTokens += inputTokens;
      this.stats.costUsd += (inputTokens / 1e6) * PRICE_PER_MTOK;
      this.onStats(this.stats);
      return judgmentFromAnswers(response.answers, 0);
    } catch (err) {
      this.client = null;
      this.stats.errors++;
      this.stats.lastError = String(err.message || err);
      this.onStats(this.stats);
      return null;
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

module.exports = { Judge, RELEVANCE_LEVELS, MANIPULATION_LEVELS, TECHNIQUE_CRITERIA, KIND_CRITERIA, safetyFromAnswers };
