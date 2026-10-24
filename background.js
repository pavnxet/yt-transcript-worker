/**
 * background.js — MV3 service worker.
 *
 * Single source of truth for talking to the user's self-hosted
 * yt-transcript-worker (Cloudflare Worker). The popup and the content
 * script never call the worker directly; they send a message here.
 *
 * Why the service worker does the fetch:
 *   The worker sets no CORS headers, so a page-context fetch would be
 *   blocked. A service-worker fetch to an origin listed in the extension's
 *   host permissions is not subject to CORS, and the response's custom
 *   headers (X-Active-Key-Index / X-Active-Key-Credits) stay readable.
 *
 * This file also owns: export formats (txt/srt/md), the batch engine,
 * local history, the keyboard command and the action badge.
 */

importScripts("zip.js"); // provides globalThis.makeZip

// Kept byte-for-byte in sync with NOTE_PROMPT in the worker repo so the
// "Copy with AI prompt" output matches the web UI.
const NOTE_PROMPT = `Convert the provided transcript into one continuous topper-style handwritten notebook infographic.
Output: Return ONLY complete HTML + CSS (no markdown, explanations, or extra text).
Content Rules: Extract 100% of content exactly as written. No omissions, summaries, rewording, or added theory.
Preserve all questions, answers, examples, formulas, tables, and diagrams. Visual Learning Style: 🔴 Red bold = Headings, Definitions, Laws, Theorems 🔵 Blue = Explanations, Notes, Examples 🟡 Yellow Highlight = Formulas, Keywords, Values, Answers Use underlines, arrows, callout boxes, sticky notes, margin notes, connectors, icons, and visual hierarchy.
Memory Retention Enhancements: Generate memory tricks, mnemonics, visual associations, and quick-recall cues ONLY from existing content.
Create inline mind maps, flowcharts, comparison charts, timelines, process diagrams, concept trees, and visual summaries wherever applicable.
Convert complex information into easy-to-remember visual structures without changing the original content.
Exam-Focused Labels: Exam Tip • Most Important • Memory Trick • Shortcut • Common Mistake • Frequently Asked • Revision Point • Last-Minute Recall Design Requirements: Single infinite canvas (no pages, no chapter breaks).
Ultra-realistic handwritten notes with natural handwriting variations, pen-pressure effects, doodles, highlights, and scanned notebook aesthetics.
Embed relevant SVG diagrams, visual icons, arrows, and educational illustrations directly beside related concepts for maximum recall.
Optimize for 1-minute revision, long-term memory retention, and exam preparation.`;

const DEFAULT_SETTINGS = {
  workerUrl: "",
  autoRunOnWatch: false,
  defaultFormat: "txt",
  showFab: true,       // show the floating button on YouTube video pages
  autoDownload: false, // download the file automatically after a fetch
};

const HISTORY_KEY = "history";
const HISTORY_MAX_ENTRIES = 25;
const HISTORY_MAX_CHARS = 4_000_000;
const HISTORY_ENTRY_MAX_CHARS = 200_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- settings -------------------------------------------------------------

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// --- url helpers ----------------------------------------------------------

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

/**
 * Pull the 11-char video id out of any YouTube URL shape the worker accepts
 * (watch, youtu.be, shorts, live, embed, v, vi), or accept a bare id.
 * Mirrors YOUTUBE_URL_REGEX in worker.js.
 */
function extractVideoId(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const m = raw.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?.*?v=|shorts\/|live\/|embed\/|v\/|vi\/)|youtube\.com\/(?:user\/\w+\/)?(?:c\/\w+\/)?)([a-zA-Z0-9_-]{11})/
  );
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
  return null;
}

/** Does this look like a playlist / channel rather than one video? */
function looksLikeCollection(url) {
  const s = String(url || "");
  return (
    /[?&]list=/.test(s) ||
    /\/playlist\b/.test(s) ||
    /\/channel\//.test(s) ||
    /\/@[\w.\-]+/.test(s) ||
    /\/c\//.test(s) ||
    /\/user\//.test(s)
  );
}

function extractVideoIdsFromHtml(html) {
  const ids = [];
  const seen = new Set();
  let m;
  const re = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  while ((m = re.exec(html))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  if (!ids.length) {
    const re2 = /\/watch\?v=([a-zA-Z0-9_-]{11})/g;
    while ((m = re2.exec(html))) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        ids.push(m[1]);
      }
    }
  }
  return ids.slice(0, 100);
}

/**
 * Expand a playlist / channel URL by fetching its page and scraping video ids.
 * Needs host permission for youtube.com — the popup requests it on the click.
 */
async function expandCollection(url) {
  let target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  try {
    const res = await fetch(target, { method: "GET" });
    if (!res.ok) return [];
    return extractVideoIdsFromHtml(await res.text());
  } catch {
    return [];
  }
}

async function resolveInputs(rawItems, expand, onStatus) {
  const ids = [];
  for (const raw of rawItems) {
    const item = String(raw || "").trim();
    if (!item) continue;
    if (expand && looksLikeCollection(item)) {
      if (onStatus) onStatus(`Reading playlist/channel: ${item.slice(0, 60)}…`);
      ids.push(...(await expandCollection(item)));
    } else {
      const id = extractVideoId(item);
      if (id) ids.push(id);
    }
  }
  return ids;
}

// --- permission check -----------------------------------------------------

async function hasHostPermission(base) {
  let origin;
  try {
    origin = new URL(base).origin + "/*";
  } catch {
    return false;
  }
  return chrome.permissions.contains({ origins: [origin] });
}

// --- core fetch -----------------------------------------------------------

/**
 * Validate input, check permission, POST multipart/form-data to /process,
 * and return the transcript + key metadata. Always resolves to a plain
 * object so callers can `sendResponse` directly.
 */
async function fetchTranscript(rawInput) {
  const settings = await getSettings();
  const base = normalizeBase(settings.workerUrl);

  if (!base) {
    return {
      ok: false,
      code: "NO_URL",
      error:
        "No Worker URL set yet. Open the extension's Options and paste your Cloudflare Worker URL (e.g. https://your-worker.workers.dev).",
    };
  }

  let parsed;
  try {
    parsed = new URL(base);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad protocol");
  } catch {
    return {
      ok: false,
      code: "BAD_WORKER_URL",
      error: `The saved Worker URL "${base}" is not a valid http(s) URL.`,
    };
  }

  const videoId = extractVideoId(rawInput);
  if (!videoId) {
    return {
      ok: false,
      code: "BAD_URL",
      error:
        "That doesn't look like a YouTube video, Shorts, live or embed link.",
    };
  }

  if (!(await hasHostPermission(base))) {
    return {
      ok: false,
      code: "NO_PERM",
      error: `Permission to reach ${parsed.origin} hasn't been granted. Open Options and click "Save & grant access".`,
    };
  }

  // The worker sanitises to a standard watch URL; do it here too so odd
  // /shorts/ or /live/ links never reach the upstream transcript API.
  const formData = new FormData();
  formData.append("youtube_url", `https://www.youtube.com/watch?v=${videoId}`);

  let res;
  try {
    res = await fetch(`${base}/process`, { method: "POST", body: formData });
  } catch (e) {
    return {
      ok: false,
      code: "NETWORK",
      error: `Couldn't reach the worker at ${parsed.origin} (${e.message}). Check the URL and that it is deployed.`,
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      code: "HTTP",
      error: `Worker returned HTTP ${res.status}. ${body.slice(0, 300)}`.trim(),
    };
  }

  const transcript = await res.text();
  if (!transcript.trim()) {
    return {
      ok: false,
      code: "EMPTY",
      error:
        "The worker returned an empty transcript. The video may have no captions.",
    };
  }

  return {
    ok: true,
    transcript,
    aiPrompt: NOTE_PROMPT,
    meta: {
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      worker: parsed.origin,
      keySlot: res.headers.get("X-Active-Key-Index") || "N/A",
      credits: res.headers.get("X-Active-Key-Credits") || "N/A",
    },
  };
}

// --- export formats -------------------------------------------------------

/** Parse "[HH:MM:SS] text" (or "[MM:SS] text") lines into cue objects. */
function parseCues(transcript) {
  const cues = [];
  for (const line of String(transcript).split(/\r?\n/)) {
    const m = line.match(/^\s*\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]\s*(.*)$/);
    if (!m) continue;
    const start =
      m[3] !== undefined
        ? +m[1] * 3600 + +m[2] * 60 + +m[3]
        : +m[1] * 60 + +m[2];
    cues.push({ start, text: m[4].trim() });
  }
  return cues;
}

function fmtClock(sec) {
  const t = Math.floor(sec);
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function fmtSrtTime(sec) {
  const whole = Math.floor(sec);
  const ms = Math.round((sec - whole) * 1000);
  return `${fmtClock(whole)},${String(ms).padStart(3, "0")}`;
}

function toSRT(cues) {
  const out = [];
  cues.forEach((c, i) => {
    const end =
      i + 1 < cues.length ? Math.max(cues[i + 1].start, c.start + 0.5) : c.start + 3;
    out.push(String(i + 1));
    out.push(`${fmtSrtTime(c.start)} --> ${fmtSrtTime(end)}`);
    out.push(c.text);
    out.push("");
  });
  return out.join("\n");
}

function toMarkdown(cues, meta) {
  const head =
    `# YouTube transcript\n\n` +
    `- Video: https://www.youtube.com/watch?v=${(meta && meta.videoId) || ""}\n` +
    `- Lines: ${cues.length}\n\n---\n\n`;
  return head + cues.map((c) => `**\`${fmtClock(c.start)}\`** ${c.text}`).join("\n\n");
}

/**
 * Format a transcript for export.
 * Returns { text, fellBack } — fellBack is true when an SRT/MD export was
 * requested but the transcript carried no timestamps.
 */
function formatTranscript(transcript, format, meta) {
  if (format === "txt") return { text: transcript, fellBack: false };
  const cues = parseCues(transcript);
  if (!cues.length) return { text: transcript, fellBack: true };
  if (format === "srt") return { text: toSRT(cues), fellBack: false };
  if (format === "md") return { text: toMarkdown(cues, meta), fellBack: false };
  return { text: transcript, fellBack: false };
}

// --- history --------------------------------------------------------------

async function getHistory() {
  const { history } = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(history) ? history : [];
}

async function addHistory(entry) {
  if (!entry || !entry.transcript) return;
  if (entry.transcript.length > HISTORY_ENTRY_MAX_CHARS) return; // too big to keep
  const list = await getHistory();
  const filtered = list.filter((e) => e.videoId !== entry.videoId);
  filtered.unshift({
    id: crypto.randomUUID(),
    videoId: entry.videoId,
    url: entry.url,
    keySlot: entry.keySlot,
    chars: entry.transcript.length,
    transcript: entry.transcript,
    ts: Date.now(),
  });
  const kept = [];
  let chars = 0;
  for (const e of filtered.slice(0, HISTORY_MAX_ENTRIES)) {
    chars += (e.transcript || "").length;
    if (chars > HISTORY_MAX_CHARS) break;
    kept.push(e);
  }
  await chrome.storage.local.set({ [HISTORY_KEY]: kept });
}

async function deleteHistory(id) {
  const list = await getHistory();
  await chrome.storage.local.set({
    [HISTORY_KEY]: list.filter((e) => e.id !== id),
  });
}

async function clearHistory() {
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
}

// --- badge ----------------------------------------------------------------

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text || "" });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* action may be unavailable in some contexts */
  }
}

function flashBadge(text, color, ms) {
  setBadge(text, color);
  setTimeout(() => setBadge(""), ms);
}

// --- batch engine (long-lived port) ---------------------------------------

async function runBatch(msg, port, isCancelled) {
  const settings = await getSettings();
  const base = normalizeBase(settings.workerUrl);

  if (!base) {
    port.postMessage({ type: "fatal", error: "No Worker URL set. Open Options and add it." });
    return;
  }
  if (!(await hasHostPermission(base))) {
    port.postMessage({ type: "fatal", error: "Host access to your worker isn't granted. Open Options and click “Save & grant access”." });
    return;
  }

  const expand = msg.expandCollections !== false;
  const rawItems = Array.isArray(msg.items) ? msg.items : [];

  port.postMessage({ type: "status", text: "Resolving links…" });
  const resolved = await resolveInputs(rawItems, expand, (t) =>
    port.postMessage({ type: "status", text: t })
  );
  if (isCancelled()) return;

  const unique = [...new Set(resolved)];
  if (!unique.length) {
    port.postMessage({
      type: "fatal",
      error:
        "No valid video links found. Paste full YouTube links (one per line), or a playlist/channel URL.",
    });
    return;
  }

  port.postMessage({ type: "plan", total: unique.length, ids: unique });

  let ok = 0;
  let fail = 0;
  const results = [];

  for (let i = 0; i < unique.length; i++) {
    if (isCancelled()) break;
    const videoId = unique[i];
    port.postMessage({ type: "item-start", index: i, videoId });

    const r = await fetchTranscript(videoId);
    if (r.ok) {
      ok++;
      results.push({ videoId, ok: true, transcript: r.transcript, meta: r.meta });
      await addHistory({
        videoId,
        url: r.meta.url,
        keySlot: r.meta.keySlot,
        transcript: r.transcript,
      });
      port.postMessage({
        type: "item-done",
        index: i,
        videoId,
        ok: true,
        chars: r.transcript.length,
        keySlot: r.meta.keySlot,
        transcript: r.transcript,
        meta: r.meta,
      });
    } else {
      fail++;
      results.push({ videoId, ok: false, error: r.error });
      port.postMessage({ type: "item-done", index: i, videoId, ok: false, error: r.error });
    }

    if (i < unique.length - 1) await sleep(400); // be gentle with the transcript API
  }

  if (ok) flashBadge("✓", "#2ecc71", 2500);
  else if (fail) flashBadge("!", "#ff6b6b", 3000);

  port.postMessage({ type: "done", ok, fail, results, cancelled: isCancelled() });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "batch") return;
  let cancelled = false;
  port.onDisconnect.addListener(() => {
    cancelled = true;
  });
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "START_BATCH") {
      cancelled = false;
      runBatch(msg, port, () => cancelled).catch((e) => {
        try {
          port.postMessage({ type: "fatal", error: "Batch failed: " + e.message });
        } catch {
          /* port already gone */
        }
      });
    }
  });
});

// --- keyboard command -----------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "fetch-current") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return;
  try {
    // The content script only exists on YouTube pages, so a failure here
    // simply means "not on YouTube".
    await chrome.tabs.sendMessage(tab.id, { type: "OPEN_TRANSCRIPT_PANEL" });
  } catch {
    flashBadge("!", "#ff6b6b", 3000);
  }
});

// --- message router -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "GET_TRANSCRIPT") {
    fetchTranscript(msg.url)
      .then(async (resp) => {
        if (resp.ok) {
          await addHistory({
            videoId: resp.meta.videoId,
            url: resp.meta.url,
            keySlot: resp.meta.keySlot,
            transcript: resp.transcript,
          });
          flashBadge("✓", "#2ecc71", 2000);
        } else {
          flashBadge("!", "#ff6b6b", 3000);
        }
        sendResponse(resp);
      })
      .catch((e) => sendResponse({ ok: false, code: "INTERNAL", error: e.message }));
    return true; // async
  }

  if (msg.type === "FORMAT_TRANSCRIPT") {
    sendResponse(formatTranscript(msg.transcript || "", msg.format || "txt", msg.meta || {}));
    return true;
  }

  if (msg.type === "GET_SETTINGS") {
    getSettings().then(sendResponse);
    return true;
  }

  if (msg.type === "GET_HISTORY") {
    getHistory().then(sendResponse);
    return true;
  }

  if (msg.type === "DELETE_HISTORY") {
    deleteHistory(msg.id).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "CLEAR_HISTORY") {
    clearHistory().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
});

// First install: drop the user straight into Options so they can paste their
// Worker URL without hunting for it.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});
