/**
 * dom-extract.js — read YouTube's own transcript panel straight out of the page.
 *
 * This is the extension's PRIMARY transcript source. It costs no API credits
 * and needs no network round trip: YouTube already renders the transcript in
 * the DOM once the panel is open, so we just read it.
 *
 * content.js calls `YTTX_DOM.getTranscript()` first and only falls back to the
 * Cloudflare Worker when this returns nothing (no captions, panel unavailable,
 * unknown layout, …).
 *
 * Layouts handled
 * ---------------
 *   Legacy   ytd-transcript-segment-renderer inside
 *            ytd-engagement-panel-section-list-renderer[target-id="…transcript"]
 *   Modern   transcript-segment-view-model inside
 *            yt-section-list-renderer[data-target-id="PAmodern_transcript_view"]
 *            (the inner data-target-id exists; the outer panel often has none)
 *   Mobile   ytm-* custom elements, or any container we can infer from
 *            repeated timecode nodes (generic fallback below)
 *
 * Trap worth knowing about: YouTube also renders a HIDDEN dummy panel with
 *   target-id="PAmodern_transcript_view"
 *   visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"
 * containing only a spinner. Matching it yields nothing, so hidden panels are
 * always rejected.
 *
 * Exposes: globalThis.YTTX_DOM.getTranscript({ onProgress, timeoutMs })
 *          -> { entries, text, source } | null
 */
(function (root) {
  "use strict";

  const SEGMENT_SELECTOR = [
    "transcript-segment-view-model",
    ".ytwTranscriptSegmentViewModelHost",
    "ytd-transcript-segment-renderer",
    "ytm-transcript-segment-renderer",
    ".ytmTranscriptSegmentRendererHost",
    ".ytSegmentRendererHost",
  ].join(", ");

  const PANEL_SELECTOR = [
    "ytd-engagement-panel-section-list-renderer",
    "ytm-engagement-panel-section-list-renderer",
    "ytd-transcript-renderer",
    "ytm-transcript-renderer",
    "#engagement-panel-searchable-transcript",
    '[target-id*="transcript"]',
    '[data-target-id*="transcript"]',
  ].join(", ");

  /** "1:23" or "1:02:03" — a bare timecode with nothing else. */
  const TIMESTAMP_RE = /^\d{1,3}:\d{2}(?::\d{2})?$/;

  /** Labels that mean "open the transcript", across desktop and mobile. */
  const TRANSCRIPT_LABELS = ["show transcript", "transcript", "open transcript"];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(...args) {
    // console.log("[yttx:dom]", ...args);
  }

  // -------------------------------------------------------------------------
  // visibility
  // -------------------------------------------------------------------------

  /**
   * Does this document actually lay out? jsdom, and any non-visual host,
   * reports zero client rects for *everything*, which would make every panel
   * look hidden. Only trust geometry when the body itself has boxes.
   */
  function layoutIsReliable() {
    const body = document.body;
    return !!(body && body.getClientRects && body.getClientRects().length > 0);
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN") return false;
    if (el.hasAttribute("hidden")) return false;
    const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (cs) {
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (cs.opacity === "0") return false;
    }
    if (layoutIsReliable() && el.getClientRects().length === 0) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // panel discovery
  // -------------------------------------------------------------------------

  /** First visible panel that already has rendered segments. */
  function findLoadedPanel() {
    const panels = document.querySelectorAll(PANEL_SELECTOR);
    for (const panel of panels) {
      if (!isVisible(panel)) continue;
      const segments = panel.querySelectorAll(SEGMENT_SELECTOR);
      if (segments.length) {
        log("loaded panel:", panel.getAttribute("target-id") || "(no target-id)", segments.length);
        return { panel, segments: Array.from(segments) };
      }
    }
    return null;
  }

  /** Segments anywhere on the page, even if no known panel wrapper matched. */
  function findSegmentsAnywhere() {
    const all = Array.from(document.querySelectorAll(SEGMENT_SELECTOR)).filter(isVisible);
    if (!all.length) return null;
    const panel = all[0].closest(PANEL_SELECTOR) || all[0].parentElement || document.body;
    log("segments found without a known panel wrapper:", all.length);
    return { panel, segments: all };
  }

  function commonAncestor(a, b) {
    if (!a || !b) return null;
    const seen = new Set();
    for (let n = a; n; n = n.parentElement) seen.add(n);
    for (let n = b; n; n = n.parentElement) if (seen.has(n)) return n;
    return null;
  }

  /**
   * Containers that legitimately hold a handful of timecodes but are NOT a
   * transcript — chapter lists in the description are the main trap. Matching
   * one of those would hand back chapter titles as a "transcript" and stop us
   * ever falling back to the worker, so they are excluded outright.
   */
  const NON_TRANSCRIPT_ZONES = [
    "#description",
    "#description-inline-expander",
    "ytd-text-inline-expander",
    "#info-contents",
    "ytd-watch-metadata #bottom-row",
    "ytm-expandable-video-description-body-renderer",
    "ytd-horizontal-card-list-renderer",
  ].join(", ");

  /**
   * Last-resort container inference for layouts we don't recognise (mobile,
   * redesigns). Finds repeated timecode leaves and takes their nearest common
   * ancestor.
   *
   * Deliberately conservative: a real transcript has many segments, so we
   * demand at least MIN_GENERIC_STAMPS of them and refuse anything living in a
   * chapter/description container. Better to return null (and let the worker
   * answer) than to return chapters dressed up as a transcript.
   */
  const MIN_GENERIC_STAMPS = 5;

  function findGenericPanel() {
    const stamps = [];
    for (const el of document.querySelectorAll("span, div, p")) {
      if (el.children.length) continue;
      if (TIMESTAMP_RE.test(el.textContent.trim())) stamps.push(el);
      if (stamps.length >= 60) break;
    }
    if (stamps.length < MIN_GENERIC_STAMPS) return null;

    const panel = commonAncestor(stamps[0], stamps[1]);
    if (!panel || panel === document.body || panel === document.documentElement) return null;
    if (panel.closest(NON_TRANSCRIPT_ZONES)) {
      log("generic candidate rejected: inside a description/chapter zone");
      return null;
    }

    log("generic panel inferred from", stamps.length, "timecodes");
    return { panel, segments: [], generic: true };
  }

  // -------------------------------------------------------------------------
  // segment extraction
  // -------------------------------------------------------------------------

  function firstText(el, selectors) {
    for (const sel of selectors) {
      const found = el.querySelector(sel);
      if (found && found.textContent.trim()) return found.textContent.trim();
    }
    return "";
  }

  /** { timestamp, text } from a segment element of any known layout. */
  function extractSegmentData(segment) {
    const tag = segment.tagName.toLowerCase();
    const isModern =
      tag === "transcript-segment-view-model" ||
      segment.classList.contains("ytwTranscriptSegmentViewModelHost") ||
      segment.classList.contains("ytmTranscriptSegmentRendererHost") ||
      segment.classList.contains("ytSegmentRendererHost");

    if (isModern) {
      let timestamp = firstText(segment, [
        ".ytwTranscriptSegmentViewModelTimestamp",
        ".ytmTranscriptSegmentViewModelTimestamp",
        "[class*='SegmentViewModelTimestamp']",
        "[class*='segment-timestamp']",
      ]);

      // Fallback: scan leaves for something that looks like a timecode.
      if (!timestamp) {
        for (const child of segment.querySelectorAll("div, span")) {
          const t = child.textContent.trim();
          if (TIMESTAMP_RE.test(t)) {
            timestamp = t;
            break;
          }
        }
      }

      let text = firstText(segment, [
        '.ytAttributedStringHost[role="text"]',
        'span[role="text"]',
        ".ytAttributedStringHost",
        "[class*='SegmentText']",
        "[class*='segment-text']",
      ]);

      if (!text) {
        text = segment.textContent.trim();
        if (timestamp && text.startsWith(timestamp)) text = text.slice(timestamp.length).trim();
      }

      return { timestamp, text };
    }

    // Legacy / mobile renderers
    const timestamp = firstText(segment, [".segment-timestamp", "[class*='segment-timestamp']"]);
    const text = firstText(segment, [".segment-text", "[class*='segment-text']"]);
    if (text) return { timestamp, text };

    // Unknown segment tag: split the flattened text on a leading timecode.
    const flat = segment.textContent.trim();
    const m = flat.match(/^(\d{1,3}:\d{2}(?::\d{2})?)\s+([\s\S]+)$/);
    if (m) return { timestamp: m[1], text: m[2].trim() };
    return { timestamp: "", text: flat };
  }

  /** Pair timecode leaves with the text that follows them, for unknown markup. */
  function fallbackExtract(panel) {
    log("running node-walk fallback");
    const entries = [];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_ELEMENT);
    let currentTimestamp = "";
    let node;
    while ((node = walker.nextNode())) {
      if (node.children.length > 0) continue; // leaves only, avoids duplicated text
      const t = node.textContent.trim();
      if (!t) continue;
      if (TIMESTAMP_RE.test(t)) {
        currentTimestamp = t;
        continue;
      }
      if (node.closest("#header, form, button, ytd-engagement-panel-title-header-renderer")) continue;
      if (node.matches('span[role="text"], .ytAttributedStringHost, .segment-text') || t.length > 1) {
        entries.push({ timestamp: currentTimestamp, text: t });
        currentTimestamp = "";
      }
    }
    log("fallback found", entries.length, "entries");
    return entries;
  }

  // -------------------------------------------------------------------------
  // opening the panel
  // -------------------------------------------------------------------------

  function findShowTranscriptControl(scope) {
    const byLabel = scope.querySelector(
      '[aria-label="Show transcript"], [aria-label="Show transcript" i]'
    );
    if (byLabel && isVisible(byLabel)) return byLabel;

    const nodes = scope.querySelectorAll(
      'button, a, tp-yt-paper-item, ytm-menu-item, [role="button"], [role="menuitem"]'
    );
    for (const n of nodes) {
      const label = (n.textContent || "").trim().toLowerCase();
      if (TRANSCRIPT_LABELS.includes(label) && isVisible(n)) return n;
    }
    return null;
  }

  async function pollFor(fn, timeoutMs, intervalMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = fn();
      if (value) return value;
      await sleep(intervalMs || 150);
    }
    return null;
  }

  /** Click whatever opens the transcript. Returns true if something was clicked. */
  async function openTranscriptPanel() {
    let control = findShowTranscriptControl(document);
    if (control) {
      control.click();
      return true;
    }

    // Description may be collapsed ("...more").
    const expand = document.querySelector(
      "ytd-text-inline-expander #expand, ytm-expandable-video-description-body-renderer #expand, tp-yt-paper-button#expand, #expand"
    );
    if (expand && isVisible(expand)) {
      expand.click();
      await sleep(350);
      control = findShowTranscriptControl(document);
      if (control) {
        control.click();
        return true;
      }
    }

    // "More actions" (⋮) menu still holds "Show transcript" on some layouts.
    const more = document.querySelector(
      'button[aria-label="More actions"], #button-shape > button[aria-label*="More"], ytm-menu-button-renderer button'
    );
    if (more && isVisible(more)) {
      more.click();
      const item = await pollFor(() => findShowTranscriptControl(document), 4000, 150);
      if (item) {
        item.click();
        return true;
      }
    }
    return false;
  }

  /**
   * On playlist pages the open playlist panel competes with the transcript
   * panel and stops it loading. Hide it while we work, then put it back.
   */
  function hidePlaylistPanel() {
    const playlist = document.querySelector("ytd-playlist-panel-renderer#playlist, ytd-playlist-panel-renderer");
    if (!playlist) return null;
    const previous = playlist.style.display;
    playlist.style.display = "none";
    return () => {
      playlist.style.display = previous;
    };
  }

  // -------------------------------------------------------------------------
  // formatting
  // -------------------------------------------------------------------------

  /** "1:23" / "1:02:03" -> "HH:MM:SS", matching the worker's output format. */
  function toClock(stamp) {
    const parts = String(stamp || "").split(":");
    if (parts.length < 2 || parts.length > 3) return null;
    const nums = parts.map((n) => parseInt(n, 10));
    if (nums.some((n) => Number.isNaN(n))) return null;
    const [h, m, s] = parts.length === 3 ? nums : [0, nums[0], nums[1]];
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  /**
   * Emit the same `[HH:MM:SS] text` shape the worker returns, so the existing
   * .srt / .md exporters and the search box work unchanged on page-sourced
   * transcripts.
   */
  function formatEntries(entries) {
    const withStamps = entries.some((e) => toClock(e.timestamp));
    return entries
      .map((e) => {
        const clock = withStamps ? toClock(e.timestamp) : null;
        return clock ? `[${clock}] ${e.text}` : e.text;
      })
      .join("\n");
  }

  // -------------------------------------------------------------------------
  // public entry point
  // -------------------------------------------------------------------------

  /**
   * @param {{ onProgress?: (msg: string) => void, timeoutMs?: number }} [opts]
   * @returns {Promise<{entries: Array, text: string, source: string}|null>}
   */
  async function getTranscript(opts) {
    const options = opts || {};
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : function () {};
    const timeoutMs = options.timeoutMs || 15000;

    const restorePlaylist = hidePlaylistPanel();
    try {
      // Already open and rendered? (generic inference is last because it is
      // the most expensive and the least certain.)
      let found = findLoadedPanel() || findSegmentsAnywhere() || findGenericPanel();

      if (!found) {
        onProgress("Opening the transcript panel…");
        const opened = await openTranscriptPanel();
        if (opened) {
          onProgress("Waiting for the transcript to load…");
          found = await pollFor(
            () => findLoadedPanel() || findSegmentsAnywhere() || findGenericPanel(),
            timeoutMs,
            150
          );
        } else {
          // No control to click — but an unfamiliar layout may already be
          // rendered, so give generic inference one more look.
          log("no transcript control found; trying generic inference");
          found = findGenericPanel();
        }
        if (!found) {
          log("transcript not available on this page");
          return null;
        }
      }

      if (!found) {
        log("panel never loaded");
        return null;
      }

      let entries = [];
      for (const segment of found.segments) {
        const data = extractSegmentData(segment);
        if (data && data.text) entries.push(data);
      }

      if (!entries.length) entries = fallbackExtract(found.panel);
      if (!entries.length) {
        log("no entries extracted");
        return null;
      }

      const text = formatEntries(entries);
      if (!text.trim()) return null;

      return { entries, text, source: "page" };
    } catch (err) {
      log("extraction failed:", err && err.message);
      return null;
    } finally {
      if (restorePlaylist) restorePlaylist();
    }
  }

  root.YTTX_DOM = { getTranscript, formatEntries, toClock };

  // Allow the module to be exercised directly under Node for testing.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getTranscript, formatEntries, toClock };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
