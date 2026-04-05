import "dotenv/config";
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import { BrowserUse } from "browser-use-sdk/v3";
import { z } from "zod";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const db = new Database("cache.db");
db.pragma("journal_mode = WAL");

initDb();

const LOGIN_RESULT_SCHEMA = z.object({
  signedInConfirmed: z.boolean().default(false),
  notes: z.string().optional(),
});

const REMOVE_RESULT_SCHEMA = z.object({
  removedCourseCodes: z.array(z.string()).default([]),
  removedCount: z.number().int().nonnegative().default(0),
  notes: z.string().optional(),
});

const EVAL_REFRESH_SCHEMA = z.object({
  name: z.string().min(1),
  courseCode: z.string().trim().min(1).optional(),
  rmp: z
    .object({
      score: z.number().nullable().optional(),
      difficulty: z.number().nullable().optional(),
      wouldTakeAgain: z.number().nullable().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  cape: z
    .object({
      recommendProf: z.number().nullable().optional(),
      recommendCourse: z.number().nullable().optional(),
      avgGradeExpected: z.number().nullable().optional(),
      avgHoursPerWeek: z.number().nullable().optional(),
    })
    .optional(),
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ready" });
});

app.get("/api/browser-use/has-profile", (req, res) => {
  const pid = normalizePid(req.query.pid);
  if (!pid) {
    return res.status(400).json({ error: "pid query param required" });
  }

  const row = getProfileRow(pid);
  const hasProfile = Boolean(
    row && row.profile_id && row.signed_in_confirmed === 1 && row.setup_status === "ready"
  );

  res.json({
    pid,
    hasProfile,
    profileId: row?.profile_id || null,
    signedInConfirmed: Boolean(row?.signed_in_confirmed),
    setupStatus: row?.setup_status || "missing",
    lastVerifiedAt: row?.last_verified_at || null,
    lastError: row?.last_error || null,
  });
});

app.post("/api/browser-use/set-profile", async (req, res) => {
  const pid = normalizePid(req.body?.pid);
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");

  if (!pid) return res.status(400).json({ error: "pid required" });
  if (!email) return res.status(400).json({ error: "email required" });
  if (!password) return res.status(400).json({ error: "password required" });

  if (!process.env.BROWSER_USE_API_KEY) {
    return res.status(500).json({ error: "BROWSER_USE_API_KEY not set in environment." });
  }

  const buClient = new BrowserUse();

  let profileId;
  try {
    profileId = await resolveOrCreateProfileId(buClient, pid);
  } catch (error) {
    return res.status(500).json({
      error: "Could not create Browser Use profile",
      details: error?.message || String(error),
    });
  }

  const startedAt = nowIso();
  upsertProfileRow({
    pid,
    profileId,
    loginEmail: email,
    loginPassword: password,
    signedInConfirmed: false,
    setupStatus: "pending",
    lastError: null,
    lastSetupStartedAt: startedAt,
  });

  let session;
  try {
    session = await buClient.sessions.create({
      profileId,
      keepAlive: true,
      model: "claude-sonnet-4.6",
    });
  } catch (error) {
    upsertProfileRow({
      pid,
      profileId,
      signedInConfirmed: false,
      setupStatus: "error",
      lastError: `session-create: ${error?.message || String(error)}`,
      lastSetupStartedAt: startedAt,
      lastSetupCompletedAt: nowIso(),
    });

    return res.status(500).json({
      error: "Could not create Browser Use session",
      details: error?.message || String(error),
    });
  }

  res.json({
    pid,
    profileId,
    sessionId: session.id,
    liveUrl: session.liveUrl || null,
    setupStatus: "pending",
  });

  void runProfileSetupInBackground({
    buClient,
    pid,
    profileId,
    sessionId: session.id,
    startedAt,
  });
});

app.post("/api/browser-use/remove-planned", async (req, res) => {
  const pid = normalizePid(req.body?.pid);
  const termCode = String(req.body?.termCode || "").trim().toUpperCase();
  const maxRemovalsRaw = Number(req.body?.maxRemovals ?? 4);
  const maxRemovals = Number.isFinite(maxRemovalsRaw)
    ? Math.max(1, Math.min(8, Math.floor(maxRemovalsRaw)))
    : 4;

  if (!pid) return res.status(400).json({ error: "pid required" });
  if (!termCode) return res.status(400).json({ error: "termCode required" });

  const profile = getProfileRow(pid);
  if (!profile || !profile.profile_id || profile.signed_in_confirmed !== 1 || profile.setup_status !== "ready") {
    return res.status(409).json({ error: "No verified Browser Use profile found for this PID." });
  }

  if (!process.env.BROWSER_USE_API_KEY) {
    return res.status(500).json({ error: "BROWSER_USE_API_KEY not set in environment." });
  }

  const buClient = new BrowserUse();

  let session;
  try {
    session = await buClient.sessions.create({
      profileId: profile.profile_id,
      keepAlive: true,
      model: "claude-sonnet-4.6",
    });

    const prompt = [
      "Open UCSD WebReg and switch to term code " + termCode + ".",
      "Go to the active calendar area where planned classes have a Remove button.",
      "Remove up to " + maxRemovals + " planned classes from the active calendar.",
      "Only click Remove for classes currently marked planned.",
      "If no planned classes are present, do not remove anything.",
      "Return strict JSON with keys: removedCourseCodes (string[]), removedCount (number), notes (string).",
    ].join(" ");

    const result = await buClient.run(prompt, {
      sessionId: session.id,
      keepAlive: false,
      model: "claude-sonnet-4.6",
      schema: REMOVE_RESULT_SCHEMA,
    });

    const removedCourseCodes = dedupeStrings(result.output?.removedCourseCodes || []);
    const removedCount =
      Number.isFinite(result.output?.removedCount) && result.output.removedCount >= 0
        ? Math.min(removedCourseCodes.length || result.output.removedCount, maxRemovals)
        : Math.min(removedCourseCodes.length, maxRemovals);

    touchProfileVerified(pid);

    return res.json({
      pid,
      profileId: profile.profile_id,
      termCode,
      removedCourseCodes,
      removedCount,
      notes: result.output?.notes || "",
      sessionId: session.id,
      liveUrl: session.liveUrl || null,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to remove planned classes",
      details: error?.message || String(error),
      liveUrl: session?.liveUrl || null,
      sessionId: session?.id || null,
    });
  } finally {
    if (session?.id) {
      try {
        await buClient.sessions.stop(session.id);
      } catch {
        // best effort
      }
    }
  }
});

app.get("/api/evals/professor", (req, res) => {
  const name = normalizeProfessorName(req.query.name);
  const courseCode = normalizeCourseCode(req.query.courseCode);

  if (!name) {
    return res.status(400).json({ error: "name query param required" });
  }

  const evals = getProfessorEvaluations(name, courseCode);
  res.json({
    found: Boolean(evals.rmp || evals.cape),
    name,
    courseCode: courseCode || null,
    rmp: evals.rmp,
    cape: evals.cape,
  });
});

app.post("/api/evals/professor/refresh", (req, res) => {
  const parsed = EVAL_REFRESH_SCHEMA.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid refresh payload",
      details: parsed.error.issues.map(issue => issue.message).join("; "),
    });
  }

  const payload = parsed.data;
  if (!payload.rmp && !payload.cape) {
    return res.status(400).json({ error: "At least one of rmp or cape must be provided." });
  }

  const name = normalizeProfessorName(payload.name);
  const courseCode = normalizeCourseCode(payload.courseCode);
  const professorId = ensureProfessor(name);

  if (payload.rmp) {
    insertRmpEvaluation({
      professorId,
      courseCode,
      rmpScore: payload.rmp.score ?? null,
      rmpDifficulty: payload.rmp.difficulty ?? null,
      rmpWouldTakeAgain: payload.rmp.wouldTakeAgain ?? null,
      rmpTags: payload.rmp.tags ?? [],
    });
  }

  if (payload.cape) {
    insertCapeEvaluation({
      professorId,
      courseCode,
      recommendProf: payload.cape.recommendProf ?? null,
      recommendCourse: payload.cape.recommendCourse ?? null,
      avgGradeExpected: payload.cape.avgGradeExpected ?? null,
      avgHoursPerWeek: payload.cape.avgHoursPerWeek ?? null,
    });
  }

  const evals = getProfessorEvaluations(name, courseCode);
  res.json({
    refreshed: true,
    name,
    courseCode: courseCode || null,
    rmp: evals.rmp,
    cape: evals.cape,
  });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

async function runProfileSetupInBackground({
  buClient,
  pid,
  profileId,
  sessionId,
  startedAt,
}) {
  try {
    const prompt = [
      "Navigate to https://act.ucsd.edu/webreg2 and stop there.",
      "Do not type credentials or attempt Duo/2FA yourself.",
      "Wait for the user to take over, sign in manually, and complete Duo/2FA.",
      "After login, verify the UCSD landing page is authenticated.",
      "Return strict JSON with keys signedInConfirmed (boolean) and notes (string).",
    ].join(" ");

    const result = await buClient.run(prompt, {
      sessionId,
      keepAlive: true,
      model: "claude-sonnet-4.6",
      schema: LOGIN_RESULT_SCHEMA,
    });

    const signedInConfirmed = Boolean(result.output?.signedInConfirmed || result.isTaskSuccessful);
    upsertProfileRow({
      pid,
      profileId,
      signedInConfirmed,
      setupStatus: signedInConfirmed ? "ready" : "error",
      lastError: signedInConfirmed ? null : result.output?.notes || "Agent could not confirm login state.",
      lastSetupStartedAt: startedAt,
      lastSetupCompletedAt: nowIso(),
      lastVerifiedAt: signedInConfirmed ? nowIso() : null,
    });
  } catch (error) {
    upsertProfileRow({
      pid,
      profileId,
      signedInConfirmed: false,
      setupStatus: "error",
      lastError: error?.message || String(error),
      lastSetupStartedAt: startedAt,
      lastSetupCompletedAt: nowIso(),
    });
  } finally {
    try {
      await buClient.sessions.stop(sessionId);
    } catch {
      // best effort
    }
  }
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_use_profiles (
      pid TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      signed_in_confirmed INTEGER NOT NULL DEFAULT 0,
      setup_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      last_setup_started_at TEXT,
      last_setup_completed_at TEXT,
      last_verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  ensureTableColumn("browser_use_profiles", "login_email", "TEXT");
  ensureTableColumn("browser_use_profiles", "login_password", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS professors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS rmp_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      professor_internal_id INTEGER NOT NULL REFERENCES professors(id),
      course_code TEXT,
      rmp_score REAL,
      rmp_difficulty REAL,
      rmp_would_take_again REAL,
      rmp_tags TEXT,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cape_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      professor_internal_id INTEGER NOT NULL REFERENCES professors(id),
      course_code TEXT,
      recommend_prof REAL,
      recommend_course REAL,
      avg_grade_expected REAL,
      avg_hours_per_week REAL,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_professors_name ON professors(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rmp_prof_course ON rmp_evaluations(professor_internal_id, course_code, last_updated)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cape_prof_course ON cape_evaluations(professor_internal_id, course_code, last_updated)`);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePid(value) {
  const pid = String(value || "").trim();
  return pid || null;
}

function normalizeProfessorName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  return name || null;
}

function normalizeCourseCode(value) {
  if (value == null) return null;
  const cleaned = String(value).trim().toUpperCase().replace(/\s+/g, " ");
  if (!cleaned) return null;
  const match = cleaned.match(/^([A-Z&]+)\s*([0-9A-Z]+)$/);
  if (!match) return cleaned;
  return `${match[1]} ${match[2]}`;
}

async function resolveOrCreateProfileId(buClient, pid) {
  const existing = getProfileRow(pid);
  if (existing?.profile_id) {
    try {
      await buClient.profiles.get(existing.profile_id);
      return existing.profile_id;
    } catch {
      // stale profile id, create a new one
    }
  }

  const created = await buClient.profiles.create({
    userId: pid,
    name: `UCSD PID ${pid}`,
  });

  if (!created?.id) {
    throw new Error("Browser Use profile creation returned no id.");
  }

  return created.id;
}

function getProfileRow(pid) {
  return db
    .prepare(
      `SELECT pid, profile_id, login_email, login_password, signed_in_confirmed, setup_status, last_error, last_setup_started_at, last_setup_completed_at, last_verified_at
       FROM browser_use_profiles
       WHERE pid = ?`
    )
    .get(pid);
}

function upsertProfileRow({
  pid,
  profileId,
  loginEmail,
  loginPassword,
  signedInConfirmed,
  setupStatus,
  lastError,
  lastSetupStartedAt,
  lastSetupCompletedAt,
  lastVerifiedAt,
}) {
  const previous = getProfileRow(pid);

  const signed = signedInConfirmed ? 1 : 0;
  const storedEmail =
    loginEmail !== undefined ? (String(loginEmail || "").trim() || null) : previous?.login_email ?? null;
  const storedPassword =
    loginPassword !== undefined ? (String(loginPassword || "") || null) : previous?.login_password ?? null;
  const started = lastSetupStartedAt ?? previous?.last_setup_started_at ?? null;
  const completed = lastSetupCompletedAt ?? previous?.last_setup_completed_at ?? null;
  const verified = lastVerifiedAt ?? previous?.last_verified_at ?? null;

  db.prepare(
    `INSERT INTO browser_use_profiles (
        pid,
        profile_id,
        login_email,
        login_password,
        signed_in_confirmed,
        setup_status,
        last_error,
        last_setup_started_at,
        last_setup_completed_at,
        last_verified_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(pid) DO UPDATE SET
        profile_id = excluded.profile_id,
        login_email = excluded.login_email,
        login_password = excluded.login_password,
        signed_in_confirmed = excluded.signed_in_confirmed,
        setup_status = excluded.setup_status,
        last_error = excluded.last_error,
        last_setup_started_at = excluded.last_setup_started_at,
        last_setup_completed_at = excluded.last_setup_completed_at,
        last_verified_at = excluded.last_verified_at,
        updated_at = CURRENT_TIMESTAMP`
  ).run(
    pid,
    profileId,
    storedEmail,
    storedPassword,
    signed,
    setupStatus,
    lastError,
    started,
    completed,
    verified
  );
}

function ensureTableColumn(tableName, columnName, sqliteType) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = rows.some(row => row.name === columnName);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqliteType}`);
  }
}

function touchProfileVerified(pid) {
  db.prepare(
    `UPDATE browser_use_profiles
     SET last_verified_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE pid = ?`
  ).run(nowIso(), pid);
}

function ensureProfessor(name) {
  const insert = db.prepare("INSERT OR IGNORE INTO professors(name) VALUES (?)");
  insert.run(name);
  return db.prepare("SELECT id FROM professors WHERE name = ?").get(name).id;
}

function insertRmpEvaluation({
  professorId,
  courseCode,
  rmpScore,
  rmpDifficulty,
  rmpWouldTakeAgain,
  rmpTags,
}) {
  db.prepare(
    `INSERT INTO rmp_evaluations (
      professor_internal_id,
      course_code,
      rmp_score,
      rmp_difficulty,
      rmp_would_take_again,
      rmp_tags,
      last_updated
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    professorId,
    courseCode || null,
    rmpScore,
    rmpDifficulty,
    rmpWouldTakeAgain,
    JSON.stringify(rmpTags || [])
  );
}

function insertCapeEvaluation({
  professorId,
  courseCode,
  recommendProf,
  recommendCourse,
  avgGradeExpected,
  avgHoursPerWeek,
}) {
  db.prepare(
    `INSERT INTO cape_evaluations (
      professor_internal_id,
      course_code,
      recommend_prof,
      recommend_course,
      avg_grade_expected,
      avg_hours_per_week,
      last_updated
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    professorId,
    courseCode || null,
    recommendProf,
    recommendCourse,
    avgGradeExpected,
    avgHoursPerWeek
  );
}

function getProfessorEvaluations(name, courseCode) {
  const professor = db.prepare("SELECT id FROM professors WHERE name = ?").get(name);
  if (!professor?.id) {
    return { rmp: null, cape: null };
  }

  const params = [professor.id];
  let courseClause = "";
  if (courseCode) {
    courseClause = " AND course_code = ?";
    params.push(courseCode);
  }

  const rmp = db
    .prepare(
      `SELECT course_code, rmp_score, rmp_difficulty, rmp_would_take_again, rmp_tags, last_updated
       FROM rmp_evaluations
       WHERE professor_internal_id = ?${courseClause}
       ORDER BY last_updated DESC
       LIMIT 1`
    )
    .get(...params);

  const cape = db
    .prepare(
      `SELECT course_code, recommend_prof, recommend_course, avg_grade_expected, avg_hours_per_week, last_updated
       FROM cape_evaluations
       WHERE professor_internal_id = ?${courseClause}
       ORDER BY last_updated DESC
       LIMIT 1`
    )
    .get(...params);

  return {
    rmp: rmp
      ? {
          courseCode: rmp.course_code || null,
          score: rmp.rmp_score,
          difficulty: rmp.rmp_difficulty,
          wouldTakeAgain: rmp.rmp_would_take_again,
          tags: safeParseJsonArray(rmp.rmp_tags),
          lastUpdated: rmp.last_updated,
        }
      : null,
    cape: cape
      ? {
          courseCode: cape.course_code || null,
          recommendProf: cape.recommend_prof,
          recommendCourse: cape.recommend_course,
          avgGradeExpected: cape.avg_grade_expected,
          avgHoursPerWeek: cape.avg_hours_per_week,
          lastUpdated: cape.last_updated,
        }
      : null,
  };
}

function safeParseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const item = String(value || "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
