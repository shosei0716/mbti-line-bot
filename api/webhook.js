// api/webhook.js — Vercel Serverless Function: LINE Bot Webhook
// POST /api/webhook でLINEからのイベントを受け取り、analyzeLocal で判定して返信する

import { analyzeLocal } from "./analyze.js";

function scoreEmoji(score) {
  if (score >= 80) return "\u2705";
  if (score >= 60) return "\u26A0\uFE0F";
  if (score >= 40) return "\uD83D\uDD36";
  return "\uD83D\uDEA8";
}

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
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!response.ok) {
    const errBody = await response.text();
    console.error("[LINE] reply error:", response.status, errBody);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const events = req.body?.events || [];

  for (const event of events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;

    const userText = event.message.text;
    const replyToken = event.replyToken;

    console.log(`[LINE] received: "${userText}"`);

    const result = analyzeLocal(userText, "INFP");
    const emoji = scoreEmoji(result.score);
    const detected =
      result.ngWords.length > 0
        ? result.ngWords.map((nw) => `\u30FB${nw.keyword}\uFF08${nw.reason}\uFF09`).join("\n")
        : "\u306A\u3057";
    const reasons = result.scoreReason.join("\n");

    const replyText =
      `${emoji} \u5B89\u5168\u30B9\u30B3\u30A2: ${result.score}/100\n` +
      `\n` +
      `\u3010\u691C\u51FA\u3055\u308C\u305F\u8868\u73FE\u3011\n${detected}\n` +
      `\n` +
      `\u3010\u5224\u5B9A\u7406\u7531\u3011\n${reasons}\n` +
      `\n` +
      `\u3010\u6539\u5584\u6848\u3011\n${result.improved}`;

    await replyToLine(replyToken, [{ type: "text", text: replyText }]);
  }

  return res.status(200).json({ ok: true });
}
