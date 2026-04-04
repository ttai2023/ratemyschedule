/**
 * @file handler.js
 * @description This file contains the handler functions for the backend APPI
 * endpoints. Handles professor-score caching, schedule caching (both
 * via SQLITE database for fast lookups).
 * @version 1.0.0
 * @author Keramis
 */

const db = require('better-sqlite3')('cache.db');