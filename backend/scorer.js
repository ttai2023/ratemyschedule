/**
 * scorer.js
 *
 * Normalises each criterion to [0, 1] before weighting so that raw
 * magnitudes never dominate. Final score = Σ(weight_i × score_i) × 100.
 *
 * Expected section shape (from WebReg + RMP/CAPE enrichment):
 * {
 *   instructor:          string,
 *   rmp_quality?:        number,   // 1–5  (from RMP)
 *   cape_recommend_prof?:number,   // 0–100 (% who recommend prof, from CAPE)
 *   capeHours?:          number,   // avg hrs/wk (from CAPE)
 *   meetings: [{
 *     days:  string,               // "MWF" | "TuTh" | "M" | "Tu" | ...
 *     start: string,               // "10:00"  (24-h HH:MM)
 *     end:   string,               // "10:50"
 *   }],
 *   final?: {
 *     date:  string,               // "2026-08-15"
 *     start: string,               // "08:00"
 *     end:   string,               // "11:00"
 *   } | null,
 * }
 *
 * prefs shape (passed to scoreSchedule / rankSchedules):
 * {
 *   prefStart?:    number,   // preferred window start, minutes (default 600 = 10 AM)
 *   prefEnd?:      number,   // preferred window end,   minutes (default 960 = 4 PM)
 *   hardLimits?: {
 *     neverBefore?: number,  // hard cutoff — any meeting starting at/before this → 0
 *     neverAfter?:  number,  // hard cutoff — any meeting ending at/after this   → 0
 *   },
 *   dayPattern?:   "MWF" | "TuTh" | "minimize" | "any",  // default "any"
 *   minHours?:     number,   // comfortable load lower bound (default 12)
 *   maxHours?:     number,   // comfortable load upper bound (default 20)
 * }
 */

// ── Internal helpers ──────────────────────────────────────────

/** "HH:MM" → minutes since midnight. Also accepts a number (pass-through). */
function toMins(t) {
  if (typeof t === "number") return t;
  const [h, m = 0] = String(t).split(":").map(Number);
  return h * 60 + m;
}

/**
 * "MWF" → ["M","W","F"],  "TuTh" → ["Tu","Th"],  "M" → ["M"]
 * Two-char codes (Tu, Th) are parsed before single-char codes.
 */
function expandDays(daysStr) {
  const out = [];
  let i = 0;
  while (i < daysStr.length) {
    const two = daysStr.slice(i, i + 2);
    if (two === "Tu" || two === "Th") { out.push(two); i += 2; }
    else                              { out.push(daysStr[i]); i += 1; }
  }
  return out;
}

/** Section → final exam timestamp (ms), or null if no final data. */
function finalMs(sec) {
  if (!sec.final?.date || !sec.final?.start) return null;
  const ts = Date.parse(`${sec.final.date}T${sec.final.start}`);
  return isNaN(ts) ? null : ts;
}

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// ── 1. Professor quality ──────────────────────────────────────

/**
 * Blends RMP overall quality and CAPE "recommend professor" into one score.
 *
 *   rmp_norm  = (rmp_quality - 1) / 4          maps 1–5 → 0–1
 *   cape_norm = cape_recommend_prof / 100       maps 0–100% → 0–1
 *   blend     = 0.6 × rmp_norm + 0.4 × cape_norm  (when both available)
 *
 * Falls back to whichever source exists, or 0.5 if neither.
 * Averages the blended score across all sections in the schedule.
 */
function scoreProfessor(sections) {
  const scored = sections.map(s => {
    const hasRmp  = s.rmp_quality        != null && s.rmp_quality >= 1;
    const hasCape = s.cape_recommend_prof != null;

    if (!hasRmp && !hasCape) return null;

    const rmpNorm  = hasRmp  ? (s.rmp_quality - 1) / 4          : null;
    const capeNorm = hasCape ? s.cape_recommend_prof / 100       : null;

    if (rmpNorm  != null && capeNorm != null) return 0.6 * rmpNorm + 0.4 * capeNorm;
    if (rmpNorm  != null)                     return rmpNorm;
    return capeNorm;
  }).filter(v => v != null);

  if (!scored.length) return 0.5;
  return clamp(scored.reduce((a, b) => a + b, 0) / scored.length);
}

// ── 2. Time-of-day preference ─────────────────────────────────

/**
 * Scores how well meeting times fit the user's preferred window.
 *
 * For each meeting:
 *   - Hard limit triggered (neverBefore / neverAfter) → 0.0 for that meeting
 *   - Fully inside [prefStart, prefEnd]               → 1.0
 *   - Partially/fully outside                         → linear decay based on
 *     total minutes outside the window, capped at 3 hours (180 min) → 0.0
 *
 * Final score = mean across all meetings in the schedule.
 *
 * @param {Array}  sections
 * @param {number} prefStart   minutes (default 600 = 10 AM)
 * @param {number} prefEnd     minutes (default 960  =  4 PM)
 * @param {Object} hardLimits  { neverBefore?, neverAfter? }
 */
function scoreTime(sections, prefStart = 600, prefEnd = 960, hardLimits = {}) {
  const meetings = sections.flatMap(s => s.meetings ?? []);
  if (!meetings.length) return 0.5;

  const DECAY_WINDOW = 180; // minutes — full decay range outside preferred window

  const scores = meetings.map(m => {
    const start = toMins(m.start);
    const end   = toMins(m.end);

    // Hard limits — instant zero
    if (hardLimits.neverBefore != null && start <= hardLimits.neverBefore) return 0;
    if (hardLimits.neverAfter  != null && end   >= hardLimits.neverAfter)  return 0;

    if (start >= prefStart && end <= prefEnd) return 1.0;

    const earlyMins = Math.max(0, prefStart - start);
    const lateMins  = Math.max(0, end - prefEnd);
    const outsideMins = earlyMins + lateMins;

    return clamp(1 - outsideMins / DECAY_WINDOW);
  });

  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// ── 3. Final exam spread ──────────────────────────────────────

/**
 * Scores how spread out the final exam schedule is.
 *
 * Base score:
 *   min gap between any two finals → min(gapHrs, 48) / 48
 *   0 or 1 final → 1.0 (no conflict possible)
 *
 * Crunch penalty:
 *   If 3 or more finals fall within any 24-hour window, the score
 *   is hard-capped at 0.15 (severe penalty regardless of base score).
 */
function scoreFinals(sections) {
  const times = sections
    .map(finalMs)
    .filter(t => t != null)
    .sort((a, b) => a - b);

  if (times.length < 2) return 1.0;

  // Base: minimum gap between consecutive finals
  let minGapMs = Infinity;
  for (let i = 1; i < times.length; i++) {
    minGapMs = Math.min(minGapMs, times[i] - times[i - 1]);
  }
  const gapHrs   = minGapMs / (1000 * 60 * 60);
  let baseScore  = Math.min(gapHrs, 48) / 48;

  // Crunch penalty: 3+ finals within any 24-hour span
  const MS_24H = 24 * 60 * 60 * 1000;
  for (let i = 0; i + 2 < times.length; i++) {
    if (times[i + 2] - times[i] <= MS_24H) {
      baseScore = Math.min(baseScore, 0.15);
      break;
    }
  }

  return baseScore;
}

// ── 4. Day pattern preference ─────────────────────────────────

/**
 * Scores how well the schedule's day distribution matches the user's
 * preferred pattern.
 *
 * Patterns:
 *   "MWF"      → 1.0 if no TuTh classes, 0.5 if mixed, 0.3 if TuTh-only
 *   "TuTh"     → 1.0 if no MWF classes,  0.5 if mixed, 0.3 if MWF-only
 *   "minimize" → fewer distinct class days = better (1 day → 1.0, 5 → 0.0)
 *   "any"      → neutral 0.5
 */
function scoreDayPattern(sections, pattern = "any") {
  if (pattern === "any") return 0.5;

  const allDays = new Set(
    sections.flatMap(s =>
      (s.meetings ?? []).flatMap(m => expandDays(m.days ?? ""))
    )
  );

  if (pattern === "minimize") {
    return clamp(1 - (allDays.size - 1) / 4);
  }

  const MWF_DAYS  = new Set(["M", "W", "F"]);
  const TUTH_DAYS = new Set(["Tu", "Th"]);

  const hasMWF  = [...allDays].some(d => MWF_DAYS.has(d));
  const hasTuTh = [...allDays].some(d => TUTH_DAYS.has(d));

  if (pattern === "MWF") {
    if (hasMWF && !hasTuTh) return 1.0;
    if (hasMWF &&  hasTuTh) return 0.5;
    return 0.3; // TuTh-only schedule when user wants MWF
  }

  if (pattern === "TuTh") {
    if (hasTuTh && !hasMWF) return 1.0;
    if (hasTuTh &&  hasMWF) return 0.5;
    return 0.3;
  }

  return 0.5;
}

// ── 5. Difficulty / workload balance ─────────────────────────

/**
 * Uses CAPE avg_hours_per_week as a proxy for course difficulty.
 * Sums across all sections in the schedule and scores against a
 * comfortable target band [minHrs, maxHrs].
 *
 *   Inside band            → 1.0
 *   Under-loaded (<minHrs) → linear from 0.3 (0 hrs) to 1.0 (minHrs)
 *                            (a light load isn't terrible, floor at 0.3)
 *   Over-loaded  (>maxHrs) → linear decay to 0 at 2×maxHrs
 *                            (a crushing load should dominate the penalty)
 *
 * Falls back to 0.5 when no CAPE data is available for any section.
 */
function scoreDifficulty(sections, minHrs = 12, maxHrs = 20) {
  const withData = sections.filter(s => s.capeHours != null);
  if (!withData.length) return 0.5;

  const total = withData.reduce((sum, s) => sum + s.capeHours, 0);

  if (total >= minHrs && total <= maxHrs) return 1.0;

  if (total < minHrs) {
    // Light load: interpolate from 0.3 (at 0 hrs) to 1.0 (at minHrs)
    return clamp(0.3 + 0.7 * (total / minHrs));
  }

  // Heavy load: decay from 1.0 (at maxHrs) to 0.0 (at 2×maxHrs)
  return clamp(1 - (total - maxHrs) / maxHrs);
}

// ── 6. Enrollment difficulty / pass recommendation ───────────

/**
 * Computes a normalized enrollment difficulty score [0, 1] for a single section.
 *
 *   fillRate = (seats_total - seats_available) / seats_total
 *
 * If no seat data is available, returns 0 (unknown → assume easy).
 */
function scoreEnrollmentDifficulty(section) {
  const total = section.seats_total;
  const avail = section.seats_available;
  if (total == null || total <= 0 || avail == null) return 0;
  return clamp((total - avail) / total);
}

/**
 * Given the sections of a chosen schedule, recommends which to enroll in
 * during First Pass vs Second Pass.
 *
 * First Pass criteria (either):
 *   - Fill rate >= 0.5 (more than half full — high competition)
 *   - No one on waitlist AND fill rate >= 0.3 (can't recover if missed)
 *
 * Second Pass:
 *   - Everything else (high availability or active waitlist as safety net)
 *
 * Returns:
 * {
 *   label:      string,   // "First Pass: [X, Y] / Second Pass: [Z, W]"
 *   firstPass:  string[], // ["CSE 101 A00", ...]
 *   secondPass: string[], // ["CSE 105 B00", ...]
 *   details:    Array,    // per-section breakdown with reason
 * }
 */
function recommendPasses(sections) {
  const details = sections.map(section => {
    const total    = section.seats_total    ?? 0;
    const avail    = section.seats_available ?? total;
    const waitlist = section.waitlist        ?? 0;

    const fillRate   = total > 0 ? clamp((total - avail) / total) : 0;
    const noWaitlist = waitlist === 0;

    // First pass if heavily filled OR no waitlist to fall back on
    const isFirst = fillRate >= 0.5 || (noWaitlist && fillRate >= 0.3);

    // Build a human-readable reason
    const fillPct  = Math.round(fillRate * 100);
    const availPct = total > 0 ? Math.round((avail / total) * 100) : null;
    let reason;
    if (fillRate >= 0.85) {
      reason = `${fillPct}% full – very high competition`;
    } else if (fillRate >= 0.5 && !noWaitlist) {
      reason = `${fillPct}% full`;
    } else if (noWaitlist && fillRate >= 0.3) {
      reason = `No waitlist – can't recover if missed (${fillPct}% full)`;
    } else if (noWaitlist) {
      reason = `No waitlist – register early to be safe`;
    } else {
      reason = availPct != null
        ? `${availPct}% seats available${waitlist > 0 ? `, ${waitlist} on waitlist` : ""}`
        : "High availability";
    }

    return {
      courseCode:           section.courseCode,
      section_id:           section.section_id,
      fillRate:             Math.round(fillRate * 100) / 100,
      seats_available:      avail,
      seats_total:          total,
      waitlist,
      noWaitlist,
      enrollmentDifficulty: fillRate >= 0.7 ? "high" : fillRate >= 0.4 ? "medium" : "low",
      pass:                 isFirst ? "first" : "second",
      reason,
    };
  });

  // Sort first pass hardest-first, second pass easiest-first
  const firstPass  = details.filter(d => d.pass === "first")
    .sort((a, b) => b.fillRate - a.fillRate);
  const secondPass = details.filter(d => d.pass === "second")
    .sort((a, b) => a.fillRate - b.fillRate);

  const fmt  = d => `${d.courseCode} ${d.section_id}`;
  const fpStr = firstPass.length  ? firstPass.map(fmt).join(", ")  : "none";
  const spStr = secondPass.length ? secondPass.map(fmt).join(", ") : "none";

  return {
    label:      `First Pass: [${fpStr}] / Second Pass: [${spStr}]`,
    firstPass:  firstPass.map(fmt),
    secondPass: secondPass.map(fmt),
    details,
  };
}

// ── Aggregate scorer ─────────────────────────────────────────

/**
 * Score one schedule candidate.
 *
 * @param {Object} schedule   Must have a `sections` array (WebReg shape above).
 * @param {Object} weights    Normalised weights summing to 1.
 *   { professor, time, finals, days, difficulty }
 * @param {Object} prefs      See file header for full prefs shape.
 * @returns {{ score: number, breakdown: Object }}
 *   score 0–100 (integer), breakdown keys each 0–100.
 */
function scoreSchedule(schedule, weights, prefs = {}) {
  const {
    prefStart    = 10 * 60,
    prefEnd      = 16 * 60,
    hardLimits   = {},
    dayPattern   = "any",
    minHours     = 12,
    maxHours     = 20,
  } = prefs;

  const secs = schedule.sections ?? [];

  const normalised = {
    professor:  scoreProfessor(secs),
    time:       scoreTime(secs, prefStart, prefEnd, hardLimits),
    finals:     scoreFinals(secs),
    days:       scoreDayPattern(secs, dayPattern),
    difficulty: scoreDifficulty(secs, minHours, maxHours),
  };

  const weightedSum = Object.keys(normalised).reduce(
    (sum, k) => sum + (weights[k] ?? 0) * normalised[k],
    0
  );

  return {
    score:     Math.round(weightedSum * 100),
    breakdown: Object.fromEntries(
      Object.entries(normalised).map(([k, v]) => [k, Math.round(v * 100)])
    ),
  };
}

/**
 * Rank an array of schedule candidates in-place (descending score).
 * Annotates each with `.score` and `.breakdown`.
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
  scoreProfessor,
  scoreTime,
  scoreFinals,
  scoreDayPattern,
  scoreDifficulty,
  scoreEnrollmentDifficulty,
  recommendPasses,
  // helpers — useful for unit tests
  toMins,
  expandDays,
};
