// ============================================================
// backend/server.js
//
// Express API server for the schedule planner.
// Loads the schedule JSON into memory on startup for O(1) lookups.
//
// Run:  node backend/server.js
// Deps: npm install express cors dotenv
// ============================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  loadScheduleIntoMemory,
  getCourse,
  getDepartment,
  searchCourses,
} from "./scraping/webreg.js";
import { generateSchedules } from "./scheduler.js";
import { handleRank } from "./handler.js";
import { rankSchedules, recommendPasses } from "./scorer.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────────────────────
// Load schedule data into memory on startup
// ──────────────────────────────────────────────────────────────

const DEFAULT_TERM = "S126";
let ready = false;

async function init() {
  console.log("[server] Loading schedule data...");
  await loadScheduleIntoMemory(DEFAULT_TERM);
  ready = true;
  console.log("[server] Ready!");
}

// Health check / readiness
app.get("/api/health", (req, res) => {
  res.json({ status: ready ? "ready" : "loading" });
});

// ──────────────────────────────────────────────────────────────
// SCHEDULE ENDPOINTS
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/getClass?code=CSE+100&term=S326
 *
 * Returns full course data with all sections, meetings, finals.
 */
app.get("/api/getClass", (req, res) => {
  const { code, term = DEFAULT_TERM } = req.query;
  if (!code) return res.status(400).json({ error: "code param required" });

  // Extract subject from course code: "CSE 100" → "CSE"
  const subj = code.split(" ")[0].toUpperCase();
  const codeNum = code.split(" ")[1];
  const course = getCourse(term, subj, code.toUpperCase());

  // course doesn't exist
  if (!course) {
    return res.status(404).json({ error: `Course ${code} not found` });
  }

  // need to scrap locally
  if (!course.sections || course.sections.length === 0) {
    return res.status(204).json({ error: `Course ${code} has no content` });
  }

  // success
  res.json(course);
  return res.status(200).json(course);
});

/**
 * POST /api/setClass
 *
 * Sets the subject class in the database with same parameters as getClass
 */
app.post("/api/setClass", (req, res) => {
  const { code, term = DEFAULT_TERM } = req.body;
  if (!code) return res.status(400).json({ error: "code param required" });

  const course = getCourse(term, code.split(" ")[0].toUpperCase(), code.split(" ")[1]);
  if (!course) {
    return res.status(404).json({ error: `Course ${code} not found` });
  }

  res.json(course);
});

/**
 * GET /api/getProf
 *
 * Get CAPE and Rate My Prof data for a professor by name (e.g. "Smith, John").
 */
app.get("/api/getProf", (req, res) => {
  const { name, term = DEFAULT_TERM } = req.query;
  if (!name) return res.status(400).json({ error: "name param required" });

  const prof = searchCourses(term, name);
  res.json({professor: prof});
});

/**
 * POST /api/setBrowserUse
 *
 * Kick off a Browser Use session so the user can log in via SSO.
 * Body: { pid, email, password }
 *
 * Flow:
 *  1. Validate pid (must match degree audit on file).
 *  2. Create a Browser Use project/session (saves cookies + fingerprint for 2FA).
 *  3. Return sessionUrl so the user can open it, confirm their device, and clear 2FA.
 */
app.post("/api/setBrowserUse", async (req, res) => {
  const { pid, email, password } = req.body;

  if (!pid)      return res.status(400).json({ error: "pid required" });
  if (!email)    return res.status(400).json({ error: "email required" });
  if (!password) return res.status(400).json({ error: "password required" });

  // TODO: launch Browser Use session with { pid, email, password }
  const sessionUrl = await startBrowserUseSession({ pid, email, password });
  res.json({ sessionUrl });

  res.status(501).json({ error: "Browser Use session launch not yet implemented." });
});

// ──────────────────────────────────────────────────────────────
// SCHEDULE GENERATION + RANKING
// ──────────────────────────────────────────────────────────────

/**
 * POST /api/generate
 *
 * Generate and rank schedule candidates for a set of courses.
 *
 * Body:
 * {
 *   courses:      string[],   // ["CSE 100", "CSE 101", "MATH 183"]
 *   term?:        string,     // default DEFAULT_TERM
 *   weights?:     object,     // { professor, time, finals, days, difficulty }
 *                             //   raw numbers; will be normalised
 *   prefs?:       object,     // { prefStart, prefEnd, hardLimits,
 *                             //   dayPattern, minHours, maxHours }
 *   sectionTypes?: string[],  // default ["LE"]
 * }
 *
 * Returns:
 * {
 *   schedules:     ranked Schedule[],  // each has .score, .breakdown, .sections
 *   count:         number,
 *   totalSections: number[],           // sections available per course
 * }
 */
app.post("/api/generate", (req, res) => {
  if (!ready) return res.status(503).json({ error: "Server still loading" });

  const {
    courses,
    term    = DEFAULT_TERM,
    weights = {},
    prefs   = {},
  } = req.body;

  if (!courses || !Array.isArray(courses) || courses.length === 0) {
    return res.status(400).json({ error: "courses array required" });
  }
  if (courses.length > 8) {
    return res.status(400).json({ error: "Max 8 courses per generation request" });
  }

  const { schedules, totalBundles, missing } = generateSchedules(courses, term);

  if (schedules.length === 0) {
    return res.json({ schedules: [], count: 0, totalBundles, missing });
  }

  // Normalise weights
  const CRITERIA = ["professor", "time", "finals", "days", "difficulty"];
  const total = CRITERIA.reduce((s, k) => s + (weights[k] ?? 0), 0);
  const normWeights = total > 0
    ? Object.fromEntries(CRITERIA.map(k => [k, (weights[k] ?? 0) / total]))
    : Object.fromEntries(CRITERIA.map(k => [k, 1 / CRITERIA.length]));

  const ranked = rankSchedules(schedules, normWeights, prefs);

  res.json({ schedules: ranked, count: ranked.length, totalBundles, missing });
});

/**
 * POST /api/rank
 *
 * Re-rank already-generated candidates (e.g. when user changes weights).
 * Delegates to handleRank in handler.js.
 */
app.post("/api/rank", handleRank);

// ──────────────────────────────────────────────────────────────
// RECOMMEND ENDPOINT
// ──────────────────────────────────────────────────────────────

/**
 * POST /api/recommend
 *
 * Single-shot: generate, score, and return the top N schedules.
 * Handles linked sections (lecture + discussion combos automatically).
 *
 * Body:
 * {
 *   courses:  string[],  // ["CSE 140", "MATH 183"]
 *   term?:    string,    // default S126
 *   topN?:    number,    // how many to return (default 5, max 20)
 *   weights?: {          // raw numbers, will be normalised to sum 1
 *     professor?:  number,
 *     time?:       number,
 *     finals?:     number,
 *     days?:       number,
 *     difficulty?: number,
 *   },
 *   prefs?: {
 *     prefStart?:  number,  // minutes since midnight (e.g. 540 = 9 AM)
 *     prefEnd?:    number,  // minutes since midnight (e.g. 1020 = 5 PM)
 *     dayPattern?: "MWF" | "TuTh" | "minimize" | "any",
 *     hardLimits?: { neverBefore?: number, neverAfter?: number },
 *     minHours?:   number,
 *     maxHours?:   number,
 *   },
 * }
 *
 * Response:
 * {
 *   schedules: [           // sorted best → worst
 *     {
 *       rank:      number,
 *       score:     number,              // 0–100
 *       breakdown: { professor, time, finals, days, difficulty },
 *       sections: [{
 *         courseCode, section_id, type, instructor,
 *         meetings: [{days, start, end, building, room}],
 *         final, seats_available, status,
 *       }],
 *       summary: string,   // human-readable one-liner, e.g. "MWF 10–11 AM · 3 courses"
 *     }
 *   ],
 *   meta: {
 *     total_valid:    number,   // total non-conflicting combos found
 *     total_bundles:  number[], // bundles available per course
 *     missing:        string[], // course codes not found in schedule data
 *     courses:        string[],
 *   },
 * }
 */
app.post("/api/recommend", (req, res) => {
  if (!ready) return res.status(503).json({ error: "Server still loading" });

  const {
    courses,
    term    = DEFAULT_TERM,
    topN    = 5,
    weights = {},
    prefs   = {},
  } = req.body;

  if (!courses || !Array.isArray(courses) || courses.length === 0) {
    return res.status(400).json({ error: "courses array required" });
  }
  if (courses.length > 8) {
    return res.status(400).json({ error: "Max 8 courses per request" });
  }
  const clampedN = Math.min(Math.max(1, topN), 20);

  // ── Generate ──────────────────────────────────────────────────
  const { schedules, totalBundles, missing } = generateSchedules(
    courses, term, { topN: clampedN }
  );

  // ── Normalise weights ─────────────────────────────────────────
  const CRITERIA = ["professor", "time", "finals", "days", "difficulty"];
  const wTotal   = CRITERIA.reduce((s, k) => s + (weights[k] ?? 0), 0);
  const normW    = wTotal > 0
    ? Object.fromEntries(CRITERIA.map(k => [k, (weights[k] ?? 0) / wTotal]))
    : Object.fromEntries(CRITERIA.map(k => [k, 1 / CRITERIA.length]));

  // ── Rank all, slice top N ─────────────────────────────────────
  const ranked = rankSchedules(schedules, normW, prefs).slice(0, clampedN);

  // ── Build summary string for each schedule ────────────────────
  function buildSummary(sched) {
    const allMeetings = sched.sections.flatMap(s => s.meetings ?? []);
    const days = [...new Set(allMeetings.flatMap(m => expandDaysForSummary(m.days ?? "")))];
    const starts = allMeetings.map(m => toMinsForSummary(m.start)).filter(Boolean);
    const ends   = allMeetings.map(m => toMinsForSummary(m.end)).filter(Boolean);
    const earliest = starts.length ? Math.min(...starts) : null;
    const latest   = ends.length   ? Math.max(...ends)   : null;
    const dayStr   = formatDays(days);
    const timeStr  = earliest != null && latest != null
      ? `${fmtMins(earliest)}–${fmtMins(latest)}`
      : "";
    const n = new Set(sched.sections.map(s => s.courseCode)).size;
    return [dayStr, timeStr, `${n} course${n !== 1 ? "s" : ""}`].filter(Boolean).join(" · ");
  }

  // Minimal helpers for summary (avoid importing scorer helpers)
  function toMinsForSummary(t) {
    if (!t) return null;
    const [h, m = "0"] = String(t).split(":");
    return parseInt(h, 10) * 60 + parseInt(m, 10);
  }
  function expandDaysForSummary(str) {
    const out = []; let i = 0;
    while (i < str.length) {
      const two = str.slice(i, i + 2);
      if (two === "Tu" || two === "Th") { out.push(two); i += 2; }
      else { out.push(str[i]); i += 1; }
    }
    return out;
  }
  function formatDays(days) {
    const ORDER = ["M","Tu","W","Th","F"];
    const sorted = days.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return sorted.join("");
  }
  function fmtMins(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const p = h >= 12 ? "PM" : "AM";
    const d = h > 12 ? h - 12 : h === 0 ? 12 : h;
    return m ? `${d}:${String(m).padStart(2, "0")} ${p}` : `${d} ${p}`;
  }

  const response = {
    schedules: ranked.map((sched, i) => ({
      rank:      i + 1,
      score:     sched.score,
      breakdown: sched.breakdown,
      sections:  sched.sections,
      summary:   buildSummary(sched),
      passes:    recommendPasses(sched.sections),
    })),
    meta: {
      total_valid:   schedules.length,
      total_bundles: totalBundles,
      missing,
      courses,
    },
  };

  res.json(response);
});

// ──────────────────────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────────────────────

init().then(() => {
  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
});