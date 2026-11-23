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

  if (message?.type === "start-hls") {
    startHlsJob(message)
      .then((jobId) => sendResponse({ ok: true, jobId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.target === "background" && message.type === "hls-progress") {
    void updateJob(message.jobId, message.patch).then(closeOffscreenIfIdle);
  }

  if (message?.target === "background" && message.type === "hls-ready") {
    void saveHlsResult(message);
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(candidateKey(tabId));
});

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  void finishDownload(delta.id, state);
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

let jobWrites = Promise.resolve();
let creatingOffscreen = null;

async function startHlsJob({ url, name }) {
  const job = {
    id: crypto.randomUUID(),
    url,
    name,
    state: "queued",
    message: "저장을 준비하고 있습니다.",
    createdAt: Date.now()
  };
  await updateJob(job.id, job);
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ target: "offscreen", type: "run-hls", job });
  return job.id;
}

async function saveHlsResult({ jobId, objectUrl, filename }) {
  await updateJob(jobId, { state: "saving", message: "저장 위치를 선택하세요." });
  try {
    const downloadId = await chrome.downloads.download({ url: objectUrl, filename, saveAs: true });
    await updateJob(jobId, { downloadId });
  } catch (error) {
    await releaseJob(jobId, { state: "error", message: error.message || "파일을 저장하지 못했습니다." });
  }
}

async function finishDownload(downloadId, state) {
  const jobs = await getJobs();
  const job = Object.values(jobs).find((item) => item.downloadId === downloadId);
  if (!job) return;
  await releaseJob(job.id, state === "complete"
    ? { state: "done", message: "저장을 마쳤습니다." }
    : { state: "error", message: "저장이 취소되었거나 중단되었습니다." });
}

async function releaseJob(jobId, patch) {
  await chrome.runtime.sendMessage({ target: "offscreen", type: "revoke-url", jobId }).catch(() => {});
  await updateJob(jobId, patch);
  await closeOffscreenIfIdle();
}

async function getJobs() {
  const { hlsJobs = {} } = await chrome.storage.session.get("hlsJobs");
  return hlsJobs;
}

function updateJob(jobId, patch) {
  jobWrites = jobWrites.then(async () => {
    const jobs = await getJobs();
    const now = Date.now();
    for (const [id, item] of Object.entries(jobs)) {
      if (isFinished(item) && now - item.updatedAt > 10 * 60 * 1000) delete jobs[id];
    }
    jobs[jobId] = { ...jobs[jobId], ...patch, updatedAt: now };
    await chrome.storage.session.set({ hlsJobs: jobs });
  });
  return jobWrites;
}

function isFinished(job) {
  return job.state === "done" || job.state === "error";
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: "팝업이 닫혀도 HLS 조각을 받아 하나의 파일로 합칩니다."
  }).finally(() => {
    creatingOffscreen = null;
  });
  await creatingOffscreen;
}

async function closeOffscreenIfIdle() {
  const jobs = await getJobs();
  if (Object.values(jobs).some((job) => !isFinished(job))) return;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) await chrome.offscreen.closeDocument().catch(() => {});
}
