import json
import re
import concurrent.futures
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import requests
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.proxies import GenericProxyConfig

PROXY_LIST_URL = "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.json"

def extract_video_id(url):
    patterns = [
        r"(?:youtube\.com/watch\?.*v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/)([a-zA-Z0-9_-]{11})",
        r"^([a-zA-Z0-9_-]{11})$",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None

def fetch_proxies():
    try:
        res = requests.get(PROXY_LIST_URL, timeout=10)
        res.raise_for_status()
        proxies = res.json()
        http_proxies = [
            p for p in proxies
            if p.get("protocol") in ("http", "https") and p.get("ip") and p.get("port")
        ]
        return [
            f"http://{p['ip']}:{p['port']}"
            for p in http_proxies[:50]
        ]
    except Exception:
        return []

def test_proxy(proxy_url, timeout=5):
    try:
        res = requests.get(
            "https://httpbin.org/ip",
            proxies={"http": proxy_url, "https": proxy_url},
            timeout=timeout,
        )
        if res.status_code == 200:
            return proxy_url
    except Exception:
        pass
    return None

def get_fastest_proxy():
    proxies = fetch_proxies()
    if not proxies:
        return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(test_proxy, p): p for p in proxies[:15]}
        for future in concurrent.futures.as_completed(futures, timeout=8):
            result = future.result()
            if result:
                executor.shutdown(wait=False, cancel_futures=True)
                return result
    return None

def fetch_transcript(video_id, proxy_url=None):
    proxy_config = None
    if proxy_url:
        proxy_config = GenericProxyConfig(
            http_url=proxy_url,
            https_url=proxy_url,
        )

    ytt_api = YouTubeTranscriptApi(proxy_config=proxy_config)
    transcript = ytt_api.fetch(video_id, languages=["en"])
    return " ".join(snippet.text for snippet in transcript)

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if "url" not in params:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Missing url parameter"}).encode())
            return

        url = params["url"][0]
        video_id = extract_video_id(url)

        if not video_id:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid YouTube URL"}).encode())
            return

        proxy_url = get_fastest_proxy()

        try:
            transcript = fetch_transcript(video_id, proxy_url)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{video_id}-transcript.txt"')
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(transcript.encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
