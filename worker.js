const NOTE_PROMPT = `Convert the provided transcript into one continuous topper-style handwritten notebook infographic.
Output: Return ONLY complete HTML + CSS (no markdown, explanations, or extra text).
Content Rules: Extract 100% of content exactly as written. No omissions, summaries, rewording, or added theory.
Preserve all questions, answers, examples, formulas, tables, and diagrams. Visual Learning Style: 🔴 Red bold = Headings, Definitions, Laws, Theorems 🔵 Blue = Explanations, Notes, Examples 🟡 Yellow Highlight = Formulas, Keywords, Values, Answers Use underlines, arrows, callout boxes, sticky notes, margin notes, connectors, icons, and visual hierarchy.
Memory Retention Enhancements: Generate memory tricks, mnemonics, visual associations, and quick-recall cues ONLY from existing content.
Create inline mind maps, flowcharts, comparison charts, timelines, process diagrams, concept trees, and visual summaries wherever applicable.
Convert complex information into easy-to-remember visual structures without changing the original content.
Exam-Focused Labels: Exam Tip • Most Important • Memory Trick • Shortcut • Common Mistake • Frequently Asked • Revision Point • Last-Minute Recall Design Requirements: Single infinite canvas (no pages, no chapter breaks).
Ultra-realistic handwritten notes with natural handwriting variations, pen-pressure effects, doodles, highlights, and scanned notebook aesthetics.
Embed relevant SVG diagrams, visual icons, arrows, and educational illustrations directly beside related concepts for maximum recall.
Optimize for 1-minute revision, long-term memory retention, and exam preparation.`;

// सुरक्षित पासवर्ड मैचिंग फ़ंक्शन (Timing Attacks से सुरक्षा)
function safeCompare(a, b) {
  if (!a || !b) return false;
  const maxLen = Math.max(a.length, b.length);
  let result = 0;
  for (let i = 0; i < maxLen; i++) {
    result |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return result === 0;
}

function generateId() {
  return crypto.randomUUID();
}

const YOUTUBE_URL_REGEX = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?.*?v=|shorts\/|live\/|embed\/|v\/|vi\/)|youtu\.be\/|youtube\.com\/(?:user\/\w+\/)?(?:c\/\w+\/)?)([a-zA-Z0-9_-]{11})/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const globalHeaders = {
      "Content-Type": "text/html;charset=UTF-8",
      "X-Powered-By": "Pavnxet (https://pavnxet.github.io/)"
    };

    // रूट एंडपॉइंट (मेन पेज)
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(getHTMLForm(), { headers: globalHeaders });
    }

    // एडमिन पैनल एंडपॉइंट
    if (request.method === "GET" && url.pathname === "/admin") {
      return new Response(getAdminForm(), { headers: globalHeaders });
    }

    // 🔒 सिक्योर एंडपॉइंट: मास्क किया हुआ डेटा + एक्टिव की स्टेट भेजना
    if (request.method === "POST" && url.pathname === "/admin/fetch-keys") {
      try {
        const savedPassword = env.ADMIN_PASSWORD;
        if (!savedPassword) {
          return new Response(JSON.stringify({ error: "Server Configuration Missing" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }

        const formData = await request.formData();
        const inputPassword = formData.get("admin_password") || "";

        if (!safeCompare(inputPassword, savedPassword)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
        }

        const storedKeysRaw = await env.CONFIG_KV.get("MULTI_API_KEYS") || "[]";
        const forcedActiveIdx = await env.CONFIG_KV.get("FORCED_ACTIVE_INDEX") || "auto";
        const keyList = JSON.parse(storedKeysRaw);

        const maskedList = keyList.map((item) => {
          let maskedKey = "••••••••";
          if (item.key && item.key.length > 10) {
            maskedKey = `${item.key.substring(0, 6)}...${item.key.slice(-4)}`;
          }
          return {
            id: item.id || "",
            maskedKey: maskedKey,
            credits: item.credits || "0"
          };
        });

        return new Response(JSON.stringify({ keys: maskedList, forcedActiveIndex: forcedActiveIdx }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Failed to load vault" }), { status: 500 });
      }
    }

    // 🔒 सिक्योर एंडपॉइंट: ऑन-डिमांड सिंगल की डिलीवरी
    if (request.method === "POST" && url.pathname === "/admin/reveal-key") {
      try {
        const savedPassword = env.ADMIN_PASSWORD;
        if (!savedPassword) {
          return new Response("Server Configuration Missing", { status: 500 });
        }

        const formData = await request.formData();
        const inputPassword = formData.get("admin_password") || "";
        const targetIndex = parseInt(formData.get("index") || "0", 10);

        if (!safeCompare(inputPassword, savedPassword)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const storedKeysRaw = await env.CONFIG_KV.get("MULTI_API_KEYS") || "[]";
        const keyList = JSON.parse(storedKeysRaw);

        if (keyList[targetIndex]) {
          return new Response(keyList[targetIndex].key, { status: 200, headers: { "Content-Type": "text/plain" } });
        } else {
          return new Response("Key Not Found", { status: 404 });
        }
      } catch (error) {
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    // 🔒 सिक्योर एंडपॉइंट: पूर्ण डेटाबेस मैट्रिक्स और एक्टिव की इंडेक्स अपडेट करना
    if (request.method === "POST" && url.pathname === "/admin/update-keys") {
      try {
        const savedPassword = env.ADMIN_PASSWORD;
        if (!savedPassword) {
          return new Response("Server Configuration Missing", { status: 500 });
        }

        const formData = await request.formData();
        const inputPassword = formData.get("admin_password") || "";
        const keysJsonData = formData.get("keys_json") || "[]";
        const forcedActiveIdx = formData.get("forced_active_index") || "auto";

        if (!safeCompare(inputPassword, savedPassword)) {
          return new Response("Unauthorized: Invalid Password", { status: 401 });
        }

        const incomingList = JSON.parse(keysJsonData);
        const storedKeysRaw = await env.CONFIG_KV.get("MULTI_API_KEYS") || "[]";
        let currentList = JSON.parse(storedKeysRaw);

        const currentMap = new Map();
        currentList.forEach(item => {
          if (item.id) currentMap.set(item.id, item.key);
        });

        const finalMatrix = incomingList.map((item) => {
          if (item.isNew) {
            return { id: item.id || generateId(), key: item.key, credits: item.credits };
          }
          const masterKeyRecord = currentMap.get(item.id) || "";
          return {
            id: item.id,
            key: masterKeyRecord,
            credits: item.credits
          };
        });

        await env.CONFIG_KV.put("MULTI_API_KEYS", JSON.stringify(finalMatrix));
        await env.CONFIG_KV.put("FORCED_ACTIVE_INDEX", forcedActiveIdx);
        
        return new Response("Success: Vault Matrix and Active Key Configuration saved!", { status: 200 });
      } catch (error) {
        return new Response("Storage Error: Failed to save vault matrix", { status: 500 });
      }
    }

    // प्रोसेसिंग एंडपॉइंट (/process)
    if (request.method === "POST" && url.pathname === "/process") {
      try {
        const formData = await request.formData();
        const youtubeUrl = formData.get("youtube_url");

        if (!youtubeUrl) {
          return new Response("Missing YouTube URL", { status: 400 });
        }

        const ytMatch = youtubeUrl.match(YOUTUBE_URL_REGEX);
        if (!ytMatch) {
          return new Response("Invalid YouTube URL", { status: 400 });
        }

        // 🛡️ FIX: एक्सट्रैक्ट की हुई वीडियो ID से हमेशा स्टैंडर्ड यूआरएल फॉर्मेट बनाएं ताकि थर्ड-पार्टी API क्रैश न हो
        const videoId = ytMatch[1];
        const sanitizedApiUrl = `https://www.youtube.com/watch?v=${videoId}`;

        let selectedApiKey = env.TRANSCRIPT_API_KEY;
        let keyIndexUsed = "Fallback";
        let creditsRemaining = "N/A";
        let keyList = [];
        let hasMultiKeys = false;

        if (env.CONFIG_KV) {
          const storedKeysRaw = await env.CONFIG_KV.get("MULTI_API_KEYS");
          const forcedActiveIdx = await env.CONFIG_KV.get("FORCED_ACTIVE_INDEX") || "auto";
          
          if (storedKeysRaw) {
            try {
              keyList = JSON.parse(storedKeysRaw);
              if (keyList.length > 0) {
                hasMultiKeys = true;
                let targetIndex = -1;

                const parsedForced = parseInt(forcedActiveIdx, 10);
                if (forcedActiveIdx !== "auto" && !isNaN(parsedForced) && keyList[parsedForced]) {
                  targetIndex = parsedForced;
                } else {
                  targetIndex = keyList.findIndex(k => parseInt(k.credits || "0", 10) > 0);
                }

                if (targetIndex !== -1) {
                  selectedApiKey = keyList[targetIndex].key;
                  keyIndexUsed = (targetIndex + 1).toString();
                  creditsRemaining = Math.max(0, parseInt(keyList[targetIndex].credits || "0", 10) - 1).toString();
                } else {
                  selectedApiKey = keyList[0].key;
                  keyIndexUsed = "1";
                  creditsRemaining = "0";
                }
              }
            } catch (e) {
              hasMultiKeys = false;
            }
          }
        }

        // 🛡️ FIX: यहाँ अब 'sanitizedApiUrl' पास होगा, जिससे /live/ या /shorts/ वाले एरर कभी नहीं आएंगे
        const apiResponse = await fetch(
          `https://transcriptapi.com/api/v2/youtube/transcript?video_url=${encodeURIComponent(sanitizedApiUrl)}`,
          {
            method: "GET",
            headers: { "Authorization": `Bearer ${selectedApiKey}` },
          }
        );

        if (!apiResponse.ok) {
          const errorText = await apiResponse.text();
          return new Response(`API Error: ${errorText}`, { status: apiResponse.status });
        }

        const data = await apiResponse.json();
        const segments = data.transcript || [];
        const formattedTranscript = segments.map(seg => `[${formatTime(seg.start)}] ${seg.text}`).join("\n");

        if (segments.length > 0 && hasMultiKeys && keyIndexUsed !== "Fallback") {
          const targetIdx = parseInt(keyIndexUsed, 10) - 1;
          let currentCredits = parseInt(keyList[targetIdx].credits || "0", 10);
          if (currentCredits > 0) {
            keyList[targetIdx].credits = (currentCredits - 1).toString();
            await env.CONFIG_KV.put("MULTI_API_KEYS", JSON.stringify(keyList));
          }
        }

        return new Response(formattedTranscript, {
          status: 200,
          headers: { 
            "Content-Type": "text/plain;charset=UTF-8",
            "X-Processed-By": "Pavnxet-Engine",
            "X-Active-Key-Index": keyIndexUsed,
            "X-Active-Key-Credits": creditsRemaining
          },
        });

      } catch (error) {
        return new Response("Worker Processing Error", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function getCSSVariables() {
  return `
    :root {
      --bg-primary: #faf6f0;
      --bg-surface: #ffffff;
      --bg-inner: #f6efe5;
      --cream2: #f4ede2;
      --cream3: #ecdfd0;
      --ink: #1e1a15;
      --ink2: #4a4038;
      --text-muted: #7a7266;
      --text-inverse: #ffffff;
      --accent: #b07d4a;
      --accent-cocoa: #8e7c68;
      --warm: #c9a87c;
      --radius: 16px;
      --font-primary: 'Outfit', 'Segoe UI', system-ui, sans-serif;
      --font-sans: 'Sora', 'Segoe UI Variable', system-ui, sans-serif;
      --font-serif: 'Lora', Georgia, serif;
      --transition-elastic: all 0.25s cubic-bezier(.22,.68,0,1.1);
      --shadow: 0 4px 20px rgba(160, 120, 70, 0.08);
      --shadow-md: 0 10px 24px rgba(142, 124, 104, 0.06);
    }
  `;
}

function getHTMLForm() {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>YouTube Transcript Downloader</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600&family=Outfit:wght@400;600&family=Lora:wght@500&display=swap" rel="stylesheet">
      <style>
        ${getCSSVariables()}
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background-color: var(--bg-primary); color: var(--ink2); font-family: var(--font-primary); display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .card { background: var(--bg-surface); padding: 2.5rem; border-radius: var(--radius); box-shadow: var(--shadow); transition: var(--transition-elastic); width: 100%; max-width: 480px; margin: 16px; border: 1px solid var(--cream2); position: relative; }
        .card:hover { box-shadow: var(--shadow-md); transform: translateY(-5px); }
        h1 { font-family: var(--font-serif); font-weight: 500; font-size: 1.8rem; margin-bottom: 0.5rem; color: var(--ink); text-align: center; }
        p.subtitle { font-family: var(--font-sans); font-size: 14px; color: var(--text-muted); text-align: center; margin-bottom: 0.8rem; }
        .key-status-badge { display: block; text-align: center; font-family: var(--font-sans); font-size: 12px; font-weight: 600; color: var(--accent); background: var(--bg-inner); padding: 6px 14px; border-radius: 14px; margin-bottom: 1.5rem; width: fit-content; margin-left: auto; margin-right: auto; border: 1px solid var(--cream3); line-height: 1.4; }
        .input-box { width: 100%; padding: 12px 18px; background: var(--bg-surface); border: 1.5px solid var(--cream3); border-radius: 24px; font-family: var(--font-sans); font-size: 14px; color: var(--ink); outline: none; transition: var(--transition-elastic); margin-bottom: 1.2rem; }
        .input-box:focus { border-color: var(--warm); box-shadow: 0 4px 20px rgba(160,120,70,0.08); }
        button { width: 100%; padding: 12px; border-radius: 24px; font-family: var(--font-sans); font-weight: 600; font-size: 14px; cursor: pointer; transition: var(--transition-elastic); letter-spacing: 0.03em; outline: none; }
        .btn-process { background: var(--ink); color: var(--text-inverse); border: none; margin-bottom: 1.5rem; display: flex; justify-content: center; align-items: center; gap: 8px; }
        .action-section { display: flex; flex-direction: column; gap: 0.75rem; opacity: 0.5; transition: opacity 0.3s ease; pointer-events: none; }
        .action-section.unlocked { opacity: 1; pointer-events: auto; }
        button.btn-download { background: var(--accent-cocoa); color: var(--text-inverse); border: none; }
        button.btn-copy { background: transparent; color: var(--accent-cocoa); border: 1.5px solid var(--accent-cocoa); }
        .footer-links { display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; border-top: 1px dashed var(--cream3); padding-top: 1rem; }
        .admin-link { font-size: 12px; color: var(--text-muted); text-decoration: none; font-family: var(--font-sans); }
        .ui-watermark { font-size: 12px; font-family: var(--font-sans); color: var(--text-muted); text-decoration: none; }
        .popup-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(30, 26, 21, 0.4); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 2000; opacity: 0; pointer-events: none; transition: opacity 0.2s ease; }
        .popup-overlay.active { opacity: 1; pointer-events: auto; }
        .popup-card { background: var(--bg-surface); padding: 2rem; border-radius: var(--radius); box-shadow: var(--shadow-md); border: 1px solid var(--cream2); text-align: center; max-width: 400px; width: 85%; transform: scale(0.9); transition: var(--transition-elastic); }
        .popup-overlay.active .popup-card { transform: scale(1); }
        .popup-title { font-family: var(--font-serif); font-size: 1.3rem; margin-bottom: 0.5rem; color: var(--ink); }
        .popup-text { font-family: var(--font-sans); font-size: 14px; color: var(--ink2); margin-bottom: 1.5rem; line-height: 1.5; }
        .popup-btn { padding: 10px 30px; background: var(--accent-cocoa); color: var(--text-inverse); border: none; border-radius: 20px; cursor: pointer; font-size: 13px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>📥 YouTube TXT Downloader</h1>
        <p class="subtitle">Premium Clean Transcript Exporter</p>
        <div class="key-status-badge" id="key-tracker">Active Key: System Ready <br><small style="opacity:0.8;">Waiting for prompt sequence...</small></div>
        <input type="url" id="youtube_url" class="input-box" placeholder="Paste YouTube link here..." required>
        <button class="btn-process" id="btn-process" onclick="processYouTubeLink()">⚙️ Process YouTube Link</button>
        <div class="action-section" id="action-section">
          <button class="btn-download" id="btn-download" onclick="downloadTextFile()">Download .txt File</button>
          <button class="btn-copy" id="btn-copy" onclick="copyPromptWithTranscript()">✨ Copy with Intelligent Prompt</button>
        </div>
        <div class="footer-links">
          <a href="/admin" class="admin-link">⚙️ Configuration Panel</a>
          <a href="https://pavnxet.github.io/" target="_blank" class="ui-watermark">Made with 💖 by Pavnxet</a>
        </div>
      </div>
      <div class="popup-overlay" id="popup-overlay">
        <div class="popup-card">
          <h2 class="popup-title" id="popup-title">Notification</h2>
          <p class="popup-text" id="popup-text">Message goes here.</p>
          <button class="popup-btn" onclick="closePopupModal()">OK</button>
        </div>
      </div>
      <script>
        let globalProcessedTranscript = "";
        let globalVideoId = null;
        const clientSidePrompt = \`${NOTE_PROMPT}\`;

        function getVid(url) {
          url = url.trim();
          const regExp = /^.*(?:(?:youtu\\.be\\/|v\\/|vi\\/|u\\/\\w\\/|embed\\/|shorts\\/|live\\/)|(?:(?:watch)?\\?v(?:i)?=([^\\&\\?]*)|\\&v(?:i)?=([^\\&\\?]*)))([^#\\&\\?]*)/;
          const match = url.match(regExp);
          
          if (match) {
            if (match[1]) return match[1];
            if (match[2]) return match[2];
            
            const pathParts = url.split(/[?#]/)[0].split('/');
            const lastPart = pathParts[pathParts.length - 1];
            if (lastPart && lastPart.length === 11) return lastPart;
          }
          return null;
        }

        function triggerPopup(title, text) {
          document.getElementById('popup-title').innerText = title;
          document.getElementById('popup-text').innerText = text;
          document.getElementById('popup-overlay').classList.add('active');
        }
        function closePopupModal() { document.getElementById('popup-overlay').classList.remove('active'); }
        async function processYouTubeLink() {
          const urlInput = document.getElementById('youtube_url');
          const btnProcess = document.getElementById('btn-process');
          const actionSection = document.getElementById('action-section');
          const keyTracker = document.getElementById('key-tracker');
          
          globalVideoId = getVid(urlInput.value.trim());
          if (!globalVideoId) {
            triggerPopup('❌ Error', 'कृपया एक मान्य यूट्यूब वीडियो या लाइव स्ट्रीम का लिंक पेस्ट करें।');
            return;
          }
          
          btnProcess.innerText = 'Processing Video...'; btnProcess.disabled = true;
          try {
            const formData = new FormData();
            formData.append('youtube_url', urlInput.value.trim());
            const response = await fetch('/process', { method: 'POST', body: formData });
            if (!response.ok) { triggerPopup('❌ Failed', 'Error: ' + await response.text()); return; }
            const activeKeyNum = response.headers.get("X-Active-Key-Index") || "Unknown";
            const leftCredits = response.headers.get("X-Active-Key-Credits") || "N/A";
            keyTracker.innerHTML = "Active Vault Slot: <b>#" + activeKeyNum + "</b><br><span style='color:#2e7d32; font-size:11px;'>📊 Remaining Credits: " + leftCredits + "</span>";
            globalProcessedTranscript = await response.text();
            triggerPopup('🎉 Success', 'प्रोसेस सफल! Slot #' + activeKeyNum + ' का उपयोग किया गया है (बचे हुए क्रेडिट: ' + leftCredits + ')');
            actionSection.classList.add('unlocked');
          } catch (err) { triggerPopup('❌ System Error', err.message); }
          finally { btnProcess.innerText = '⚙️ Process YouTube Link'; btnProcess.disabled = false; }
        }
        function downloadTextFile() {
          const blob = new Blob([globalProcessedTranscript], { type: 'text/plain;charset=utf-8' });
          const dlUrl = window.URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = dlUrl; a.download = 'youtube-' + (globalVideoId || 'video') + '.txt';
          document.body.appendChild(a); a.click(); a.remove();
        }
        async function copyPromptWithTranscript() {
          const combinedPayload = clientSidePrompt + "\\n\\n=========================================\\nINPUT TRANSCRIPT CONTENT:\\n=========================================\\n" + globalProcessedTranscript;
          try {
            await navigator.clipboard.writeText(combinedPayload);
            triggerPopup('✨ Clipboard Copied', 'क्लिपबोर्ड पर कॉपी हो गया है!');
          } catch (err) { triggerPopup('❌ Copy Failed', err.message); }
        }
      </script>
    </body>
    </html>
  `;
}

function getAdminForm() {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Premium Multi-Key Console</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600&family=Outfit:wght@400;600&family=Lora:wght@500&display=swap" rel="stylesheet">
      <style>
        ${getCSSVariables()}
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background-color: var(--bg-primary); color: var(--ink2); font-family: var(--font-primary); display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 12px; }
        .card { background: var(--bg-surface); padding: 2rem 1.5rem; border-radius: var(--radius); box-shadow: var(--shadow); transition: var(--transition-elastic); width: 100%; max-width: 650px; border: 1px solid var(--cream2); }
        h1 { font-family: var(--font-serif); font-weight: 500; font-size: 1.8rem; margin-bottom: 0.5rem; color: var(--ink); text-align: center; }
        p.subtitle { font-family: var(--font-sans); font-size: 13px; color: var(--text-muted); text-align: center; margin-bottom: 1.5rem; }
        .input-box { width: 100%; padding: 12px 18px; background: var(--bg-surface); border: 1.5px solid var(--cream3); border-radius: 24px; font-family: var(--font-sans); font-size: 14px; color: var(--ink); outline: none; transition: var(--transition-elastic); margin-bottom: 1.2rem; }
        .dialogue-box { background: var(--bg-inner); border-radius: var(--radius); padding: 1.2rem; border: 1px dashed var(--accent-cocoa); margin-top: 1.5rem; display: none; animation: fadeIn 0.3s ease-in-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .dialogue-box h3 { font-family: var(--font-serif); font-size: 1.1rem; color: var(--ink); margin-bottom: 1rem; border-bottom: 1px dashed var(--cream3); padding-bottom: 0.5rem; }
        .key-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 0.75rem; background: var(--bg-surface); padding: 10px 14px; border-radius: 20px; border: 1px solid var(--cream2); transition: border-color 0.2s; }
        .key-row.forced-active { border-color: #2e7d32; background: #f1f8e9; }
        .key-num { font-family: var(--font-sans); font-weight: 600; font-size: 13px; color: var(--accent); width: 20px; text-align: center; }
        .field-key { flex: 2; min-width: 140px; padding: 8px 12px; border: 1px solid var(--cream3); border-radius: 20px; font-size: 13px; outline: none; font-family: monospace; width: 100%; }
        .field-credits { flex: 0.6; min-width: 65px; padding: 8px 10px; border: 1px solid var(--cream3); border-radius: 20px; font-size: 13px; text-align: center; outline: none; font-family: var(--font-sans); width: 100%; }
        .btn-set-active { display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 20px; border: 1px solid var(--cream3); font-size: 11px; font-family: var(--font-sans); font-weight: 600; background: var(--bg-surface); cursor: pointer; transition: var(--transition-elastic); color: var(--text-muted); }
        .btn-set-active.active { background: #2e7d32; color: #fff; border-color: #2e7d32; }
        .action-group { display: flex; gap: 6px; align-items: center; margin-left: auto; }
        .btn-action { padding: 8px 12px; border-radius: 20px; border: none; font-size: 13px; font-family: var(--font-sans); font-weight: 600; cursor: pointer; transition: var(--transition-elastic); display: inline-flex; align-items: center; justify-content: center; }
        .btn-copy { background: var(--cream2); color: var(--ink2); }
        .btn-copy:hover { background: var(--cream3); }
        .btn-remove { background: #fce8e6; color: #a51d24; }
        .btn-remove:hover { background: #f9d3cf; }
        .control-btns { display: flex; flex-direction: column; gap: 10px; margin-top: 1.2rem; }
        .btn-main { width: 100%; padding: 11px; border-radius: 24px; font-family: var(--font-sans); font-weight: 600; font-size: 13px; cursor: pointer; border: none; transition: var(--transition-elastic); text-align: center; }
        .btn-add { background: transparent; border: 1.5px dashed var(--accent-cocoa); color: var(--accent-cocoa); }
        .btn-add:hover { background: var(--cream2); }
        .btn-save { background: var(--ink); color: var(--text-inverse); }
        .btn-save:hover { background: var(--ink2); }
        .footer-links { display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; border-top: 1px dashed var(--cream3); padding-top: 1rem; font-size: 12px; }
        .back-link { color: var(--accent-cocoa); text-decoration: none; font-family: var(--font-sans); font-weight: 600; }
        .ui-watermark { font-family: var(--font-sans); color: var(--text-muted); text-decoration: none; }
        @media (max-width: 480px) {
          .card { padding: 1.5rem 1rem; margin: 4px; }
          h1 { font-size: 1.4rem; }
          .key-row { padding: 12px 10px; gap: 8px; border-radius: 14px; }
          .field-key { flex: 1 1 100%; order: 2; } 
          .field-credits { flex: 1; order: 3; max-width: 80px; } 
          .btn-set-active { order: 4; }
          .action-group { order: 5; margin-left: auto; } 
          .key-num { order: 1; } 
          .dialogue-box { padding: 0.8rem; }
        }
        @media (min-width: 481px) {
          .control-btns { flex-direction: row; }
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>⚙️ Multi-Key Vault</h1>
        <p class="subtitle">Securely isolate, store and track multiple API credentials</p>
        <input type="password" id="admin_password" class="input-box" placeholder="Enter Secure Password to Unlock Console" required>
        <button id="btn-unlock" class="btn-save" style="width:100%; padding:12px; border-radius:24px;" onclick="unlockAndLoadDashboard()">🔓 Unlock Cluster Vault</button>
        <div class="dialogue-box" id="vault-dialogue">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:8px;">
            <h3 style="margin:0; border:none; padding:0;">API Key Pool Configurations</h3>
            <button class="btn-set-active" id="btn-auto-rotate" onclick="setForcedActiveIndex('auto')" style="font-size:12px; padding:6px 12px;">🔄 Auto-Rotation Mode</button>
          </div>
          <div id="keys-container"></div>
          <div class="control-btns">
            <button class="btn-main btn-add" onclick="addNewKeyRow()">➕ Add New Key Slot</button>
            <button class="btn-main btn-save" id="btn-save-all" onclick="saveAllKeysToKV()">💾 Save Vault Matrix</button>
          </div>
        </div>
        <div class="footer-links">
          <a href="/" class="back-link">← Return to App</a>
          <a href="https://pavnxet.github.io/" target="_blank" class="ui-watermark">Protected by Pavnxet</a>
        </div>
      </div>
      <script>
        let clientSideMaskedArray = [];
        let currentForcedActiveIndex = "auto";
        async function unlockAndLoadDashboard() {
          const pwd = document.getElementById('admin_password').value;
          const btnUnlock = document.getElementById('btn-unlock');
          if(!pwd) { alert('Password डालना अनिवार्य है!'); return; }
          btnUnlock.innerText = 'Verifying Authenticity...';
          try {
            const formData = new FormData();
            formData.append('admin_password', pwd);
            const response = await fetch('/admin/fetch-keys', { method: 'POST', body: formData });
            if(response.status === 401) { alert('❌ Unauthorized: ग़लत पासवर्ड!'); return; }
            if(response.status === 500) { alert('❌ Server Error: Cloudflare में ADMIN_PASSWORD SET नहीं है!'); return; }
            const payload = await response.json();
            clientSideMaskedArray = payload.keys;
            currentForcedActiveIndex = payload.forcedActiveIndex;
            document.getElementById('vault-dialogue').style.display = 'block';
            document.getElementById('admin_password').disabled = true;
            btnUnlock.style.display = 'none';
            renderKeyInterface();
          } catch(err) { alert('Error loading vault: ' + err.message); }
          finally { btnUnlock.innerText = '🔓 Unlock Cluster Vault'; }
        }
        function renderKeyInterface() {
          const container = document.getElementById('keys-container');
          container.innerHTML = '';
          const autoBtn = document.getElementById('btn-auto-rotate');
          if(currentForcedActiveIndex === "auto") {
            autoBtn.classList.add('active');
            autoBtn.innerText = "🔄 Auto-Rotation: ON";
          } else {
            autoBtn.classList.remove('active');
            autoBtn.innerText = "🔄 Switch to Auto Mode";
          }
          if(clientSideMaskedArray.length === 0) {
            container.innerHTML = '<p style="font-size:13px; color:var(--text-muted); text-align:center; padding:10px;">No active slots found.</p>';
            return;
          }
          clientSideMaskedArray.forEach((item, index) => {
            const row = document.createElement('div');
            const isForced = currentForcedActiveIndex === index.toString();
            row.className = 'key-row' + (isForced ? ' forced-active' : '');
            const isNewSlot = item.isNew;
            const inputFieldHTML = isNewSlot 
              ? \`<input type="text" class="field-key" value="\${item.key}" placeholder="Paste Live Token Here" onchange="updateLocalField(\${index}, 'key', this.value)">\`
              : \`<input type="text" class="field-key" value="\${item.maskedKey}" readonly style="background:var(--cream2); color:var(--text-muted); cursor:not-allowed;" title="Protected by Server Scrubbing">\`;
            row.innerHTML = \`
              <div class="key-num">\${index + 1}</div>
              \${inputFieldHTML}
              <input type="number" class="field-credits" value="\${item.credits}" placeholder="Credits" onchange="updateLocalField(\${index}, 'credits', this.value)">
              <button class="btn-set-active \${isForced ? 'active' : ''}" onclick="setForcedActiveIndex('\${index}')">
                \${isForced ? '⚡ Active' : 'Make Active'}
              </button>
              <div class="action-group">
                <button class="btn-action btn-copy" \${isNewSlot ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} onclick="copyKeyFromServer(\${index})">📋</button>
                <button class="btn-action btn-remove" onclick="removeKeyRow(\${index})">✕</button>
              </div>
            \`;
            container.appendChild(row);
          });
        }
        function setForcedActiveIndex(idxStr) { currentForcedActiveIndex = idxStr; renderKeyInterface(); }
        function updateLocalField(index, field, value) { clientSideMaskedArray[index][field] = value.trim(); }
        
        // 🛡️ FIX: ब्राउज़र क्रैश एरर को रोकने के लिए 'self.crypto.randomUUID()' या फ़ॉलबैक यूज़ किया गया है
        function addNewKeyRow() { 
          let newId = '';
          try {
            newId = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : 'id-' + Date.now();
          } catch(e) {
            newId = 'id-' + Math.random().toString(36).substring(2, 11);
          }
          clientSideMaskedArray.push({ id: newId, key: '', credits: '100', isNew: true }); 
          renderKeyInterface(); 
        }
        
        function removeKeyRow(index) {
          if(confirm('क्या आप सच में इस चाबी के स्लॉट को हटाना चाहते हैं?')) {
            if(currentForcedActiveIndex === index.toString()) { currentForcedActiveIndex = "auto"; }
            clientSideMaskedArray.splice(index, 1);
            renderKeyInterface();
          }
        }
        async function copyKeyFromServer(index) {
          const pwd = document.getElementById('admin_password').value;
          const formData = new FormData();
          formData.append('admin_password', pwd);
          formData.append('index', index);
          try {
            const response = await fetch('/admin/reveal-key', { method: 'POST', body: formData });
            if(response.ok) {
              const realToken = await response.text();
              await navigator.clipboard.writeText(realToken);
              alert('🔑 Key #' + (index + 1) + ' सुरक्षित रूप से क्लिपबोर्ड पर कॉपी हो गई!');
            } else { alert('Fetch failed. Token cannot be decrypted.'); }
          } catch(err) { alert('Error securely copying key.'); }
        }
        async function saveAllKeysToKV() {
          const pwd = document.getElementById('admin_password').value;
          const btnSave = document.getElementById('btn-save-all');
          btnSave.innerText = 'Syncing Vault Matrix...';
          try {
            const formData = new FormData();
            formData.append('admin_password', pwd);
            formData.append('keys_json', JSON.stringify(clientSideMaskedArray));
            formData.append('forced_active_index', currentForcedActiveIndex);
            const response = await fetch('/admin/update-keys', { method: 'POST', body: formData });
            if(response.ok) {
              alert(await response.text());
              const refreshForm = new FormData();
              refreshForm.append('admin_password', pwd);
              const refreshRes = await fetch('/admin/fetch-keys', { method: 'POST', body: refreshForm });
              const payload = await refreshRes.json();
              clientSideMaskedArray = payload.keys;
              currentForcedActiveIndex = payload.forcedActiveIndex;
              renderKeyInterface();
            } else { alert('Sync Failed: ' + await response.text()); }
          } catch(err) { alert('Matrix sync network error: ' + err.message); }
          finally { btnSave.innerText = '💾 Save Vault Matrix'; }
        }
      </script>
    </body>
    </html>
  `;
}
