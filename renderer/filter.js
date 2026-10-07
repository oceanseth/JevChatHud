// Feed visibility policy, kept pure so tests can exercise it without a DOM.
// Precedence:
//   1. "see all"      → raw feed, nothing hidden.
//   2. tags selected  → only messages Jev tagged with a selected kind at >50%
//                       confidence. The relevancy slider is intentionally
//                       ignored here: kinds like toxic or chatter score near-0
//                       relevancy by design and would otherwise never surface.
//   3. otherwise      → slider metric >= threshold (the curated view). The
//                       metric is relevancy, or Jev's factuality score when
//                       "facts only" is checked — the checkbox swaps what the
//                       slider measures, it never re-judges anything.
// Unjudged messages only appear in "see all".
const KIND_CONFIDENCE_MIN = 0.5;

// Mirrors KIND_CRITERIA in src/judge.js (asserted equal in tests), ordered by
// how urgently a moderator typically needs each kind.
const KINDS = ["stream_issue", "question", "feedback", "personal", "hype", "chatter", "toxic"];

function messageVisible(judgment, { seeAll, kinds, threshold, factsOnly }) {
  if (seeAll) return true;
  if (!judgment) return false;
  if (kinds && kinds.length) {
    return kinds.includes(judgment.kind) && judgment.kindConfidence > KIND_CONFIDENCE_MIN;
  }
  // Judgments from a build without the factual score have no factuality;
  // in facts-only mode they behave like unjudged messages.
  const metric = factsOnly ? judgment.factuality : judgment.relevancy;
  return metric != null && metric >= threshold;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { messageVisible, KINDS, KIND_CONFIDENCE_MIN };
}
