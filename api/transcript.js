const WATCH_URL = "https://www.youtube.com/watch?v=";
const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

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

async function getSession(videoId) {
  const res = await fetch(`${WATCH_URL}${videoId}&hl=en`, {
    headers: { "User-Agent": USER_AGENT },
  });
  const html = await res.text();

  const apiKey = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)?.[1];
  if (!apiKey) throw new Error("Cannot extract API key");

  const clientVersion =
    html.match(/"INNERTUBE_CLIENT_VERSION":\s*"([^"]+)"/)?.[1] || "2.20260320.08.00";
  const visitorData =
    html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || "";

  return { apiKey, clientVersion, visitorData };
}

async function getCaptions(videoId) {
  const session = await getSession(videoId);

  const res = await fetch(`${INNERTUBE_URL}?key=${session.apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-YouTube-Client-Name": "1",
      "X-YouTube-Client-Version": session.clientVersion,
      ...(session.visitorData ? { "X-Goog-Visitor-Id": session.visitorData } : {}),
    },
    body: JSON.stringify({
      context: {
        client: {
          hl: "en",
          gl: "US",
          clientName: "WEB",
          clientVersion: session.clientVersion,
          visitorData: session.visitorData,
        },
      },
      videoId,
    }),
  });

  if (!res.ok) throw new Error(`InnerTube API returned ${res.status}`);
  const data = await res.json();

  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) throw new Error("No captions available");

  const track = tracks.find((t) => t.languageCode === "en") || tracks[0];
  const subRes = await fetch(track.baseUrl, {
    headers: { "User-Agent": USER_AGENT },
  });

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

  return snippets.join(" ");
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
