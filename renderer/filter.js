// Feed visibility policy, kept pure so tests can exercise it without a DOM.
// Precedence:
//   1. "see all"      → raw feed, nothing hidden.
//   2. tags selected  → only messages Jev tagged with a selected kind at >50%
//                       confidence. The relevancy slider is intentionally
//                       ignored here: kinds like toxic or chatter score near-0
//                       relevancy by design and would otherwise never surface.
//   3. otherwise      → relevancy >= threshold (the curated view).
// Unjudged messages only appear in "see all".
const KIND_CONFIDENCE_MIN = 0.5;

// Mirrors KIND_CRITERIA in src/judge.js (asserted equal in tests), ordered by
// how urgently a moderator typically needs each kind.
const KINDS = ["stream_issue", "question", "feedback", "personal", "hype", "chatter", "toxic"];

function messageVisible(judgment, { seeAll, kinds, threshold }) {
  if (seeAll) return true;
  if (!judgment) return false;
  if (kinds && kinds.length) {
    return kinds.includes(judgment.kind) && judgment.kindConfidence > KIND_CONFIDENCE_MIN;
  }
  return judgment.relevancy >= threshold;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { messageVisible, KINDS, KIND_CONFIDENCE_MIN };
}
