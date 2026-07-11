# YouTube Transcript Extractor

A Vercel serverless function that extracts transcripts from YouTube videos.

## Setup

1. Clone the repo
2. Install dependencies:
   ```bash
   npm install
   ```
3. Deploy to Vercel:
   ```bash
   vercel --prod
   ```

## Usage

### Web UI

Visit your Vercel deployment URL and paste a YouTube link.

### API

```
GET /api/transcript?url=https://www.youtube.com/watch?v=VIDEO_ID
```

Returns the transcript as a plain text file.

## Supported URL Formats

- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://youtube.com/embed/VIDEO_ID`
- Raw video ID (11 characters)

## License

MIT
