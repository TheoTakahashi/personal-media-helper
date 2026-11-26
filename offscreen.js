const objectUrls = new Map();
const tempFiles = new Map();
const tempDirReady = clearTempDir();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "run-hls") {
    void runHls(message.job);
  } else if (message.type === "revoke-url") {
    const objectUrl = objectUrls.get(message.jobId);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrls.delete(message.jobId);
    void removeTempFile(message.jobId);
  }
  return false;
});

function report(jobId, patch) {
  return chrome.runtime.sendMessage({ target: "background", type: "hls-progress", jobId, patch });
}

async function runHls(job) {
  try {
    const { objectUrl, filename } = await buildHls(job);
    objectUrls.set(job.id, objectUrl);
    await chrome.runtime.sendMessage({ target: "background", type: "hls-ready", jobId: job.id, objectUrl, filename });
  } catch (error) {
    await removeTempFile(job.id);
    await report(job.id, { state: "error", message: error.message || "다운로드에 실패했습니다." });
  }
}

async function buildHls(job) {
  const playlistUrl = new URL(job.url);
  await report(job.id, { state: "running", message: "재생목록을 읽고 있습니다." });
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
    finalUrl = variant.url;
    playlist = await fetchText(finalUrl);
  }

  const parsed = parseMediaPlaylist(playlist, finalUrl);
  if (parsed.segments.length === 0) throw new Error("재생목록에 저장할 미디어 조각이 없습니다.");

  const resources = [...(parsed.init ? [parsed.init] : []), ...parsed.segments];

  const extension = parsed.init ? "mp4" : "ts";
  const writable = await createTempFile(job.id);
  let totalBytes = 0;
  try {
    for (let index = 0; index < resources.length; index += 4) {
      const batch = resources.slice(index, index + 4);
      const downloaded = await Promise.all(batch.map(fetchBytes));
      for (const part of downloaded) {
        await writable.write(part);
        totalBytes += part.size;
      }
      const done = Math.min(index + batch.length, resources.length);
      await report(job.id, {
        state: "running",
        message: "미디어 조각을 받는 중",
        done,
        total: resources.length,
        bytes: totalBytes
      });
    }
    await report(job.id, { state: "running", message: "파일로 합치는 중" });
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }

  const file = await tempFiles.get(job.id).getFile();
  return {
    objectUrl: URL.createObjectURL(file),
    filename: `${sanitizeFilename(baseName(job.name || fileNameFromUrl(job.url) || "media"))}.${extension}`
  };
}

async function getTempDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("hls", { create: true });
}

async function clearTempDir() {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("hls", { recursive: true }).catch(() => {});
}

async function createTempFile(jobId) {
  await tempDirReady;
  const dir = await getTempDir();
  const handle = await dir.getFileHandle(jobId, { create: true });
  tempFiles.set(jobId, handle);
  return handle.createWritable();
}

async function removeTempFile(jobId) {
  if (!tempFiles.has(jobId)) return;
  tempFiles.delete(jobId);
  const dir = await getTempDir();
  await dir.removeEntry(jobId).catch(() => {});
}

async function fetchText(url) {
  const response = await fetchWithHint(url, "재생목록");
  if (!response.ok) throw new Error(`재생목록 응답 오류: HTTP ${response.status}`);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetchWithHint(url, "미디어 조각");
  if (!response.ok) throw new Error(`미디어 조각 응답 오류: HTTP ${response.status}`);
  return response.blob();
}

async function fetchWithHint(url, label) {
  try {
    return await fetch(url, { credentials: "include", cache: "no-store" });
  } catch {
    throw new Error(`${label}을(를) 받지 못했습니다(${new URL(url).hostname}). 다른 도메인이라면 '이 사이트에서 계속 찾기'로 권한을 허용한 뒤 다시 시도하세요.`);
  }
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
