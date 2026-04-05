/**
 * @file db_init.js
 * @description Initializes the SQLITE database for caching professor scores.
 * This script should be run once to set up the database schema,
 * although it has safeguards to prevent overwriting existing data.
 * @version 1.0.0
 * @author Keramis
 */

/**
 * NOTE: Storing schedules will be done via a JSON table instead of sqlite,
 * since schedules are more complex and less structured than professor scores,
 * and very mutable (and keeping TEXT json array inside sqlite would be 
 * pointless and inefficient). Professor scores are more structured and less mutable,
 * and benefit from fast lookups via sqlite.
 */

import Database from 'better-sqlite3';
const db = new Database('cache.db');

db.pragma('journal_mode = WAL');
// Enable Write-Ahead Logging for better concurrency

//TODO: Add indexes on professor name and course code for faster lookups.

// create professors table so both tables can reference it
db.exec(`
  CREATE TABLE IF NOT EXISTS professors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
  )
`);

// Create rmp_evaluations table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS rmp_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_internal_id INTEGER REFERENCES professors(id),
    course_code TEXT,
    rmp_score REAL,
    rmp_difficulty REAL,
    rmp_would_take_again REAL,
    rmp_tags TEXT,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);
// rmp_tags would need to be stored as a JSON array.


// create CAPE evaluations table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS cape_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_internal_id INTEGER REFERENCES professors(id),
    course_code TEXT,
    recommend_prof REAL,
    recommend_course REAL,
    avg_grade_expected REAL,
    avg_hours_per_week REAL,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);


// table for the browser-use profiles for each user (stores cookies/localstore)
// we unforunately store email:pass SSO in plaintext for now.
db.exec(`
  CREATE TABLE IF NOT EXISTS browser_use_profiles (
    pid INTEGER PRIMARY KEY AUTOINCREMENT, --used for referencing users (PID)
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    profile_name TEXT,
    profile_id TEXT --what's actually used in the requests to BW
  )
`);