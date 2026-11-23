const list = document.querySelector("#media-list");
const emptyState = document.querySelector("#empty-state");
const count = document.querySelector("#media-count");
const status = document.querySelector("#status");
const monitorButton = document.querySelector("#monitor-button");
const permissionState = document.querySelector("#permission-state");

let activeTab;
let entries = [];
let jobs = {};

void initialize();
monitorButton.addEventListener("click", enableMonitoring);
chrome.storage.session.onChanged.addListener((changes) => {
  if (!changes.hlsJobs) return;
  jobs = changes.hlsJobs.newValue ?? {};
  renderEntries();
  showLatestJob();
});

async function initialize() {
  ({ hlsJobs: jobs = {} } = await chrome.storage.session.get("hlsJobs"));
  showLatestJob();

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !activeTab.url?.startsWith("http")) {
    document.querySelector("#page-name").textContent = "이 페이지는 확인할 수 없습니다";
    monitorButton.disabled = true;
    return;
  }

  document.querySelector("#page-name").textContent = new URL(activeTab.url).hostname;
  await refreshMedia();
}

async function refreshMedia() {
  try {
    const [pageResult, storedResult] = await Promise.all([
      chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func: scanCurrentPage }),
      chrome.runtime.sendMessage({ type: "get-candidates", tabId: activeTab.id })
    ]);
    entries = mergeEntries(pageResult[0]?.result ?? [], storedResult?.candidates ?? []);
    renderEntries();
  } catch (error) {
    showStatus(`페이지를 읽지 못했습니다: ${error.message}`, true);
  }
}

async function enableMonitoring() {
  const origin = new URL(activeTab.url).origin;
  const granted = await chrome.permissions.request({
    permissions: ["webRequest"],
    origins: [`${origin}/*`]
  });
  if (!granted) {
    showStatus("권한을 허용하지 않아 페이지의 현재 미디어만 확인합니다.");
    return;
  }

  const result = await chrome.runtime.sendMessage({ type: "enable-origin", origin });
  if (!result?.ok) {
    showStatus(result?.error ?? "사이트 탐지를 시작하지 못했습니다.", true);
    return;
  }

  permissionState.textContent = "이 사이트의 미디어 요청을 기기에서 찾습니다";
  showStatus("탐지를 켰습니다. 영상 재생 후 새로고침하세요.");
}

function mergeEntries(pageEntries, networkEntries) {
  const byUrl = new Map();
  for (const item of [...networkEntries, ...pageEntries]) {
    if (!item.url || byUrl.has(item.url)) continue;
    byUrl.set(item.url, item);
  }
  return [...byUrl.values()].slice(0, 80);
}

function renderEntries() {
  list.replaceChildren();
  count.textContent = String(entries.length);
  emptyState.hidden = entries.length > 0;

  for (const entry of entries) {
    const card = document.createElement("article");
    card.className = "media-card";

    const name = document.createElement("div");
    name.className = "media-name";
    name.textContent = entry.name || fileNameFromUrl(entry.url) || "미디어 파일";

    const meta = document.createElement("div");
    meta.className = "media-meta";
    meta.textContent = entry.type || entry.mimeType || "미디어";

    const url = document.createElement("div");
    url.className = "media-url";
    url.textContent = entry.url;
    url.title = entry.url;

    const actions = document.createElement("div");
    actions.className = "media-actions";
    const button = document.createElement("button");
    button.className = "download-button";
    button.type = "button";
    const busy = isJobRunning(entry.url);
    button.textContent = isDash(entry) ? "지원 안 함" : busy ? "저장 중" : "저장";
    button.disabled = isDash(entry) || busy;
    if (!isDash(entry) && !busy) button.addEventListener("click", () => downloadEntry(entry, button));
    actions.append(button);

    card.append(name, meta, url, actions);
    list.append(card);
  }
}

async function downloadEntry(entry, button) {
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = "준비 중";
  try {
    if (isHls(entry)) {
      await startHls(entry);
      showStatus("저장을 시작했습니다. 팝업을 닫거나 다른 탭으로 옮겨도 계속됩니다.");
      return;
    } else if (isDirectMedia(entry)) {
      const filename = directFilename(entry);
      await chrome.downloads.download({ url: entry.url, filename, saveAs: true });
    } else {
      throw new Error("이 형식은 아직 지원하지 않습니다.");
    }
    showStatus("다운로드를 시작했습니다.");
  } catch (error) {
    showStatus(error.message || "다운로드에 실패했습니다.", true);
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
}

async function startHls(entry) {
  const playlistUrl = new URL(entry.url);
  if (!["http:", "https:"].includes(playlistUrl.protocol)) {
    throw new Error("HTTP 또는 HTTPS HLS만 지원합니다.");
  }

  const granted = await chrome.permissions.request({ origins: [`${playlistUrl.origin}/*`] });
  if (!granted) throw new Error("HLS 재생목록을 읽을 권한이 필요합니다.");

  const result = await chrome.runtime.sendMessage({ type: "start-hls", url: entry.url, name: entry.name });
  if (!result?.ok) throw new Error(result?.error ?? "저장을 시작하지 못했습니다.");
}

function isJobRunning(url) {
  return Object.values(jobs).some((job) => job.url === url && job.state !== "done" && job.state !== "error");
}

function showLatestJob() {
  const latest = Object.values(jobs).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (latest) showStatus(latest.message, latest.state === "error");
}

function isHls(entry) {
  return /\.m3u8(?:[?#]|$)/i.test(entry.url)
    || /mpegurl/i.test(entry.mimeType ?? "");
}

function isDirectMedia(entry) {
  return /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|ogg|opus)(?:[?#]|$)/i.test(entry.url)
    || /^(video|audio)\//i.test(entry.mimeType ?? "");
}

function isDash(entry) {
  return /\.mpd(?:[?#]|$)/i.test(entry.url)
    || /dash\+xml/i.test(entry.mimeType ?? "");
}

function directFilename(entry) {
  const suggested = filenameFromDisposition(entry.disposition)
    || fileNameFromUrl(entry.url)
    || entry.name
    || "media";
  const extension = extensionFromUrl(entry.url) || extensionFromMime(entry.mimeType);
  return sanitizeFilename(/\.[a-z0-9]{2,5}$/i.test(suggested) || !extension
    ? suggested
    : `${suggested}.${extension}`);
}

function filenameFromDisposition(disposition = "") {
  const extended = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const value = extended ?? plain;
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extensionFromUrl(url) {
  try {
    return new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

function extensionFromMime(mimeType = "") {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  return ({
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
    "video/mp2t": "ts",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/webm": "webm"
  })[mime] ?? "";
}

function fileNameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 160) || "media";
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function scanCurrentPage() {
  const mediaElements = [...document.querySelectorAll("video, audio")];
  const entries = [];
  for (const element of mediaElements) {
    const candidates = [element.currentSrc, element.src, ...[...element.querySelectorAll("source")].map((source) => source.src)];
    for (const url of candidates) {
      if (!url || url.startsWith("blob:")) continue;
      entries.push({
        url,
        name: document.title,
        type: element.tagName.toLowerCase(),
        mimeType: element.getAttribute("type") ?? ""
      });
    }
  }

  for (const anchor of document.querySelectorAll("a[href]")) {
    const url = anchor.href;
    if (/\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|ogg|opus|m3u8|mpd)(?:[?#]|$)/i.test(url)) {
      entries.push({ url, name: anchor.textContent.trim() || document.title, type: "링크", mimeType: "" });
    }
  }
  return [...new Map(entries.map((entry) => [entry.url, entry])).values()].slice(0, 80);
}
