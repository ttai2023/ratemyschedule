/**
 * scheduler.js  —  Schedule generation with linked-section support
 *
 * Section grouping convention (UCSD WebReg):
 *   section_id prefix letter → offering group   e.g. "A", "B"
 *   numeric suffix "00"      → lecture (LE)
 *   numeric suffix "01","02" → discussion (DI) or lab (LA)
 *
 *   MATH 183:  A00(LE)  A01(DI)  A02(DI)
 *     → bundles: [A00+A01], [A00+A02]
 *
 *   MATH 142A: A00(LE) A01(DI),  B00(LE) B01(DI)
 *     → bundles: [A00+A01], [B00+B01]   (groups are independent offerings)
 *
 * A "bundle" is the smallest enrollable unit for a course:
 *   one lecture + one discussion (if the group has DI/LA sections).
 *
 * A "schedule" = one bundle per requested course, no meeting conflicts.
 *
 * Conflict: two meetings overlap iff they share at least one calendar day
 *   AND their time intervals overlap (non-inclusive endpoints).
 *
 * Cap: MAX_CANDIDATES prevents combinatorial explosion.
 * Top-N filtering: only the top N by score are returned to the caller.
 */

import { getCourse } from "./scraping/webreg.js";

const MAX_CANDIDATES = 2000; // internal search cap before scoring

// ── Time / day helpers ────────────────────────────────────────

/** "HH:MM" → minutes since midnight. Pass-through for numbers. */
function toMins(t) {
  if (typeof t === "number") return t;
  const [h, m = "0"] = String(t).split(":");
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

/**
 * "MWF" → ["M","W","F"]   "TuTh" → ["Tu","Th"]
 * Two-char codes (Tu, Th, Sa, Su) are parsed before single-char.
 */
function expandDays(str) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    const two = str.slice(i, i + 2);
    if (two === "Tu" || two === "Th" || two === "Sa" || two === "Su") {
      out.push(two); i += 2;
    } else {
      out.push(str[i]); i += 1;
    }
  }
  return out;
}

/** Do two meeting blocks conflict? */
function meetingsConflict(a, b) {
  const aDays = new Set(expandDays(a.days ?? ""));
  const bDays = new Set(expandDays(b.days ?? ""));
  if (![...aDays].some(d => bDays.has(d))) return false;

  const aS = toMins(a.start), aE = toMins(a.end);
  const bS = toMins(b.start), bE = toMins(b.end);
  return !(aE <= bS || bE <= aS);
}

/**
 * Does a candidate bundle conflict with any already-chosen bundle?
 * All meetings of all sections in both bundles are compared.
 */
function bundleConflictsWithChosen(chosen, candidate) {
  const candMeetings = candidate.flatMap(s => s.meetings ?? []);
  for (const bundle of chosen) {
    for (const sec of bundle) {
      for (const ma of sec.meetings ?? []) {
        for (const mb of candMeetings) {
          if (meetingsConflict(ma, mb)) return true;
        }
      }
    }
  }
  return false;
}

// ── Section normaliser ────────────────────────────────────────

function normaliseSection(raw, courseCode) {
  return {
    courseCode,
    section_id:          raw.section_id,
    section_number:      raw.section_number,
    type:                raw.type,
    instructor:          raw.instructor,
    rmp_quality:         raw.rmp_quality         ?? null,
    cape_recommend_prof: raw.cape_recommend_prof ?? null,
    capeHours:           raw.capeHours           ?? null,
    meetings:            raw.meetings ?? [],
    final:               raw.final    ?? null,
    seats_total:         raw.seats_total,
    seats_available:     raw.seats_available,
    enrolled:            raw.enrolled,
    waitlist:            raw.waitlist,
    status:              raw.status,
  };
}

// ── Bundle builder ────────────────────────────────────────────

/**
 * Extract the group-letter prefix from a section_id.
 * "A00" → "A",  "B02" → "B",  "A01" → "A"
 */
function groupLetter(sectionId) {
  const m = String(sectionId ?? "").match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : "A";
}

/**
 * Build all valid enrollable bundles for one course.
 *
 * A bundle is an array of section objects the student must take together
 * (lecture + linked discussion/lab, if any).
 *
 * Strategy:
 *   1. Group sections by their prefix letter (A, B, C, …).
 *   2. Within each group, separate lectures from discussions/labs.
 *   3. Produce cartesian product: each LE × each DI (× each LA if present).
 *   4. If a group has no DI/LA, each LE is its own single-section bundle.
 *   5. If a group has DI/LA but NO lecture (edge case), bundle each DI/LA alone.
 *
 * @param {Object[]} rawSections   All sections for the course from WebReg.
 * @param {string}   courseCode    e.g. "CSE 140"
 * @returns {Array[]}  Array of bundles; each bundle is an array of normalised sections.
 */
function buildBundles(rawSections, courseCode) {
  const normalised = rawSections.map(s => normaliseSection(s, courseCode));

  // Group by prefix letter
  const groups = {};
  for (const sec of normalised) {
    const g = groupLetter(sec.section_id);
    (groups[g] ??= []).push(sec);
  }

  const bundles = [];

  for (const [, secs] of Object.entries(groups)) {
    const lectures = secs.filter(s => s.type === "LE");
    const discs    = secs.filter(s => s.type === "DI" || s.type === "LA");

    if (lectures.length === 0 && discs.length === 0) continue;

    if (lectures.length === 0) {
      // No lecture in this group — treat each disc/lab as a standalone bundle
      discs.forEach(d => bundles.push([d]));
      continue;
    }

    if (discs.length === 0) {
      // Lecture-only course or group — each lecture is its own bundle
      lectures.forEach(le => bundles.push([le]));
      continue;
    }

    // LE × DI — cartesian product (each lecture paired with each discussion)
    for (const le of lectures) {
      for (const di of discs) {
        bundles.push([le, di]);
      }
    }
  }

  return bundles;
}

// ── Main generator ────────────────────────────────────────────

/**
 * Generate all non-conflicting schedule candidates for the given courses,
 * then return the top `topN` by descending score index (scoring is done
 * by the caller via rankSchedules).
 *
 * @param {string[]} courseCodes   e.g. ["CSE 140", "MATH 183"]
 * @param {string}   term          e.g. "S126"
 * @param {Object}   [options]
 * @param {number}   [options.topN=5]          Max schedules to return.
 * @returns {{
 *   schedules:     { sections: Object[] }[],
 *   totalBundles:  number[],   bundles available per course
 *   missing:       string[],   courses not found in the schedule data
 * }}
 */
function generateSchedules(courseCodes, term, options = {}) {
  void options; // caller slices top-N after ranking

  const perCourseBundles = [];
  const totalBundles     = [];
  const missing          = [];

  for (const code of courseCodes) {
    const subj   = code.split(" ")[0].toUpperCase();
    const course = getCourse(term, subj, code.toUpperCase());

    if (!course) {
      missing.push(code);
      perCourseBundles.push([]);
      totalBundles.push(0);
      continue;
    }

    const bundles = buildBundles(course.sections ?? [], code.toUpperCase());
    perCourseBundles.push(bundles);
    totalBundles.push(bundles.length);
  }

  // Any course with zero bundles → no valid schedule possible
  if (perCourseBundles.some(b => b.length === 0)) {
    return { schedules: [], totalBundles, missing };
  }

  // Backtracking search over bundle combinations
  const schedules = [];

  function backtrack(courseIdx, chosenBundles) {
    if (schedules.length >= MAX_CANDIDATES) return;

    if (courseIdx === perCourseBundles.length) {
      // Flatten all bundles into a single sections array
      schedules.push({ sections: chosenBundles.flat() });
      return;
    }

    for (const bundle of perCourseBundles[courseIdx]) {
      if (!bundleConflictsWithChosen(chosenBundles, bundle)) {
        chosenBundles.push(bundle);
        backtrack(courseIdx + 1, chosenBundles);
        chosenBundles.pop();
        if (schedules.length >= MAX_CANDIDATES) return;
      }
    }
  }

  backtrack(0, []);

  // Return up to topN (caller will rank before slicing; we pass all for ranking)
  return { schedules, totalBundles, missing };
}

export { generateSchedules, buildBundles };
