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

const INVIDIOUS_INSTANCES = [
  "https://vid.puffyan.us",
  "https://invidious.snopyta.org",
  "https://yewtu.be",
  "https://inv.tux.pizza",
  "https://invidious.privacyredirect.com",
];

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n/g, " ")
    .trim();
}

async function fetchCaptions(videoId) {
  let lastError;

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const apiUrl = `${instance}/api/v1/captions/${videoId}`;
      const res = await fetch(apiUrl, {
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) continue;

      const data = await res.json();
      const captions = data?.captions;

      if (!captions || captions.length === 0) continue;

      const enCaption =
        captions.find((c) => c.language_code === "en") || captions[0];

      const subRes = await fetch(
        `${instance}${enCaption.url}`,
        { signal: AbortSignal.timeout(10000) }
      );

      if (!subRes.ok) continue;

      const subData = await subRes.json();
      const segments = subData?.captions || subData || [];

      if (Array.isArray(segments) && segments.length > 0) {
        return segments.map((s) => decodeHtmlEntities(s.text || s.content || ""));
      }
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw lastError || new Error("All Invidious instances failed");
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
    const textSegments = await fetchCaptions(videoId);
    const transcript = textSegments.join(" ");

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
