<div align="center">

# 🎬 YouTube Transcript Worker

**Turn any YouTube video into clean, timestamped text — with your own private key vault.**

A self-hosted Cloudflare Worker *plus* a companion Chrome extension.
No subscriptions, no third-party dashboards, no shared API keys.

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-2ea44f)

</div>

---

## 📖 Table of contents

- [✨ What is this?](#-what-is-this)
- [🧩 Two halves, one project](#-two-halves-one-project)
- [🏗️ Architecture](#️-architecture)
- [🚀 Quick start](#-quick-start)
  - [1️⃣ Deploy the worker](#1️⃣-deploy-the-worker)
  - [2️⃣ Install the extension](#2️⃣-install-the-extension)
- [⚙️ Configuration](#️-configuration)
- [🔌 API reference](#-api-reference)
- [🖥️ The worker web UI](#️-the-worker-web-ui)
- [🧩 The Chrome extension](#-the-chrome-extension)
  - [Features](#-features)
  - [How to use it](#-how-to-use-it)
  - [Settings](#-settings)
  - [Keyboard shortcut](#-keyboard-shortcut)
  - [Permissions & privacy](#-permissions--privacy)
- [📁 Project structure](#-project-structure)
- [🛠️ Development](#️-development)
- [🔐 Security](#-security)
- [🧯 Troubleshooting](#-troubleshooting)
- [❓ FAQ](#-faq)
- [📜 License](#-license)

---

## ✨ What is this?

Paste a YouTube link → get back a clean, timestamped transcript you can read,
copy, download, or feed straight into an AI to build study notes.

It works for **videos, Shorts, live streams, embeds and playlists**, and it runs
entirely on infrastructure you control:

- 🛰️ A **Cloudflare Worker** does the fetching, key rotation and formatting.
- 🧩 A **Chrome extension** gives you a nice UI for it — in the toolbar and
  right on the YouTube page.

> 🔒 Your API keys never leave your own Cloudflare account. The extension ships
> with **no key at all** — you point it at your own worker.

---

## 🧩 Two halves, one project

| | 🛰️ Worker | 🧩 Extension |
|---|---|---|
| **What it is** | Cloudflare Worker + KV | Chrome Manifest V3 extension |
| **Lives in** | `worker.js` | `manifest.json` + friends, at the repo root |
| **Job** | Fetch, rotate keys, format, serve a web UI | Give you a fast UI to drive it |
| **Needs** | Cloudflare account, transcript API key | A deployed worker URL |
| **Users** | Anyone with the link | Just you (unpacked install) |

You can use the worker **on its own** — it has a complete web UI. The extension
is a power-user layer on top.

---

## 🏗️ Architecture

```
┌──────────────────────┐        ┌───────────────────────────┐
│  YouTube page        │        │  Extension popup          │
│  (in-page panel)     │        │  (Single / Batch / History)│
└──────────┬───────────┘        └─────────────┬─────────────┘
           │  chrome.runtime.sendMessage       │
           └───────────────┬───────────────────┘
                           ▼
                ┌─────────────────────┐
                │  background.js      │  MV3 service worker
                │  (does the fetch)   │  ← not subject to CORS
                └──────────┬──────────┘
                           │  POST <worker>/process
                           ▼
                ┌─────────────────────┐
                │  Cloudflare Worker  │  key vault + rotation
                │     worker.js       │  in KV storage
                └──────────┬──────────┘
                           │  GET transcript
                           ▼
                ┌─────────────────────┐
                │  Transcript API     │
                └─────────────────────┘
```

**Why the extension fetches from the service worker:** the worker sets no CORS
headers, so a page-context request would be blocked. A service-worker request
covered by the extension's host permission isn't subject to CORS — and the
worker's custom response headers stay readable.

---

## 🚀 Quick start

### 1️⃣ Deploy the worker

**Prerequisites**

- ☁️ A Cloudflare account with Workers enabled
- 🔑 A transcript API key (the worker is built around [TranscriptAPI](https://transcriptapi.com), but any compatible endpoint works)
- 🧰 `wrangler` CLI — `npm install -g wrangler`

**Steps**

```bash
# 1. Clone
git clone https://github.com/<your-username>/yt-transcript-worker.git
cd yt-transcript-worker

# 2. Create the KV namespace that stores your key vault
wrangler kv:namespace create CONFIG_KV
```

Copy the printed `id` into `wrangler.toml`:

```toml
name = "yt-transcript-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[vars]
TRANSCRIPT_API_KEY = ""        # optional fallback key

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "<your-kv-namespace-id>"
preview_id = "<your-kv-namespace-id>"
```

```bash
# 3. Set the admin password as an encrypted secret
wrangler secret put ADMIN_PASSWORD

# 4. Ship it
wrangler deploy
```

You now have a URL like `https://yt-transcript-worker.<you>.workers.dev` 🎉

### 2️⃣ Install the extension

1. 📥 Download or clone this repo.
2. 🌐 Open `chrome://extensions` in Chrome (or any Chromium browser).
3. 🧪 Turn on **Developer mode** (top-right).
4. 📂 Click **Load unpacked** and select **this repo folder** (the one with `manifest.json` in it).
5. ⚙️ The Options page opens automatically — paste your worker URL there.
6. ✅ Click **Save & grant access** and approve the prompt.

That's it. Open a YouTube video and click the extension icon 🎬

---

## ⚙️ Configuration

### Worker environment

| Variable | Type | Required | Description |
|---|---|---|---|
| `TRANSCRIPT_API_KEY` | Env var | Optional | Fallback key, used when the KV vault is empty |
| `ADMIN_PASSWORD` | 🔐 Secret | **Yes** | Password that unlocks `/admin` |
| `CONFIG_KV` | KV binding | **Yes** | Stores your API keys and the active index |

### KV storage layout

| Key | Value |
|---|---|
| `MULTI_API_KEYS` | JSON array of `{ id, key, credits }` objects |
| `FORCED_ACTIVE_INDEX` | `"auto"` or a numeric string (`"0"`, `"1"`, …) |

### Extension settings

| Setting | Default | What it does |
|---|---|---|
| 🔘 Show the floating button | On | Shows/hides the *Transcript* button on YouTube pages |
| ⬇️ Auto-download after fetching | Off | Saves the file the moment a fetch finishes |
| ▶️ Auto-fetch on video pages | Off | Fetches automatically when you open a video |
| 📄 Default export format | Plain `.txt` | Used by Download and auto-download |

---

## 🔌 API reference

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | — | Main transcript downloader UI |
| `GET` | `/admin` | — | Admin panel UI |
| `POST` | `/process` | — | Fetch + format a transcript |
| `POST` | `/admin/fetch-keys` | 🔐 | List keys, masked, with credit counts |
| `POST` | `/admin/reveal-key` | 🔐 | Reveal one full key |
| `POST` | `/admin/update-keys` | 🔐 | Save the key configuration |

### `POST /process`

Accepts `multipart/form-data` with a single field:

| Field | Example |
|---|---|
| `youtube_url` | `https://www.youtube.com/watch?v=dQw4w9WgXcQ` |

Returns `text/plain` — one line per caption segment:

```
[00:00:02] Welcome back everyone
[00:00:06] Today we're covering...
[00:00:12] Let's get started
```

…plus some handy response headers:

| Header | Meaning |
|---|---|
| `X-Active-Key-Index` | Which vault slot served this request |
| `X-Active-Key-Credits` | Credits left on that slot |

> 💡 The URL is validated **server-side** and normalised to a standard
> `watch?v=` form, so `/shorts/`, `/live/` and `/embed/` links all work without
> tripping up the upstream API.

---

## 🖥️ The worker web UI

Open your worker URL in a browser and you get a full interface — no extension
needed.

**Main page (`/`)** 🎬

- Paste any YouTube link → **Process YouTube Link**
- Download the transcript as `.txt`
- 📋 **Copy with AI prompt** — bundles the transcript with a ready-made
  "turn this into handwritten study notes" prompt

**Admin panel (`/admin`)** 🛡️

- 🔐 Password-protected dashboard
- 👀 View masked API keys with live credit counts
- ➕ Add / remove key slots
- 🔄 Force a specific key, or leave it on auto-rotation
- 💾 Save the whole matrix to KV in one click

---

## 🧩 The Chrome extension

### ✨ Features

- 🗂️ **Three tabs** — Single, Batch, History
- 🪟 **In-page panel** — a floating button on watch / Shorts / live / embed pages, in a shadow root that survives YouTube's SPA navigation
- ⌨️ **Keyboard shortcut** — `Alt`+`Shift`+`T` grabs the current video
- 📚 **Batch mode** — paste many links, or a **playlist / channel URL** to expand
- 🔤 **Three export formats** — `.txt`, `.srt` subtitles, `.md` with timestamp headings
- 🔍 **Search inside a transcript** — step through matches with ◀ / ▶
- ⏱️ **Click a timestamp to seek** — jump the video to that exact moment
- 🕘 **History** — the last 25 transcripts, kept locally, re-copy without spending a credit
- 🗜️ **ZIP export** — bundle a whole batch, one file per video
- 📊 **Status badge** — ✓ / ! on the toolbar icon
- 🎨 **Claude-inspired theme** — warm cream, coral accent, serif headings
- ⚡ **Page-first** — reads YouTube's own transcript panel (**0 API credits**), worker only as fallback
- 📱 **Mobile-ready** — works on `m.youtube.com` in Chromium-based mobile browsers that support extensions

### 🎯 How to use it

**Single video**

1. Click the extension icon — the current tab's link is pre-filled
2. Hit **Get transcript**
3. Search it, pick a format, then **Copy** / **Copy + AI prompt** / **Download**

**Batch**

1. Switch to the **Batch** tab
2. Paste links one per line — or a playlist / channel URL
3. **Fetch all** (keep the popup open while it runs)
4. **Copy all**, **Download .txt** (combined), or **Download .zip**

**On the page**

Open any YouTube video and click the red **Transcript** button in the
bottom-right corner. Click any `[00:00:00]` line to seek the video there.

### ⚡ Where the transcript comes from

The extension tries two sources, in this order:

1. **The page (primary).** YouTube already renders the transcript in the DOM
   once the panel is open, so `dom-extract.js` just reads it. No API call, no
   credits, instant. It handles the legacy renderer, the modern tabbed
   "In this video" panel, mobile markup, and unknown layouts (it can infer the
   container from repeated timecodes). It also ignores YouTube's hidden dummy
   panel and refuses to mistake a chapter list for a transcript.
2. **Your worker (fallback).** If the page has no captions, the panel won't
   open, or the markup is unrecognisable, it asks your Cloudflare Worker
   exactly as before.

The two chips in the panel tell you which one answered: *Source: page panel ·
0 credits used* or *Slot: 2 · Credits: 41*.

Timestamps are normalised to `[HH:MM:SS]` either way, so search, `.srt` and
`.md` export behave identically regardless of source.

### ⚙️ Settings

All four live on the Options page. The first two also have quick toggles in the
popup footer. Changes apply **immediately** — the in-page panel updates live,
with no reload.

### ⌨️ Keyboard shortcut

| Action | Default |
|---|---|
| Open the transcript panel for the current video | `Alt` + `Shift` + `T` |

Rebind it at `chrome://extensions/shortcuts`. Off a YouTube video page the badge
flashes `!` instead.

### 🔐 Permissions & privacy

| Permission | Why |
|---|---|
| `storage` | Save your settings and transcript history |
| `activeTab` | Read the current tab's URL when you click the icon |
| `clipboardWrite` | The Copy buttons |
| `optional_host_permissions` | Requested **at runtime**, only for the origins you actually use |

- 🎯 Access is granted to **your worker's origin** — and to `youtube.com` only if
  you use playlist expansion.
- 🙅 The extension never asks to read your browsing history.
- 🚫 No analytics, no telemetry, no third-party calls. Requests go only to the
  worker you configure.

---

## 📁 Project structure

```
yt-transcript-worker/
│
├── 🛰️  WORKER
│   ├── worker.js               Cloudflare Worker — API, admin panel, web UI
│   ├── wrangler.toml           Cloudflare config + KV binding
│   └── creamy_theme_guide.txt  The "Creamy Light Mode" design system reference
│
├── 🧩  EXTENSION  (Manifest V3)
│   ├── manifest.json           Permissions, command, action, content script
│   ├── background.js           Service worker — settings, fetch, exporters,
│   │                           history, batch engine, commands, badge
│   ├── dom-extract.js          Reads YouTube's own transcript panel (primary source)
│   ├── content.js              Floating button + shadow-DOM panel on YouTube
│   ├── popup.html/.css/.js     Toolbar UI — Single / Batch / History
│   ├── options.html/.js        Worker URL, permission grant, preferences
│   ├── zip.js                  Dependency-free ZIP writer
│   └── icons/                  16 / 32 / 48 / 128 px icons
│
└── README.md
```

> 📌 Because `manifest.json` sits at the repo root, **Load unpacked** should
> point at the repo root itself.

---

## 🛠️ Development

**Worker**

```bash
wrangler dev        # local dev server
wrangler deploy     # ship to production
wrangler tail       # live logs
```

**Extension**

There's no build step — it's plain HTML/CSS/JS.

1. Edit any file.
2. Go to `chrome://extensions`.
3. Hit 🔄 **Reload** on the extension card.
4. For `content.js` changes, also refresh the YouTube tab.

**Handy files while developing**

- `worker.js` — everything is in this one file, including the inline HTML/CSS/JS for both pages
- `zip.js` — runs in both the service worker (`importScripts`) and the popup (`<script>`)

---

## 🔐 Security

- 🕵️ **Constant-time password comparison** — resists timing attacks on `/admin`
- 🙈 **Keys masked in the UI** — only first 6 + last 4 characters shown
- 🔓 **Full keys revealed only on explicit request**
- ✅ **Server-side URL validation** — only real YouTube links reach the upstream API
- 🗄️ **Credentials in Cloudflare KV** — encrypted at rest
- 🤐 **Generic error messages** — no information leakage
- 🚫 **No secrets in this repo** — the API key ships empty and the admin password
  is a Cloudflare secret, never a file

> ⚠️ **Never commit a real API key.** Keep `TRANSCRIPT_API_KEY` empty in
> `wrangler.toml` and manage keys through the `/admin` panel or `wrangler secret`.

---

## 🧯 Troubleshooting

| 😖 Problem | 🔧 Fix |
|---|---|
| `Missing YouTube URL` / `Invalid YouTube URL` | The link has to contain a valid 11-character video id |
| `API Error: …` from `/process` | Your transcript API key is invalid or out of credits — check `/admin` |
| `Server Error: ADMIN_PASSWORD not set` | Run `wrangler secret put ADMIN_PASSWORD` and redeploy |
| Extension says *"No Worker URL set"* | Open the extension Options and paste your worker URL |
| Extension says *"Permission … hasn't been granted"* | Options → **Save & grant access** |
| Transcript comes back empty | That video has no captions available |
| `.srt` / `.md` falls back to plain text | The transcript had no timestamps |
| Batch stops partway | The popup must stay open — closing it cancels the job |
| Credits show as `N/A` | Your worker build doesn't emit those headers (fallback-key path) |
| Chips say *Source: page panel* | Working as intended — no credits were spent |
| Falls back to the worker every time | The video has no captions, or the transcript panel never opened |

---

## ❓ FAQ

<details>
<summary><b>Do I need the extension?</b></summary>

No. The worker has a complete web UI at its root URL. The extension is a
convenience layer — batch processing, history, on-page panel, keyboard shortcut.
</details>

<details>
<summary><b>Can I use a different transcript API?</b></summary>

Yes — swap the upstream `fetch` inside the `/process` handler in `worker.js`.
Keep the shape (`{ transcript: [{ start, text }] }`) and everything else works.
</details>

<details>
<summary><b>How does multi-key rotation work?</b></summary>

Each key in KV has a credit count. On every request the worker picks the first
key with credits left (or a forced slot if you've pinned one), uses it, then
decrements its count. When a key hits zero it's skipped automatically.
</details>

<details>
<summary><b>How many credits does a batch cost?</b></summary>

One credit per video. A 40-video playlist costs 40 credits.
</details>

<details>
<summary><b>Where is my history stored?</b></summary>

Locally, in `chrome.storage.local` — capped at 25 entries / ~4 MB. Nothing is
uploaded anywhere. Clear it from the **History** tab.
</details>

<details>
<summary><b>Does this work in Edge, Brave, Arc…?</b></summary>

Yes — anything Chromium-based that supports Manifest V3.
</details>

---

## 📜 License

MIT — do what you like with it.

<div align="center">

**⭐ If this saved you time, a star is appreciated!**

</div>
