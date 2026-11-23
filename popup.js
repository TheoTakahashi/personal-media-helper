const list = document.querySelector("#media-list");
const emptyState = document.querySelector("#empty-state");
const count = document.querySelector("#media-count");
const status = document.querySelector("#status");
const monitorButton = document.querySelector("#monitor-button");
const permissionState = document.querySelector("#permission-state");

let activeTab;
let entries = [];

void initialize();
monitorButton.addEventListener("click", enableMonitoring);

async function initialize() {
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
    button.textContent = isDash(entry) ? "지원 안 함" : "저장";
    button.disabled = isDash(entry);
    if (!isDash(entry)) button.addEventListener("click", () => downloadEntry(entry, button));
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
      await downloadHls(entry);
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

async function downloadHls(entry) {
  const playlistUrl = new URL(entry.url);
  if (!["http:", "https:"].includes(playlistUrl.protocol)) {
    throw new Error("HTTP 또는 HTTPS HLS만 지원합니다.");
  }

  const granted = await chrome.permissions.request({ origins: [`${playlistUrl.origin}/*`] });
  if (!granted) throw new Error("HLS 재생목록을 읽을 권한이 필요합니다.");

  showStatus("재생목록을 읽고 있습니다.");
  let playlist = await fetchText(playlistUrl.href);
  let finalUrl = playlistUrl.href;

  if (playlist.includes("#EXT-X-SESSION-KEY")) {
    throw new Error("키가 포함된 HLS는 처리하지 않습니다.");
  }

  if (playlist.includes("#EXT-X-STREAM-INF")) {
    const variant = chooseVariant(playlist, playlistUrl.href);
    if (variant.separateAudio) {
      throw new Error("별도 오디오 트랙이 있는 HLS는 아직 지원하지 않습니다.");
    }
    if (new URL(variant.url).origin !== playlistUrl.origin) {
      throw new Error("다른 도메인의 HLS 변형은 별도 권한을 요청해야 합니다.");
    }
    finalUrl = variant.url;
    playlist = await fetchText(finalUrl);
  }

  const parsed = parseMediaPlaylist(playlist, finalUrl);
  if (parsed.segments.length === 0) throw new Error("재생목록에 저장할 미디어 조각이 없습니다.");
  if (parsed.segments.length > 1000) throw new Error("재생목록이 너무 깁니다. 1,000개 이하의 조각만 저장할 수 있습니다.");

  const resources = [...(parsed.init ? [parsed.init] : []), ...parsed.segments];
  if (resources.some((resource) => new URL(resource).origin !== playlistUrl.origin)) {
    throw new Error("미디어 조각이 재생목록과 다른 도메인에 있어 이 버전에서는 저장하지 않습니다.");
  }

  const parts = [];
  let totalBytes = 0;
  for (let index = 0; index < resources.length; index += 4) {
    const batch = resources.slice(index, index + 4);
    const downloaded = await Promise.all(batch.map(fetchBytes));
    totalBytes += downloaded.reduce((sum, part) => sum + part.size, 0);
    if (totalBytes > 512 * 1024 * 1024) {
      throw new Error("저장할 미디어가 512MB를 넘어 이 버전의 메모리 한도를 초과합니다.");
    }
    parts.push(...downloaded);
    showStatus(`미디어 조각 ${Math.min(index + batch.length, resources.length)}/${resources.length} 저장 중`);
  }

  const extension = parsed.init ? "mp4" : "ts";
  const blob = new Blob(parts, { type: parsed.init ? "video/mp4" : "video/mp2t" });
  const objectUrl = URL.createObjectURL(blob);
  const filename = `${sanitizeFilename(baseName(entry.name || fileNameFromUrl(entry.url) || "media"))}.${extension}`;
  try {
    await chrome.downloads.download({ url: objectUrl, filename, saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
  }
}

async function fetchText(url) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`재생목록 응답 오류: HTTP ${response.status}`);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`미디어 조각 응답 오류: HTTP ${response.status}`);
  return response.blob();
}

function chooseVariant(playlist, baseUrl) {
  const lines = playlist.split(/\r?\n/);
  let best = null;
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
    const bandwidth = Number(lines[index].match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/)?.[1] ?? 0);
    const separateAudio = /(?:^|,)AUDIO="[^"]+"/.test(lines[index].slice("#EXT-X-STREAM-INF:".length));
    const uri = lines.slice(index + 1).find((line) => line.trim() && !line.trim().startsWith("#"));
    if (uri && (!best || bandwidth > best.bandwidth)) {
      best = { bandwidth, separateAudio, url: new URL(uri.trim(), baseUrl).href };
    }
  }
  if (!best) throw new Error("HLS 변형 재생목록을 해석하지 못했습니다.");
  return best;
}

function parseMediaPlaylist(playlist, baseUrl) {
  const lines = playlist.split(/\r?\n/);
  const segments = [];
  let init = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXT-X-KEY:")) {
      const method = trimmed.match(/METHOD=([^,]+)/)?.[1]?.replaceAll('"', "");
      if (method && method !== "NONE") throw new Error("암호화되었거나 DRM으로 보호된 HLS는 처리하지 않습니다.");
    }
    if (trimmed.startsWith("#EXT-X-SESSION-KEY:")) {
      throw new Error("키가 포함된 HLS는 처리하지 않습니다.");
    }
    if (trimmed.startsWith("#EXT-X-BYTERANGE:")) {
      throw new Error("바이트 범위로 나뉜 HLS는 아직 지원하지 않습니다.");
    }
    if (trimmed.startsWith("#EXT-X-MAP:")) {
      const uri = trimmed.match(/URI="([^"]+)"/)?.[1];
      if (!uri) throw new Error("HLS 초기화 조각을 해석하지 못했습니다.");
      init = new URL(uri, baseUrl).href;
    } else if (!trimmed.startsWith("#")) {
      segments.push(new URL(trimmed, baseUrl).href);
    }
  }
  return { init, segments };
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

function baseName(name) {
  return name.replace(/\.[a-z0-9]{2,5}$/i, "") || "media";
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
