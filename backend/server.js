// ============================================================
// backend/server.js
//
// Express API server for the schedule planner.
// Loads the schedule JSON into memory on startup for O(1) lookups.
//
// Run:  node backend/server.js
// Deps: npm install express cors dotenv
// ============================================================

import express from "express";
import cors from "cors";
import {
  loadScheduleIntoMemory,
  getCourse,
  getDepartment,
  searchCourses,
} from "./scraping/webreg.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────────────────────
// Load schedule data into memory on startup
// ──────────────────────────────────────────────────────────────

const DEFAULT_TERM = "S326";
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
 * GET /api/course?code=CSE+100&term=S326
 *
 * Returns full course data with all sections, meetings, finals.
 */
app.get("/api/course", (req, res) => {
  const { code, term = DEFAULT_TERM } = req.query;
  if (!code) return res.status(400).json({ error: "code param required" });

  // Extract subject from course code: "CSE 100" → "CSE"
  const subj = code.split(" ")[0].toUpperCase();
  const course = getCourse(term, subj, code.toUpperCase());

  if (!course) {
    return res.status(404).json({ error: `Course ${code} not found` });
  }

  res.json(course);
});

/**
 * GET /api/department?code=CSE&term=S326
 *
 * Returns all courses in a department.
 */
app.get("/api/department", (req, res) => {
  const { code, term = DEFAULT_TERM } = req.query;
  if (!code) return res.status(400).json({ error: "code param required" });

  const dept = getDepartment(term, code.toUpperCase());
  if (!dept) {
    return res.status(404).json({ error: `Department ${code} not found` });
  }

  res.json(dept);
});

/**
 * GET /api/search?q=CSE+1&term=S326
 *
 * Search courses by partial match. For the extension's search bar.
 */
app.get("/api/search", (req, res) => {
  const { q, term = DEFAULT_TERM } = req.query;
  if (!q) return res.status(400).json({ error: "q param required" });

  const results = searchCourses(term, q);
  res.json({ results, count: results.length });
});

/**
 * POST /api/sections
 *
 * Batch lookup: get sections for multiple courses at once.
 * Body: { courses: ["CSE 100", "CSE 105", "MATH 183"], term: "S326" }
 */
app.post("/api/sections", (req, res) => {
  const { courses, term = DEFAULT_TERM } = req.body;
  if (!courses || !Array.isArray(courses)) {
    return res.status(400).json({ error: "courses array required" });
  }

  if (courses.length > 10) {
    return res.status(400).json({ error: "Max 10 courses per request" });
  }

  const results = {};
  const notFound = [];

  for (const code of courses) {
    const subj = code.split(" ")[0].toUpperCase();
    const course = getCourse(term, subj, code.toUpperCase());
    if (course) {
      results[code.toUpperCase()] = course;
    } else {
      notFound.push(code);
    }
  }

  res.json({ results, not_found: notFound });
});

// ──────────────────────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────────────────────

init().then(() => {
  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
});