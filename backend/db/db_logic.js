/**
 * @file db_logic.js
 * @description This file contains the logic for interacting with the database,
 * including functions for caching professor scores and schedules, and retrieving
 * them when needed. This is used by the API handlers to serve requests from the database when possible, and to update the database when new data is scraped.
 * @version 1.0.0
 * @author Keramis
 */

let db = require('better-sqlite3')('cache.db');

function cacheProfessorScore(professorName, courseCode, scoreData) {
  // Check if professor already exists in the professors table
  let stmt = db.prepare('SELECT id FROM professors WHERE name = ?');
  let row = stmt.get(professorName);
  let professorId;

  if (!row) {
    // Professor doesn't exist, insert them
    let insertStmt = db.prepare('INSERT INTO professors (name) VALUES (?)');
    insertStmt.run(professorName);
    professorId = db.lastInsertRowid;
  } else {
    professorId = row.id;
  }

  // Insert or update the professor's score data
  let upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO rmp_evaluations 
    (professor_internal_id, course_code, rmp_score, rmp_difficulty, rmp_would_take_again, rmp_tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  upsertStmt.run(
    professorId,
    courseCode,
    scoreData.overall_quality,
    scoreData.difficulty,
    scoreData.would_take_again,
    JSON.stringify(scoreData.tags)
  );
}

function getProfessorScore(professorName, courseCode) {
  let stmt = db.prepare(`
    SELECT rmp_score, rmp_difficulty, rmp_would_take_again, rmp_tags
    FROM rmp_evaluations
    JOIN professors ON rmp_evaluations.professor_internal_id = professors.id
    WHERE professors.name = ? AND rmp_evaluations.course_code = ?
  `);
  return stmt.get(professorName, courseCode);
}

function setBrowserUseProfile(pid, email, password, profileName, profileId) {
    let stmt = db.prepare('INSERT INTO browser_use_profiles (pid, email, password, profile_name, profile_id) VALUES (?, ?, ?, ?, ?)');
    stmt.run(pid, email, password, profileName, profileId);
}


function getBrowserUseSessionByPID(pid) {
  let stmt = db.prepare('SELECT profile_id FROM browser_use_profiles WHERE pid = ?');
  let row = stmt.get(pid);
  return row ? row.profile_id : null;
}

function cacheSchedule(courseCode, termCode, scheduleData) {
  // Since schedules are complex and mutable, we will store them in a JSON file instead of the database.
  const fs = require('fs');
  const path = `schedules/${courseCode}_${termCode}.json`;
  fs.writeFileSync(path, JSON.stringify(scheduleData));
}

function getSchedule(courseCode, termCode) {
  const fs = require('fs');
  const path = `schedules/${courseCode}_${termCode}.json`;
  if (fs.existsSync(path)) {
    return JSON.parse(fs.readFileSync(path));
  } else {
    return null;
  } // Caller will need to scrape if this returns null
}

export { cacheProfessorScore, getProfessorScore, cacheSchedule, getSchedule };