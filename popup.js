/**
 * popup.js — the toolbar UI: Single / Batch / History tabs.
 * All network calls are delegated to the background service worker so CORS
 * and host-permission handling stay in one place.
 */

const $ = (id) => document.getElementById(id);

const els = {
  setup: $("setup"),
  setupBtn: $("setupBtn"),
  openOptions: $("openOptions"),

  // single
  urlInput: $("urlInput"),
  fetchBtn: $("fetchBtn"),
  pasteBtn: $("pasteBtn"),
  status: $("status"),
  result: $("result"),
  output: $("output"),
  metaSlot: $("metaSlot"),
  metaCredits: $("metaCredits"),
  metaLen: $("metaLen"),
  searchInput: $("searchInput"),
  searchPrev: $("searchPrev"),
  searchNext: $("searchNext"),
  searchCount: $("searchCount"),
  formatSelect: $("formatSelect"),
  copyBtn: $("copyBtn"),
  copyPromptBtn: $("copyPromptBtn"),
  downloadBtn: $("downloadBtn"),

  // batch
  batchInput: $("batchInput"),
  expandCollections: $("expandCollections"),
  batchBtn: $("batchBtn"),
  batchStop: $("batchStop"),
  batchStatus: $("batchStatus"),
  batchBar: $("batchBar"),
  batchResults: $("batchResults"),
  batchActions: $("batchActions"),
  batchCopyAll: $("batchCopyAll"),
  batchTxt: $("batchTxt"),
  batchZip: $("batchZip"),

  // history
  historyList: $("historyList"),
  clearHistory: $("clearHistory"),

  // quick settings
  qShowFab: $("qShowFab"),
  qAutoDownload: $("qAutoDownload"),
};

const state = {
  raw: "",          // raw transcript as returned by the worker
  view: "",         // formatted transcript currently shown
  meta: null,
  aiPrompt: "",
  format: "txt",
  autoDownload: false,
  showFab: true,
  search: { hits: [], idx: -1 },
  batch: { items: [], results: [], total: 0, done: 0, running: false },
};

let batchPort = null;

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function setStatus(el, text, kind = "") {
  el.textContent = text || "";
  el.className = "status " + kind;
}

async function getActiveTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && tab.url ? tab.url : "";
  } catch {
    return "";
  }
}

function isYouTube(url) {
  return /^https?:\/\/(www\.|m\.)?youtube\.com\/|^https?:\/\/youtu\.be\//.test(url || "");
}

function looksLikeCollection(url) {
  const s = String(url || "");
  return (
    /[?&]list=/.test(s) || /\/playlist\b/.test(s) || /\/channel\//.test(s) ||
    /\/@[\w.\-]+/.test(s) || /\/c\//.test(s) || /\/user\//.test(s)
  );
}

function relTime(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

async function copyText(text, statusEl, okMsg) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(statusEl, okMsg, "ok");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      setStatus(statusEl, okMsg, "ok");
    } catch {
      setStatus(statusEl, "Copy failed — select the text and copy manually.", "err");
    } finally {
      ta.remove();
    }
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Save the currently shown transcript. Returns the extension used, or null if
 * there is nothing to save. Shared by the Download button and auto-download.
 */
function downloadCurrent() {
  if (!state.view) return null;
  const ext = state.format === "srt" ? "srt" : state.format === "md" ? "md" : "txt";
  const id = (state.meta && state.meta.videoId) || "video";
  saveBlob(
    new Blob([state.view], { type: "text/plain;charset=utf-8" }),
    `youtube-${id}.${ext}`
  );
  return ext;
}

// --------------------------------------------------------------------------
// tabs
// --------------------------------------------------------------------------

$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === btn));
  document.querySelectorAll(".panel-view").forEach((v) => {
    v.classList.toggle("hidden", v.dataset.view !== btn.dataset.tab);
  });
  if (btn.dataset.tab === "history") loadHistory();
});

// --------------------------------------------------------------------------
// settings
// --------------------------------------------------------------------------

async function loadSettings() {
  const settings = (await chrome.runtime.sendMessage({ type: "GET_SETTINGS" })) || {};
  const configured = settings.workerUrl && settings.workerUrl.trim();
  els.setup.classList.toggle("hidden", Boolean(configured));
  if (settings.defaultFormat) {
    state.format = settings.defaultFormat;
    els.formatSelect.value = settings.defaultFormat;
  }
  state.autoDownload = Boolean(settings.autoDownload);
  state.showFab = settings.showFab !== false;
  els.qAutoDownload.checked = state.autoDownload;
  els.qShowFab.checked = state.showFab;
  return settings;
}

/** Merge one preference into the synced settings object. */
async function saveSetting(patch) {
  const { settings } = await chrome.storage.sync.get("settings");
  await chrome.storage.sync.set({ settings: { ...(settings || {}), ...patch } });
}

// --------------------------------------------------------------------------
// single
// --------------------------------------------------------------------------

async function prefetchFromTab() {
  const url = await getActiveTabUrl();
  if (isYouTube(url)) {
    els.urlInput.value = url;
    els.urlInput.focus();
    els.urlInput.setSelectionRange(url.length, url.length);
  }
}

function renderView() {
  els.output.value = state.view;
  els.metaLen.textContent = state.view.length.toLocaleString("en-IN") + " chars";
  resetSearch();
}

async function applyFormat() {
  if (!state.raw) return;
  const resp = await chrome.runtime.sendMessage({
    type: "FORMAT_TRANSCRIPT",
    transcript: state.raw,
    format: state.format,
    meta: state.meta || {},
  });
  state.view = (resp && resp.text) || state.raw;
  renderView();
  if (resp && resp.fellBack) {
    setStatus(els.status, "No timestamps found — exported as plain text.", "err");
  }
}

async function runFetch() {
  const url = els.urlInput.value.trim();
  if (!url) {
    setStatus(els.status, "Paste a YouTube link first.", "err");
    return;
  }

  els.fetchBtn.disabled = true;
  els.result.classList.add("hidden");
  setStatus(els.status, "Fetching transcript…", "busy");

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "GET_TRANSCRIPT", url });
  } catch (e) {
    setStatus(els.status, "Extension error: " + e.message, "err");
    els.fetchBtn.disabled = false;
    return;
  }
  els.fetchBtn.disabled = false;

  if (!resp || !resp.ok) {
    setStatus(els.status, (resp && resp.error) || "Something went wrong.", "err");
    if (resp && (resp.code === "NO_URL" || resp.code === "NO_PERM")) {
      els.setup.classList.remove("hidden");
    }
    return;
  }

  state.raw = resp.transcript;
  state.aiPrompt = resp.aiPrompt || "";
  state.meta = resp.meta;
  els.metaSlot.textContent = "Slot: " + resp.meta.keySlot;
  els.metaCredits.textContent = "Credits: " + resp.meta.credits;

  await applyFormat();
  els.result.classList.remove("hidden");

  const lines = resp.transcript.split("\n").length;
  let msg = `Done — ${lines} lines via slot #${resp.meta.keySlot}.`;
  if (state.autoDownload) {
    const ext = downloadCurrent();
    if (ext) msg += ` Saved .${ext} file.`;
  }
  setStatus(els.status, msg, "ok");
}

// --- search ---------------------------------------------------------------

function resetSearch() {
  state.search = { hits: [], idx: -1 };
  els.searchCount.textContent = "0/0";
}

function runSearch() {
  const term = els.searchInput.value;
  const hay = els.output.value;
  const hits = [];
  if (term) {
    const needle = term.toLowerCase();
    const h = hay.toLowerCase();
    let i = h.indexOf(needle);
    while (i !== -1) {
      hits.push(i);
      i = h.indexOf(needle, i + needle.length);
    }
  }
  state.search = { hits, idx: hits.length ? 0 : -1 };
  updateSearchUI();
  if (hits.length) jumpToHit(0);
}

function updateSearchUI() {
  const { hits, idx } = state.search;
  els.searchCount.textContent = hits.length ? `${idx + 1}/${hits.length}` : "0/0";
}

function jumpToHit(i) {
  const { hits } = state.search;
  if (!hits.length) return;
  const n = hits.length;
  const idx = ((i % n) + n) % n;
  state.search.idx = idx;
  const start = hits[idx];
  const end = start + els.searchInput.value.length;
  els.output.focus();
  els.output.setSelectionRange(start, end);
  updateSearchUI();
}

els.searchInput.addEventListener("input", runSearch);
els.searchNext.addEventListener("click", () => jumpToHit(state.search.idx + 1));
els.searchPrev.addEventListener("click", () => jumpToHit(state.search.idx - 1));

// --------------------------------------------------------------------------
// batch
// --------------------------------------------------------------------------

function batchLines() {
  return els.batchInput.value
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function setBatchRunning(running) {
  state.batch.running = running;
  els.batchBtn.disabled = running;
  els.batchStop.disabled = !running;
  els.batchBtn.textContent = running ? "Fetching…" : "Fetch all";
}

function renderBatchResults() {
  const { results, total, done } = state.batch;
  els.batchBar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";

  if (!results.length) {
    els.batchResults.classList.add("hidden");
    return;
  }
  els.batchResults.classList.remove("hidden");
  els.batchResults.innerHTML = "";

  for (const r of results) {
    const row = document.createElement("div");
    row.className = "item" + (r.ok ? "" : " bad");

    const grow = document.createElement("div");
    grow.className = "grow";
    const id = document.createElement("div");
    id.className = "id";
    id.textContent = r.videoId;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = r.ok
      ? `${r.transcript.length.toLocaleString("en-IN")} chars · slot #${r.meta ? r.meta.keySlot : "?"}`
      : (r.error || "failed").slice(0, 70);
    grow.append(id, sub);

    const st = document.createElement("span");
    st.className = "state " + (r.ok ? "ok" : "err");
    st.textContent = r.ok ? "✓" : "✕";

    row.append(grow, st);

    if (r.ok) {
      const dl = document.createElement("button");
      dl.className = "ghost";
      dl.textContent = ".txt";
      dl.title = "Download this transcript";
      dl.addEventListener("click", () =>
        saveBlob(
          new Blob([r.transcript], { type: "text/plain;charset=utf-8" }),
          `youtube-${r.videoId}.txt`
        )
      );
      row.appendChild(dl);
    }
    els.batchResults.appendChild(row);
  }
}

function batchOkResults() {
  return state.batch.results.filter((r) => r.ok);
}

function batchCombinedText() {
  const parts = batchOkResults().map(
    (r) =>
      `=========================================================\n` +
      `VIDEO: ${r.videoId}\nhttps://www.youtube.com/watch?v=${r.videoId}\n` +
      `=========================================================\n\n` +
      r.transcript
  );
  return parts.join("\n\n\n");
}

function onBatchMessage(msg) {
  switch (msg.type) {
    case "status":
      setStatus(els.batchStatus, msg.text, "busy");
      break;
    case "plan":
      state.batch.total = msg.total;
      state.batch.done = 0;
      setStatus(els.batchStatus, `Queued ${msg.total} video(s). Fetching…`, "busy");
      renderBatchResults();
      break;
    case "item-start":
      setStatus(
        els.batchStatus,
        `Fetching ${msg.index + 1}/${state.batch.total} — ${msg.videoId}…`,
        "busy"
      );
      break;
    case "item-done":
      state.batch.done++;
      state.batch.results.push(
        msg.ok
          ? {
              videoId: msg.videoId,
              ok: true,
              transcript: msg.transcript || "",
              meta: msg.meta || { keySlot: msg.keySlot },
            }
          : { videoId: msg.videoId, ok: false, error: msg.error }
      );
      renderBatchResults();
      break;
    case "fatal":
      setStatus(els.batchStatus, msg.error, "err");
      setBatchRunning(false);
      break;
    case "done":
      state.batch.total = state.batch.total || msg.results.length;
      state.batch.done = state.batch.total;
      state.batch.results = msg.results;
      renderBatchResults();
      els.batchActions.classList.toggle("hidden", batchOkResults().length === 0);
      setStatus(
        els.batchStatus,
        msg.cancelled
          ? `Stopped — ${msg.ok} fetched, ${msg.fail} failed.`
          : `Done — ${msg.ok} fetched, ${msg.fail} failed.`,
        msg.fail ? "err" : "ok"
      );
      setBatchRunning(false);
      break;
  }
}

// The port only carries light metadata; transcripts are re-read on demand.
// We stash them as they arrive so "Copy all" / ".zip" don't need another call.
// (Handled via the results payload in the "done" message.)

function ensureBatchPort() {
  if (batchPort) return batchPort;
  batchPort = chrome.runtime.connect({ name: "batch" });
  batchPort.onMessage.addListener(onBatchMessage);
  batchPort.onDisconnect.addListener(() => {
    batchPort = null;
  });
  return batchPort;
}

async function startBatch() {
  const items = batchLines();
  if (!items.length) {
    setStatus(els.batchStatus, "Paste at least one link.", "err");
    return;
  }

  // Playlist/channel expansion needs access to youtube.com to read the page.
  const expand = els.expandCollections.checked;
  if (expand && items.some(looksLikeCollection)) {
    const origins = ["https://www.youtube.com/*"];
    let granted = await chrome.permissions.contains({ origins });
    if (!granted) {
      try {
        granted = await chrome.permissions.request({ origins });
      } catch {
        granted = false;
      }
    }
    if (!granted) {
      setStatus(
        els.batchStatus,
        "Access to youtube.com is needed to read playlists. Allow it and retry.",
        "err"
      );
      return;
    }
  }

  state.batch = { items, results: [], total: 0, done: 0, running: true };
  els.batchActions.classList.add("hidden");
  els.batchResults.innerHTML = "";
  els.batchBar.style.width = "0%";
  setBatchRunning(true);
  setStatus(els.batchStatus, "Starting…", "busy");

  ensureBatchPort().postMessage({
    type: "START_BATCH",
    items,
    expandCollections: expand,
  });
}

function stopBatch() {
  if (batchPort) {
    batchPort.disconnect();
    batchPort = null;
  }
  setBatchRunning(false);
  setStatus(els.batchStatus, "Stopped.", "err");
}

// --------------------------------------------------------------------------
// history
// --------------------------------------------------------------------------

async function loadHistory() {
  const list = await chrome.runtime.sendMessage({ type: "GET_HISTORY" });
  els.historyList.innerHTML = "";

  if (!list || !list.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No transcripts saved yet.";
    els.historyList.appendChild(empty);
    return;
  }

  for (const entry of list) {
    const row = document.createElement("div");
    row.className = "item";

    const grow = document.createElement("div");
    grow.className = "grow";
    const id = document.createElement("div");
    id.className = "id";
    id.textContent = entry.videoId;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${relTime(entry.ts)} · ${(entry.chars || 0).toLocaleString("en-IN")} chars`;
    grow.append(id, sub);
    row.appendChild(grow);

    const copy = document.createElement("button");
    copy.className = "ghost";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => copyText(entry.transcript, els.status, "Copied from history."));

    const dl = document.createElement("button");
    dl.className = "ghost";
    dl.textContent = ".txt";
    dl.addEventListener("click", () =>
      saveBlob(
        new Blob([entry.transcript], { type: "text/plain;charset=utf-8" }),
        `youtube-${entry.videoId}.txt`
      )
    );

    const open = document.createElement("button");
    open.className = "ghost";
    open.textContent = "↗";
    open.title = "Open on YouTube";
    open.addEventListener("click", () =>
      chrome.tabs.create({ url: entry.url || `https://www.youtube.com/watch?v=${entry.videoId}` })
    );

    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "DELETE_HISTORY", id: entry.id });
      loadHistory();
    });

    row.append(copy, dl, open, del);
    els.historyList.appendChild(row);
  }
}

// --------------------------------------------------------------------------
// wiring
// --------------------------------------------------------------------------

els.fetchBtn.addEventListener("click", runFetch);
els.urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runFetch();
});

els.pasteBtn.addEventListener("click", async () => {
  const url = await getActiveTabUrl();
  if (isYouTube(url)) {
    els.urlInput.value = url;
    setStatus(els.status, "Loaded the current tab's link.", "ok");
  } else {
    setStatus(els.status, "The current tab isn't a YouTube page.", "err");
  }
});

els.formatSelect.addEventListener("change", () => {
  state.format = els.formatSelect.value;
  applyFormat();
});

els.copyBtn.addEventListener("click", () => copyText(state.view, els.status, "Transcript copied."));
els.copyPromptBtn.addEventListener("click", () => {
  const payload =
    state.aiPrompt +
    "\n\n=========================================\nINPUT TRANSCRIPT CONTENT:\n=========================================\n" +
    state.raw;
  copyText(payload, els.status, "Copied with AI note prompt.");
});
els.downloadBtn.addEventListener("click", () => {
  const ext = downloadCurrent();
  if (ext) setStatus(els.status, `Saved .${ext} file.`, "ok");
});

els.qShowFab.addEventListener("change", async () => {
  state.showFab = els.qShowFab.checked;
  await saveSetting({ showFab: state.showFab });
  setStatus(els.status, state.showFab ? "Floating button shown." : "Floating button hidden.", "ok");
});

els.qAutoDownload.addEventListener("change", async () => {
  state.autoDownload = els.qAutoDownload.checked;
  await saveSetting({ autoDownload: state.autoDownload });
  setStatus(
    els.status,
    state.autoDownload ? "Auto-download on." : "Auto-download off.",
    "ok"
  );
});

els.batchBtn.addEventListener("click", startBatch);
els.batchStop.addEventListener("click", stopBatch);

els.batchCopyAll.addEventListener("click", () =>
  copyText(batchCombinedText(), els.batchStatus, "Copied all transcripts.")
);
els.batchTxt.addEventListener("click", () => {
  const text = batchCombinedText();
  if (!text) return;
  saveBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), "youtube-transcripts.txt");
  setStatus(els.batchStatus, "Saved combined .txt.", "ok");
});
els.batchZip.addEventListener("click", () => {
  const ok = batchOkResults();
  if (!ok.length) return;
  const files = ok.map((r) => ({ name: `youtube-${r.videoId}.txt`, data: r.transcript }));
  const bytes = makeZip(files);
  saveBlob(new Blob([bytes], { type: "application/zip" }), "youtube-transcripts.zip");
  setStatus(els.batchStatus, `Saved .zip with ${files.length} file(s).`, "ok");
});

els.clearHistory.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
  loadHistory();
});

els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.setupBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// --------------------------------------------------------------------------
// init
// --------------------------------------------------------------------------

(async function init() {
  await loadSettings();
  await prefetchFromTab();
})();
