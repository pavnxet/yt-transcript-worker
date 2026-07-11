function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

const PROXY_APIS = [
  `https://yt.lemnoslife.com/noKey/captions?part=snippet&videoId=`,
  `https://yt.lemnoslife.com/noKey/captions?videoId=`,
];

async function fetchWithTimeout(url, opts = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function getCaptions(videoId) {
  for (const api of PROXY_APIS) {
    try {
      const res = await fetchWithTimeout(`${api}${videoId}`);
      if (!res.ok) continue;

      const data = await res.json();
      const items = data?.items || data?.captions || [];

      if (!items.length) continue;

      const snippet = items[0]?.snippet || items[0];
      const trackUrl = snippet?.trackContentUrl || snippet?.url;

      if (!trackUrl) continue;

      const subRes = await fetchWithTimeout(trackUrl);
      if (!subRes.ok) continue;

      const xml = await subRes.text();
      const snippets = [];
      const regex = /<text start="([^"]*)" dur="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
      let match;

      while ((match = regex.exec(xml)) !== null) {
        const text = match[3]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n/g, " ")
          .trim();
        if (text) snippets.push(text);
      }

      if (snippets.length) return snippets.join(" ");
    } catch {
      continue;
    }
  }

  throw new Error("All caption APIs failed");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

  try {
    const transcript = await getCaptions(videoId);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${videoId}-transcript.txt"`);
    return res.status(200).send(transcript);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
