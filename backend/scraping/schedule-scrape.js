// ============================================================
// backend/scraping/webreg.js
//
// Scrapes UCSD WebReg schedule data.
// Strategy:
//   1. Use BrowserUse (cloud SDK) to SSO-login and grab cookies
//   2. Use plain fetch() with those cookies for all data calls
//   3. Transform WebReg's flat JSON into our nested structure
//   4. Write the result to a JSON file for in-memory loading
// ============================================================

import "dotenv/config";
import { BrowserUse } from "browser-use-sdk";
import fs from "fs/promises";
import path from "path";

// ──────────────────────────────────────────────────────────────
// 1. AUTH — Get session cookies via BrowserUse cloud agent
// ──────────────────────────────────────────────────────────────

/**
 * Uses BrowserUse cloud agent to log into WebReg via UCSD SSO
 * and return the session cookies as a string for use in fetch headers.
 *
 * NOTE: BrowserUse cloud SDK runs a headless browser on their servers.
 * You'll need a BROWSER_USE_API_KEY env variable.
 *
 * For the hackathon, an alternative approach is to:
 *   1. Log into WebReg manually in your own browser
 *   2. Copy the cookie header from DevTools Network tab
 *   3. Paste it into a .env file
 * This is faster and avoids burning BrowserUse credits on login.
 */
async function getWebRegCookiesViaBrowserUse() {
  const client = new BrowserUse();

  // BrowserUse cloud agent navigates and logs in
  const result = await client.run({
    task: `
      1. Go to https://act.ucsd.edu/webreg2/start
      2. You'll be redirected to UCSD SSO login.
      3. Log in with:
         - Username: ${process.env.UCSD_USERNAME}
         - Password: ${process.env.UCSD_PASSWORD}
      4. If prompted for Duo 2FA, wait for push approval.
      5. Wait until you see the WebReg page (quarter selector or schedule).
      6. Once on WebReg, go to this URL and return its content:
         https://act.ucsd.edu/webreg2/svc/wradapter/secure/search-get-crse-list?termcode=S326&subjlist=
      7. Return the page content.
    `,
    // If BrowserUse cloud supports cookie extraction, grab them here.
    // Otherwise we rely on the manual cookie approach below.
  });

  // The cloud SDK may not expose raw cookies directly.
  // See the manual approach below as a more reliable hackathon option.
  return result;
}

/**
 * RECOMMENDED FOR HACKATHON: Manual cookie approach.
 *
 * Steps:
 *   1. Open Chrome, go to https://act.ucsd.edu/webreg2/start
 *   2. Log in through SSO
 *   3. Open DevTools → Network tab
 *   4. Click any request to act.ucsd.edu
 *   5. Copy the "Cookie" header value
 *   6. Save to .env as WEBREG_COOKIE="paste_here"
 *
 * Cookies typically last a few hours, which is enough for
 * a full scrape + hackathon demo.
 */
function getCookieFromEnv() {
  const cookie = process.env.WEBREG_COOKIE;
  if (!cookie) {
    throw new Error(
      "WEBREG_COOKIE not set. Log into WebReg in Chrome, " +
        "copy cookie header from DevTools, add to .env"
    );
  }
  return cookie;
}

// ──────────────────────────────────────────────────────────────
// 2. FETCHING — Hit WebReg JSON APIs with session cookies
// ──────────────────────────────────────────────────────────────

const BASE_URL = "https://act.ucsd.edu/webreg2/svc/wradapter/secure";

/**
 * Fetch with WebReg session cookies and error handling.
 */
async function webregFetch(endpoint, params = {}) {
  const cookie = getCookieFromEnv();

  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, val);
  }
  // WebReg uses a _ timestamp param for cache busting
  url.searchParams.set("_", Date.now().toString());

  const response = await fetch(url.toString(), {
    headers: {
      Cookie: cookie,
      // WebReg also checks these sometimes
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  if (!response.ok) {
    if (response.status === 302 || response.status === 401) {
      throw new Error("Session expired — refresh your WEBREG_COOKIE");
    }
    throw new Error(`WebReg API error: ${response.status} on ${endpoint}`);
  }

  return response.json();
}

/**
 * Get the master list of all courses for a term.
 * Returns array of { SUBJ_CODE, CRSE_CODE, CRSE_TITLE }
 */
async function fetchAllCourses(termCode = "S126") {
  return webregFetch("search-get-crse-list", {
    termcode: termCode,
    subjlist: "", // empty = all subjects
  });
}

/**
 * Get all sections/meetings for a specific course.
 * Returns the raw WebReg JSON array of meeting rows.
 */
async function fetchCourseSections(subjCode, crseCode, termCode = "S126") {
  return webregFetch("search-load-group-data", {
    subjcode: subjCode,
    crsecode: crseCode,
    termcode: termCode,
  });
}

// ──────────────────────────────────────────────────────────────
// 3. TRANSFORM — Convert WebReg format to our clean structure
// ──────────────────────────────────────────────────────────────

const DAY_MAP = {
  1: "M",
  2: "Tu",
  3: "W",
  4: "Th",
  5: "F",
  6: "Sa",
  7: "Su",
};

/**
 * Convert WebReg DAY_CODE to readable string.
 * "135" → "MWF", "24" → "TuTh"
 */
function parseDays(dayCode) {
  return dayCode
    .trim()
    .split("")
    .map((ch) => DAY_MAP[ch] || "")
    .join("");
}

/**
 * Format hour + minute into "HH:MM" string.
 * (16, 0) → "16:00"
 */
function formatTime(hh, mm) {
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Clean instructor name.
 * "Gillespie, Gary N; " → "Gillespie, Gary N"
 * "Staff; " → "Staff"
 */
function cleanInstructor(name) {
  return name.trim().replace(/;\s*$/, "").trim();
}

/**
 * Transform the flat WebReg array into our nested structure.
 *
 * KEY INSIGHT: WebReg returns one row per MEETING, not per section.
 * A lecture with MWF 5:00-5:50 AND a final on Friday 7:00-9:59
 * comes back as TWO separate rows with the same SECTION_NUMBER.
 * We group by SECT_CODE to reconstruct full sections.
 *
 * Special meeting codes (FK_SPM_SPCL_MTG_CD):
 *   "  " = regular meeting
 *   "FI" = final exam
 *   "MI" = midterm
 *   "TBA"= to be announced
 *
 * Section status codes (FK_SST_SCTN_STATCD):
 *   "AC" = active
 *   "NC" = new/current (also active)
 *   "CA" = cancelled
 */
function transformCourseData(subjCode, crseCode, rawSections, courseTitle = "") {
  const courseCode = `${subjCode.trim()} ${crseCode.trim()}`;
  const sectionMap = {};

  for (const row of rawSections) {
    const sectKey = row.SECT_CODE.trim();
    const special = row.FK_SPM_SPCL_MTG_CD.trim();
    const status = row.FK_SST_SCTN_STATCD.trim();

    // Skip cancelled sections
    if (status === "CA") continue;

    // Initialize section if first time seeing this SECT_CODE
    if (!sectionMap[sectKey]) {
      sectionMap[sectKey] = {
        section_id: sectKey,
        // SECTION_NUMBER is what WebReg uses for enrollment — save it!
        section_number: row.SECTION_NUMBER,
        type: row.FK_CDI_INSTR_TYPE.trim(), // LE, DI, LA, etc.
        instructor: cleanInstructor(row.PERSON_FULL_NAME),
        meetings: [],
        final: null,
        seats_total: row.SCTN_CPCTY_QTY,
        seats_available: row.AVAIL_SEAT,
        enrolled: row.SCTN_ENRLT_QTY,
        waitlist: row.COUNT_ON_WAITLIST,
        status,
      };
    }

    // Build the meeting object
    const meeting = {
      days: parseDays(row.DAY_CODE),
      start: formatTime(row.BEGIN_HH_TIME, row.BEGIN_MM_TIME),
      end: formatTime(row.END_HH_TIME, row.END_MM_TIME),
      building: row.BLDG_CODE.trim(),
      room: row.ROOM_CODE.trim(),
    };

    if (special === "FI") {
      // Final exam — store separately
      sectionMap[sectKey].final = {
        date: row.START_DATE,
        start: meeting.start,
        end: meeting.end,
        building: meeting.building,
        room: meeting.room,
      };
    } else if (special === "MI") {
      // Midterm — skip for MVP, add later if you want
    } else {
      // Regular class meeting
      sectionMap[sectKey].meetings.push(meeting);
    }
  }

  return {
    course_code: courseCode,
    course_title: courseTitle,
    sections: Object.values(sectionMap),
  };
}

// ──────────────────────────────────────────────────────────────
// 4. BUILD — Scrape everything, assemble the master JSON
// ──────────────────────────────────────────────────────────────

/**
 * Delay helper — be nice to WebReg's servers.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the full schedule JSON for a given term.
 *
 * This scrapes ALL departments and courses, so it takes a while
 * (~10-20 min depending on the term). Run it once before the demo,
 * not during it.
 *
 * Output structure:
 * {
 *   "S326": {
 *     "CSE": {
 *       "CSE 100": {
 *         "course_code": "CSE 100",
 *         "sections": [ ... ]
 *       }
 *     },
 *     "MATH": { ... }
 *   }
 * }
 */
async function buildQuarterJSON(termCode = "S126") {
  console.log(`[webreg] Fetching course list for ${termCode}...`);
  const allCourses = await fetchAllCourses(termCode);

  // Group courses by subject, preserving titles
  const subjects = {};
  for (const course of allCourses) {
    const subj = course.SUBJ_CODE?.trim();
    const crse = course.CRSE_CODE?.trim();
    const title = course.CRSE_TITLE?.trim() ?? "";
    if (!subj || !crse) continue;

    if (!subjects[subj]) subjects[subj] = {};
    if (!subjects[subj][crse]) subjects[subj][crse] = title;
  }

  const deptCount = Object.keys(subjects).length;
  console.log(`[webreg] Found ${deptCount} departments`);

  const schedule = { [termCode]: {} };
  let courseCount = 0;
  let errorCount = 0;

  for (const [subj, courses] of Object.entries(subjects)) {
    console.log(`[webreg]   ${subj} (${Object.keys(courses).length} courses)...`);
    schedule[termCode][subj] = {};

    for (const [crse, title] of Object.entries(courses)) {
      try {
        const raw = await fetchCourseSections(subj, crse, termCode);

        // WebReg sometimes returns empty arrays for courses
        // with no sections scheduled yet
        if (!Array.isArray(raw) || raw.length === 0) continue;

        const transformed = transformCourseData(subj, crse, raw, title);
        schedule[termCode][subj][transformed.course_code] = transformed;
        courseCount++;

        // Rate limiting: 200ms between requests
        await sleep(200);
      } catch (err) {
        console.error(`[webreg]     Error on ${subj} ${crse}: ${err.message}`);
        errorCount++;

        // If we get a session error, abort early
        if (err.message.includes("Session expired")) {
          throw err;
        }
      }
    }
  }

  // Write to disk
  const outDir = path.join(process.cwd(), "backend", "data");
  await fs.mkdir(outDir, { recursive: true });

  const outPath = path.join(outDir, `schedule_${termCode}.json`);
  const jsonStr = JSON.stringify(schedule, null, 2);
  await fs.writeFile(outPath, jsonStr);

  const sizeMB = (Buffer.byteLength(jsonStr) / (1024 * 1024)).toFixed(1);
  console.log(`[webreg] Done! ${courseCount} courses, ${errorCount} errors`);
  console.log(`[webreg] Written to ${outPath} (${sizeMB} MB)`);

  return schedule;
}

// ──────────────────────────────────────────────────────────────
// 5. TARGETED SCRAPE — Just a few departments (faster for dev)
// ──────────────────────────────────────────────────────────────

/**
 * Scrape only specific departments.
 * Use this during development and for pre-loading demo data.
 *
 * Example: buildDepartments(["CSE", "MATH", "ECE", "BILD"])
 */
async function buildDepartments(deptList, termCode = "S126") {
  console.log(
    `[webreg] Fetching courses for: ${deptList.join(", ")} (${termCode})`
  );
  const allCourses = await fetchAllCourses(termCode);

  // Filter to only requested departments, preserving titles
  const subjects = {};
  for (const course of allCourses) {
    const subj = course.SUBJ_CODE?.trim();
    const crse = course.CRSE_CODE?.trim();
    const title = course.CRSE_TITLE?.trim() ?? "";
    if (!subj || !crse) continue;
    if (!deptList.includes(subj)) continue;

    if (!subjects[subj]) subjects[subj] = {};
    if (!subjects[subj][crse]) subjects[subj][crse] = title;
  }

  const schedule = { [termCode]: {} };

  for (const [subj, courses] of Object.entries(subjects)) {
    console.log(`[webreg]   ${subj} (${Object.keys(courses).length} courses)...`);
    schedule[termCode][subj] = {};

    for (const [crse, title] of Object.entries(courses)) {
      try {
        const raw = await fetchCourseSections(subj, crse, termCode);
        if (!Array.isArray(raw) || raw.length === 0) continue;

        const transformed = transformCourseData(subj, crse, raw, title);
        schedule[termCode][subj][transformed.course_code] = transformed;
        await sleep(200);
      } catch (err) {
        console.error(`[webreg]     Error: ${subj} ${crse}: ${err.message}`);
        if (err.message.includes("Session expired")) throw err;
      }
    }
  }

  const outDir = path.join(process.cwd(), "backend", "data");
  await fs.mkdir(outDir, { recursive: true });

  const outPath = path.join(outDir, `schedule_${termCode}.json`);

  // Merge with existing data if the file exists
  let existing = {};
  try {
    const existingData = await fs.readFile(outPath, "utf-8");
    existing = JSON.parse(existingData);
  } catch {
    // File doesn't exist yet, that's fine
  }

  // Deep merge: keep existing departments, overwrite scraped ones
  if (!existing[termCode]) existing[termCode] = {};
  Object.assign(existing[termCode], schedule[termCode]);

  const jsonStr = JSON.stringify(existing, null, 2);
  await fs.writeFile(outPath, jsonStr);

  const sizeMB = (Buffer.byteLength(jsonStr) / (1024 * 1024)).toFixed(1);
  console.log(`[webreg] Written to ${outPath} (${sizeMB} MB)`);

  return existing;
}

// ──────────────────────────────────────────────────────────────
// 6. IN-MEMORY LOADER — For use in the Express/Fastify server
// ──────────────────────────────────────────────────────────────

let scheduleCache = null;

/**
 * Load the schedule JSON into memory. Call once on server startup.
 * After this, use getScheduleData() for O(1) lookups.
 */
async function loadScheduleIntoMemory(termCode = "S126") {
  const filePath = path.join(
    process.cwd(),
    "backend",
    "data",
    `schedule_${termCode}.json`
  );

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    scheduleCache = JSON.parse(raw);

    const deptCount = Object.keys(scheduleCache[termCode] || {}).length;
    const courseCount = Object.values(scheduleCache[termCode] || {}).reduce(
      (sum, dept) => sum + Object.keys(dept).length,
      0
    );
    console.log(
      `[schedule] Loaded ${courseCount} courses across ${deptCount} departments`
    );
  } catch (err) {
    console.warn(
      `[schedule] No schedule file found at ${filePath}. ` +
        `Run the scraper first: node backend/scraping/webreg.js`
    );
    scheduleCache = {};
  }

  return scheduleCache;
}

/**
 * O(1) lookup for a specific course.
 * Returns null if not found.
 *
 * Example: getScheduleData("S326", "CSE", "CSE 100")
 */
function getCourse(termCode, subjCode, courseCode) {
  return scheduleCache?.[termCode]?.[subjCode]?.[courseCode] || null;
}

/**
 * Get all courses in a department.
 *
 * Example: getDepartment("S326", "CSE")
 */
function getDepartment(termCode, subjCode) {
  return scheduleCache?.[termCode]?.[subjCode] || null;
}

/**
 * Search courses by partial match.
 * Useful for the extension's course search bar.
 *
 * Example: searchCourses("S326", "CSE 1") → ["CSE 100", "CSE 101", ...]
 */
function searchCourses(termCode, query) {
  const results = [];
  const q = query.toUpperCase().trim();
  const termData = scheduleCache?.[termCode];
  if (!termData) return results;

  for (const [, deptCourses] of Object.entries(termData)) {
    for (const [courseCode, courseData] of Object.entries(deptCourses)) {
      const titleUpper = (courseData.course_title ?? "").toUpperCase();
      if (courseCode.toUpperCase().includes(q) || titleUpper.includes(q)) {
        results.push({
          course_code: courseCode,
          course_title: courseData.course_title ?? "",
          section_count: courseData.sections?.length || 0,
          // Grab instructor from the first lecture section
          instructors: [
            ...new Set(
              courseData.sections
                ?.filter((s) => s.type === "LE")
                .map((s) => s.instructor)
                .filter((name) => name && name !== "Staff") || []
            ),
          ],
        });
      }
    }
  }

  return results.sort((a, b) => a.course_code.localeCompare(b.course_code));
}

// ──────────────────────────────────────────────────────────────
// 7. CLI — Run directly to scrape
// ──────────────────────────────────────────────────────────────

// Run: node backend/scraping/webreg.js
// Or:  node backend/scraping/webreg.js CSE MATH ECE BILD
const isMainModule = process.argv[1]?.includes("webreg");

if (isMainModule) {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    // Scrape specific departments
    buildDepartments(args).catch(console.error);
  } else {
    // Scrape everything
    buildQuarterJSON().catch(console.error);
  }
}

// ──────────────────────────────────────────────────────────────
// EXPORTS
// ──────────────────────────────────────────────────────────────

export {
  buildQuarterJSON,
  buildDepartments,
  loadScheduleIntoMemory,
  getCourse,
  getDepartment,
  searchCourses,
  fetchCourseSections,
  transformCourseData,
};