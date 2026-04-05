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
const API_BASE = "http://localhost:3001";

// courses: array of { code, name, units, instructors: [{name, rmp}] }
const courses = [];
const completedCourses = [];

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const DARS_BASE_URL = "https://act.ucsd.edu/studentDarsSelfservice/audit/";
const DARS_LIST_URL = new URL("list.html", DARS_BASE_URL).toString();
const DARS_CREATE_URL = new URL("create.html", DARS_BASE_URL).toString();
const DEGREE_AUDIT_CACHE_KEY = "degreeAudit.latest";
const DEGREE_AUDIT_LOCAL_STORAGE_KEY = "degreeAudit.latest.local";
const DEGREE_AUDIT_CACHE_VERSION = 1;
const DEGREE_AUDIT_DEBUG_LIMIT = 30;
const DEGREE_AUDIT_AUTH_RECOVERY_RETRIES = 1;
const DEGREE_AUDIT_AUTH_RECOVERY_WAIT_MS = 3500;

const degreeAuditEls = {
  status: document.getElementById("degree-audit-status"),
  empty: document.getElementById("degree-audit-empty"),
  content: document.getElementById("degree-audit-content"),
  program: document.getElementById("degree-audit-program"),
  created: document.getElementById("degree-audit-created"),
  openLink: document.getElementById("degree-audit-open-link"),
  preview: document.getElementById("degree-audit-preview"),
  fetchBtn: document.getElementById("fetch-audit-btn"),
  requestBtn: document.getElementById("request-audit-btn"),
  debugLog: document.getElementById("degree-audit-debug-log"),
};

const degreeAuditState = {
  latestAudit: null,
  isWorking: false,
  activeAction: null,
  debugLines: [],
  cacheWarningShown: false,
};

degreeAuditEls.fetchBtn.addEventListener("click", fetchMostRecentAuditManually);
degreeAuditEls.requestBtn.addEventListener("click", requestNewAudit);
initializeDegreeAudit();

async function initializeDegreeAudit() {
  exposeDegreeAuditApi();
  pushDegreeAuditDebug("Popup opened. Starting degree audit bootstrap.");
  updateAuditButtons();
  await renderCachedAudit();
  if (degreeAuditState.latestAudit) {
    setDegreeAuditStatus("Loaded cached audit. Click Fetch Most Recent Audit to refresh.");
    return;
  }

  renderNoAudit("No audit loaded yet. Click Fetch Most Recent Audit to load your latest degree audit.");
  pushDegreeAuditDebug("Waiting for a manual degree-audit fetch.");
}

async function renderCachedAudit() {
  const cached = await readCachedAudit();
  if (!cached) {
    pushDegreeAuditDebug("No cached audit found.");
    return;
  }

  const { audit: cachedAudit, source } = cached;
  if (!cachedAudit.parsedAudit && cachedAudit.rawHtml) {
    try {
      cachedAudit.parsedAudit = parseDegreeAuditHtml(cachedAudit.rawHtml, cachedAudit);
    } catch (error) {
      pushDegreeAuditDebug(`Cached audit parse failed: ${error?.message || error}`);
    }
  }

  degreeAuditState.latestAudit = cachedAudit;
  pushDegreeAuditDebug(`Loaded cached audit ${cachedAudit.id || "(unknown id)"} from ${source}.`);
  renderDegreeAudit(cachedAudit, "Loaded your cached audit.");
}

async function fetchMostRecentAuditManually() {
  if (degreeAuditState.isWorking) return;

  beginAuditAction("fetch");
  setDegreeAuditStatus("Fetching your most recent completed audit...");
  pushDegreeAuditDebug("Manual fetch requested.");

  const maxAttempts = 1 + DEGREE_AUDIT_AUTH_RECOVERY_RETRIES;
  let lastError = null;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await refreshLatestAudit({
          successStatus: "Showing your most recent completed audit.",
        });
        if (attempt > 1) {
          pushDegreeAuditDebug(`Manual fetch recovered on retry ${attempt}/${maxAttempts}.`);
        }
        return;
      } catch (error) {
        lastError = error;
        const message = error?.message || "Could not load degree audits.";
        pushDegreeAuditDebug(`Fetch attempt ${attempt}/${maxAttempts} failed: ${message}`);

        const canRetry = attempt < maxAttempts && shouldTryAuditAuthRecovery(message);
        if (!canRetry) break;

        setDegreeAuditStatus("Audit auth looks stale. Opening DARS and retrying...");
        await openAuditCreatePageForAuthRecovery(attempt);
        pushDegreeAuditDebug(`Waiting ${DEGREE_AUDIT_AUTH_RECOVERY_WAIT_MS}ms before retry.`);
        await wait(DEGREE_AUDIT_AUTH_RECOVERY_WAIT_MS);
      }
    }

    const finalMessage = lastError?.message || "Could not load degree audits.";
    if (degreeAuditState.latestAudit) {
      renderDegreeAudit(
        degreeAuditState.latestAudit,
        `${finalMessage} Showing the cached audit instead.`,
        true
      );
      return;
    }

    renderNoAudit(finalMessage, true);
  } finally {
    endAuditAction();
  }
}

function shouldTryAuditAuthRecovery(message) {
  const text = String(message || "");
  return /sign in|login|auth|session|studentdarsselfservice|401|403|could not fetch audit data|degree audit request failed/i
    .test(text);
}

async function openAuditCreatePageForAuthRecovery(attemptNumber) {
  pushDegreeAuditDebug(
    `Opening DARS create page to refresh auth session (retry ${attemptNumber}/${DEGREE_AUDIT_AUTH_RECOVERY_RETRIES}).`
  );

  if (chrome?.tabs?.create) {
    try {
      await chrome.tabs.create({ url: DARS_CREATE_URL, active: true });
      return;
    } catch (error) {
      pushDegreeAuditDebug(`chrome.tabs.create failed: ${error?.message || error}`);
    }
  }

  const openedWindow = window.open(DARS_CREATE_URL, "_blank", "noopener,noreferrer");
  if (!openedWindow) {
    pushDegreeAuditDebug("Could not open DARS create page automatically (popup may have been blocked).");
  }
}

async function refreshLatestAudit(options = {}) {
  const successStatus = options.successStatus || "Showing your most recent completed audit.";
  pushDegreeAuditDebug("Refreshing latest audit from manage audits.");

  const latestDescriptor = await fetchLatestAuditDescriptor();
  if (!latestDescriptor) {
    degreeAuditState.latestAudit = null;
    renderNoAudit("No completed audits found yet.");
    await clearCachedAudit();
    pushDegreeAuditDebug("Manage audits returned no completed audit rows.");
    return null;
  }

  if (
    degreeAuditState.latestAudit?.id === latestDescriptor.id &&
    degreeAuditState.latestAudit?.parsedAudit
  ) {
    renderDegreeAudit(degreeAuditState.latestAudit, successStatus);
    pushDegreeAuditDebug(`Latest audit unchanged (${latestDescriptor.id}); reused loaded data.`);
    return degreeAuditState.latestAudit;
  }

  const hydratedAudit = await hydrateAudit(latestDescriptor);
  renderDegreeAudit(hydratedAudit, successStatus);
  await writeCachedAudit(hydratedAudit);
  pushDegreeAuditDebug(`Latest audit ready: ${hydratedAudit.id}.`);
  return hydratedAudit;
}

async function requestNewAudit() {
  if (degreeAuditState.isWorking) return;

  beginAuditAction("request");
  setDegreeAuditStatus("Working.. requesting a new degree audit.");
  pushDegreeAuditDebug("Requesting a new degree audit.");

  try {
    const previousAudit = await fetchLatestAuditDescriptor();
    pushDegreeAuditDebug(
      previousAudit
        ? `Previous latest audit: ${previousAudit.id}.`
        : "No previous audit found before request."
    );
    const requestDetails = await buildAuditRequest();

    await fetchAuditText(requestDetails.actionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: requestDetails.params.toString(),
    });

    const latestAudit = await pollForNewAudit(previousAudit?.id ?? null);
    if (!latestAudit) {
      throw new Error("Audit request started, but the new audit did not finish in time.");
    }

    renderDegreeAudit(latestAudit, "New degree audit is ready.");
    await writeCachedAudit(latestAudit);
    pushDegreeAuditDebug(`New audit completed: ${latestAudit.id}.`);
    await refreshLatestAudit({ successStatus: "New degree audit is ready." });
  } catch (error) {
    const message = error?.message || "Could not request a new audit.";
    pushDegreeAuditDebug(`Request failed: ${message}`);
    setDegreeAuditStatus(message, true);
  } finally {
    endAuditAction();
  }
}

async function buildAuditRequest() {
  pushDegreeAuditDebug("Loading create.html to build the audit request.");
  const createHtml = await fetchAuditText(DARS_CREATE_URL);
  const doc = new DOMParser().parseFromString(createHtml, "text/html");
  const form = doc.querySelector('form[name="auditRequest"]');

  if (!form) {
    throw new Error("Could not find the degree audit request form.");
  }

  const params = serializeForm(form);

  if (params.has("auditTemplate")) {
    params.set("auditTemplate", "htm!!!!htm");
  }

  if (params.has("useDefaultDegreePrograms")) {
    params.set("useDefaultDegreePrograms", "true");
  }

  const actionUrl = new URL(form.getAttribute("action") || "create.html", DARS_BASE_URL).toString();
  pushDegreeAuditDebug(`Prepared POST payload with ${Array.from(params.keys()).length} fields.`);
  return { actionUrl, params };
}

function serializeForm(form) {
  const params = new URLSearchParams();
  const fields = form.querySelectorAll("input, select, textarea");

  fields.forEach(field => {
    if (!field.name || field.disabled) return;

    const tag = field.tagName.toLowerCase();
    const type = (field.type || "").toLowerCase();

    if ((type === "checkbox" || type === "radio") && !field.checked) {
      return;
    }

    if (tag === "select" && field.multiple) {
      Array.from(field.selectedOptions).forEach(option => {
        params.append(field.name, option.value);
      });
      return;
    }

    params.append(field.name, field.value ?? "");
  });

  return params;
}

async function pollForNewAudit(previousAuditId) {
  const attempts = 15;
  const delayMs = 2000;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await wait(delayMs);
    }

    setDegreeAuditStatus(`Working.. waiting for the new audit (${attempt + 1}/${attempts}).`);
    const latestDescriptor = await fetchLatestAuditDescriptor();

    if (!latestDescriptor) {
      pushDegreeAuditDebug(`Poll ${attempt + 1}: no audits visible yet.`);
      continue;
    }

    if (latestDescriptor.id !== previousAuditId) {
      pushDegreeAuditDebug(`Poll ${attempt + 1}: found new audit ${latestDescriptor.id}.`);
      return hydrateAudit(latestDescriptor);
    }

    pushDegreeAuditDebug(`Poll ${attempt + 1}: latest audit is still ${latestDescriptor.id}.`);
  }

  return null;
}

async function fetchLatestAuditDescriptor() {
  pushDegreeAuditDebug(`Fetching manage audits from ${DARS_LIST_URL}.`);
  const listHtml = await fetchAuditText(DARS_LIST_URL);
  return parseLatestAuditDescriptor(listHtml);
}

async function hydrateAudit(descriptor) {
  pushDegreeAuditDebug(`Fetching full audit HTML from ${descriptor.readUrl}.`);
  const auditHtml = await fetchAuditText(descriptor.readUrl);
  const parsedAudit = parseDegreeAuditHtml(auditHtml, descriptor);

  const hydrated = {
    ...descriptor,
    rawHtml: auditHtml,
    parsedAudit,
    fetchedAt: new Date().toISOString(),
  };

  degreeAuditState.latestAudit = hydrated;
  pushDegreeAuditDebug(
    `Parsed audit: requirements=${parsedAudit.summary.requirementCount}, subrequirements=${parsedAudit.summary.subrequirementCount}, courses=${parsedAudit.summary.completedCourseCount}.`
  );
  return hydrated;
}

function parseLatestAuditDescriptor(listHtml) {
  const doc = new DOMParser().parseFromString(listHtml, "text/html");
  const row = Array.from(doc.querySelectorAll("table.resultList tr")).find(candidate =>
    candidate.querySelector('a[href*="read.html?id="]')
  );

  if (!row) {
    return null;
  }

  const cells = row.querySelectorAll("td");
  const link = row.querySelector('a[href*="read.html?id="]');
  const readUrl = new URL(link.getAttribute("href"), DARS_LIST_URL).toString();

  pushDegreeAuditDebug(
    `Parsed latest audit row: program=${cleanText(cells[2]?.textContent) || "(unknown)"} id=${getAuditId(readUrl)}.`
  );

  return {
    id: getAuditId(readUrl),
    readUrl,
    program: cleanText(cells[2]?.textContent),
    catalogYear: cleanText(cells[3]?.textContent),
    createdAt: cleanText(cells[4]?.textContent),
    format: cleanText(cells[6]?.textContent),
  };
}

function parseDegreeAuditHtml(auditHtml, descriptor = {}) {
  const doc = new DOMParser().parseFromString(auditHtml, "text/html");
  const student = parseAuditStudentInfo(doc, descriptor);
  const requirements = parseAuditRequirements(doc);
  const summary = buildAuditSummary(student, requirements);

  return {
    parsedAt: new Date().toISOString(),
    student,
    descriptor: {
      id: descriptor.id || "",
      readUrl: descriptor.readUrl || "",
      program: descriptor.program || "",
      catalogYear: descriptor.catalogYear || "",
      createdAt: descriptor.createdAt || "",
      format: descriptor.format || "",
    },
    summary,
    requirements,
  };
}

function parseAuditStudentInfo(doc, descriptor) {
  const titleLines = parseAuditTitleLines(doc);
  const headerEntries = parseAuditHeaderEntries(doc);
  const completionText = cleanText(
    doc.querySelector("#auditHeader .completionTextNO, #auditHeader .completionTextOK, #auditHeader .completionText")
      ?.textContent
  );

  return {
    name: titleLines[0] || "",
    programName: titleLines[1] || descriptor.program || "",
    pid: headerEntries.pid || "",
    programCode: headerEntries.program_code || descriptor.program || "",
    catalogYear: headerEntries.catalog_year || descriptor.catalogYear || "",
    preparedOn: headerEntries.prepared_on || descriptor.createdAt || "",
    graduationDate: headerEntries.graduation_date || "",
    jobId: headerEntries.job_id || "",
    admissionText: cleanText(doc.querySelector("#auditHeader .includeTopText")?.textContent),
    completionText,
    headerEntries,
  };
}

function parseAuditTitleLines(doc) {
  const titleNode = doc.querySelector(".auditTitle");
  if (!titleNode) return [];

  const clone = titleNode.cloneNode(true);
  clone.querySelectorAll(".floatright, script, style").forEach(node => node.remove());
  return splitHtmlLines(clone);
}

function parseAuditHeaderEntries(doc) {
  const labels = Array.from(doc.querySelectorAll(".auditHeaderEntryLabel"));
  const values = Array.from(doc.querySelectorAll(".auditHeaderEntry"));
  const entries = {};
  const max = Math.min(labels.length, values.length);

  for (let i = 0; i < max; i++) {
    const rawLabel = cleanText(labels[i]?.textContent).replace(/:$/, "");
    const value = cleanText(values[i]?.textContent);
    if (!rawLabel) continue;
    entries[normalizeHeaderKey(rawLabel)] = value;
  }

  return entries;
}

function parseAuditRequirements(doc) {
  const requirementNodes = Array.from(doc.querySelectorAll("#auditRequirements > .requirement"));
  return requirementNodes.map(node => parseAuditRequirement(node));
}

function parseAuditRequirement(node) {
  const statusCode = extractStatusCode(node.className);
  const status = normalizeStatus(statusCode);
  const totals = parseMetricRows(node.querySelector(".requirementTotals"));
  const subrequirements = Array.from(node.querySelectorAll(".auditSubrequirements > .subrequirement"))
    .map(subNode => parseAuditSubrequirement(subNode));
  const categoryMatch = String(node.className || "").match(/\bcategory_([^\s]+)/);

  return {
    id: node.id || "",
    rname: node.getAttribute("rname") || "",
    pseudo: node.getAttribute("pseudo") || "",
    category: categoryMatch ? categoryMatch[1].replace(/_/g, " ") : "",
    statusCode,
    status,
    title: cleanText(node.querySelector(".reqTitle")?.textContent),
    headerText: cleanText(node.querySelector(".reqHeader")?.textContent),
    requiredSubrequirements: parseNumber(node.getAttribute("rqdsubreq")),
    requiredCount: parseNumber(node.getAttribute("rqdcount")),
    requiredGpa: parseNumber(node.getAttribute("rqdgpa")),
    requiredHours: parseNumber(node.getAttribute("rqdhours")),
    totals,
    subrequirements,
  };
}

function parseAuditSubrequirement(node) {
  const statusNode = node.querySelector(".subreqPretext .status") || node.querySelector(".status");
  const statusCode = extractStatusCode((statusNode && statusNode.className) || node.className);
  const status = normalizeStatus(statusCode);
  const selectOptions = parseSelectCourseOptions(node);
  const pseudoListRaw = node.getAttribute("pseudolist") || "";
  let pseudoList = [];
  try {
    pseudoList = JSON.parse(pseudoListRaw);
  } catch {
    pseudoList = pseudoListRaw ? [pseudoListRaw] : [];
  }

  return {
    id: node.id || "",
    pseudo: node.getAttribute("pseudo") || "",
    pseudoList,
    number: cleanText(node.querySelector(".subreqNumber")?.textContent),
    statusCode,
    status,
    title: cleanText(node.querySelector(".subreqTitle")?.textContent),
    requiredSubrequirements: parseNumber(node.getAttribute("rqdsubreq")),
    requiredGpa: parseNumber(node.getAttribute("rqdgpa")),
    requiredHours: parseNumber(node.getAttribute("rqdhours")),
    totals: parseMetricRows(node.querySelector(".subrequirementTotals")),
    needs: parseNeedsRows(node),
    completedCourses: parseCompletedCourses(node),
    selectCoursesText: selectOptions.text,
    selectCourses: selectOptions.items,
    notCoursesText: cleanText(
      node.querySelector("table.notcourses .fromcourselist")?.textContent ||
      node.querySelector("table.notcourses")?.textContent
    ),
  };
}

function parseNeedsRows(subNode) {
  return Array.from(subNode.querySelectorAll("table.subreqNeeds tr")).map(row => {
    const label = cleanText(row.querySelector(".rowlabel")?.textContent);
    const hoursText = cleanText(row.querySelector(".hours.number")?.textContent);
    const countText = cleanText(row.querySelector(".count.number")?.textContent);
    const hoursLabel = cleanText(row.querySelector(".hourslabel")?.textContent);
    const countLabel = cleanText(row.querySelector(".countlabel")?.textContent);
    const rawText = cleanText(row.textContent);
    return {
      label: label || null,
      hoursText: hoursText || null,
      hoursValue: parseNumber(hoursText),
      hoursLabel: hoursLabel || null,
      countText: countText || null,
      countValue: parseNumber(countText),
      countLabel: countLabel || null,
      rawText,
    };
  }).filter(row => row.rawText);
}

function parseCompletedCourses(subNode) {
  const courseRows = Array.from(subNode.querySelectorAll("table.completedCourses tr.takenCourse"));
  return courseRows.map(row => {
    const grade = cleanText(row.querySelector(".grade")?.textContent);
    const inProgress = row.classList.contains("ip") || /\bWIP\b/i.test(grade);

    return {
      term: cleanText(row.querySelector(".term")?.textContent),
      course: cleanText(row.querySelector(".course")?.textContent),
      creditText: cleanText(row.querySelector(".credit")?.textContent),
      creditValue: parseNumber(row.querySelector(".credit")?.textContent),
      grade,
      conditionCode: cleanText(row.querySelector(".ccode")?.textContent),
      description: cleanText(row.querySelector(".description")?.textContent),
      isInProgress: inProgress,
    };
  });
}

function parseSelectCourseOptions(subNode) {
  const listNode = subNode.querySelector("table.selectcourses .fromcourselist");
  const text = cleanText(listNode?.textContent);
  const items = Array.from(subNode.querySelectorAll("table.selectcourses .course .number"))
    .map(node => cleanText(node.textContent))
    .filter(Boolean);

  return {
    text,
    items: Array.from(new Set(items)),
  };
}

function parseMetricRows(table) {
  if (!table) return [];

  return Array.from(table.querySelectorAll("tr")).map(row => {
    const rowType = cleanText((row.className || "").split(/\s+/)[0]);
    const label = cleanText(row.querySelector(".rowlabel")?.textContent);
    const hoursText = cleanText(row.querySelector(".hours.number")?.textContent);
    const countText = cleanText(row.querySelector(".count.number")?.textContent);
    const subreqsText = cleanText(row.querySelector(".subreqs.number")?.textContent);
    const gpaText = cleanText(row.querySelector(".gpa.number")?.textContent);
    const pointsText = cleanText(row.querySelector(".points.number")?.textContent);
    const rawText = cleanText(row.textContent);

    return {
      rowType: rowType || null,
      label: label || null,
      hoursText: hoursText || null,
      hoursValue: parseNumber(hoursText),
      hoursLabel: cleanText(row.querySelector(".hourslabel")?.textContent) || null,
      countText: countText || null,
      countValue: parseNumber(countText),
      countLabel: cleanText(row.querySelector(".countlabel")?.textContent) || null,
      subreqsText: subreqsText || null,
      subreqsValue: parseNumber(subreqsText),
      subreqsLabel: cleanText(row.querySelector(".subreqslabel")?.textContent) || null,
      gpaText: gpaText || null,
      gpaValue: parseNumber(gpaText),
      gpaLabel: cleanText(row.querySelector(".gpalabel")?.textContent) || null,
      pointsText: pointsText || null,
      pointsValue: parseNumber(pointsText),
      pointsLabel: cleanText(row.querySelector(".pointslabel")?.textContent) || null,
      rawText,
    };
  }).filter(row => row.rawText);
}

function buildAuditSummary(student, requirements) {
  const requirementStatusCounts = createStatusCounter();
  const subrequirementStatusCounts = createStatusCounter();
  const seenCourses = new Set();
  let inProgressCourseCount = 0;
  let subrequirementCount = 0;
  let outstandingRequirementCount = 0;
  let outstandingSubrequirementCount = 0;
  let remainingCourseCount = 0;
  let remainingUnitCount = 0;

  requirements.forEach(requirement => {
    incrementStatusCounter(requirementStatusCounts, requirement.status);
    if (requirement.status !== "complete" && requirement.status !== "none") {
      outstandingRequirementCount += 1;
    }

    requirement.totals.forEach(row => {
      const rowTag = `${row.label || ""} ${row.rowType || ""}`.toLowerCase();
      if (!/needs/.test(rowTag)) return;
      if (row.countValue != null) remainingCourseCount += row.countValue;
      if (row.hoursValue != null) remainingUnitCount += row.hoursValue;
    });

    requirement.subrequirements.forEach(sub => {
      subrequirementCount += 1;
      incrementStatusCounter(subrequirementStatusCounts, sub.status);
      if (sub.status !== "complete" && sub.status !== "none") {
        outstandingSubrequirementCount += 1;
      }

      sub.needs.forEach(need => {
        if (need.countValue != null) remainingCourseCount += need.countValue;
        if (need.hoursValue != null) remainingUnitCount += need.hoursValue;
      });

      sub.completedCourses.forEach(course => {
        const key = `${course.term}|${course.course}|${course.creditText}|${course.grade}|${course.description}`;
        if (!seenCourses.has(key)) {
          seenCourses.add(key);
          if (course.isInProgress) inProgressCourseCount += 1;
        }
      });
    });
  });

  const unitRequirement = requirements.find(req =>
    req.rname === "TOTALHRX" || /minimum of 180 units/i.test(req.title)
  );
  const gpaRequirement = requirements.find(req =>
    req.rname === "TOTALGPAX" || /uc gpa/i.test(req.title)
  );

  const earnedUnitsRow = unitRequirement?.totals.find(row => String(row.rowType).toLowerCase() === "reqearned");
  const wipUnitsRow = unitRequirement?.totals.find(row => String(row.rowType).toLowerCase() === "reqipdetail");
  const gpaRow = gpaRequirement?.totals.find(row => String(row.rowType).toLowerCase() === "reqearned");

  return {
    completionText: student.completionText || "",
    requirementCount: requirements.length,
    subrequirementCount,
    requirementStatusCounts,
    subrequirementStatusCounts,
    completedCourseCount: seenCourses.size,
    inProgressCourseCount,
    outstandingRequirementCount,
    outstandingSubrequirementCount,
    remainingCourseCount: roundToTwo(remainingCourseCount),
    remainingUnitCount: roundToTwo(remainingUnitCount),
    minimumUnitProgress: {
      earnedUnits: earnedUnitsRow?.hoursValue ?? null,
      inProgressUnits: wipUnitsRow?.hoursValue ?? null,
      targetUnits: unitRequirement?.requiredHours ?? null,
    },
    ucGpa: gpaRow?.gpaValue ?? null,
  };
}

function createStatusCounter() {
  return {
    complete: 0,
    in_progress: 0,
    planned: 0,
    unfulfilled: 0,
    none: 0,
  };
}

function incrementStatusCounter(counter, status) {
  if (counter[status] == null) {
    counter.none += 1;
    return;
  }
  counter[status] += 1;
}

function extractStatusCode(className) {
  const expanded = String(className || "");
  let match = expanded.match(/\bStatus_(OK|NO|IP|PL|NONE)\b/i);
  if (match) return match[1].toUpperCase();
  match = expanded.match(/\bstatus(OK|NO|IP|PL|NONE)\b/i);
  if (match) return match[1].toUpperCase();
  return "NONE";
}

function normalizeStatus(code) {
  const statusCode = String(code || "NONE").toUpperCase();
  if (statusCode === "OK") return "complete";
  if (statusCode === "NO") return "unfulfilled";
  if (statusCode === "IP") return "in_progress";
  if (statusCode === "PL") return "planned";
  return "none";
}

function statusLabel(status) {
  if (status === "complete") return "Complete";
  if (status === "unfulfilled") return "Unfulfilled";
  if (status === "in_progress") return "In Progress";
  if (status === "planned") return "Planned";
  return "Info";
}

function renderDegreeAuditPreview(parsedAudit) {
  if (!parsedAudit) {
    degreeAuditEls.preview.innerHTML = `
      <div class="audit-preview-root">
        <div class="audit-preview-card audit-muted">
          No parsed audit details are available. Fetch the most recent audit to populate this view.
        </div>
      </div>`;
    return;
  }

  const summary = parsedAudit.summary || {};
  const student = parsedAudit.student || {};
  const requirementsHtml = (parsedAudit.requirements || []).map(requirement =>
    renderRequirementPreview(requirement)
  ).join("");

  const minimumUnitBits = [];
  if (summary.minimumUnitProgress?.earnedUnits != null) {
    minimumUnitBits.push(`${summary.minimumUnitProgress.earnedUnits} earned`);
  }
  if (summary.minimumUnitProgress?.inProgressUnits != null) {
    minimumUnitBits.push(`${summary.minimumUnitProgress.inProgressUnits} WIP`);
  }
  if (summary.minimumUnitProgress?.targetUnits != null) {
    minimumUnitBits.push(`${summary.minimumUnitProgress.targetUnits} target`);
  }

  degreeAuditEls.preview.innerHTML = `
    <div class="audit-preview-root">
      <div class="audit-preview-card">
        <div class="audit-preview-title">${esc(student.name || "Student")}</div>
        <div class="audit-preview-subtitle">
          ${esc(student.programName || student.programCode || "Degree Program")}
          ${student.pid ? ` | PID ${esc(student.pid)}` : ""}
        </div>
        ${student.preparedOn ? `<div class="audit-preview-subtitle">Prepared On: ${esc(student.preparedOn)}</div>` : ""}
        ${summary.completionText ? `<div class="audit-completion-text">${esc(summary.completionText)}</div>` : ""}
      </div>

      <div class="audit-summary-grid">
        <div class="audit-summary-item">
          <span class="audit-summary-label">Requirements</span>
          <span class="audit-summary-value">${esc(String(summary.requirementCount || 0))} total | ${esc(String(summary.outstandingRequirementCount || 0))} open</span>
        </div>
        <div class="audit-summary-item">
          <span class="audit-summary-label">Subrequirements</span>
          <span class="audit-summary-value">${esc(String(summary.subrequirementCount || 0))} total | ${esc(String(summary.outstandingSubrequirementCount || 0))} open</span>
        </div>
        <div class="audit-summary-item">
          <span class="audit-summary-label">Completed Courses</span>
          <span class="audit-summary-value">${esc(String(summary.completedCourseCount || 0))} (${esc(String(summary.inProgressCourseCount || 0))} WIP)</span>
        </div>
        <div class="audit-summary-item">
          <span class="audit-summary-label">Needs (aggregate)</span>
          <span class="audit-summary-value">${esc(String(summary.remainingCourseCount || 0))} courses | ${esc(String(summary.remainingUnitCount || 0))} units</span>
        </div>
        <div class="audit-summary-item">
          <span class="audit-summary-label">Minimum Units</span>
          <span class="audit-summary-value">${esc(minimumUnitBits.join(" | ") || "Not available")}</span>
        </div>
        <div class="audit-summary-item">
          <span class="audit-summary-label">UC GPA</span>
          <span class="audit-summary-value">${summary.ucGpa != null ? esc(String(summary.ucGpa)) : "Not available"}</span>
        </div>
      </div>

      ${requirementsHtml || `<div class="audit-preview-card audit-muted">No requirements found in this audit.</div>`}
    </div>
  `;
}

function renderRequirementPreview(requirement) {
  const title = requirement.title || requirement.headerText || requirement.rname || "Requirement";
  const open = requirement.status !== "complete" ? " open" : "";
  const subrequirementsHtml = requirement.subrequirements.map(sub => renderSubrequirementPreview(sub)).join("");
  const totalsHtml = renderMetricList(requirement.totals);

  return `
    <details class="audit-requirement"${open}>
      <summary>
        ${renderStatusBadge(requirement.status)}
        <span class="audit-requirement-title">${esc(title)}</span>
      </summary>
      <div class="audit-requirement-body">
        ${requirement.headerText && requirement.headerText !== requirement.title ? `<div class="audit-muted">${esc(requirement.headerText)}</div>` : ""}
        ${totalsHtml}
        ${subrequirementsHtml || `<div class="audit-muted">No subrequirements listed.</div>`}
      </div>
    </details>
  `;
}

function renderSubrequirementPreview(subrequirement) {
  const open = subrequirement.status !== "complete" ? " open" : "";
  const title = subrequirement.title || "Subrequirement";
  const numberPrefix = subrequirement.number ? `${esc(subrequirement.number)} ` : "";
  const totalsHtml = renderMetricList(subrequirement.totals);
  const needsHtml = renderNeedsList(subrequirement.needs);
  const coursesHtml = renderCompletedCoursesTable(subrequirement.completedCourses);

  return `
    <details class="audit-subrequirement"${open}>
      <summary>
        ${renderStatusBadge(subrequirement.status)}
        <span class="audit-subrequirement-title">${numberPrefix}${esc(title)}</span>
      </summary>
      <div class="audit-subrequirement-body">
        ${totalsHtml}
        ${needsHtml}
        ${coursesHtml}
        ${subrequirement.selectCoursesText ? `<div class="audit-options-block"><strong>Course Options:</strong> ${esc(subrequirement.selectCoursesText)}</div>` : ""}
        ${subrequirement.notCoursesText ? `<div class="audit-options-block"><strong>Excluded Courses:</strong> ${esc(subrequirement.notCoursesText)}</div>` : ""}
      </div>
    </details>
  `;
}

function renderStatusBadge(status) {
  return `<span class="audit-status audit-status-${status}">${esc(statusLabel(status))}</span>`;
}

function renderMetricList(rows) {
  if (!rows || !rows.length) return "";
  const rowsHtml = rows.map(row => {
    const label = row.label || row.rowType || "Detail";
    const value = formatMetricRowValue(row);
    return `
      <div class="audit-metric-row">
        <span class="audit-metric-label">${esc(label)}</span>
        <span class="audit-metric-value">${esc(value)}</span>
      </div>
    `;
  }).join("");
  return `<div class="audit-preview-card">${rowsHtml}</div>`;
}

function renderNeedsList(needs) {
  if (!needs || !needs.length) return "";
  const needsRows = needs.map(need => {
    const label = need.label || "Needs";
    const value = formatNeedsRowValue(need);
    return `
      <div class="audit-metric-row">
        <span class="audit-metric-label">${esc(label)}</span>
        <span class="audit-metric-value">${esc(value)}</span>
      </div>
    `;
  }).join("");
  return `<div class="audit-preview-card">${needsRows}</div>`;
}

function renderCompletedCoursesTable(coursesList) {
  if (!coursesList || !coursesList.length) return "";

  const rowsHtml = coursesList.map(course => `
      <tr class="${course.isInProgress ? "audit-course-in-progress" : ""}">
        <td>${esc(course.term || "")}</td>
        <td>${esc(course.course || "")}</td>
        <td>${esc(course.creditText || "")}</td>
        <td>${esc(course.grade || "")}</td>
        <td>${esc(course.conditionCode || "")}</td>
        <td>${esc(course.description || "")}</td>
      </tr>
    `).join("");

  return `
    <div class="audit-preview-card">
      <div class="audit-preview-subtitle">Completed / In-Progress Courses</div>
      <table class="audit-course-table">
        <thead>
          <tr>
            <th>Term</th>
            <th>Course</th>
            <th>Credit</th>
            <th>Grade</th>
            <th>Code</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function formatMetricRowValue(row) {
  const bits = [];
  if (row.hoursText) bits.push(`${row.hoursText}${row.hoursLabel ? ` ${row.hoursLabel}` : ""}`.trim());
  if (row.countText) bits.push(`${row.countText}${row.countLabel ? ` ${row.countLabel}` : ""}`.trim());
  if (row.subreqsText) bits.push(`${row.subreqsText}${row.subreqsLabel ? ` ${row.subreqsLabel}` : ""}`.trim());
  if (row.pointsText) bits.push(`${row.pointsText}${row.pointsLabel ? ` ${row.pointsLabel}` : " points"}`.trim());
  if (row.gpaText) bits.push(`GPA ${row.gpaText}`);
  if (!bits.length) return row.rawText || "";
  return bits.join(" | ");
}

function formatNeedsRowValue(row) {
  const bits = [];
  if (row.countText) bits.push(`${row.countText}${row.countLabel ? ` ${row.countLabel}` : ""}`.trim());
  if (row.hoursText) bits.push(`${row.hoursText}${row.hoursLabel ? ` ${row.hoursLabel}` : ""}`.trim());
  if (!bits.length) return row.rawText || "";
  return bits.join(" | ");
}

async function fetchAuditText(url, init = {}) {
  const method = init.method || "GET";
  pushDegreeAuditDebug(`${method} ${url}`);

  const auditTab = await findAuditCapableTab();
  if (auditTab?.id != null) {
    pushDegreeAuditDebug(`Using UCSD tab ${auditTab.id} (${auditTab.url || "no url"}) for first-party fetch.`);
    const tabErrors = [];
    const canScript = hasScriptingApi();

    if (canScript) {
      try {
        const mainWorldResult = await fetchAuditTextViaMainWorld(auditTab.id, url, init);
        return validateAuditResponse(mainWorldResult, { url, method, source: "tab-main" });
      } catch (error) {
        const message = error?.message || String(error);
        tabErrors.push(`main-world: ${message}`);
        pushDegreeAuditDebug(`Main-world fetch failed: ${message}`);
      }
    } else {
      pushDegreeAuditDebug("Skipping main-world fetch because chrome.scripting is unavailable in this runtime.");
    }

    try {
      const bridgeResult = await fetchAuditTextViaBridge(auditTab.id, url, init);
      return validateAuditResponse(bridgeResult, { url, method, source: "tab-bridge" });
    } catch (error) {
      const message = error?.message || String(error);
      tabErrors.push(`bridge: ${message}`);
      pushDegreeAuditDebug(`Content bridge fetch failed: ${message}`);
    }

    try {
      pushDegreeAuditDebug("Trying popup-origin fetch as a final fallback.");
      const extensionResult = await fetchAuditTextViaExtension(url, init);
      return validateAuditResponse(extensionResult, { url, method, source: "popup-fallback" });
    } catch (error) {
      const message = error?.message || String(error);
      tabErrors.push(`popup-fallback: ${message}`);
      pushDegreeAuditDebug(`Popup fallback fetch failed: ${message}`);
    }

    throw new Error(`Could not fetch audit data from the signed-in UCSD tab (${tabErrors.join(" | ")}).`);
  }

  pushDegreeAuditDebug(
    "No UCSD tab found. Falling back to popup fetch; auth cookies may be blocked by SameSite."
  );
  const extensionResult = await fetchAuditTextViaExtension(url, init);
  return validateAuditResponse(extensionResult, { url, method, source: "popup" });
}

async function findAuditCapableTab() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeMatch = activeTabs.find(tab => isUcsdTab(tab));
  if (activeMatch) {
    return activeMatch;
  }

  const matchingTabs = await chrome.tabs.query({ url: ["https://act.ucsd.edu/*"] });
  return matchingTabs.find(tab => isUcsdTab(tab)) || null;
}

function isUcsdTab(tab) {
  return Boolean(tab?.id) && /^https:\/\/act\.ucsd\.edu\//i.test(tab.url || "");
}

async function fetchAuditTextViaBridge(tabId, url, init = {}) {
  const payload = {
    type: "degreeAuditFetch",
    url,
    method: init.method || "GET",
    headers: init.headers || {},
    body: init.body || null,
  };

  try {
    const result = await sendMessageToTab(tabId, payload);

    if (!result) {
      throw new Error("Content bridge returned no result.");
    }

    return result;
  } catch (error) {
    const errorMessage = String(error?.message || error);
    if (/Receiving end does not exist|Could not establish connection/i.test(errorMessage)) {
      if (!hasScriptingApi()) {
        throw new Error(
          "Content bridge not loaded in the UCSD tab. Reload that act.ucsd.edu tab once, then retry."
        );
      }

      pushDegreeAuditDebug("Content bridge missing in tab. Injecting bridge script and retrying.");
      await injectAuditBridge(tabId);
      const retryResult = await sendMessageToTab(tabId, payload);
      if (!retryResult) {
        throw new Error("Content bridge returned no result after reinjection.");
      }
      return retryResult;
    }

    throw new Error(`Could not run audit fetch inside the UCSD tab: ${errorMessage}`);
  }
}

async function fetchAuditTextViaMainWorld(tabId, url, init = {}) {
  let injectionResults;
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [
        {
          url,
          method: init.method || "GET",
          headers: init.headers || {},
          body: init.body || null,
        },
      ],
      func: async request => {
        try {
          const response = await fetch(request.url, {
            method: request.method || "GET",
            headers: request.headers || {},
            body: request.body || null,
            credentials: "include",
            redirect: "follow",
          });
          const text = await response.text();
          const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);

          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            redirected: response.redirected,
            text,
            title: titleMatch ? titleMatch[1] : "",
            source: "main-world",
          };
        } catch (error) {
          return {
            ok: false,
            networkError: String(error),
            url: request.url,
            source: "main-world",
          };
        }
      },
    });
  } catch (error) {
    throw new Error(`Could not execute main-world audit fetch: ${error?.message || error}`);
  }

  const result = injectionResults?.[0]?.result;
  if (!result) {
    throw new Error("Main-world fetch returned no result.");
  }

  return result;
}

async function injectAuditBridge(tabId) {
  if (!hasScriptingApi()) {
    throw new Error("chrome.scripting is unavailable, so the content bridge cannot be injected.");
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["ucsd-content.js"],
    });
  } catch (error) {
    throw new Error(`Could not inject content bridge: ${error?.message || error}`);
  }
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

function hasScriptingApi() {
  return Boolean(chrome?.scripting?.executeScript);
}

function hasChromeStorageLocal() {
  return Boolean(chrome?.storage?.local);
}

async function readCachedAudit() {
  const canUseChromeStorage = hasChromeStorageLocal();

  if (canUseChromeStorage) {
    try {
      const stored = await chrome.storage.local.get(DEGREE_AUDIT_CACHE_KEY);
      const audit = extractCachedAuditPayload(stored[DEGREE_AUDIT_CACHE_KEY]);
      if (!audit) return null;
      return { audit, source: "chrome.storage.local" };
    } catch {
      pushDegreeAuditDebug("Cache read from chrome.storage.local failed. Trying localStorage fallback.");
    }
  } else {
    warnCacheUnavailable();
  }

  try {
    const raw = window.localStorage.getItem(DEGREE_AUDIT_LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    const audit = extractCachedAuditPayload(payload);
    if (!audit) return null;
    return { audit, source: "localStorage" };
  } catch {
    pushDegreeAuditDebug("Cache read from localStorage failed; continuing without cached audit.");
    return null;
  }
}

async function writeCachedAudit(audit) {
  const payload = buildCachedAuditPayload(audit);
  const canUseChromeStorage = hasChromeStorageLocal();

  if (canUseChromeStorage) {
    try {
      await chrome.storage.local.set({ [DEGREE_AUDIT_CACHE_KEY]: payload });
      return;
    } catch {
      pushDegreeAuditDebug("Cache write to chrome.storage.local failed. Trying localStorage fallback.");
    }
  } else {
    warnCacheUnavailable();
  }

  try {
    window.localStorage.setItem(DEGREE_AUDIT_LOCAL_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    pushDegreeAuditDebug("Cache write to localStorage failed; continuing without persistence.");
  }
}

async function clearCachedAudit() {
  if (hasChromeStorageLocal()) {
    try {
      await chrome.storage.local.remove(DEGREE_AUDIT_CACHE_KEY);
    } catch {
      pushDegreeAuditDebug("Cache clear from chrome.storage.local failed; continuing.");
    }
  } else {
    warnCacheUnavailable();
  }

  try {
    window.localStorage.removeItem(DEGREE_AUDIT_LOCAL_STORAGE_KEY);
  } catch {
    pushDegreeAuditDebug("Cache clear from localStorage failed; continuing.");
  }
}

function buildCachedAuditPayload(audit) {
  return {
    version: DEGREE_AUDIT_CACHE_VERSION,
    cachedAt: new Date().toISOString(),
    audit: {
      id: audit.id || "",
      readUrl: audit.readUrl || "",
      program: audit.program || "",
      catalogYear: audit.catalogYear || "",
      createdAt: audit.createdAt || "",
      format: audit.format || "",
      fetchedAt: audit.fetchedAt || "",
      rawHtml: typeof audit.rawHtml === "string" ? audit.rawHtml : "",
      parsedAudit: audit.parsedAudit && typeof audit.parsedAudit === "object" ? audit.parsedAudit : null,
    },
  };
}

function extractCachedAuditPayload(payload) {
  if (!payload) return null;

  let candidate = null;
  if (payload.version === DEGREE_AUDIT_CACHE_VERSION && payload.audit) {
    candidate = payload.audit;
  } else if (payload.readUrl || payload.id) {
    candidate = payload;
  }
  if (!candidate) return null;

  const audit = {
    id: String(candidate.id || ""),
    readUrl: String(candidate.readUrl || ""),
    program: cleanText(candidate.program),
    catalogYear: cleanText(candidate.catalogYear),
    createdAt: cleanText(candidate.createdAt),
    format: cleanText(candidate.format),
    fetchedAt: cleanText(candidate.fetchedAt),
    rawHtml: typeof candidate.rawHtml === "string" ? candidate.rawHtml : "",
    parsedAudit: candidate.parsedAudit && typeof candidate.parsedAudit === "object"
      ? candidate.parsedAudit
      : null,
  };

  if (!audit.id || !audit.readUrl) {
    return null;
  }

  return audit;
}

function beginAuditAction(action) {
  degreeAuditState.isWorking = true;
  degreeAuditState.activeAction = action;
  updateAuditButtons();
}

function endAuditAction() {
  degreeAuditState.isWorking = false;
  degreeAuditState.activeAction = null;
  updateAuditButtons();
}

function updateAuditButtons() {
  const isWorking = degreeAuditState.isWorking;
  degreeAuditEls.fetchBtn.disabled = isWorking;
  degreeAuditEls.requestBtn.disabled = isWorking;

  degreeAuditEls.fetchBtn.textContent =
    isWorking && degreeAuditState.activeAction === "fetch"
      ? "Fetching..."
      : "Fetch Most Recent Audit";
  degreeAuditEls.requestBtn.textContent =
    isWorking && degreeAuditState.activeAction === "request"
      ? "Working..."
      : "Request New Audit";
}

function exposeDegreeAuditApi() {
  globalThis.getDegreeAuditJson = getDegreeAuditJson;
  globalThis.sendToRemote = sendToRemote;
}

function getDegreeAuditJson() {
  return degreeAuditState.latestAudit?.parsedAudit || null;
}

async function sendToRemote(apiUrl, options = {}) {
  if (!degreeAuditState.latestAudit) {
    const cached = await readCachedAudit();
    if (cached?.audit) {
      degreeAuditState.latestAudit = cached.audit;
    }
  }

  const audit = degreeAuditState.latestAudit;
  if (!audit) {
    throw new Error("No degree audit is loaded. Fetch an audit first.");
  }

  if (!audit.parsedAudit && audit.rawHtml) {
    audit.parsedAudit = parseDegreeAuditHtml(audit.rawHtml, audit);
  }
  if (!audit.parsedAudit) {
    throw new Error("No parsed degree audit is available to send.");
  }

  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error("sendToRemote(apiUrl) requires a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("sendToRemote(apiUrl) only supports HTTPS URLs.");
  }

  const method = String(options.method || "POST").toUpperCase();
  const payload = {
    sentAt: new Date().toISOString(),
    descriptor: {
      id: audit.id,
      readUrl: audit.readUrl,
      program: audit.program,
      catalogYear: audit.catalogYear,
      createdAt: audit.createdAt,
      format: audit.format,
      fetchedAt: audit.fetchedAt,
    },
    parsedAudit: audit.parsedAudit,
    rawAuditHtml: audit.rawHtml || "",
  };

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const requestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    requestInit.body = JSON.stringify(payload);
  }

  pushDegreeAuditDebug(`sendToRemote -> ${url.toString()} (${method})`);

  let response;
  try {
    response = await fetch(url.toString(), requestInit);
  } catch (error) {
    const message = error?.message || String(error);
    pushDegreeAuditDebug(`sendToRemote network failure: ${message}`);
    throw new Error(`sendToRemote failed: ${message}`);
  }

  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    // Response body is not JSON.
  }

  const result = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    responseText,
    responseJson,
  };

  if (!response.ok) {
    pushDegreeAuditDebug(`sendToRemote failed: status=${response.status}`);
    throw new Error(`sendToRemote failed with status ${response.status}.`);
  }

  pushDegreeAuditDebug(`sendToRemote succeeded: status=${response.status}`);
  return result;
}

function splitHtmlLines(node) {
  if (!node) return [];

  const html = String(node.innerHTML || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|td|th|h1|h2|h3|h4|h5|h6)>/gi, "\n");
  const container = document.createElement("div");
  container.innerHTML = html;

  return String(container.textContent || "")
    .split("\n")
    .map(line => cleanText(line))
    .filter(Boolean);
}

function normalizeHeaderKey(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseNumber(value) {
  if (value == null) return null;
  const normalized = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!normalized) return null;
  const num = Number(normalized[0]);
  return Number.isFinite(num) ? num : null;
}

function roundToTwo(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function warnCacheUnavailable() {
  if (degreeAuditState.cacheWarningShown) return;
  degreeAuditState.cacheWarningShown = true;
  pushDegreeAuditDebug("chrome.storage.local is unavailable in this runtime; using localStorage fallback.");
}

async function fetchAuditTextViaExtension(url, init = {}) {
  try {
    const response = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      ...init,
    });

    const text = await response.text();
    const title = new DOMParser()
      .parseFromString(text, "text/html")
      .querySelector("title")?.textContent || "";

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      redirected: response.redirected,
      text,
      title,
    };
  } catch (error) {
    throw new Error(`Popup fetch failed: ${error.message || error}`);
  }
}

function validateAuditResponse(result, context) {
  if (result.networkError) {
    pushDegreeAuditDebug(`${context.source} fetch network error: ${result.networkError}`);
    throw new Error(result.networkError);
  }

  pushDegreeAuditDebug(
    `${context.source} fetch response: status=${result.status || "?"} redirected=${Boolean(result.redirected)} finalUrl=${result.url || "(none)"}`
  );

  if (result.title) {
    pushDegreeAuditDebug(`${context.source} response title: ${result.title}`);
  }

  if (!result.ok) {
    throw new Error(`Degree audit request failed (${result.status || "unknown"}).`);
  }

  if (result.redirected && !String(result.url || "").includes("/studentDarsSelfservice/")) {
    throw new Error("Please sign in to UCSD in an act.ucsd.edu tab first.");
  }

  if (
    /login|single sign on|sign in/i.test(result.title || "") &&
    !String(result.url || "").includes("/studentDarsSelfservice/")
  ) {
    throw new Error("Please sign in to UCSD in an act.ucsd.edu tab first.");
  }

  return result.text;
}

function pushDegreeAuditDebug(message) {
  const timestamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  degreeAuditState.debugLines.push(`[${timestamp}] ${message}`);
  if (degreeAuditState.debugLines.length > DEGREE_AUDIT_DEBUG_LIMIT) {
    degreeAuditState.debugLines.splice(0, degreeAuditState.debugLines.length - DEGREE_AUDIT_DEBUG_LIMIT);
  }
  degreeAuditEls.debugLog.textContent = degreeAuditState.debugLines.join("\n");
}

function renderDegreeAudit(audit, statusText, isError = false) {
  degreeAuditEls.empty.style.display = "none";
  degreeAuditEls.content.style.display = "flex";
  degreeAuditEls.program.textContent = audit.program || "Latest Audit";

  const metaBits = [audit.createdAt, audit.catalogYear, audit.format].filter(Boolean);
  degreeAuditEls.created.textContent = metaBits.join(" | ");
  degreeAuditEls.openLink.href = audit.readUrl;
  if (!audit.parsedAudit && audit.rawHtml) {
    try {
      audit.parsedAudit = parseDegreeAuditHtml(audit.rawHtml, audit);
    } catch (error) {
      pushDegreeAuditDebug(`Audit parse error: ${error?.message || error}`);
    }
  }
  renderDegreeAuditPreview(audit.parsedAudit);
  setDegreeAuditStatus(statusText, isError);
  if (audit.parsedAudit) populateCoursesFromAudit(audit.parsedAudit);
}

function renderNoAudit(message, isError = false) {
  degreeAuditEls.content.style.display = "none";
  degreeAuditEls.empty.style.display = "block";
  degreeAuditEls.preview.innerHTML = "";
  degreeAuditEls.openLink.href = "#";
  setDegreeAuditStatus(message, isError);
}

function setDegreeAuditStatus(message, isError = false) {
  degreeAuditEls.status.textContent = message;
  degreeAuditEls.status.style.color = isError ? "#b42318" : "#667085";
}

function getAuditId(readUrl) {
  return new URL(readUrl).searchParams.get("id") || readUrl;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Audit-driven course extraction ─────────────────────────────

/**
 * Walk the parsed degree audit and collect course codes that are still
 * needed — i.e., the `selectCourses.items` from every unfulfilled or
 * in-progress subrequirement.
 */
function extractRequiredCourses(parsedAudit) {
  const codes = new Set();
  for (const req of parsedAudit?.requirements ?? []) {
    if (req.status === "complete") continue;
    for (const sub of req.subrequirements ?? []) {
      if (sub.status === "complete") continue;
      for (const code of sub.selectCourses ?? []) {
        const normalized = code.trim().toUpperCase();
        if (normalized) codes.add(normalized);
      }
    }
  }
  return [...codes];
}

/**
 * Given a parsed audit, find which required courses are offered this
 * term (via /api/sections), populate the `courses` array, and
 * re-render the course list.
 */
async function populateCoursesFromAudit(parsedAudit) {
  const statusEl = document.getElementById("audit-courses-status");

  const needed = extractRequiredCourses(parsedAudit);
  if (!needed.length) {
    statusEl.textContent = "No unfulfilled course requirements found in your audit.";
    return;
  }

  statusEl.textContent = `Checking ${needed.length} required courses against this term's schedule…`;

  let available = [];
  try {
    // Batch-lookup: API accepts up to 10 at a time
    const chunks = [];
    for (let i = 0; i < needed.length; i += 10) chunks.push(needed.slice(i, i + 10));

    for (const chunk of chunks) {
      const res = await fetch(`${API_BASE}/api/sections`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ courses: chunk }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const [code, courseData] of Object.entries(data.results ?? {})) {
        const instructors = [
          ...new Set(
            (courseData.sections ?? [])
              .filter(s => s.type === "LE")
              .map(s => s.instructor)
              .filter(n => n && n !== "Staff")
          ),
        ];
        available.push({
          code,
          name:        courseData.course_title || code,
          units:       (courseData.sections?.length ?? 0) + " sec",
          instructors: instructors.map(n => ({ name: n, rmp: null })),
        });
      }
    }
  } catch {
    statusEl.textContent = "Could not reach the schedule API. Is the server running?";
    return;
  }

  // Clear and repopulate
  courses.length = 0;
  for (const c of available) {
    if (!courses.some(x => x.code === c.code)) courses.push(c);
  }

  const notFound = needed.length - available.length;
  const parts = [`${available.length} required course${available.length !== 1 ? "s" : ""} loaded`];
  if (notFound > 0) parts.push(`${notFound} not offered this term`);
  statusEl.textContent = parts.join(" · ");

  renderCourseList();
  syncPassLists();
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

/**
 * Read weights from the priorities UI.
 * Uses data-id on each <li> ("professor","time","finals","days","difficulty")
 * so it's label-text-independent.
 * Returns { professor: N, time: N, ... } where values are 0–100 integers
 * computed by computeWeights() with the current weightMode curve.
 */
function getCurrentWeights() {
  const items = [...document.querySelectorAll("#priority-list li")];
  const vals  = computeWeights(items.length, weightMode);
  const w = {};
  items.forEach((item, i) => {
    const key = item.dataset.id;   // "professor" | "time" | "finals" | "days" | "difficulty"
    if (key) w[key] = vals[i];
  });
  return w;
}

/**
 * Parse "9:00 AM" / "3:00 PM" select values → minutes since midnight.
 * Returns null for unrecognised values.
 */
function parseTimeOption(str) {
  if (!str) return null;
  const m = str.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const pm  = m[3].toUpperCase() === "PM";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h * 60 + min;
}

/**
 * Derive a dayPattern string from the individual day-btn toggles.
 *   All active          → "any"
 *   Only M/W/F active   → "MWF"
 *   Only Tu/Th active   → "TuTh"
 *   Fewer days than 5   → "minimize"
 */
function getDayPattern() {
  const active = new Set(
    [...document.querySelectorAll(".day-btn.active")].map(b => b.dataset.day)
  );
  if (active.size === 5) return "any";
  const mwf  = active.has("Mon") && active.has("Wed") && active.has("Fri") &&
               !active.has("Tue") && !active.has("Thu");
  const tuth = active.has("Tue") && active.has("Thu") &&
               !active.has("Mon") && !active.has("Wed") && !active.has("Fri");
  if (mwf)  return "MWF";
  if (tuth) return "TuTh";
  return "minimize";
}

/**
 * Read all preferences from the preferences UI.
 * Handles time selects, day pattern, and hard-constraint checkboxes.
 */
function getCurrentPrefs() {
  const prefs = {};

  const ps = parseTimeOption(document.getElementById("pref-start")?.value);
  const pe = parseTimeOption(document.getElementById("pref-end")?.value);
  if (ps != null) prefs.prefStart = ps;
  if (pe != null) prefs.prefEnd   = pe;

  prefs.dayPattern = getDayPattern();

  // Hard constraint checkboxes
  const hardLimits = {};
  if (document.getElementById("c-no-8am")?.checked) {
    hardLimits.neverBefore = 8 * 60;   // any meeting starting at/before 8:00 → score 0
  }
  if (Object.keys(hardLimits).length) prefs.hardLimits = hardLimits;

  return prefs;
}

/** Expand "MWF" → ["M","W","F"], handling two-char Tu/Th */
function expandDaysJS(str) {
  const out = []; let i = 0;
  while (i < str.length) {
    const two = str.slice(i, i+2);
    if (two==="Tu"||two==="Th"||two==="Sa"||two==="Su") { out.push(two); i+=2; }
    else { out.push(str[i]); i+=1; }
  }
  return out;
}

const DAY_TO_COL = { M:1, Tu:2, W:3, Th:4, F:5 };

/** Convert real API section → calendar/detail display shape */
function adaptSection(sec, fallbackIdx) {
  const ci = courses.findIndex(c => c.code === sec.courseCode);
  const colorIdx = (ci >= 0 ? ci : fallbackIdx) % COURSE_COLORS.length;
  const flatDays = (sec.meetings ?? []).flatMap(m =>
    expandDaysJS(m.days ?? "").map(d => DAY_TO_COL[d]).filter(Boolean)
  );
  const first = sec.meetings?.[0] ?? {};
  const room  = first.building ? `${first.building} ${first.room ?? ""}`.trim() : (first.room ?? "TBA");
  const finalStr = sec.final
    ? `${sec.final.date} ${sec.final.start}–${sec.final.end}`
    : "TBA";
  return {
    code: sec.courseCode,
    name: sec.courseCode,
    days: [...new Set(flatDays)],
    start: first.start ?? "00:00",
    end:   first.end   ?? "00:00",
    instructor: sec.instructor ?? "TBA",
    rmp:  sec.rmp_quality,
    cape: { hours: sec.capeHours, recommend: sec.cape_recommend_prof, grade: null },
    room, final: finalStr, colorIdx,
    seats_available: sec.seats_available,
    status: sec.status,
  };
}

async function launchResults() {
  if (courses.length === 0) {
    alert("Fetch your degree audit first — no required courses loaded.");
    return;
  }

  // Switch to results tab and show loading state
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "results"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === "tab-results"));
  document.getElementById("results-empty").style.display = "none";
  document.getElementById("results-content").style.display = "flex";
  document.getElementById("sched-label").textContent = "Generating…";
  document.getElementById("sched-score-badge").textContent = "–";
  document.getElementById("score-breakdown").innerHTML = "";

  try {
    const res = await fetch(`${API_BASE}/api/recommend`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courses:  courses.map(c => c.code),
        topN:     3,
        weights:  getCurrentWeights(),
        prefs:    getCurrentPrefs(),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();

    if (!data.schedules?.length) {
      const missing = data.meta?.missing?.join(", ");
      const msg = missing
        ? `No valid schedules — courses not found: ${missing}`
        : "No valid schedules found (all combinations conflict)";
      document.getElementById("sched-label").textContent = msg;
      document.getElementById("results-content").style.display = "none";
      document.getElementById("results-empty").style.display = "flex";
      return;
    }

    activeSchedules = data.schedules.map(sched => ({
      score:     sched.score,
      breakdown: sched.breakdown,
      summary:   sched.summary ?? "",
      sections:  sched.sections.map((sec, i) => adaptSection(sec, i)),
    }));
    currentScheduleIdx = 0;
    renderSchedule();
  } catch (err) {
    document.getElementById("sched-label").textContent = "Error — " + err.message;
  }
}

function renderSchedule() {
  const s = activeSchedules[currentScheduleIdx];
  const n = activeSchedules.length;

  // Nav
  const labelMain = `Top ${currentScheduleIdx + 1} of ${n}`;
  const labelSub  = s.summary ? ` — ${s.summary}` : "";
  document.getElementById("sched-label").textContent = labelMain + labelSub;
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

  const rmpHtml  = sec.rmp  != null ? ` <span class="rmp-badge">★${sec.rmp.toFixed(1)}</span>` : "";
  const capeGrade = sec.cape?.grade    ? `Avg ${esc(sec.cape.grade)} · ` : "";
  const capeHrs   = sec.cape?.hours    != null ? `${sec.cape.hours}h/wk · ` : "";
  const capeRec   = sec.cape?.recommend != null ? `${sec.cape.recommend}% rec` : "";
  const capeHtml  = (capeGrade || capeHrs || capeRec) ? (capeGrade + capeHrs + capeRec) : "No CAPE data";

  const seatsHtml = sec.seats_available != null
    ? `<div class="detail-row"><span class="detail-lbl">Seats</span><span>${sec.seats_available} open</span></div>`
    : "";

  document.getElementById("detail-body").innerHTML = `
    <div class="detail-row">
      <span class="detail-lbl">Instructor</span>
      <span>${esc(sec.instructor)}${rmpHtml}</span>
    </div>
    <div class="detail-row">
      <span class="detail-lbl">CAPE</span>
      <span>${capeHtml}</span>
    </div>
    <div class="detail-row">
      <span class="detail-lbl">Room</span>
      <span>${esc(sec.room)}</span>
    </div>
    ${seatsHtml}
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
    // Use real seats_available if we have it from the API, else fall back to PASS_META
    const realSeats  = s.seats_available;
    const hasMeta    = realSeats != null;
    const seats      = hasMeta ? realSeats : (PASS_META[s.code]?.seats ?? defaultMeta(s.code, i).seats);
    const difficulty = seats <= 15 ? "Hard" : seats <= 35 ? "Medium" : "Easy";
    const reason     = hasMeta
      ? `${seats} seat${seats !== 1 ? "s" : ""} available`
      : (PASS_META[s.code]?.reason ?? defaultMeta(s.code, i).reason);
    const autoPass   = difficulty === "Hard" || seats < 30 ? "first" : "second";
    return { ...s, seats, difficulty, reason, pass: autoPass };
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
