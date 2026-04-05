(function () {
  const DAY_CODE_TO_LABEL = {
    "1": "M",
    "2": "Tu",
    "3": "W",
    "4": "Th",
    "5": "F",
    "6": "Sa",
    "7": "Su",
  };

  const CAL_DAY_ORDER = ["M", "Tu", "W", "Th", "F", "Sa", "Su"];
  const MAX_CANDIDATES = 2000;

  function normalizeCourseCode(raw) {
    const cleaned = String(raw || "")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "";
    const match = cleaned.match(/^([A-Z&]+)\s*([0-9A-Z]+)$/);
    return match ? `${match[1]} ${match[2]}` : cleaned;
  }

  function normalizeName(raw) {
    return String(raw || "")
      .replace(/;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function toTime(hh, mm) {
    const h = Number.isFinite(Number(hh)) ? Number(hh) : 0;
    const m = Number.isFinite(Number(mm)) ? Number(mm) : 0;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function dayCodeToPattern(dayCode) {
    const raw = String(dayCode || "").trim();
    if (!raw) return "";
    return raw
      .split("")
      .map(d => DAY_CODE_TO_LABEL[d] || "")
      .join("");
  }

  function expandDays(daysStr) {
    const out = [];
    let i = 0;
    const src = String(daysStr || "");
    while (i < src.length) {
      const two = src.slice(i, i + 2);
      if (two === "Tu" || two === "Th" || two === "Sa" || two === "Su") {
        out.push(two);
        i += 2;
      } else {
        out.push(src[i]);
        i += 1;
      }
    }
    return out;
  }

  function toMins(t) {
    if (typeof t === "number") return t;
    const [h, m = 0] = String(t).split(":").map(Number);
    return h * 60 + m;
  }

  function meetingKey(meeting) {
    return [
      meeting.days || "",
      meeting.start || "",
      meeting.end || "",
      meeting.building || "",
      meeting.room || "",
    ].join("|");
  }

  function parseLoadGroupDataRows(rows, courseCode) {
    const normalizedCode = normalizeCourseCode(courseCode);
    const bySection = new Map();

    for (const row of rows || []) {
      const sectionId = String(row?.SECT_CODE || "").trim();
      if (!sectionId) continue;

      const type = String(row?.FK_CDI_INSTR_TYPE || "").trim() || "LE";
      const status = String(row?.FK_SST_SCTN_STATCD || "").trim() || "";
      const instructor = normalizeName(row?.PERSON_FULL_NAME) || "Staff";

      if (!bySection.has(sectionId)) {
        bySection.set(sectionId, {
          courseCode: normalizedCode,
          section_id: sectionId,
          section_number: String(row?.SECTION_NUMBER || "").trim(),
          type,
          instructor,
          meetings: [],
          final: null,
          seats_total: Number(row?.SCTN_CPCTY_QTY ?? 0),
          seats_available: Number(row?.AVAIL_SEAT ?? 0),
          enrolled: Number(row?.SCTN_ENRLT_QTY ?? 0),
          waitlist: Number(row?.COUNT_ON_WAITLIST ?? 0),
          status,
          rmp_quality: null,
          cape_recommend_prof: null,
          capeHours: null,
        });
      }

      const section = bySection.get(sectionId);
      section.type = type || section.type;
      section.status = status || section.status;
      section.instructor = instructor || section.instructor;
      section.seats_total = Number(row?.SCTN_CPCTY_QTY ?? section.seats_total ?? 0);
      section.seats_available = Number(row?.AVAIL_SEAT ?? section.seats_available ?? 0);
      section.enrolled = Number(row?.SCTN_ENRLT_QTY ?? section.enrolled ?? 0);
      section.waitlist = Number(row?.COUNT_ON_WAITLIST ?? section.waitlist ?? 0);

      const specialCode = String(row?.FK_SPM_SPCL_MTG_CD || "").trim().toUpperCase();
      const start = toTime(row?.BEGIN_HH_TIME, row?.BEGIN_MM_TIME);
      const end = toTime(row?.END_HH_TIME, row?.END_MM_TIME);
      const days = dayCodeToPattern(row?.DAY_CODE);
      const building = String(row?.BLDG_CODE || "").trim();
      const room = String(row?.ROOM_CODE || "").trim();

      if (specialCode === "FI") {
        section.final = {
          date: String(row?.START_DATE || row?.SECTION_END_DATE || "").trim(),
          start,
          end,
          building,
          room,
        };
        continue;
      }

      if (!days) continue;
      const meeting = { days, start, end, building, room };
      const dedupe = new Set(section.meetings.map(meetingKey));
      if (!dedupe.has(meetingKey(meeting))) {
        section.meetings.push(meeting);
      }
    }

    return {
      code: normalizedCode,
      sections: [...bySection.values()].sort((a, b) => String(a.section_id).localeCompare(String(b.section_id))),
    };
  }

  function groupLetter(sectionId) {
    const match = String(sectionId || "").match(/^([A-Za-z]+)/);
    return match ? match[1].toUpperCase() : "A";
  }

  function buildBundles(rawSections, courseCode) {
    const sections = (rawSections || []).map(raw => ({
      ...raw,
      courseCode: normalizeCourseCode(courseCode),
    }));

    const groups = {};
    for (const section of sections) {
      const key = groupLetter(section.section_id);
      (groups[key] ??= []).push(section);
    }

    const bundles = [];

    for (const secs of Object.values(groups)) {
      const lectures = secs.filter(s => s.type === "LE");
      const linked = secs.filter(s => s.type === "DI" || s.type === "LA");

      if (!lectures.length && !linked.length) continue;
      if (!lectures.length) {
        linked.forEach(sec => bundles.push([sec]));
        continue;
      }
      if (!linked.length) {
        lectures.forEach(sec => bundles.push([sec]));
        continue;
      }

      for (const lecture of lectures) {
        for (const child of linked) {
          bundles.push([lecture, child]);
        }
      }
    }

    return bundles;
  }

  function meetingsConflict(a, b) {
    const aDays = new Set(expandDays(a.days || ""));
    const bDays = new Set(expandDays(b.days || ""));
    if (![...aDays].some(day => bDays.has(day))) return false;

    const aStart = toMins(a.start);
    const aEnd = toMins(a.end);
    const bStart = toMins(b.start);
    const bEnd = toMins(b.end);
    return !(aEnd <= bStart || bEnd <= aStart);
  }

  function bundleConflicts(chosenBundles, candidateBundle) {
    const candidateMeetings = candidateBundle.flatMap(s => s.meetings || []);
    for (const bundle of chosenBundles) {
      for (const sec of bundle) {
        for (const a of sec.meetings || []) {
          for (const b of candidateMeetings) {
            if (meetingsConflict(a, b)) return true;
          }
        }
      }
    }
    return false;
  }

  function generateSchedules(courseEntries, options = {}) {
    const allowOverlaps = Boolean(options.allowOverlaps);
    const maxCandidates = Number.isFinite(options.maxCandidates)
      ? Math.max(1, Math.floor(options.maxCandidates))
      : MAX_CANDIDATES;

    const perCourseBundles = [];
    const totalBundles = [];
    const missing = [];

    for (const course of courseEntries || []) {
      const code = normalizeCourseCode(course?.code);
      if (!code || !Array.isArray(course?.sections)) {
        perCourseBundles.push([]);
        totalBundles.push(0);
        if (code) missing.push(code);
        continue;
      }

      const bundles = buildBundles(course.sections, code);
      perCourseBundles.push(bundles);
      totalBundles.push(bundles.length);
      if (!bundles.length) missing.push(code);
    }

    if (perCourseBundles.some(b => !b.length)) {
      return { schedules: [], totalBundles, missing };
    }

    const schedules = [];

    function backtrack(courseIdx, chosenBundles) {
      if (schedules.length >= maxCandidates) return;
      if (courseIdx >= perCourseBundles.length) {
        schedules.push({ sections: chosenBundles.flat() });
        return;
      }

      for (const bundle of perCourseBundles[courseIdx]) {
        if (!allowOverlaps && bundleConflicts(chosenBundles, bundle)) {
          continue;
        }
        chosenBundles.push(bundle);
        backtrack(courseIdx + 1, chosenBundles);
        chosenBundles.pop();
        if (schedules.length >= maxCandidates) return;
      }
    }

    backtrack(0, []);
    return { schedules, totalBundles, missing };
  }

  function clamp(v, lo = 0, hi = 1) {
    return Math.min(hi, Math.max(lo, v));
  }

  function finalMs(section) {
    if (!section.final?.date || !section.final?.start) return null;
    const ts = Date.parse(`${section.final.date}T${section.final.start}`);
    return Number.isFinite(ts) ? ts : null;
  }

  function scoreProfessor(sections) {
    const values = (sections || [])
      .map(section => {
        const hasRmp = section.rmp_quality != null && section.rmp_quality >= 1;
        const hasCape = section.cape_recommend_prof != null;
        if (!hasRmp && !hasCape) return null;

        const rmp = hasRmp ? (section.rmp_quality - 1) / 4 : null;
        const cape = hasCape ? section.cape_recommend_prof / 100 : null;
        if (rmp != null && cape != null) return 0.6 * rmp + 0.4 * cape;
        if (rmp != null) return rmp;
        return cape;
      })
      .filter(v => v != null);

    if (!values.length) return 0.5;
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    return clamp(avg);
  }

  function scoreTime(sections, prefs = {}) {
    const meetings = (sections || []).flatMap(section => section.meetings || []);
    if (!meetings.length) return 0.5;

    const prefStart = prefs.prefStart ?? 10 * 60;
    const prefEnd = prefs.prefEnd ?? 16 * 60;
    const hardLimits = prefs.hardLimits || {};
    const hardNoFriday = Boolean(prefs.hardNoFriday);
    const avoidBackToBack = Boolean(prefs.avoidBackToBack);

    const DECAY_WINDOW = 180;
    const baseScores = [];

    for (const meeting of meetings) {
      const start = toMins(meeting.start);
      const end = toMins(meeting.end);
      const daySet = new Set(expandDays(meeting.days || ""));

      if (hardNoFriday && daySet.has("F")) return 0;
      if (hardLimits.neverBefore != null && start <= hardLimits.neverBefore) return 0;
      if (hardLimits.neverAfter != null && end >= hardLimits.neverAfter) return 0;

      if (start >= prefStart && end <= prefEnd) {
        baseScores.push(1);
        continue;
      }

      const early = Math.max(0, prefStart - start);
      const late = Math.max(0, end - prefEnd);
      const outside = early + late;
      baseScores.push(clamp(1 - outside / DECAY_WINDOW));
    }

    let score = baseScores.reduce((sum, v) => sum + v, 0) / baseScores.length;

    if (avoidBackToBack) {
      const byDay = {};
      for (const meeting of meetings) {
        for (const day of expandDays(meeting.days || "")) {
          if (!byDay[day]) byDay[day] = [];
          byDay[day].push({ start: toMins(meeting.start), end: toMins(meeting.end) });
        }
      }

      let backToBackCount = 0;
      let transitionCount = 0;

      for (const day of Object.keys(byDay)) {
        const sorted = byDay[day].sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i++) {
          transitionCount += 1;
          const gap = sorted[i].start - sorted[i - 1].end;
          if (gap >= 0 && gap <= 15) backToBackCount += 1;
        }
      }

      if (transitionCount > 0) {
        const penalty = clamp(backToBackCount / transitionCount);
        score = clamp(score - penalty * 0.35);
      }
    }

    return score;
  }

  function scoreFinals(sections) {
    const times = (sections || [])
      .map(finalMs)
      .filter(v => v != null)
      .sort((a, b) => a - b);

    if (times.length < 2) return 1;

    let minGap = Infinity;
    for (let i = 1; i < times.length; i++) {
      minGap = Math.min(minGap, times[i] - times[i - 1]);
    }

    let score = Math.min(minGap / (1000 * 60 * 60), 48) / 48;
    const dayMs = 24 * 60 * 60 * 1000;
    for (let i = 0; i + 2 < times.length; i++) {
      if (times[i + 2] - times[i] <= dayMs) {
        score = Math.min(score, 0.15);
        break;
      }
    }
    return clamp(score);
  }

  function scoreDayPattern(sections, pattern = "any") {
    if (pattern === "any") return 0.5;

    const allDays = new Set(
      (sections || []).flatMap(section =>
        (section.meetings || []).flatMap(meeting => expandDays(meeting.days || ""))
      )
    );

    if (pattern === "minimize") {
      return clamp(1 - (allDays.size - 1) / 4);
    }

    const mwf = new Set(["M", "W", "F"]);
    const tuth = new Set(["Tu", "Th"]);
    const hasMwf = [...allDays].some(day => mwf.has(day));
    const hasTuTh = [...allDays].some(day => tuth.has(day));

    if (pattern === "MWF") {
      if (hasMwf && !hasTuTh) return 1;
      if (hasMwf && hasTuTh) return 0.5;
      return 0.3;
    }

    if (pattern === "TuTh") {
      if (hasTuTh && !hasMwf) return 1;
      if (hasTuTh && hasMwf) return 0.5;
      return 0.3;
    }

    return 0.5;
  }

  function scoreDifficulty(sections, minHours = 12, maxHours = 20) {
    const withData = (sections || []).filter(section => section.capeHours != null);
    if (!withData.length) return 0.5;

    const total = withData.reduce((sum, section) => sum + Number(section.capeHours || 0), 0);
    if (total >= minHours && total <= maxHours) return 1;
    if (total < minHours) return clamp(0.3 + 0.7 * (total / minHours));
    return clamp(1 - (total - maxHours) / maxHours);
  }

  function normalizeWeights(weights) {
    const keys = ["professor", "time", "finals", "days", "difficulty"];
    const total = keys.reduce((sum, key) => sum + Number(weights?.[key] || 0), 0);
    if (total <= 0) {
      const equal = 1 / keys.length;
      return Object.fromEntries(keys.map(key => [key, equal]));
    }
    return Object.fromEntries(keys.map(key => [key, Number(weights?.[key] || 0) / total]));
  }

  function scoreSchedule(schedule, weights, prefs = {}) {
    const sections = schedule.sections || [];
    const normalized = {
      professor: scoreProfessor(sections),
      time: scoreTime(sections, prefs),
      finals: scoreFinals(sections),
      days: scoreDayPattern(sections, prefs.dayPattern || "any"),
      difficulty: scoreDifficulty(sections, prefs.minHours ?? 12, prefs.maxHours ?? 20),
    };

    const keys = Object.keys(normalized);
    const weightedSum = keys.reduce((sum, key) => sum + Number(weights?.[key] || 0) * normalized[key], 0);

    return {
      score: Math.round(weightedSum * 100),
      breakdown: Object.fromEntries(keys.map(key => [key, Math.round(normalized[key] * 100)])),
    };
  }

  function rankSchedules(candidates, rawWeights, prefs = {}) {
    const weights = normalizeWeights(rawWeights || {});
    const ranked = (candidates || []).map(candidate => {
      const scored = scoreSchedule(candidate, weights, prefs);
      return { ...candidate, score: scored.score, breakdown: scored.breakdown };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  function recommendPasses(sections) {
    const details = (sections || []).map(section => {
      const total = section.seats_total ?? 0;
      const avail = section.seats_available ?? total;
      const waitlist = section.waitlist ?? 0;
      const fillRate = total > 0 ? clamp((total - avail) / total) : 0;
      const noWaitlist = waitlist === 0;
      const isFirst = fillRate >= 0.5 || (noWaitlist && fillRate >= 0.3);
      const fillPct = Math.round(fillRate * 100);

      let reason;
      if (fillRate >= 0.85) reason = `${fillPct}% full - very high competition`;
      else if (fillRate >= 0.5 && !noWaitlist) reason = `${fillPct}% full`;
      else if (noWaitlist && fillRate >= 0.3) reason = `No waitlist - hard to recover (${fillPct}% full)`;
      else if (noWaitlist) reason = "No waitlist - register early";
      else reason = "Capacity available";

      return {
        courseCode: section.courseCode,
        section_id: section.section_id,
        fillRate,
        pass: isFirst ? "first" : "second",
        reason,
      };
    });

    const first = details.filter(d => d.pass === "first").sort((a, b) => b.fillRate - a.fillRate);
    const second = details.filter(d => d.pass === "second").sort((a, b) => a.fillRate - b.fillRate);
    const toLabel = item => `${item.courseCode} ${item.section_id}`;

    return {
      label: `First Pass: [${first.map(toLabel).join(", ") || "none"}] / Second Pass: [${second.map(toLabel).join(", ") || "none"}]`,
      firstPass: first.map(toLabel),
      secondPass: second.map(toLabel),
      details,
    };
  }

  function buildSummary(schedule) {
    const meetings = (schedule.sections || []).flatMap(section => section.meetings || []);
    const daySet = new Set(meetings.flatMap(meeting => expandDays(meeting.days || "")));
    const starts = meetings.map(m => toMins(m.start));
    const ends = meetings.map(m => toMins(m.end));
    const dayString = [...daySet]
      .sort((a, b) => CAL_DAY_ORDER.indexOf(a) - CAL_DAY_ORDER.indexOf(b))
      .join("");
    const earliest = starts.length ? Math.min(...starts) : null;
    const latest = ends.length ? Math.max(...ends) : null;

    const parts = [];
    if (dayString) parts.push(dayString);
    if (earliest != null && latest != null) parts.push(`${fmtMins(earliest)}-${fmtMins(latest)}`);

    const courses = new Set((schedule.sections || []).map(section => section.courseCode)).size;
    parts.push(`${courses} course${courses === 1 ? "" : "s"}`);

    return parts.join(" | ");
  }

  function fmtMins(mins) {
    const h24 = Math.floor(mins / 60);
    const m = mins % 60;
    const suffix = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 > 12 ? h24 - 12 : h24 === 0 ? 12 : h24;
    if (m === 0) return `${h12} ${suffix}`;
    return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
  }

  window.ScheduleEngine = {
    normalizeCourseCode,
    parseLoadGroupDataRows,
    generateSchedules,
    rankSchedules,
    recommendPasses,
    buildSummary,
    toMins,
    expandDays,
  };
})();
