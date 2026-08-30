'use strict';

/**
 * Variance protocol from PRD §6.5.
 *
 * The same prompt run twice can produce different outputs, and a judge model can
 * score identical outputs differently. So "base scored 4, head scored 3" tells you
 * nothing on its own. Every comparison here is made against an observed noise floor.
 *
 * Correctness bias, per §10: a false regression is worse than a missed one, because
 * it destroys trust in the gate. When in doubt, report inconclusive.
 */

/** Median of a score array. Even-length arrays average the two middle values. */
function median(scores) {
  if (!Array.isArray(scores) || scores.length === 0) {
    throw new Error('median requires a non-empty array of scores');
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Observed spread across runs: max minus min. Zero for a single run. */
function spread(scores) {
  if (!Array.isArray(scores) || scores.length === 0) {
    throw new Error('spread requires a non-empty array of scores');
  }
  return Math.max(...scores) - Math.min(...scores);
}

/**
 * The noise floor for a case is the spread observed on the BASE version (§6.5 step 3).
 * The base is the control: it tells us how much this case moves when nothing changed.
 *
 * Deterministic assertions have a noise floor of zero by construction, so a flipped
 * assertion is always a real regression (§6.2).
 */
function noiseFloor(baseScores) {
  return spread(baseScores);
}

/**
 * Classify one case into improved | regressed | flat | inconclusive.
 *
 * §6.5 step 4: a case is reported as a regression only when the median dropped AND
 * the drop *exceeds* the noise floor. "Exceeds" is strict — a drop exactly equal to
 * the noise floor is inconclusive, not a regression. That boundary is the whole
 * difference between a credible gate and a noise generator.
 */
function classify(baseScores, headScores) {
  const baseMedian = median(baseScores);
  const headMedian = median(headScores);
  const floor = noiseFloor(baseScores);
  const delta = headMedian - baseMedian;

  let outcome;
  if (delta === 0) {
    outcome = 'flat';
  } else if (Math.abs(delta) > floor) {
    outcome = delta > 0 ? 'improved' : 'regressed';
  } else {
    outcome = 'inconclusive';
  }

  return {
    outcome,
    delta,
    noiseFloor: floor,
    baseMedian,
    headMedian,
    baseSpread: floor,
    headSpread: spread(headScores),
  };
}

/** Roll case verdicts up into the run-level verdict shown on the run view (§8.3). */
function summarize(verdicts) {
  const counts = { improved: 0, regressed: 0, flat: 0, inconclusive: 0 };
  for (const v of verdicts) counts[v.outcome]++;

  let verdict;
  if (counts.regressed > 0) verdict = 'regressions';
  else if (counts.inconclusive > 0) verdict = 'inconclusive';
  else verdict = 'clean';

  return { counts, verdict };
}

module.exports = { median, spread, noiseFloor, classify, summarize };
