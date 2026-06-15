# yt-transcript-worker

A secure, self-hosted YouTube transcript downloader with multi-key API management, built for Cloudflare Workers.

## Features

- **YouTube Transcript Export** — Paste any YouTube URL (videos, shorts, live streams, embeds) and download clean timestamped transcripts
- **Multi-Key Vault** — Store and manage multiple transcript API keys with automatic credit tracking and rotation
- **Admin Panel** — Password-protected dashboard to manage API keys, view masked credentials, and monitor credit balances
- **Smart Key Selection** — Auto-rotates between keys based on available credits, or forces a specific key
- **One-Click Copy** — Copy transcript with an AI-ready prompt for generating handwritten study notes
- **Server-Side Validation** — YouTube URLs validated server-side to prevent abuse
- **Constant-Time Auth** — Timing-attack resistant password comparison

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Storage:** Cloudflare KV (key-value store)
- **External API:** [TranscriptAPI](https://transcriptapi.com) for YouTube transcript extraction
- **Frontend:** Vanilla HTML/CSS/JS (no framework)
- **Fonts:** Google Fonts (Sora, Outfit, Lora)

## Deployment

### Prerequisites

- Cloudflare account with Workers enabled
- TranscriptAPI key (or compatible transcript service)
- `wrangler` CLI installed (`npm install -g wrangler`)

### Setup

1. Clone this repo:
   ```bash
   git clone https://github.com/yourusername/yt-transcript-worker.git
   cd yt-transcript-worker
   ```

2. Configure `wrangler.toml` (create if needed):
   ```toml
   name = "yt-transcript-worker"
   main = "worker.js"
   compatibility_date = "2024-01-01"

   [vars]
   TRANSCRIPT_API_KEY = "your-transcript-api-key"

   [[kv_namespaces]]
   binding = "CONFIG_KV"
   id = "your-kv-namespace-id"
   ```

3. Set the admin password as a secret:
   ```bash
   wrangler secret put ADMIN_PASSWORD
   ```

4. Deploy:
   ```bash
   wrangler deploy
   ```

### Environment Variables

| Variable | Type | Description |
|----------|------|-------------|
| `TRANSCRIPT_API_KEY` | Env var | Fallback transcript API key |
| `ADMIN_PASSWORD` | Secret | Password for admin panel access |
| `CONFIG_KV` | KV binding | Stores API keys and active index |

### KV Namespace Structure

| Key | Value |
|-----|-------|
| `MULTI_API_KEYS` | JSON array of `{id, key, credits}` objects |
| `FORCED_ACTIVE_INDEX` | `"auto"` or numeric string (`"0"`, `"1"`, etc.) |

## Usage

### Main Page (`/`)

1. Paste a YouTube URL
2. Click **Process YouTube Link**
3. Download as `.txt` or copy with AI prompt

### Admin Panel (`/admin`)

1. Enter your admin password
2. View masked API keys with credit counts
3. Add/remove key slots
4. Force a specific key or enable auto-rotation
5. Save changes to KV store

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Main transcript downloader UI |
| GET | `/admin` | Admin panel UI |
| POST | `/process` | Fetch and format YouTube transcript |
| POST | `/admin/fetch-keys` | Get masked key list (auth required) |
| POST | `/admin/reveal-key` | Reveal full API key (auth required) |
| POST | `/admin/update-keys` | Save key configuration (auth required) |

## Security

- Passwords compared using constant-time comparison (prevents timing attacks)
- API keys masked in admin UI (only first 6 + last 4 chars shown)
- Full keys only revealed on explicit request
- YouTube URLs validated server-side against known patterns
- Credentials stored in Cloudflare KV (encrypted at rest)
- Generic error messages prevent information leakage

## Project Structure

```
yt-transcript-worker/
├── worker.js           # Main Cloudflare Worker (all-in-one)
├── wrangler.toml       # Cloudflare Workers config
├── bugs_found.md       # Bug audit report
├── bugs_fixed.md       # Bug fix documentation
└── README.md           # This file
```

## Bug Fixes

This project underwent a comprehensive security and reliability audit. See [bugs_found.md](bugs_found.md) for the full report and [bugs_fixed.md](bugs_fixed.md) for detailed fix documentation.

**Key fixes applied:**
- ID-based key matching (prevents index corruption on deletion)
- Constant-time password comparison
- Credit decrement only after valid transcript received
- Server-side YouTube URL validation
- NaN guards and parseInt radix fixes
- Generic error responses

## License

MIT

## Author

[Pavnxet](https://pavnxet.github.io/)
