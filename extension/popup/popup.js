// ── Tab switching ──────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// ── Course Selection ───────────────────────────────────────────
const API_BASE = "http://localhost:3000";

// courses: array of { code, name, units, instructors: [{name, rmp}] }
const courses = [];
const completedCourses = [];

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Search ─────────────────────────────────────────────────────
document.getElementById("search-btn").addEventListener("click", runSearch);
document.getElementById("course-search").addEventListener("keydown", e => {
  if (e.key === "Enter") runSearch();
});

async function runSearch() {
  const dept = document.getElementById("dept-select").value;
  const q    = document.getElementById("course-search").value.trim();
  if (!dept && !q) return;

  const container = document.getElementById("search-results");
  container.innerHTML = '<p class="search-loading">Searching…</p>';

  try {
    const params = new URLSearchParams({ dept, q });
    const res  = await fetch(`${API_BASE}/api/courses/search?${params}`);
    if (!res.ok) throw new Error("API error");
    const data = await res.json();
    renderSearchResults(data);
  } catch {
    container.innerHTML = '<p class="search-error">Could not reach API. Is the server running?</p>';
  }
}

function renderSearchResults(results) {
  const container = document.getElementById("search-results");
  if (!results.length) {
    container.innerHTML = '<p class="empty-state">No courses found.</p>';
    return;
  }
  container.innerHTML = results.map(c => {
    const instructorHtml = (c.instructors ?? []).map(i =>
      `${esc(i.name)}${i.rmp != null ? ` <span class="rmp-badge">★${i.rmp}</span>` : ""}`
    ).join(", ") || "TBA";
    const added = courses.some(x => x.code === c.code);
    return `
      <div class="course-card">
        <div class="course-card-top">
          <div class="course-card-info">
            <span class="course-code">${esc(c.code)}</span>
            <span class="course-card-name">${esc(c.name)}</span>
          </div>
          <button class="add-result-btn${added ? " added" : ""}" data-code="${esc(c.code)}">
            ${added ? "✓" : "+"}
          </button>
        </div>
        <div class="course-card-meta">${esc(c.units)} cr · ${instructorHtml}</div>
      </div>`;
  }).join("");

  container.querySelectorAll(".add-result-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const result = results.find(r => r.code === btn.dataset.code);
      if (result) {
        addCourseFromResult(result);
        btn.textContent = "✓";
        btn.classList.add("added");
      }
    });
  });
}

// ── My Courses ─────────────────────────────────────────────────
function addCourseFromResult(c) {
  if (courses.some(x => x.code === c.code)) return;
  courses.push(c);
  renderCourseList();
  syncPassLists();
}

function removeCourse(code) {
  const idx = courses.findIndex(c => c.code === code);
  if (idx !== -1) courses.splice(idx, 1);
  renderCourseList();
  syncPassLists();
}

function renderCourseList() {
  const list  = document.getElementById("course-list");
  const badge = document.getElementById("course-count");
  badge.textContent = courses.length;

  if (courses.length === 0) {
    list.innerHTML = '<li class="empty-state">No courses added yet.</li>';
    return;
  }
  list.innerHTML = courses.map(c => {
    const rmp = c.instructors?.[0]?.rmp;
    const rmpHtml = rmp != null ? `<span class="rmp-badge">★${rmp}</span>` : "";
    return `
      <li>
        <div class="course-item-info">
          <span class="course-code">${esc(c.code)}</span>
          <span class="course-item-meta">${esc(c.units)} cr ${rmpHtml}</span>
        </div>
        <button class="remove-btn" data-code="${esc(c.code)}">&times;</button>
      </li>`;
  }).join("");
  list.querySelectorAll(".remove-btn").forEach(btn => {
    btn.addEventListener("click", () => removeCourse(btn.dataset.code));
  });
}

// ── Completed Courses ──────────────────────────────────────────
document.getElementById("add-completed-btn").addEventListener("click", addCompleted);
document.getElementById("completed-input").addEventListener("keydown", e => {
  if (e.key === "Enter") addCompleted();
});

document.getElementById("completed-toggle").addEventListener("click", () => {
  const body  = document.getElementById("completed-section");
  const arrow = document.querySelector("#completed-toggle .toggle-arrow");
  const open  = body.style.display !== "none";
  body.style.display  = open ? "none" : "flex";
  arrow.textContent   = open ? "▸" : "▾";
});

function addCompleted() {
  const input = document.getElementById("completed-input");
  const code  = input.value.trim().toUpperCase();
  if (!code || completedCourses.includes(code)) return;
  completedCourses.push(code);
  input.value = "";
  renderCompletedList();
}

function removeCompleted(code) {
  const idx = completedCourses.indexOf(code);
  if (idx !== -1) completedCourses.splice(idx, 1);
  renderCompletedList();
}

function renderCompletedList() {
  const list  = document.getElementById("completed-list");
  const badge = document.getElementById("completed-count");
  badge.textContent = completedCourses.length;

  if (completedCourses.length === 0) {
    list.innerHTML = '<li class="empty-state">No completed courses yet.</li>';
    return;
  }
  list.innerHTML = completedCourses.map(c => `
    <li>
      <span>${esc(c)}</span>
      <button class="remove-btn" data-code="${esc(c)}">&times;</button>
    </li>`).join("");
  list.querySelectorAll(".remove-btn").forEach(btn => {
    btn.addEventListener("click", () => removeCompleted(btn.dataset.code));
  });
}

// ── Priorities drag-and-drop ───────────────────────────────────
const PRIORITY_COLORS = ["#2c3e7a", "#3d6bbf", "#5c9ee8", "#85beff", "#b8d8ff"];

let dragSrc = null;

let weightMode = "gentle";

function computeWeights(n, mode) {
  let raw;
  if (mode === "aggressive") {
    raw = Array.from({ length: n }, (_, i) => Math.pow(2, n - 1 - i));
  } else if (mode === "balanced") {
    // Reciprocal / rank-order centroid (ROC) weights: 1/1, 1/2, 1/3 ...
    raw = Array.from({ length: n }, (_, i) => 1 / (i + 1));
  } else {
    // Gentle: linear decay
    raw = Array.from({ length: n }, (_, i) => n - i);
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  // Round but ensure they sum to 100
  const floats = raw.map(w => w / sum * 100);
  const floored = floats.map(Math.floor);
  const remainder = 100 - floored.reduce((a, b) => a + b, 0);
  // Add remainder to the largest fractional items
  const deltas = floats.map((f, i) => ({ i, frac: f - floored[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) floored[deltas[k].i]++;
  return floored;
}

function updateWeights() {
  const items = [...document.querySelectorAll("#priority-list li")];
  const weights = computeWeights(items.length, weightMode);

  items.forEach((item, i) => {
    const pill = item.querySelector(".weight-pill");
    pill.textContent = weights[i] + "%";
    pill.style.background = PRIORITY_COLORS[i] + "22";
    pill.style.color = PRIORITY_COLORS[i];
    pill.style.borderColor = PRIORITY_COLORS[i] + "55";
    item.style.borderLeftColor = PRIORITY_COLORS[i];
  });

  renderWeightBar(items, weights);
}

function renderWeightBar(items, weights) {
  const bar    = document.getElementById("weight-bar");
  const legend = document.getElementById("weight-bar-legend");

  bar.innerHTML = items.map((item, i) => `
    <div class="weight-segment" style="width:${weights[i]}%;background:${PRIORITY_COLORS[i]}"
         title="${item.querySelector(".priority-label").textContent}: ${weights[i]}%"></div>
  `).join("");

  legend.innerHTML = items.map((item, i) => `
    <span class="legend-item">
      <span class="legend-dot" style="background:${PRIORITY_COLORS[i]}"></span>
      ${item.querySelector(".priority-label").textContent}
    </span>
  `).join("");
}

function bindDragEvents(item) {
  item.addEventListener("dragstart", () => {
    dragSrc = item;
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => {
    item.classList.remove("dragging");
    document.querySelectorAll("#priority-list li").forEach(i => i.classList.remove("drag-over"));
    updateWeights();
  });
  item.addEventListener("dragover", e => {
    e.preventDefault();
    if (item !== dragSrc) item.classList.add("drag-over");
  });
  item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
  item.addEventListener("drop", e => {
    e.preventDefault();
    if (item !== dragSrc) {
      const list = item.parentNode;
      const items = [...list.children];
      const srcIdx = items.indexOf(dragSrc);
      const dstIdx = items.indexOf(item);
      if (srcIdx < dstIdx) list.insertBefore(dragSrc, item.nextSibling);
      else list.insertBefore(dragSrc, item);
    }
    item.classList.remove("drag-over");
  });
}

document.querySelectorAll("#priority-list li").forEach(bindDragEvents);

document.querySelectorAll(".curve-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".curve-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    weightMode = btn.dataset.curve;
    updateWeights();
  });
});

// Initial render
updateWeights();

// ── Day buttons toggle ─────────────────────────────────────────
document.querySelectorAll(".day-btn").forEach(btn => {
  btn.addEventListener("click", () => btn.classList.toggle("active"));
});

// ── Results ────────────────────────────────────────────────────
const CAL_START = 7;   // 7 am
const CAL_END   = 22;  // 10 pm
const PX_PER_HR = 38;
const PX_PER_MIN = PX_PER_HR / 60;

const COURSE_COLORS = [
  { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af" },
  { bg: "#dcfce7", border: "#22c55e", text: "#166534" },
  { bg: "#fef3c7", border: "#f59e0b", text: "#78350f" },
  { bg: "#f3e8ff", border: "#a855f7", text: "#6b21a8" },
  { bg: "#ffedd5", border: "#f97316", text: "#7c2d12" },
  { bg: "#cffafe", border: "#06b6d4", text: "#164e63" },
];

// Placeholder schedules — swap with real API data later
const PLACEHOLDER_SCHEDULES = [
  {
    score: 91,
    breakdown: { professor: 95, time: 88, finals: 85, days: 90, difficulty: 78 },
    sections: [
      { code: "CSE 110", name: "Software Engineering",
        days: [1,3,5], start: "10:00", end: "10:50",
        instructor: "Thomas Powell", rmp: 4.1,
        cape: { grade: "B+", hours: 8.2, recommend: 82 },
        room: "CENTR 115", final: "Sat Dec 14, 3:00–6:00 PM", colorIdx: 0 },
      { code: "CSE 101", name: "Design & Analysis of Algorithms",
        days: [2,4], start: "11:00", end: "12:20",
        instructor: "Miles Jones", rmp: 3.8,
        cape: { grade: "B", hours: 11.5, recommend: 71 },
        room: "WLH 2001", final: "Mon Dec 9, 11:30 AM–2:30 PM", colorIdx: 1 },
      { code: "MATH 18", name: "Linear Algebra",
        days: [1,3,5], start: "13:00", end: "13:50",
        instructor: "Brendon Rhoades", rmp: 4.5,
        cape: { grade: "B+", hours: 9.1, recommend: 91 },
        room: "YORK 2722", final: "Wed Dec 11, 3:00–6:00 PM", colorIdx: 2 },
    ],
  },
  {
    score: 84,
    breakdown: { professor: 88, time: 72, finals: 90, days: 85, difficulty: 82 },
    sections: [
      { code: "CSE 110", name: "Software Engineering",
        days: [1,3,5], start: "08:00", end: "08:50",
        instructor: "Thomas Powell", rmp: 4.1,
        cape: { grade: "B+", hours: 8.2, recommend: 82 },
        room: "CENTR 115", final: "Sat Dec 14, 3:00–6:00 PM", colorIdx: 0 },
      { code: "CSE 101", name: "Design & Analysis of Algorithms",
        days: [2,4], start: "14:00", end: "15:20",
        instructor: "Daniel Kane", rmp: 4.2,
        cape: { grade: "B+", hours: 10.8, recommend: 79 },
        room: "PCYNH 109", final: "Mon Dec 9, 11:30 AM–2:30 PM", colorIdx: 1 },
      { code: "MATH 18", name: "Linear Algebra",
        days: [2,4], start: "09:30", end: "10:50",
        instructor: "Brendon Rhoades", rmp: 4.5,
        cape: { grade: "B+", hours: 9.1, recommend: 91 },
        room: "YORK 2722", final: "Wed Dec 11, 3:00–6:00 PM", colorIdx: 2 },
    ],
  },
  {
    score: 76,
    breakdown: { professor: 72, time: 80, finals: 65, days: 78, difficulty: 88 },
    sections: [
      { code: "CSE 110", name: "Software Engineering",
        days: [2,4], start: "09:30", end: "10:50",
        instructor: "Thomas Powell", rmp: 4.1,
        cape: { grade: "B+", hours: 8.2, recommend: 82 },
        room: "CENTR 115", final: "Sat Dec 14, 3:00–6:00 PM", colorIdx: 0 },
      { code: "CSE 101", name: "Design & Analysis of Algorithms",
        days: [1,3,5], start: "12:00", end: "12:50",
        instructor: "Miles Jones", rmp: 3.8,
        cape: { grade: "B", hours: 11.5, recommend: 71 },
        room: "WLH 2001", final: "Mon Dec 9, 11:30 AM–2:30 PM", colorIdx: 1 },
      { code: "MATH 18", name: "Linear Algebra",
        days: [1,3,5], start: "14:00", end: "14:50",
        instructor: "Brendon Rhoades", rmp: 4.5,
        cape: { grade: "B+", hours: 9.1, recommend: 91 },
        room: "YORK 2722", final: "Wed Dec 11, 3:00–6:00 PM", colorIdx: 2 },
    ],
  },
];

let currentScheduleIdx = 0;
let activeSchedules = [];

function timeMins(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  const p = h >= 12 ? "pm" : "am";
  const d = h > 12 ? h - 12 : h || 12;
  return m ? `${d}:${String(m).padStart(2,"0")}${p}` : `${d}${p}`;
}

document.getElementById("run-btn").addEventListener("click", launchResults);
document.getElementById("run-btn-rerun").addEventListener("click", launchResults);

function launchResults() {
  activeSchedules = PLACEHOLDER_SCHEDULES; // swap with API call later
  currentScheduleIdx = 0;
  document.getElementById("results-empty").style.display = "none";
  document.getElementById("results-content").style.display = "flex";
  renderSchedule();
}

function renderSchedule() {
  const s = activeSchedules[currentScheduleIdx];
  const n = activeSchedules.length;

  // Nav
  document.getElementById("sched-label").textContent =
    `Schedule ${currentScheduleIdx + 1} of ${n}`;
  document.getElementById("sched-prev").disabled = currentScheduleIdx === 0;
  document.getElementById("sched-next").disabled = currentScheduleIdx === n - 1;

  const badge = document.getElementById("sched-score-badge");
  badge.textContent = s.score;
  badge.className = "sched-score-badge " +
    (s.score >= 80 ? "score-good" : s.score >= 60 ? "score-ok" : "score-poor");

  renderScoreBreakdown(s.breakdown);
  renderCalendar(s);
  hideSectionDetail();
}

document.getElementById("sched-prev").addEventListener("click", () => {
  if (currentScheduleIdx > 0) { currentScheduleIdx--; renderSchedule(); }
});
document.getElementById("sched-next").addEventListener("click", () => {
  if (currentScheduleIdx < activeSchedules.length - 1) { currentScheduleIdx++; renderSchedule(); }
});

function renderScoreBreakdown(bd) {
  const criteria = [
    { id: "professor", label: "Professor" },
    { id: "time",      label: "Time" },
    { id: "finals",    label: "Finals" },
    { id: "days",      label: "Days" },
    { id: "difficulty",label: "Difficulty" },
  ];
  document.getElementById("score-breakdown").innerHTML = criteria.map(c => {
    const v = bd[c.id] ?? 0;
    const col = v >= 80 ? "#22c55e" : v >= 60 ? "#f59e0b" : "#ef4444";
    return `<div class="breakdown-row">
      <span class="breakdown-label">${c.label}</span>
      <div class="breakdown-bar-bg">
        <div class="breakdown-bar-fill" style="width:${v}%;background:${col}"></div>
      </div>
      <span class="breakdown-score">${v}</span>
    </div>`;
  }).join("");
}

function renderCalendar(schedule) {
  const body = document.getElementById("cal-body");
  body.innerHTML = "";
  const totalH = CAL_END - CAL_START;
  body.style.height = (totalH * PX_PER_HR) + "px";

  // Time gutter
  const gutter = document.createElement("div");
  gutter.className = "cal-gutter";
  for (let h = CAL_START; h < CAL_END; h++) {
    const lbl = document.createElement("div");
    lbl.className = "cal-hour-label";
    lbl.style.top = ((h - CAL_START) * PX_PER_HR) + "px";
    lbl.textContent = h > 12 ? `${h-12}p` : h === 12 ? "12p" : `${h}a`;
    gutter.appendChild(lbl);
  }
  body.appendChild(gutter);

  // Day columns
  for (let d = 1; d <= 5; d++) {
    const col = document.createElement("div");
    col.className = "cal-col";

    for (let h = 0; h < totalH; h++) {
      const line = document.createElement("div");
      line.className = "cal-hour-line";
      line.style.top = (h * PX_PER_HR) + "px";
      col.appendChild(line);
    }

    schedule.sections.forEach(sec => {
      if (!sec.days.includes(d)) return;
      const startM = timeMins(sec.start);
      const endM   = timeMins(sec.end);
      const top    = (startM - CAL_START * 60) * PX_PER_MIN;
      const height = Math.max((endM - startM) * PX_PER_MIN, 22);
      const clr    = COURSE_COLORS[sec.colorIdx % COURSE_COLORS.length];

      const ev = document.createElement("div");
      ev.className = "cal-event-block";
      ev.style.cssText =
        `top:${top}px;height:${height}px;` +
        `background:${clr.bg};border-left:3px solid ${clr.border};color:${clr.text}`;
      ev.innerHTML =
        `<div class="ev-code">${esc(sec.code)}</div>` +
        `<div class="ev-time">${fmtTime(sec.start)}–${fmtTime(sec.end)}</div>`;
      ev.addEventListener("click", () => showSectionDetail(sec, clr));
      col.appendChild(ev);
    });

    body.appendChild(col);
  }
}

function showSectionDetail(sec, clr) {
  const panel = document.getElementById("section-detail");
  panel.style.borderTopColor = clr.border;
  document.getElementById("detail-code").textContent = sec.code;
  document.getElementById("detail-name").textContent = sec.name;
  document.getElementById("detail-body").innerHTML = `
    <div class="detail-row">
      <span class="detail-lbl">Instructor</span>
      <span>${esc(sec.instructor)} <span class="rmp-badge">★${sec.rmp}</span></span>
    </div>
    <div class="detail-row">
      <span class="detail-lbl">CAPE</span>
      <span>Avg ${esc(sec.cape.grade)} · ${sec.cape.hours}h/wk · ${sec.cape.recommend}% rec</span>
    </div>
    <div class="detail-row">
      <span class="detail-lbl">Room</span>
      <span>${esc(sec.room)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-lbl">Final</span>
      <span>${esc(sec.final)}</span>
    </div>`;
  panel.style.display = "block";
}

function hideSectionDetail() {
  document.getElementById("section-detail").style.display = "none";
}

document.getElementById("detail-close").addEventListener("click", hideSectionDetail);

// ── Pass Strategy ──────────────────────────────────────────────

// Placeholder difficulty/seat data — replace with API response
const PASS_META = {
  "CSE 110": { seats: 12,  difficulty: "Hard",   reason: "Fills within the first hour"   },
  "CSE 101": { seats: 28,  difficulty: "Hard",   reason: "Very high demand every quarter" },
  "CSE 120": { seats: 18,  difficulty: "Hard",   reason: "Limited sections, long waitlist"},
  "CSE 105": { seats: 34,  difficulty: "Medium", reason: "Competitive but not instant"    },
  "MATH 18":  { seats: 45,  difficulty: "Medium", reason: "Moderate competition"           },
  "MATH 20A": { seats: 72,  difficulty: "Easy",   reason: "Many sections available"        },
  "ECE 100":  { seats: 22,  difficulty: "Hard",   reason: "Often over-enrolled"            },
  "ECE 101":  { seats: 38,  difficulty: "Medium", reason: "Can usually add 2nd pass"       },
};

function defaultMeta(_code, idx) {
  const buckets = [
    { seats: 15, difficulty: "Hard",   reason: "Historically over-enrolled"   },
    { seats: 40, difficulty: "Medium", reason: "Moderate demand expected"      },
    { seats: 70, difficulty: "Easy",   reason: "Usually easy to get a seat"    },
  ];
  return buckets[idx % buckets.length];
}

// passAssignments: [{ code, name, seats, difficulty, reason, colorIdx, pass }]
let passAssignments = [];

function syncPassLists() {
  passAssignments = [];
  renderPassColumns();
}

document.getElementById("assign-pass-btn").addEventListener("click", autoAssignPasses);

function autoAssignPasses() {
  // Build from active schedule sections if available, else from courses list
  const source = activeSchedules.length > 0
    ? activeSchedules[currentScheduleIdx].sections.map((s, i) => ({ code: s.code, name: s.name, colorIdx: s.colorIdx ?? i }))
    : courses.map((c, i) => ({ code: c.code, name: c.name || c.code, colorIdx: i }));

  if (!source.length) {
    alert("Add courses first, or run Analyze on the Results tab.");
    return;
  }

  passAssignments = source.map((s, i) => {
    const meta = PASS_META[s.code] ?? defaultMeta(s.code, i);
    const autoPass = meta.difficulty === "Hard" || meta.seats < 30 ? "first" : "second";
    return { ...s, ...meta, pass: autoPass };
  });

  renderPassColumns();
}

function renderPassColumns() {
  renderPassZone("drop-first",  passAssignments.filter(p => p.pass === "first"));
  renderPassZone("drop-second", passAssignments.filter(p => p.pass === "second"));
}

function renderPassZone(zoneId, items) {
  const zone = document.getElementById(zoneId);
  zone.innerHTML = "";

  if (!items.length) {
    zone.innerHTML = '<p class="empty-state">Drop courses here.</p>';
    return;
  }

  items.forEach(item => {
    const clr        = COURSE_COLORS[item.colorIdx % COURSE_COLORS.length];
    const seatsClass = item.seats < 25 ? "seats-low" : item.seats < 50 ? "seats-mid" : "seats-ok";
    const diffClass  = `diff-${item.difficulty.toLowerCase()}`;

    const card = document.createElement("div");
    card.className   = "pass-card";
    card.draggable   = true;
    card.dataset.code = item.code;
    card.style.borderLeftColor = clr.border;
    card.innerHTML = `
      <span class="drag-handle">&#9776;</span>
      <div class="pass-card-body">
        <div class="pass-card-top">
          <span class="course-code">${esc(item.code)}</span>
          <span class="diff-badge ${diffClass}">${esc(item.difficulty)}</span>
        </div>
        <div class="pass-card-meta">
          <span class="${seatsClass}">${item.seats} seats</span>
          <span class="pass-card-reason">${esc(item.reason)}</span>
        </div>
      </div>`;

    card.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", item.code);
      setTimeout(() => card.classList.add("dragging"), 0);
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    zone.appendChild(card);
  });
}

// Drop zone events
["drop-first", "drop-second"].forEach(zoneId => {
  const zone = document.getElementById(zoneId);
  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", ()  => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const code       = e.dataTransfer.getData("text/plain");
    const targetPass = zoneId === "drop-first" ? "first" : "second";
    const item       = passAssignments.find(p => p.code === code);
    if (item && item.pass !== targetPass) {
      item.pass = targetPass;
      renderPassColumns();
    }
  });
});
