// "Judgement replies in chat": when the safety slider blocks a message, Jev
// replies to it in the channel naming the detected fallacy / manipulation /
// persuasion, so the sender learns why. The copy stays a lens, never a
// verdict — manipulation detection is irreducibly subjective, and stream chat
// is dense with sarcasm and copypasta.
//
// This module is pure (text building + throttling policy); main.js owns the
// actual Twitch send.

// Viewer-facing names for TECHNIQUE_CRITERIA keys (src/judge.js) — keep in sync.
const TECHNIQUE_LABELS = {
  loaded_language: "loaded / triggering language",
  reputation_attack: "an attack on someone's reputation",
  false_logic: "faulty logic (false dilemma, strawman, or a bogus appeal)",
  distraction: "deflection away from the point",
  presupposition: "a smuggled assumption",
  vagueness: "strategic vagueness / weasel wording",
  coercion: "guilt, shame, or pressure tactics",
  call_to_action: "pressure to make people act",
};

// Mirrors MANIPULATION_LEVELS rungs as short names, indexed by manipulation
// score bucket (0-100 → nearest rung).
const MANIP_NAMES = [
  "straight talk",
  "rhetorical slant",
  "persuasion techniques",
  "coercive or manipulative pressure",
];

const TECHNIQUE_CONFIDENCE_MIN = 0.5;

/**
 * The chat line Jev sends under a blocked message. Names the technique when
 * the judge is confident in one, otherwise falls back to the manipulation
 * rubric rung; appends the outcome note when the message reads as steering.
 * Always fits Twitch's 500-char cap.
 */
function judgementReplyText(username, judgment) {
  const techniqueKey =
    judgment.technique && judgment.technique !== "none" && judgment.techniqueConfidence > TECHNIQUE_CONFIDENCE_MIN
      ? judgment.technique
      : null;
  const rung = MANIP_NAMES[Math.min(MANIP_NAMES.length - 1, Math.round(((judgment.manipulation || 0) / 100) * (MANIP_NAMES.length - 1)))];
  const flaggedFor = techniqueKey ? TECHNIQUE_LABELS[techniqueKey] || techniqueKey : rung;
  const steering = (judgment.outcome || 0) >= 0.6 ? " and it reads as trying to steer people toward an outcome" : "";
  const text = `@${username} Jev flagged that message (safety ${judgment.safety}/100) for ${flaggedFor}${steering}. An AI lens, not a verdict — the streamer decides.`;
  return text.length > 500 ? text.slice(0, 500) : text;
}

/**
 * Anti-spam policy for automatic replies: at most one reply per user per
 * cooldown, and a global minimum gap so a burst of unsafe messages can't turn
 * Jev into the loudest voice in chat.
 */
class ReplyThrottle {
  constructor({ perUserMs = 120000, globalMs = 15000, nowImpl = Date.now } = {}) {
    this.perUserMs = perUserMs;
    this.globalMs = globalMs;
    this.nowImpl = nowImpl;
    this.lastGlobal = -Infinity;
    this.lastByUser = new Map();
  }

  /** True (and records the send) when a reply to `user` is allowed now. */
  allow(user) {
    const now = this.nowImpl();
    const key = String(user || "").toLowerCase();
    if (now - this.lastGlobal < this.globalMs) return false;
    const last = this.lastByUser.has(key) ? this.lastByUser.get(key) : -Infinity;
    if (now - last < this.perUserMs) return false;
    this.lastGlobal = now;
    this.lastByUser.set(key, now);
    // Bounded memory: the per-user map only needs entries younger than the cooldown.
    if (this.lastByUser.size > 500) {
      for (const [u, at] of this.lastByUser) {
        if (now - at >= this.perUserMs) this.lastByUser.delete(u);
      }
    }
    return true;
  }
}

module.exports = { judgementReplyText, ReplyThrottle, TECHNIQUE_LABELS, TECHNIQUE_CONFIDENCE_MIN };
