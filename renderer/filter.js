// Feed visibility policy, kept pure so tests can exercise it without a DOM.
// Precedence:
//   1. Jev filtering off (the Judge's eyes are closed) → raw feed, nothing
//      hidden. The filter rows are hidden in the UI while this is the case.
//   2. tags selected  → only messages Jev tagged with a selected kind at >50%
//                       confidence. The sliders are intentionally ignored
//                       here: kinds like toxic or chatter score near-0
//                       relevancy by design and would otherwise never surface.
//   3. otherwise      → both slider thresholds must pass (they AND together).
//                       A slider at 0 is no constraint, so relevancy-only and
//                       factual-only curation are both just positions of the
//                       two sliders. Thresholding never re-judges anything.
// Unjudged messages only appear when filtering is off. Judgments from a build
// before the factual score exist fail any factual threshold > 0.
const KIND_CONFIDENCE_MIN = 0.5;

// Mirrors KIND_CRITERIA in src/judge.js (asserted equal in tests), ordered by
// how urgently a moderator typically needs each kind.
const KINDS = ["stream_issue", "question", "feedback", "personal", "hype", "chatter", "toxic"];

function messageVisible(judgment, { filtering = true, kinds, relevancyMin = 0, factualMin = 0 }) {
  if (!filtering) return true;
  if (!judgment) return false;
  if (kinds && kinds.length) {
    return kinds.includes(judgment.kind) && judgment.kindConfidence > KIND_CONFIDENCE_MIN;
  }
  if (judgment.relevancy < relevancyMin) return false;
  if (factualMin > 0 && !(judgment.factuality != null && judgment.factuality >= factualMin)) return false;
  return true;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { messageVisible, KINDS, KIND_CONFIDENCE_MIN };
}
