import { getSubtitles } from "youtube-captions-scraper";

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function formatTranscript(captions) {
  return captions.map((c) => c.text).join(" ");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  const videoId = extractVideoId(url);

  if (!videoId) {
    return res.status(400).json({ error: "Invalid YouTube URL or video ID" });
  }

  try {
    const captions = await getSubtitles({ videoID: videoId, lang: "en" });
    const transcript = formatTranscript(captions);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${videoId}-transcript.txt"`
    );
    return res.status(200).send(transcript);
  } catch (error) {
    return res.status(500).json({
      error: "Failed to fetch transcript",
      message: error.message,
    });
  }
}
