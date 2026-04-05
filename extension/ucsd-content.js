chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "degreeAuditFetch") {
    void (async () => {
      try {
        const response = await fetch(message.url, {
          method: message.method || "GET",
          headers: message.headers || {},
          body: message.body || null,
          credentials: "include",
          redirect: "follow",
        });

        const text = await response.text();
        const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);

        sendResponse({
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          redirected: response.redirected,
          text,
          title: titleMatch ? titleMatch[1] : "",
          source: "content-script",
        });
      } catch (error) {
        sendResponse({
          ok: false,
          networkError: String(error),
          url: message.url,
          source: "content-script",
        });
      }
    })();

    return true;
  }

  if (message?.type === "webregDetectTerm") {
    try {
      sendResponse(detectTermFromPageContext());
    } catch (error) {
      sendResponse({
        termCode: null,
        candidates: [],
        error: String(error?.message || error),
      });
    }
    return true;
  }

  return undefined;
});

function detectTermFromPageContext() {
  const candidates = [];
  const seen = new Set();

  const addCandidate = raw => {
    const code = extractTermCode(raw);
    if (!code || seen.has(code)) return;
    seen.add(code);
    candidates.push(code);
  };

  try {
    const url = new URL(window.location.href);
    ["p1", "termcode", "termCode", "term", "term_code"].forEach(key => {
      addCandidate(url.searchParams.get(key));
    });
    addCandidate(url.href);
  } catch {
    addCandidate(window.location.href);
  }

  const termFields = document.querySelectorAll(
    'input[name], input[id], select[name], select[id], [data-term], [data-termcode], [data-p1]'
  );
  termFields.forEach(field => {
    const key = `${field.getAttribute("name") || ""} ${field.getAttribute("id") || ""}`.toLowerCase();
    if (key && !/term|p1/.test(key)) return;
    addCandidate(field.value ?? field.getAttribute("value"));
    addCandidate(field.textContent);
  });

  addCandidate(document.body?.dataset?.term);
  addCandidate(document.body?.dataset?.termcode);
  addCandidate(document.body?.dataset?.p1);

  collectStorageTermCandidates(window.localStorage, addCandidate);
  collectStorageTermCandidates(window.sessionStorage, addCandidate);

  return {
    termCode: candidates[0] || null,
    candidates,
  };
}

function collectStorageTermCandidates(storage, addCandidate) {
  if (!storage) return;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = String(storage.key(i) || "");
      if (!/term|p1/i.test(key)) continue;
      addCandidate(storage.getItem(key));
    }
  } catch {
    // Ignore storage access errors.
  }
}

function extractTermCode(raw) {
  const text = String(raw || "").toUpperCase();
  if (!text) return null;
  const direct = text.replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z][0-9]{3}$/.test(direct)) return direct;
  const match = text.match(/([A-Z][0-9]{3})/);
  return match ? match[1] : null;
}
