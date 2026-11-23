const objectUrls = new Map();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "run-hls") {
    void runHls(message.job);
  } else if (message.type === "revoke-url") {
    const objectUrl = objectUrls.get(message.jobId);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrls.delete(message.jobId);
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
    const done = Math.min(index + batch.length, resources.length);
    await report(job.id, { state: "running", message: `미디어 조각 ${done}/${resources.length} 저장 중` });
  }

  const extension = parsed.init ? "mp4" : "ts";
  const blob = new Blob(parts, { type: parsed.init ? "video/mp4" : "video/mp2t" });
  return {
    objectUrl: URL.createObjectURL(blob),
    filename: `${sanitizeFilename(baseName(job.name || fileNameFromUrl(job.url) || "media"))}.${extension}`
  };
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
