// ローカル開発サーバー
// usage: node server.js
// http://localhost:3000 でアクセス

const http = require("http");
const fs = require("fs");
const path = require("path");

// .env 読み込み
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const val = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const analyzeHandler = require("./api/analyze");
const { analyzeLocal } = require("./api/analyze");

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

// --- ボディ読み取りユーティリティ ---
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

// --- Vercel互換の res ラッパー ---
function wrapRes(res) {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) {
      res.writeHead(this.statusCode, {
        ...this.headers,
        "Content-Type": "application/json; charset=utf-8"
      });
      res.end(JSON.stringify(data));
    },
    end() {
      res.writeHead(this.statusCode, this.headers);
      res.end();
    }
  };
}

// --- LINE Messaging API 返信 ---
async function replyToLine(replyToken, messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error("[LINE] LINE_CHANNEL_ACCESS_TOKEN が設定されていません");
    return;
  }
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ replyToken, messages })
  });
  if (!response.ok) {
    const errBody = await response.text();
    console.error("[LINE] reply error:", response.status, errBody);
  }
}

// --- スコアから絵文字を選択 ---
function scoreEmoji(score) {
  if (score >= 80) return "✅";
  if (score >= 60) return "⚠️";
  if (score >= 40) return "🔶";
  return "🚨";
}

// ============================================================
// HTTP サーバー
// ============================================================
const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  let parsed = {};
  try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }

  // --- POST /api/analyze（既存: Vercel互換ハンドラ） ---
  if (req.url === "/api/analyze") {
    req.body = parsed;
    const fakeRes = wrapRes(res);
    try {
      await analyzeHandler(req, fakeRes);
    } catch (err) {
      console.error("Handler error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
    return;
  }

  // --- POST /analyze（新: 軽量API） ---
  if (req.url === "/analyze" && req.method === "POST") {
    const { text, mbti } = parsed;

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "text は必須です" }));
      return;
    }
    const targetMbti = (mbti || "INFP").toUpperCase();
    if (!/^[EI][SN][TF][JP]$/.test(targetMbti)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "mbti は有効なMBTIタイプ（例: INFP）を指定してください" }));
      return;
    }

    const result = analyzeLocal(text.trim(), targetMbti);
    const response = {
      score: result.score,
      reason: result.scoreReason,
      categories: result.ngWords.map(nw => nw.keyword)
    };

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(response));
    return;
  }

  // --- POST /webhook（LINE Bot） ---
  if (req.url === "/webhook" && req.method === "POST") {
    // LINE は即座に 200 を返さないとリトライしてくるため、先に返す
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));

    const events = parsed.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const userText = event.message.text;
      const replyToken = event.replyToken;

      console.log(`[LINE] received: "${userText}"`);

      const result = analyzeLocal(userText, "INFP");
      const emoji = scoreEmoji(result.score);
      const detected = result.ngWords.length > 0
        ? result.ngWords.map(nw => `・${nw.keyword}（${nw.reason}）`).join("\n")
        : "なし";
      const reasons = result.scoreReason.join("\n");

      const replyText =
        `${emoji} 安全スコア: ${result.score}/100\n` +
        `\n` +
        `【検出された表現】\n${detected}\n` +
        `\n` +
        `【判定理由】\n${reasons}\n` +
        `\n` +
        `【改善案】\n${result.improved}`;

      await replyToLine(replyToken, [{ type: "text", text: replyText }]);
    }
    return;
  }

  // --- CORS preflight ---
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  // --- 静的ファイル配信 ---
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log("");
  console.log("  MBTI 地雷ワードチェッカー");
  console.log(`  http://localhost:${PORT}`);
  console.log("");
  console.log(`  API endpoints:`);
  console.log(`    POST /api/analyze  — 既存UI向け（Vercel互換）`);
  console.log(`    POST /analyze      — 軽量API { text, mbti } → { score, reason, categories }`);
  console.log(`    POST /webhook      — LINE Bot Webhook`);
  console.log("");
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes("xxx")) {
    console.log("  [!] ANTHROPIC_API_KEY 未設定 → ローカル判定モードで動作");
    console.log("");
  }
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.log("  [!] LINE_CHANNEL_ACCESS_TOKEN 未設定 → /webhook は応答のみ（返信不可）");
    console.log("");
  }
});
