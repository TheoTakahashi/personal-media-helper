const listenersByOrigin = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "enable-origin") {
    registerOrigin(message.origin)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-candidates") {
    chrome.storage.local.get(candidateKey(message.tabId)).then((stored) => {
      sendResponse({ candidates: stored[candidateKey(message.tabId)] ?? [] });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(candidateKey(tabId));
});

void restoreOrigins();

function candidateKey(tabId) {
  return `media-candidates:${tabId}`;
}

async function restoreOrigins() {
  const { monitoredOrigins = [] } = await chrome.storage.local.get("monitoredOrigins");
  for (const origin of monitoredOrigins) {
    try {
      await registerOrigin(origin);
    } catch {
      // 사용자가 권한을 거둔 사이트는 다시 요청을 받기 전까지 건너뜁니다.
    }
  }
}

async function registerOrigin(origin) {
  const parsedOrigin = new URL(origin).origin;
  if (listenersByOrigin.has(parsedOrigin)) return;

  const granted = await chrome.permissions.contains({
    permissions: ["webRequest"],
    origins: [`${parsedOrigin}/*`]
  });
  if (!granted) throw new Error("이 사이트의 요청 탐지 권한이 없습니다.");

  const listener = (details) => {
    void saveCandidate(details, parsedOrigin);
  };
  chrome.webRequest.onCompleted.addListener(
    listener,
    { urls: [`${parsedOrigin}/*`] },
    ["responseHeaders"]
  );
  listenersByOrigin.set(parsedOrigin, listener);

  const { monitoredOrigins = [] } = await chrome.storage.local.get("monitoredOrigins");
  if (!monitoredOrigins.includes(parsedOrigin)) {
    await chrome.storage.local.set({ monitoredOrigins: [...monitoredOrigins, parsedOrigin] });
  }
}

async function saveCandidate(details, monitoredOrigin) {
  if (details.tabId < 0 || !isMediaRequest(details)) return;

  const key = candidateKey(details.tabId);
  const stored = await chrome.storage.local.get(key);
  const previous = stored[key] ?? [];
  const candidate = {
    url: details.url,
    pageUrl: details.documentUrl ?? details.initiator ?? monitoredOrigin,
    mimeType: getHeader(details.responseHeaders, "content-type"),
    disposition: getHeader(details.responseHeaders, "content-disposition"),
    resourceType: details.type,
    seenAt: Date.now()
  };
  const retained = previous.filter((item) => item.url !== candidate.url && Date.now() - item.seenAt < 30 * 60 * 1000);
  await chrome.storage.local.set({ [key]: [candidate, ...retained].slice(0, 80) });
}

function isMediaRequest(details) {
  const mimeType = getHeader(details.responseHeaders, "content-type").toLowerCase();
  const url = details.url.toLowerCase();
  return details.type === "media"
    || mimeType.startsWith("video/")
    || mimeType.startsWith("audio/")
    || mimeType.includes("mpegurl")
    || mimeType.includes("dash+xml")
    || /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|ogg|opus|m3u8|mpd)(?:[?#]|$)/i.test(url);
}

function getHeader(headers = [], targetName) {
  return headers.find((header) => header.name.toLowerCase() === targetName)?.value ?? "";
}
