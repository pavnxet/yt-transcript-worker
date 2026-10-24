/**
 * options.js — settings page.
 * The host-permission request MUST happen here (a foreground extension page
 * on a real user gesture); a service worker cannot prompt for it.
 */

const $ = (id) => document.getElementById(id);
const els = {
  url: $("workerUrl"),
  save: $("saveBtn"),
  test: $("testBtn"),
  status: $("status"),
  permBadge: $("permBadge"),
  autoRun: $("autoRun"),
  showFab: $("showFab"),
  autoDownload: $("autoDownload"),
  defaultFormat: $("defaultFormat"),
  prefStatus: $("prefStatus"),
};

function setPrefStatus(text, kind = "") {
  els.prefStatus.textContent = text || "";
  els.prefStatus.className = "status " + kind;
}

function setStatus(text, kind = "") {
  els.status.textContent = text || "";
  els.status.className = "status " + kind;
}

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function originPattern(base) {
  try {
    return new URL(base).origin + "/*";
  } catch {
    return null;
  }
}

async function refreshPermBadge() {
  const base = normalizeBase(els.url.value);
  const pattern = originPattern(base);
  if (!pattern) {
    els.permBadge.textContent = "no valid URL";
    els.permBadge.className = "badge off";
    return false;
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  els.permBadge.textContent = granted ? "granted" : "not granted";
  els.permBadge.className = "badge " + (granted ? "on" : "off");
  return granted;
}

async function save() {
  const base = normalizeBase(els.url.value);

  if (!base) {
    setStatus("Enter your worker URL first.", "err");
    return;
  }
  const pattern = originPattern(base);
  if (!pattern) {
    setStatus("That isn't a valid http(s) URL.", "err");
    return;
  }

  // Persist first so the URL survives even if the user declines the prompt.
  const { settings } = await chrome.storage.sync.get("settings");
  await chrome.storage.sync.set({
    settings: { ...(settings || {}), workerUrl: base },
  });

  // Ask for access to just this origin, on this user gesture.
  let granted = await chrome.permissions.contains({ origins: [pattern] });
  if (!granted) {
    try {
      granted = await chrome.permissions.request({ origins: [pattern] });
    } catch {
      granted = false;
    }
  }

  await refreshPermBadge();
  if (granted) {
    setStatus("Saved. Access granted — you're ready to fetch transcripts.", "ok");
  } else {
    setStatus(
      "Saved the URL, but access wasn't granted. Click “Save & grant access” again and allow it.",
      "err"
    );
  }
}

async function testConnection() {
  const base = normalizeBase(els.url.value);
  const pattern = originPattern(base);
  if (!pattern) {
    setStatus("Enter a valid worker URL to test.", "err");
    return;
  }
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    setStatus("Grant access first (Save & grant access).", "err");
    return;
  }

  els.test.disabled = true;
  setStatus("Contacting the worker…", "busy");
  try {
    const res = await fetch(base + "/", { method: "GET" });
    if (res.ok) {
      const poweredBy = res.headers.get("X-Powered-By") || "";
      setStatus(
        `Reachable — HTTP ${res.status}.${poweredBy ? " " + poweredBy : ""}`,
        "ok"
      );
    } else {
      setStatus(`Worker answered HTTP ${res.status}. Check the URL.`, "err");
    }
  } catch (e) {
    setStatus(`Couldn't reach it (${e.message}).`, "err");
  } finally {
    els.test.disabled = false;
  }
}

// --- init -----------------------------------------------------------------

async function savePreferences() {
  const { settings } = await chrome.storage.sync.get("settings");
  await chrome.storage.sync.set({
    settings: {
      ...(settings || {}),
      autoRunOnWatch: els.autoRun.checked,
      showFab: els.showFab.checked,
      autoDownload: els.autoDownload.checked,
      defaultFormat: els.defaultFormat.value,
    },
  });
  setPrefStatus("Preferences saved.", "ok");
}

(async function init() {
  const { settings } = await chrome.storage.sync.get("settings");
  const s = settings || {};
  if (s.workerUrl) els.url.value = s.workerUrl;
  els.autoRun.checked = Boolean(s.autoRunOnWatch);
  els.showFab.checked = s.showFab !== false; // default on
  els.autoDownload.checked = Boolean(s.autoDownload);
  els.defaultFormat.value = s.defaultFormat || "txt";
  await refreshPermBadge();
})();

[els.autoRun, els.showFab, els.autoDownload].forEach((el) =>
  el.addEventListener("change", savePreferences)
);
els.defaultFormat.addEventListener("change", savePreferences);

els.save.addEventListener("click", save);
els.test.addEventListener("click", testConnection);
els.url.addEventListener("input", refreshPermBadge);
