/**
 * scorer.js
 *
 * Normalises each criterion to [0, 1] before weighting so that raw
 * magnitudes (RMP on a 1-5 scale, hours as a count, etc.) never
 * dominate the result.
 *
 * Final schedule score = Σ(weight_i × normalised_score_i), scaled to 0–100.
 *
 * Section shape expected by these functions:
 *   {
 *     rmp?:       number,           // RMP rating 1–5
 *     meetings?:  { day: string,    // "Mon" | "Tue" | ...
 *                   start: number,  // minutes since midnight
 *                   end:   number },
 *     finalTime?: Date | number,    // ms timestamp or Date object
 *     capeHours?: number,           // avg hrs/wk from CAPE
 *   }
 */

"use strict";

// ── Individual normalised scoring functions ───────────────────

/**
 * Professor quality.
 * Maps RMP 1–5 → 0–1 linearly: (rmp - 1) / 4
 * Averages across all sections in the schedule.
 * Falls back to 0.5 when no RMP data is available.
 */
function scoreRmp(sections) {
  const rated = sections.filter(s => s.rmp != null && s.rmp >= 1);
  if (!rated.length) return 0.5;
  const mean = rated.reduce((sum, s) => sum + s.rmp, 0) / rated.length;
  return Math.min(1, Math.max(0, (mean - 1) / 4));
}

/**
 * Time-of-day preference.
 *
 * Returns 1.0 when every meeting falls fully inside [prefStart, prefEnd].
 * Penalises proportionally to the fraction of meeting time outside the window.
 * Averages the per-meeting scores across all meetings in the schedule.
 *
 * @param {Array}  sections
 * @param {number} prefStart  Minutes since midnight (e.g. 9*60 = 540 for 9 AM)
 * @param {number} prefEnd    Minutes since midnight (e.g. 17*60 = 1020 for 5 PM)
 */
function scoreTime(sections, prefStart, prefEnd) {
  const meetings = sections.flatMap(s => s.meetings ?? []);
  if (!meetings.length) return 0.5;

  const scores = meetings.map(m => {
    if (m.start >= prefStart && m.end <= prefEnd) return 1.0;
    const earlyOverlap = Math.max(0, prefStart - m.start);
    const lateOverlap  = Math.max(0, m.end   - prefEnd);
    const duration     = m.end - m.start;
    if (duration <= 0) return 0.5;
    return Math.max(0, 1 - (earlyOverlap + lateOverlap) / duration);
  });

  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Finals spread.
 *
 * Scores the minimum gap between any two finals in the schedule:
 *   gap >= 48 hrs → 1.0 (two full days apart, perfect)
 *   gap == 0 hrs  → 0.0 (same timeslot, worst case)
 *   linear in between: min(gapHrs, 48) / 48
 *
 * Schedules with 0 or 1 final score 1.0 (no conflict possible).
 */
function scoreFinals(sections) {
  const times = sections
    .map(s => s.finalTime)
    .filter(t => t != null)
    .map(t => (t instanceof Date ? t.getTime() : Number(t)))
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b);

  if (times.length < 2) return 1.0;

  let minGapMs = Infinity;
  for (let i = 1; i < times.length; i++) {
    minGapMs = Math.min(minGapMs, times[i] - times[i - 1]);
  }

  const gapHrs = minGapMs / (1000 * 60 * 60);
  return Math.min(gapHrs, 48) / 48;
}

/**
 * Days-off preference.
 *
 * Base score: fewer distinct class days = better.
 *   1 day  → 1.0
 *   5 days → 0.0
 *   linear: 1 - (classDays - 1) / 4
 *
 * If the user specified preferred days off, a 30% bonus is applied
 * based on the fraction of those days that are actually free.
 *
 * @param {Array} sections
 * @param {Set}   preferredDaysOff  e.g. new Set(["Fri"])
 */
function scoreDaysOff(sections, preferredDaysOff = new Set()) {
  const classDays = new Set(
    sections.flatMap(s => (s.meetings ?? []).map(m => m.day))
  );

  const baseScore = Math.max(0, 1 - (classDays.size - 1) / 4);

  if (!preferredDaysOff.size) return baseScore;

  const freedCount = [...preferredDaysOff].filter(d => !classDays.has(d)).length;
  const bonusFrac  = freedCount / preferredDaysOff.size;

  return Math.max(0, Math.min(1, baseScore * 0.7 + bonusFrac * 0.3));
}

/**
 * Difficulty balance (via CAPE weekly hours).
 *
 * Scores 1.0 when total estimated hrs/wk falls inside [minHrs, maxHrs].
 * Linear penalty outside the range:
 *   - Under-loaded: score = totalHrs / minHrs  (0 hrs → 0.0)
 *   - Over-loaded:  score decays to 0 at 2×maxHrs
 *
 * Falls back to 0.5 when no CAPE data is available.
 *
 * @param {Array}  sections
 * @param {number} minHrs  Lower bound of comfortable range (default 10)
 * @param {number} maxHrs  Upper bound of comfortable range (default 20)
 */
function scoreDifficulty(sections, minHrs = 10, maxHrs = 20) {
  const withData = sections.filter(s => s.capeHours != null);
  if (!withData.length) return 0.5;

  const total = withData.reduce((sum, s) => sum + s.capeHours, 0);

  if (total >= minHrs && total <= maxHrs) return 1.0;
  if (total < minHrs) return Math.max(0, total / minHrs);

  // Over-loaded: linear decay to 0 at 2× maxHrs
  return Math.max(0, 1 - (total - maxHrs) / maxHrs);
}

// ── Aggregate scorer ─────────────────────────────────────────

/**
 * Score one schedule candidate.
 *
 * @param {Object} schedule      Must have a `sections` array.
 *
 * @param {Object} weights       Normalised, must sum to 1.
 *   { professor, time, finals, days, difficulty }
 *   Use computeWeights() in the extension's popup.js to produce this.
 *
 * @param {Object} [prefs]       User preference overrides.
 *   {
 *     prefStart?:        number,   // minutes (default 540 = 9 AM)
 *     prefEnd?:          number,   // minutes (default 1020 = 5 PM)
 *     preferredDaysOff?: Set,      // e.g. new Set(["Fri"])
 *     minHours?:         number,   // default 10
 *     maxHours?:         number,   // default 20
 *   }
 *
 * @returns {{ score: number, breakdown: Object }}
 *   score is 0–100 (integer).
 *   breakdown mirrors the weights keys, each 0–100.
 */
function scoreSchedule(schedule, weights, prefs = {}) {
  const {
    prefStart        = 9  * 60,
    prefEnd          = 17 * 60,
    preferredDaysOff = new Set(),
    minHours         = 10,
    maxHours         = 20,
  } = prefs;

  const secs = schedule.sections ?? [];

  const normalised = {
    professor:  scoreRmp(secs),
    time:       scoreTime(secs, prefStart, prefEnd),
    finals:     scoreFinals(secs),
    days:       scoreDaysOff(secs, preferredDaysOff),
    difficulty: scoreDifficulty(secs, minHours, maxHours),
  };

  const weightedSum = Object.keys(normalised).reduce((sum, k) => {
    return sum + (weights[k] ?? 0) * normalised[k];
  }, 0);

  return {
    score:     Math.round(weightedSum * 100),
    breakdown: Object.fromEntries(
      Object.entries(normalised).map(([k, v]) => [k, Math.round(v * 100)])
    ),
  };
}

/**
 * Rank an array of schedule candidates.
 * Annotates each with `.score` and `.breakdown`, then sorts descending.
 *
 * @param {Array}  candidates
 * @param {Object} weights     { professor, time, finals, days, difficulty } summing to 1
 * @param {Object} [prefs]     See scoreSchedule
 * @returns {Array}            Sorted candidates, highest score first
 */
function rankSchedules(candidates, weights, prefs = {}) {
  for (const c of candidates) {
    const { score, breakdown } = scoreSchedule(c, weights, prefs);
    c.score     = score;
    c.breakdown = breakdown;
  }
  return candidates.sort((a, b) => b.score - a.score);
}

export {
  rankSchedules,
  scoreSchedule,
  scoreRmp,
  scoreTime,
  scoreFinals,
  scoreDaysOff,
  scoreDifficulty,
};
