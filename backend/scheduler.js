/**
 * scheduler.js
 *
 * 3B: Schedule Generation
 *
 * Takes a list of course codes, looks up all their sections from memory,
 * and generates every valid (non-conflicting) combination of one section
 * per course.
 *
 * A "schedule" is:
 * {
 *   sections: [
 *     { courseCode, section_id, instructor, rmp_quality?, cape_recommend_prof?,
 *       capeHours?, meetings: [{days, start, end}], final? }
 *   ]
 * }
 *
 * Conflict rules:
 *   - Two meeting blocks overlap if one starts before the other ends,
 *     on at least one shared day.
 *   - Finals conflicts are not pruned here — scorer penalises them instead.
 *
 * Cap: MAX_CANDIDATES prevents combinatorial explosion. Returns the first
 * MAX_CANDIDATES valid combinations found (breadth-first over sections).
 */

import { getCourse } from "./scraping/webreg.js";

const MAX_CANDIDATES = 500;

// ── Helpers ───────────────────────────────────────────────────

/** "HH:MM" → minutes since midnight. */
function toMins(t) {
  if (typeof t === "number") return t;
  const [h, m = 0] = String(t).split(":").map(Number);
  return h * 60 + m;
}

/**
 * "MWF" → ["M","W","F"],  "TuTh" → ["Tu","Th"],  "Sa" → ["Sa"]
 * Two-char codes are parsed first.
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

/**
 * Do two meeting blocks conflict?
 * Each block: { days: "MWF", start: "10:00", end: "10:50" }
 */
function meetingsConflict(a, b) {
  const aDays = new Set(expandDays(a.days ?? ""));
  const bDays = new Set(expandDays(b.days ?? ""));
  const sharedDay = [...aDays].some(d => bDays.has(d));
  if (!sharedDay) return false;

  const aStart = toMins(a.start);
  const aEnd   = toMins(a.end);
  const bStart = toMins(b.start);
  const bEnd   = toMins(b.end);

  // Overlap: not (aEnd <= bStart || bEnd <= aStart)
  return !(aEnd <= bStart || bEnd <= aStart);
}

/**
 * Does adding `candidate` section conflict with any already-chosen section?
 * @param {Object[]} chosen   Already-selected sections.
 * @param {Object}   candidate  Section to test.
 */
function conflictsWithChosen(chosen, candidate) {
  for (const sec of chosen) {
    for (const ma of sec.meetings ?? []) {
      for (const mb of candidate.meetings ?? []) {
        if (meetingsConflict(ma, mb)) return true;
      }
    }
  }
  return false;
}

// ── Section normaliser ────────────────────────────────────────

/**
 * Convert a raw WebReg section object into the shape scorer.js expects,
 * keeping the original fields intact and adding courseCode.
 */
function normaliseSection(rawSection, courseCode) {
  return {
    courseCode,
    section_id:          rawSection.section_id,
    section_number:      rawSection.section_number,
    type:                rawSection.type,
    instructor:          rawSection.instructor,
    // Professor enrichment fields (populated later by enrichSections)
    rmp_quality:         rawSection.rmp_quality         ?? null,
    cape_recommend_prof: rawSection.cape_recommend_prof ?? null,
    capeHours:           rawSection.capeHours           ?? null,
    meetings:            rawSection.meetings ?? [],
    final:               rawSection.final   ?? null,
    seats_total:         rawSection.seats_total,
    seats_available:     rawSection.seats_available,
    enrolled:            rawSection.enrolled,
    waitlist:            rawSection.waitlist,
    status:              rawSection.status,
  };
}

// ── Main generator ────────────────────────────────────────────

/**
 * Generate valid schedule candidates.
 *
 * @param {string[]} courseCodes   e.g. ["CSE 100", "CSE 101", "MATH 183"]
 * @param {string}   term          e.g. "S126"
 * @param {Object}   [options]
 * @param {string[]} [options.sectionTypes]  Only include these types.
 *   Default: ["LE"] (lectures only). Pass ["LE","DI","LA"] to include
 *   discussions/labs, but note: the combinatorial explosion is much larger.
 * @returns {{ schedules: Object[], totalSections: number[] }}
 *   schedules: up to MAX_CANDIDATES { sections: [...] } objects
 *   totalSections: number of available sections per course (for diagnostics)
 */
function generateSchedules(courseCodes, term, options = {}) {
  const { sectionTypes = ["LE"] } = options;

  // Build a list-of-lists: perCourse[i] = sections available for courseCodes[i]
  const perCourse = [];
  const totalSections = [];

  for (const code of courseCodes) {
    const subj = code.split(" ")[0].toUpperCase();
    const course = getCourse(term, subj, code.toUpperCase());

    if (!course) {
      // Unknown course — treat as a course with zero sections (will yield 0 schedules)
      perCourse.push([]);
      totalSections.push(0);
      continue;
    }

    const sections = (course.sections ?? [])
      .filter(s => sectionTypes.includes(s.type))
      .map(s => normaliseSection(s, code.toUpperCase()));

    perCourse.push(sections);
    totalSections.push(sections.length);
  }

  // Short-circuit: if any course has no sections, no valid schedule is possible
  if (perCourse.some(list => list.length === 0)) {
    return { schedules: [], totalSections };
  }

  // Backtracking combination search
  const schedules = [];

  function backtrack(courseIdx, chosen) {
    if (schedules.length >= MAX_CANDIDATES) return;

    if (courseIdx === perCourse.length) {
      schedules.push({ sections: [...chosen] });
      return;
    }

    for (const section of perCourse[courseIdx]) {
      if (!conflictsWithChosen(chosen, section)) {
        chosen.push(section);
        backtrack(courseIdx + 1, chosen);
        chosen.pop();
        if (schedules.length >= MAX_CANDIDATES) return;
      }
    }
  }

  backtrack(0, []);

  return { schedules, totalSections };
}

export { generateSchedules };
