// api/webhook.js — Vercel Serverless Function: LINE Bot Webhook（会話型フロー）
// POST /api/webhook でLINEからのイベントを受け取り、analyzeLocal で判定して返信する
//
// フロー:
//   「診断」送信 → MBTIタイプ入力待ち → 文章入力待ち → 判定結果返信

import { analyzeLocal } from "./analyze.js";

// --- ユーザー状態管理（インメモリ） ---
const userStates = {};

function scoreEmoji(score) {
  if (score >= 80) return "✅";
  if (score >= 60) return "⚠️";
  if (score >= 40) return "🔶";
  return "🚨";
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

function formatResult(result) {
  const emoji = scoreEmoji(result.score);
  const detected =
    result.ngWords.length > 0
      ? result.ngWords.map((nw) => `・${nw.keyword}（${nw.reason}）`).join("\n")
      : "なし";
  const reasons = result.scoreReason.join("\n");

  return (
    `${emoji} 安全スコア: ${result.score}/100\n` +
    `\n` +
    `【検出された表現】\n${detected}\n` +
    `\n` +
    `【判定理由】\n${reasons}\n` +
    `\n` +
    `【改善案】\n${result.improved}`
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const events = req.body?.events || [];

  for (const event of events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;

    const userId = event.source?.userId;
    if (!userId) continue;

    const userText = event.message.text.trim();
    const replyToken = event.replyToken;
    const state = userStates[userId];

    console.log(`[LINE] userId=${userId} text="${userText}" step=${state?.step || "none"}`);

    // --- 「診断」でフロー開始 ---
    if (userText === "診断") {
      userStates[userId] = { step: "waiting_mbti" };
      await replyToLine(replyToken, [
        {
          type: "text",
          text: "MBTIタイプを入力してください（例: INFP, ESTJ）",
        },
      ]);
      continue;
    }

    // --- MBTI入力待ち ---
    if (state?.step === "waiting_mbti") {
      const mbti = userText.toUpperCase();
      if (!/^[EI][SN][TF][JP]$/.test(mbti)) {
        await replyToLine(replyToken, [
          {
            type: "text",
            text: "有効なMBTIタイプを入力してください（例: INFP, ESTJ）",
          },
        ]);
        continue;
      }
      userStates[userId] = { step: "waiting_text", mbti };
      await replyToLine(replyToken, [
        {
          type: "text",
          text: `${mbti} ですね！\nチェックしたい文章を送ってください。`,
        },
      ]);
      continue;
    }

    // --- 文章入力待ち → 判定実行 ---
    if (state?.step === "waiting_text") {
      const result = analyzeLocal(userText, state.mbti);
      delete userStates[userId];
      await replyToLine(replyToken, [
        { type: "text", text: formatResult(result) },
      ]);
      continue;
    }

    // --- フロー外のメッセージ ---
    await replyToLine(replyToken, [
      {
        type: "text",
        text: "「診断」と送ると、MBTI地雷ワードチェックを開始します。",
      },
    ]);
  }

  return res.status(200).json({ ok: true });
}
