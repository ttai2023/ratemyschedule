chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "degreeAuditFetch") {
    return undefined;
  }

  (async () => {
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
});
