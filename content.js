/**
 * content.js — runs on youtube.com.
 *
 * Adds a floating button on video pages (watch / shorts / live / embed) that
 * fetches the transcript through the background worker and shows it in an
 * in-page panel. Everything lives inside a shadow root so YouTube's CSS can't
 * leak in and our CSS can't leak out.
 *
 * Panel extras: search with next/prev jump, click-a-timestamp-to-seek, and a
 * format picker (txt / srt / md) that reuses the worker's export formatter.
 */

(function () {
  "use strict";

  const HOST_ID = "yttx-host";

  let hostEl = null;
  let shadow = null;
  let settings = {
    autoRunOnWatch: false,
    defaultFormat: "txt",
    showFab: true,
    autoDownload: false,
  };
  let ui = {};

  const state = {
    loadedFor: null,
    raw: "",
    view: "",
    aiPrompt: "",
    meta: null,
    format: "txt",
    search: { hits: [], idx: -1 },
    seekEnabled: true,
    autoRan: null, // video id we already auto-ran for
  };

  // --- which pages get the button -----------------------------------------

  function currentVideoId() {
    const p = location.pathname;
    const search = location.search;
    let m;
    if ((m = search.match(/[?&]v=([a-zA-Z0-9_-]{11})/))) return m[1];
    if ((m = p.match(/\/(?:shorts|live|embed|v)\/([a-zA-Z0-9_-]{11})/))) return m[1];
    return null;
  }

  const isVideoPage = () => Boolean(currentVideoId());

  function fmtClock(sec) {
    const t = Math.floor(sec);
    const h = String(Math.floor(t / 3600)).padStart(2, "0");
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
    const s = String(t % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  // --- styles (inside the shadow root) -------------------------------------

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .fab {
      position: fixed; right: 20px; bottom: 88px; z-index: 2147483000;
      display: flex; align-items: center; gap: 8px;
      background: #d97757; color: #fff; border: none; cursor: pointer;
      font: 600 13px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: 12px 17px; border-radius: 999px;
      box-shadow: 0 6px 20px rgba(120, 70, 45, .28);
      transition: transform .12s ease, background .15s ease;
    }
    .fab:hover { background: #c96442; transform: translateY(-1px); }
    .fab[hidden] { display: none; }

    .panel {
      position: fixed; right: 20px; bottom: 140px; z-index: 2147483000;
      width: 430px; max-width: calc(100vw - 40px);
      max-height: min(76vh, 700px);
      display: flex; flex-direction: column;
      background: #faf9f5; color: #1f1e1d;
      border: 1px solid #e8e5dc; border-radius: 16px;
      box-shadow: 0 20px 50px rgba(60, 50, 40, .22), 0 2px 6px rgba(60, 50, 40, .08);
      font: 13.5px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }
    .panel[hidden] { display: none; }

    .head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px 12px; background: #faf9f5;
      border-bottom: 1px solid #e8e5dc;
    }
    .title {
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      font-weight: 600; font-size: 15.5px; letter-spacing: .1px; color: #1f1e1d;
    }
    .x {
      background: transparent; border: none; color: #83807a; cursor: pointer;
      font-size: 19px; line-height: 1; padding: 3px 7px; border-radius: 8px;
    }
    .x:hover { color: #1f1e1d; background: #f0eee6; }

    .body { padding: 14px 16px 16px; overflow: auto; }

    .meta { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 11px; }
    .chip {
      font-size: 11px; color: #83807a; background: #f0eee6;
      border: 1px solid #e8e5dc; border-radius: 999px; padding: 3px 10px;
    }

    .search { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
    .search input {
      flex: 1; background: #fff; color: #1f1e1d; border: 1px solid #dedbd1;
      border-radius: 9px; padding: 8px 11px; outline: none;
      font: inherit; font-size: 12.5px; transition: border-color .15s ease, box-shadow .15s ease;
    }
    .search input:focus { border-color: #d97757; box-shadow: 0 0 0 3px #faf0ea; }
    .search input::placeholder { color: #a8a49b; }
    .count { font-size: 11px; color: #83807a; min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }

    textarea {
      width: 100%; height: 260px; resize: vertical;
      background: #fff; color: #1f1e1d; border: 1px solid #dedbd1;
      border-radius: 10px; padding: 11px; outline: none;
      font: 12px/1.6 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    textarea:focus { border-color: #d97757; box-shadow: 0 0 0 3px #faf0ea; }
    textarea::placeholder { color: #a8a49b; }

    .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
    .btn {
      border: 1px solid #dedbd1; border-radius: 9px; padding: 9px 13px;
      background: #fff; color: #1f1e1d; cursor: pointer;
      font: 600 12.5px/1 ui-sans-serif, system-ui, sans-serif;
      transition: background .15s ease, border-color .15s ease;
    }
    .btn:hover { background: #f0eee6; }
    .btn[disabled] { opacity: .45; cursor: default; }
    .btn.tiny { padding: 7px 10px; }
    .btn.coral { background: #d97757; color: #fff; border-color: transparent; }
    .btn.coral:hover { background: #c96442; }

    select {
      background: #fff; color: #1f1e1d; border: 1px solid #dedbd1;
      border-radius: 9px; padding: 7px 9px; font: inherit; font-size: 12.5px; outline: none;
    }
    select:focus { border-color: #d97757; box-shadow: 0 0 0 3px #faf0ea; }

    .check { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #3d3b36; cursor: pointer; }
    .check input { accent-color: #d97757; }

    .status { margin-top: 11px; font-size: 12.5px; min-height: 16px; color: #83807a; }
    .status.ok { color: #4f7a5b; }
    .status.err { color: #b4544a; }
    .status.busy { color: #b8863b; }
  `;

  // --- DOM construction ----------------------------------------------------

  function build() {
    if (hostEl) return;

    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    shadow = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLES;

    const fab = document.createElement("button");
    fab.className = "fab";
    fab.type = "button";
    fab.innerHTML = '<span aria-hidden="true">📄</span><span>Transcript</span>';
    fab.hidden = true;

    const panel = document.createElement("section");
    panel.className = "panel";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="head">
        <span class="title">YouTube Transcript</span>
        <button class="x" type="button" title="Close">×</button>
      </div>
      <div class="body">
        <div class="meta">
          <span class="chip slot">Slot: —</span>
          <span class="chip credits">Credits: —</span>
          <span class="chip len">— chars</span>
        </div>
        <div class="search">
          <input class="q" type="text" placeholder="Search transcript…" />
          <button class="btn tiny prev" type="button" title="Previous match">◀</button>
          <button class="btn tiny next" type="button" title="Next match">▶</button>
          <span class="count">0/0</span>
        </div>
        <textarea readonly spellcheck="false" placeholder="Transcript will appear here…"></textarea>
        <div class="row">
          <label class="check"><input class="seek" type="checkbox" checked /><span>Click a timestamp to seek</span></label>
          <select class="fmt">
            <option value="txt">.txt</option>
            <option value="srt">.srt</option>
            <option value="md">.md</option>
          </select>
        </div>
        <div class="row">
          <button class="btn coral copy" type="button" disabled>Copy</button>
          <button class="btn prompt" type="button" disabled>Copy + AI prompt</button>
          <button class="btn dl" type="button" disabled>Download</button>
        </div>
        <div class="status"></div>
      </div>
    `;

    shadow.append(style, fab, panel);

    ui = {
      fab,
      panel,
      close: panel.querySelector(".x"),
      slot: panel.querySelector(".slot"),
      credits: panel.querySelector(".credits"),
      len: panel.querySelector(".len"),
      q: panel.querySelector(".q"),
      prev: panel.querySelector(".prev"),
      next: panel.querySelector(".next"),
      count: panel.querySelector(".count"),
      textarea: panel.querySelector("textarea"),
      seek: panel.querySelector(".seek"),
      fmt: panel.querySelector(".fmt"),
      copy: panel.querySelector(".copy"),
      prompt: panel.querySelector(".prompt"),
      dl: panel.querySelector(".dl"),
      status: panel.querySelector(".status"),
    };

    fab.addEventListener("click", onFabClick);
    ui.close.addEventListener("click", closePanel);
    ui.copy.addEventListener("click", () => copy(state.view, "Transcript copied."));
    ui.prompt.addEventListener("click", () =>
      copy(
        state.aiPrompt +
          "\n\n=========================================\nINPUT TRANSCRIPT CONTENT:\n=========================================\n" +
          state.raw,
        "Copied with AI note prompt."
      )
    );
    ui.dl.addEventListener("click", () => {
      const ext = download();
      if (ext) setStatus(`Saved .${ext} file.`, "ok");
    });

    ui.q.addEventListener("input", runSearch);
    ui.next.addEventListener("click", () => jumpToHit(state.search.idx + 1));
    ui.prev.addEventListener("click", () => jumpToHit(state.search.idx - 1));

    ui.textarea.addEventListener("click", seekFromCaret);
    ui.seek.addEventListener("change", () => {
      state.seekEnabled = ui.seek.checked;
    });
    ui.fmt.addEventListener("change", () => {
      state.format = ui.fmt.value;
      applyFormat();
    });
  }

  function setStatus(text, kind = "") {
    if (!ui.status) return;
    ui.status.textContent = text || "";
    ui.status.className = "status " + kind;
  }

  function openPanel() {
    build();
    ui.panel.hidden = false;
  }
  function closePanel() {
    if (ui.panel) ui.panel.hidden = true;
  }

  // --- search ---------------------------------------------------------------

  function resetSearch() {
    state.search = { hits: [], idx: -1 };
    if (ui.count) ui.count.textContent = "0/0";
  }

  function runSearch() {
    const term = ui.q.value;
    const hay = ui.textarea.value;
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
    updateCount();
    if (hits.length) jumpToHit(0);
  }

  function updateCount() {
    const { hits, idx } = state.search;
    ui.count.textContent = hits.length ? `${idx + 1}/${hits.length}` : "0/0";
  }

  function jumpToHit(i) {
    const { hits } = state.search;
    if (!hits.length) return;
    const n = hits.length;
    const idx = ((i % n) + n) % n;
    state.search.idx = idx;
    const start = hits[idx];
    ui.textarea.focus();
    ui.textarea.setSelectionRange(start, start + ui.q.value.length);
    updateCount();
  }

  // --- seek -----------------------------------------------------------------

  function seekFromCaret() {
    if (!state.seekEnabled) return;
    const ta = ui.textarea;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const lineStart = before.lastIndexOf("\n") + 1;
    let lineEnd = ta.value.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = ta.value.length;
    const line = ta.value.slice(lineStart, lineEnd);

    const m = line.match(/^\s*\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]/);
    if (!m) return;
    const secs =
      m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];

    const video = document.querySelector("video");
    if (!video) {
      setStatus("No video element on this page to seek.", "err");
      return;
    }
    video.currentTime = secs;
    setStatus(`Jumped to ${fmtClock(secs)}.`, "ok");
  }

  // --- fetch / format -------------------------------------------------------

  async function applyFormat() {
    if (!state.raw) return;
    const resp = await chrome.runtime.sendMessage({
      type: "FORMAT_TRANSCRIPT",
      transcript: state.raw,
      format: state.format,
      meta: state.meta || {},
    });
    state.view = (resp && resp.text) || state.raw;
    ui.textarea.value = state.view;
    ui.len.textContent = state.view.length.toLocaleString("en-IN") + " chars";
    resetSearch();
    if (resp && resp.fellBack) {
      setStatus("No timestamps found — exported as plain text.", "err");
    }
  }

  async function onFabClick() {
    build();
    openPanel();

    const id = currentVideoId();
    if (state.loadedFor === id && state.raw) return; // already have it
    await load(id);
  }

  async function load(videoId) {
    state.loadedFor = null;
    state.raw = "";
    state.view = "";
    ui.textarea.value = "";
    ui.slot.textContent = "Slot: —";
    ui.credits.textContent = "Credits: —";
    ui.len.textContent = "— chars";
    [ui.copy, ui.prompt, ui.dl].forEach((b) => (b.disabled = true));
    resetSearch();
    setStatus("Fetching transcript…", "busy");

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "GET_TRANSCRIPT",
        url: location.href,
      });
    } catch (e) {
      setStatus("Extension error: " + e.message, "err");
      return;
    }

    if (!resp || !resp.ok) {
      setStatus((resp && resp.error) || "Something went wrong.", "err");
      if (resp && (resp.code === "NO_URL" || resp.code === "NO_PERM")) {
        const a = document.createElement("button");
        a.className = "btn";
        a.textContent = "Open settings";
        a.style.marginTop = "10px";
        a.addEventListener("click", () =>
          chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" })
        );
        ui.status.appendChild(document.createElement("br"));
        ui.status.appendChild(a);
      }
      return;
    }

    state.loadedFor = videoId;
    state.raw = resp.transcript;
    state.aiPrompt = resp.aiPrompt || "";
    state.meta = resp.meta;

    ui.slot.textContent = "Slot: " + resp.meta.keySlot;
    ui.credits.textContent = "Credits: " + resp.meta.credits;

    await applyFormat();
    [ui.copy, ui.prompt, ui.dl].forEach((b) => (b.disabled = false));

    const lines = resp.transcript.split("\n").length;
    let msg = `Done — ${lines} lines via slot #${resp.meta.keySlot}.`;
    if (settings.autoDownload) {
      const ext = download();
      if (ext) msg += ` Saved .${ext} file.`;
    }
    setStatus(msg, "ok");
  }

  async function copy(text, okMsg) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus(okMsg, "ok");
      return;
    } catch {
      // Fallback: a real textarea in the page (shadow DOM can't be selected
      // by execCommand reliably).
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setStatus(okMsg, "ok");
      } catch {
        setStatus("Copy failed — select the text and copy manually.", "err");
      } finally {
        ta.remove();
      }
    }
  }

  /** Save the shown transcript. Returns the extension used, or null. */
  function download() {
    if (!state.view) return null;
    const ext = state.format === "srt" ? "srt" : state.format === "md" ? "md" : "txt";
    const blob = new Blob([state.view], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `youtube-${(state.meta && state.meta.videoId) || "video"}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return ext;
  }

  // --- show / hide the button as the SPA navigates --------------------------

  function syncVisibility() {
    build();
    const onVideo = isVideoPage();
    ui.fab.hidden = !onVideo || !settings.showFab;
    if (!onVideo) closePanel();

    const id = currentVideoId();
    if (id !== state.loadedFor) {
      // New video → drop stale transcript.
      state.raw = "";
      state.view = "";
      state.loadedFor = null;
    }

    // Auto-run once per video when the setting is on.
    if (settings.autoRunOnWatch && onVideo && id && state.autoRan !== id) {
      state.autoRan = id;
      openPanel();
      load(id);
    }
  }

  function mount() {
    if (!document.body) return;
    if (!document.getElementById(HOST_ID)) {
      build();
      document.body.appendChild(hostEl);
    }
    syncVisibility();
  }

  // --- background messages --------------------------------------------------

  // Keep the panel in step with settings changed elsewhere (Options or popup).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    settings = { ...settings, ...(changes.settings.newValue || {}) };
    if (ui.fmt && settings.defaultFormat) ui.fmt.value = settings.defaultFormat;
    syncVisibility();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "OPEN_TRANSCRIPT_PANEL") {
      if (!isVideoPage()) {
        sendResponse({ ok: false, reason: "not-a-video" });
        return;
      }
      openPanel();
      load(currentVideoId());
      sendResponse({ ok: true });
    }
  });

  // YouTube fires yt-navigate-finish on SPA navigation; also cover the
  // standard history events and a light polling fallback for shorts.
  ["yt-navigate-finish", "popstate", "pushstate"].forEach((ev) =>
    window.addEventListener(ev, syncVisibility, true)
  );
  document.addEventListener("yt-navigate-finish", syncVisibility, true);

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      syncVisibility();
    }
  }, 1200);

  // --- init -----------------------------------------------------------------

  (async function init() {
    try {
      settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
      if (settings && settings.defaultFormat) {
        state.format = settings.defaultFormat;
      }
    } catch {
      /* keep defaults */
    }
    build();
    if (ui.fmt) ui.fmt.value = state.format;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount);
    } else {
      mount();
    }
  })();
})();
