/**
 * @file handler.js
 * @description This file contains the handler functions for the backend APPI
 * endpoints. Handles professor-score caching, schedule caching (both
 * via SQLITE database for fast lookups).
 * @version 1.0.0
 * @author Keramis
 */

const db = require('better-sqlite3')('cache.db');
const { rankSchedules } = require('./scorer');

/**
 * POST /api/rank
 *
 * Body:
 *   candidates:  Schedule[]   — from the schedule generator
 *   weights:     Object       — { professor, time, finals, days, difficulty }
 *                               raw integer ranks from the extension; will be
 *                               normalised here so they sum to 1
 *   prefs:       Object       — { prefStart, prefEnd, preferredDaysOff,
 *                                 minHours, maxHours }
 *
 * Returns the candidates array sorted by score, each annotated with
 * .score (0–100) and .breakdown ({ professor, time, finals, days, difficulty }).
 */
function handleRank(req, res) {
  const { candidates = [], weights = {}, prefs = {} } = req.body;

  // Normalise weights so they sum to 1
  const CRITERIA = ["professor", "time", "finals", "days", "difficulty"];
  const total = CRITERIA.reduce((s, k) => s + (weights[k] ?? 0), 0);
  const normWeights = total > 0
    ? Object.fromEntries(CRITERIA.map(k => [k, (weights[k] ?? 0) / total]))
    : Object.fromEntries(CRITERIA.map(k => [k, 1 / CRITERIA.length]));

  // Convert preferredDaysOff array → Set expected by scorer
  const resolvedPrefs = {
    ...prefs,
    preferredDaysOff: new Set(prefs.preferredDaysOff ?? []),
  };

  const ranked = rankSchedules(candidates, normWeights, resolvedPrefs);
  res.json(ranked);
}