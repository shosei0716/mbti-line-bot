// api/webhook.js — Vercel Serverless Function: LINE Bot Webhook（会話型フロー）
// POST /api/webhook でLINEからのイベントを受け取り、analyzeLocal で判定して返信する
//
// フロー:
//   「診断」送信 → MBTIタイプ入力待ち → 文章入力待ち → 判定結果返信

import { analyzeLocal } from "./analyze.js";

// --- ユーザー状態管理（インメモリ） ---
const userStates = {};

function riskLabel(risk) {
  if (risk >= 60) return { emoji: "🔴", label: "地雷" };
  if (risk >= 30) return { emoji: "🟠", label: "危険" };
  if (risk >= 10) return { emoji: "🟡", label: "注意" };
  return { emoji: "🟢", label: "安全" };
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
  const risk = 100 - result.score;
  const { emoji, label } = riskLabel(risk);
  const reasons = result.scoreReason.join("\n");
  const sep = "━━━━━━━━━━━━";

  return (
    `${sep}\n` +
    `⚠️ 地雷リスク：${risk}%（${emoji} ${label}）\n` +
    `${sep}\n` +
    `\n` +
    `🧠 理由：\n${reasons}\n` +
    `\n` +
    `💡 改善案：\n${result.improved}`
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

    // --- 「診断」or「診断を始める」でフロー開始 ---
    if (userText === "診断" || userText === "診断を始める") {
      userStates[userId] = { step: "waiting_mbti" };
      const mbtiTypes = [
        "INFP", "ENFP", "INFJ", "ENFJ",
        "INTJ", "ENTJ", "INTP", "ENTP",
        "ISFP", "ESFP", "ISTP", "ESTP",
        "ISFJ", "ESFJ", "ISTJ", "ESTJ",
      ];
      await replyToLine(replyToken, [
        {
          type: "text",
          text: "相手のMBTIを選んでください",
          quickReply: {
            items: mbtiTypes.map((t) => ({
              type: "action",
              action: { type: "message", label: t, text: t },
            })),
          },
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
        {
          type: "text",
          text: formatResult(result),
          quickReply: {
            items: [
              {
                type: "action",
                action: {
                  type: "message",
                  label: "もう一度診断する",
                  text: "診断を始める",
                },
              },
            ],
          },
        },
      ]);
      continue;
    }

    // --- フロー外のメッセージ → Quick Reply で案内 ---
    await replyToLine(replyToken, [
      {
        type: "text",
        text: "🔍 MBTI地雷診断を始めますか？",
        quickReply: {
          items: [
            {
              type: "action",
              action: {
                type: "message",
                label: "診断を始める",
                text: "診断を始める",
              },
            },
          ],
        },
      },
    ]);
  }

  return res.status(200).json({ ok: true });
}
