// /api/analyze.js
// Vercel Serverless Function — MBTI 地雷ワード解析
// Claude API (Anthropic) を使用してテキストを解析する
// APIキー未設定時はローカルモック判定にフォールバック
//
// 環境変数:
//   ANTHROPIC_API_KEY — Anthropic API キー
//
// future: LINE webhook integration

module.exports = async function handler(req, res) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // --- 入力バリデーション ---
  const { text, targetMbti } = req.body || {};

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "text は必須です" });
  }
  if (!targetMbti || typeof targetMbti !== "string" || !/^[EI][SN][TF][JP]$/i.test(targetMbti)) {
    return res.status(400).json({ error: "targetMbti は有効なMBTIタイプ（例: INFP）を指定してください" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const useAI = apiKey && !apiKey.includes("xxx");

  // --- モードの分岐 ---
  if (useAI) {
    console.log("[AI mode] Claude API を呼び出します — target:", targetMbti.toUpperCase());
    return handleClaudeAPI(req, res, text.trim(), targetMbti.toUpperCase(), apiKey);
  } else {
    console.log("[mock mode] ローカル判定 — target:", targetMbti.toUpperCase());
    const result = analyzeLocal(text.trim(), targetMbti.toUpperCase());
    return res.status(200).json(result);
  }
}

// ============================================================
// Claude API モード
// ============================================================
async function handleClaudeAPI(req, res, text, targetMbti, apiKey) {
  const systemPrompt = `あなたはMBTI性格診断の専門家です。
ユーザーが入力した文章を、相手のMBTIタイプの観点から分析し、
相手にとって「地雷」になりうる表現（NGワード）を検出してください。

以下のJSON形式のみで回答してください。それ以外のテキストは出力しないでください。

{
  "score": <0〜100の安全スコア。100が完全に安全、0が非常に危険>,
  "scoreReason": [<スコアの根拠を1〜3文で説明する文字列の配列>],
  "ngWords": [
    {
      "keyword": "<文章中の問題のある表現（原文のまま）>",
      "reason": "<なぜこの表現がこのMBTIタイプにとって地雷なのか>",
      "mbtiTypes": ["<該当MBTIタイプ>"]
    }
  ],
  "improved": "<NGワードを改善した文章全体。改善不要の場合は元の文章をそのまま返す>"
}

判定の基準:
- 相手のMBTIタイプの核となる価値観・行動特性を否定する表現はNG
- 同調圧力、感情の強制、思考の否定、自由の制限などに注意
- 直接的な表現だけでなく、暗に否定するニュアンスも検出
- 改善案は相手の特性を肯定しつつ、伝えたい内容を維持する表現に言い換える
- NGワードが無い場合は ngWords を空配列、score を高めに設定`;

  const userMessage = `相手のMBTIタイプ: ${targetMbti}\n\n以下の文章を判定してください:\n\n${text}`;

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }]
      })
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      console.error("Claude API error:", apiRes.status, errBody);
      return res.status(502).json({ error: `AI API エラー (${apiRes.status})` });
    }

    const apiData = await apiRes.json();
    const content = apiData.content?.[0]?.text || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("Failed to parse Claude response:", content);
      return res.status(502).json({ error: "AIレスポンスの解析に失敗しました" });
    }

    const result = JSON.parse(jsonMatch[0]);
    return res.status(200).json({
      score: typeof result.score === "number" ? result.score : 50,
      scoreReason: Array.isArray(result.scoreReason) ? result.scoreReason : [],
      ngWords: Array.isArray(result.ngWords) ? result.ngWords : [],
      improved: typeof result.improved === "string" ? result.improved : text
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: "内部エラーが発生しました" });
  }
}

// ============================================================
// ローカルモック判定（心理カテゴリベース分析）
// ============================================================

// --- 心理カテゴリ定義 ---
const PSY_CATEGORIES = {
  direct_insult:          { label: "直接侮辱",           baseSeverity: 10, desc: "人格を直接攻撃する侮辱表現" },
  ideal_denial:           { label: "理想・価値観の否定", baseSeverity: 5,  desc: "相手の信念や理想を真っ向から否定する" },
  command:                { label: "命令・支配",         baseSeverity: 4,  desc: "選択の自由を奪い、服従を強いる" },
  command_soft:           { label: "柔らかい命令・圧力", baseSeverity: 3,  desc: "励ましや指示の形をとりつつ暗に行動を強制する" },
  comparison:             { label: "比較・レッテル",     baseSeverity: 4,  desc: "他者と比較して劣等感を植えつける" },
  emotional_dismiss:      { label: "感情の軽視",         baseSeverity: 5,  desc: "感情を無意味・過剰と切り捨てる" },
  identity_attack:        { label: "人格攻撃",           baseSeverity: 5,  desc: "性格や本質を否定する" },
  conformity:             { label: "同調圧力",           baseSeverity: 4,  desc: "多数派に合わせることを強要する" },
  capability_deny:        { label: "能力の否定",         baseSeverity: 4,  desc: "相手の力量や可能性を否定する" },
  freedom_restrict:       { label: "自由の制限",         baseSeverity: 3,  desc: "行動や思考の自由を制限する" },
  goodwill_reject:        { label: "善意の拒絶",         baseSeverity: 5,  desc: "善意からの行動を迷惑と退ける" },
  privacy_invade:         { label: "境界侵害",           baseSeverity: 3,  desc: "心理的な境界を無視して踏み込む" },
  past_blame:             { label: "過去の蒸し返し",     baseSeverity: 3,  desc: "過去の失敗を持ち出して攻撃する" },
  vague_criticism:        { label: "曖昧な批判",         baseSeverity: 3,  desc: "具体性のない否定で逃げ場を奪う" },
  generalization:         { label: "過度な一般化",       baseSeverity: 2,  desc: "「いつも」「絶対」で事実を歪める" },
  interrogation_pressure: { label: "詰問・追及",         baseSeverity: 5,  desc: "答えを追い詰め、繰り返しで無力感を与える" },
  passive_aggressive:     { label: "受動攻撃",           baseSeverity: 4,  desc: "間接的に相手の価値を否定する冷淡な表現" }
};

// --- MBTI別カテゴリ感受性係数（direct_insultは固定のため除外） ---
const MBTI_MULTIPLIERS = {
  INTJ: { ideal_denial: 1.2, command: 1.0, command_soft: 0.8, comparison: 1.0, emotional_dismiss: 0.6, identity_attack: 1.2, conformity: 2.0, capability_deny: 1.5, freedom_restrict: 1.5, goodwill_reject: 0.6, privacy_invade: 1.0, past_blame: 0.8, vague_criticism: 1.2, generalization: 1.0, interrogation_pressure: 0.8, passive_aggressive: 0.8 },
  INTP: { ideal_denial: 1.5, command: 1.2, command_soft: 1.0, comparison: 0.8, emotional_dismiss: 0.5, identity_attack: 1.0, conformity: 2.0, capability_deny: 1.2, freedom_restrict: 1.5, goodwill_reject: 0.5, privacy_invade: 1.2, past_blame: 0.8, vague_criticism: 1.8, generalization: 1.5, interrogation_pressure: 0.8, passive_aggressive: 0.8 },
  ENTJ: { ideal_denial: 1.0, command: 0.8, command_soft: 0.5, comparison: 1.2, emotional_dismiss: 0.5, identity_attack: 1.2, conformity: 1.0, capability_deny: 2.0, freedom_restrict: 1.2, goodwill_reject: 0.6, privacy_invade: 0.8, past_blame: 1.0, vague_criticism: 1.0, generalization: 0.8, interrogation_pressure: 0.6, passive_aggressive: 0.6 },
  ENTP: { ideal_denial: 1.2, command: 1.5, command_soft: 0.8, comparison: 0.8, emotional_dismiss: 0.5, identity_attack: 1.0, conformity: 2.0, capability_deny: 1.0, freedom_restrict: 1.8, goodwill_reject: 0.5, privacy_invade: 0.8, past_blame: 0.8, vague_criticism: 1.5, generalization: 1.2, interrogation_pressure: 0.6, passive_aggressive: 0.8 },
  INFJ: { ideal_denial: 1.5, command: 1.2, command_soft: 1.2, comparison: 1.2, emotional_dismiss: 2.0, identity_attack: 1.8, conformity: 1.0, capability_deny: 1.0, freedom_restrict: 1.0, goodwill_reject: 1.2, privacy_invade: 1.8, past_blame: 1.2, vague_criticism: 1.0, generalization: 1.2, interrogation_pressure: 1.5, passive_aggressive: 1.5 },
  INFP: { ideal_denial: 2.0, command: 1.5, command_soft: 1.5, comparison: 1.5, emotional_dismiss: 2.0, identity_attack: 1.8, conformity: 1.2, capability_deny: 1.0, freedom_restrict: 1.2, goodwill_reject: 1.0, privacy_invade: 1.2, past_blame: 1.5, vague_criticism: 1.2, generalization: 1.0, interrogation_pressure: 1.5, passive_aggressive: 1.8 },
  ENFJ: { ideal_denial: 1.2, command: 1.0, command_soft: 1.0, comparison: 1.2, emotional_dismiss: 1.5, identity_attack: 1.5, conformity: 0.8, capability_deny: 1.0, freedom_restrict: 0.8, goodwill_reject: 2.0, privacy_invade: 1.0, past_blame: 1.0, vague_criticism: 1.0, generalization: 1.0, interrogation_pressure: 1.2, passive_aggressive: 1.2 },
  ENFP: { ideal_denial: 1.8, command: 1.5, command_soft: 1.2, comparison: 1.2, emotional_dismiss: 1.5, identity_attack: 1.2, conformity: 1.5, capability_deny: 1.0, freedom_restrict: 1.8, goodwill_reject: 0.8, privacy_invade: 0.8, past_blame: 1.5, vague_criticism: 1.0, generalization: 1.0, interrogation_pressure: 1.0, passive_aggressive: 1.2 },
  ISTJ: { ideal_denial: 1.5, command: 0.6, command_soft: 0.5, comparison: 1.0, emotional_dismiss: 0.5, identity_attack: 1.2, conformity: 0.6, capability_deny: 1.5, freedom_restrict: 0.8, goodwill_reject: 0.8, privacy_invade: 1.2, past_blame: 1.0, vague_criticism: 1.5, generalization: 1.2, interrogation_pressure: 0.8, passive_aggressive: 0.6 },
  ISFJ: { ideal_denial: 1.2, command: 1.2, command_soft: 1.2, comparison: 1.5, emotional_dismiss: 1.5, identity_attack: 1.8, conformity: 0.8, capability_deny: 1.0, freedom_restrict: 0.8, goodwill_reject: 2.0, privacy_invade: 1.5, past_blame: 1.2, vague_criticism: 1.2, generalization: 1.0, interrogation_pressure: 1.5, passive_aggressive: 1.5 },
  ESTJ: { ideal_denial: 1.0, command: 0.5, command_soft: 0.5, comparison: 1.2, emotional_dismiss: 0.5, identity_attack: 1.5, conformity: 0.5, capability_deny: 1.8, freedom_restrict: 0.6, goodwill_reject: 0.8, privacy_invade: 0.8, past_blame: 1.0, vague_criticism: 1.2, generalization: 0.8, interrogation_pressure: 0.5, passive_aggressive: 0.5 },
  ESFJ: { ideal_denial: 1.0, command: 1.0, command_soft: 1.0, comparison: 1.5, emotional_dismiss: 1.5, identity_attack: 2.0, conformity: 0.6, capability_deny: 1.0, freedom_restrict: 0.8, goodwill_reject: 1.8, privacy_invade: 1.2, past_blame: 1.2, vague_criticism: 1.0, generalization: 1.0, interrogation_pressure: 1.2, passive_aggressive: 1.2 },
  ISTP: { ideal_denial: 0.8, command: 1.5, command_soft: 1.0, comparison: 0.8, emotional_dismiss: 0.5, identity_attack: 1.0, conformity: 1.5, capability_deny: 1.2, freedom_restrict: 2.0, goodwill_reject: 0.5, privacy_invade: 1.5, past_blame: 0.8, vague_criticism: 1.2, generalization: 1.0, interrogation_pressure: 0.8, passive_aggressive: 0.6 },
  ISFP: { ideal_denial: 1.5, command: 1.5, command_soft: 1.2, comparison: 1.5, emotional_dismiss: 1.8, identity_attack: 1.5, conformity: 1.2, capability_deny: 1.0, freedom_restrict: 1.5, goodwill_reject: 0.8, privacy_invade: 1.5, past_blame: 1.2, vague_criticism: 1.5, generalization: 1.0, interrogation_pressure: 1.5, passive_aggressive: 1.5 },
  ESTP: { ideal_denial: 0.8, command: 1.2, command_soft: 0.6, comparison: 1.0, emotional_dismiss: 0.5, identity_attack: 1.2, conformity: 1.2, capability_deny: 1.0, freedom_restrict: 1.8, goodwill_reject: 0.5, privacy_invade: 1.0, past_blame: 1.8, vague_criticism: 0.8, generalization: 1.0, interrogation_pressure: 0.6, passive_aggressive: 0.5 },
  ESFP: { ideal_denial: 1.0, command: 1.2, command_soft: 1.0, comparison: 1.5, emotional_dismiss: 1.5, identity_attack: 2.0, conformity: 1.0, capability_deny: 0.8, freedom_restrict: 1.5, goodwill_reject: 0.8, privacy_invade: 0.8, past_blame: 1.2, vague_criticism: 1.0, generalization: 1.0, interrogation_pressure: 1.0, passive_aggressive: 1.0 }
};

// --- カテゴリ別パターン辞書（全パターンを心理カテゴリに一元化） ---
const CATEGORY_PATTERNS = {
  ideal_denial: [
    { patterns: ["現実を見", "現実見", "現実的に", "地に足つけ", "目を覚ませ"], reason: "理想を持つこと自体を否定し、価値観の根幹を攻撃する表現です" },
    { patterns: ["理想論", "きれいごと", "絵空事", "夢ばかり", "夢物語", "机上の空論"], reason: "価値観や夢の全否定につながる危険な表現です" },
    { patterns: ["甘い", "甘えてる", "甘すぎ", "世間知らず"], reason: "優しさや理想主義を弱さとして否定する表現です" },
    { patterns: ["ダメ", "ダメだ", "ダメでしょ"], reason: "全否定的な表現は相手の自尊心を傷つけます" },
    { patterns: ["意味ある", "役に立つの", "何の得が", "無駄じゃない"], reason: "知的好奇心や取り組みの否定。実用性だけで価値を測る表現です" },
    { patterns: ["ルール通りじゃなくても", "ルールなんて", "規則は破る"], reason: "秩序や信念を軽視する表現です" },
    { patterns: ["自分のこと先に", "人の心配より", "自分を優先しろ"], reason: "他者貢献の姿勢を批判する表現です" },
    { patterns: ["夢見すぎ", "妄想", "現実離れ"], reason: "ビジョンや理想の原動力を否定する表現です" },
    { patterns: ["将来のこと考えてる", "先のこと", "将来どうする", "老後"], reason: "今を大切に生きる姿勢への批判です" },
    { patterns: ["食べていける", "稼げるの", "お金になる", "生活できる"], reason: "情熱や価値観を経済性だけで否定する表現です" },
    { patterns: ["現実的じゃない"], reason: "可能性の探究を封じる表現です" }
  ],
  command: [
    { patterns: ["感情出して", "気持ちを言って", "もっと笑って"], reason: "感情表現の強制は大きなストレスを生みます" },
    { patterns: ["早く決めて", "さっさと決め", "いつまで迷って"], reason: "熟考を軽視し、即断を強いる表現です" },
    { patterns: ["落ち着き", "落ち着け", "落ち着いて", "静かにして"], reason: "エネルギーや活力を抑圧する表現です" },
    { patterns: ["断ればいい", "NOと言え", "嫌なら断れ"], reason: "優しさゆえに断れない苦しみを理解しない発言です" },
    { patterns: ["はっきり言って", "はっきりして", "どっちなの"], reason: "控えめさを否定し、即答を強制する表現です" },
    { patterns: ["落ち着い", "冷静に", "もっとゆっくり"], reason: "即断即決のスタイルを否定する表現です" },
    { patterns: ["真面目にやって", "真剣にやれ", "遊びじゃない", "ふざけてないで"], reason: "自由な表現を抑制する命令です" }
  ],
  command_soft: [
    { patterns: ["頑張れよ", "頑張れば", "頑張りなよ", "もっと頑張"], reason: "励ましの形をとりつつ、現状の努力を否定し行動を強制するニュアンスがあります" },
    { patterns: ["ちゃんとやれ", "ちゃんとしろ", "ちゃんとして"], reason: "「ちゃんと」は曖昧な基準で行動を強制する圧力表現です" },
    { patterns: ["しろよ", "やれよ", "しなよ", "やりなよ"], reason: "柔らかい口調でも行動の強制は相手の自律性を脅かします" }
  ],
  comparison: [
    { patterns: ["リーダーぶる", "仕切りたがり", "目立ちたがり"], reason: "自然なリーダーシップを自己顕示欲と決めつける攻撃です" },
    { patterns: ["優しく言えない", "言い方きつい", "キツイ", "怖い"], reason: "コミュニケーションスタイルへの一方的な批判です" },
    { patterns: ["人の目気にし", "周り気にし", "人目を", "顔色うかがい"], reason: "周囲への配慮を批判する表現です" }
  ],
  emotional_dismiss: [
    { patterns: ["気にしすぎ", "気にするな", "気にしないで", "気にしなくていい"], reason: "繊細さを弱さとして否定する表現です" },
    { patterns: ["考えすぎ", "考え過ぎ", "深読みしすぎ"], reason: "洞察力を過剰反応と片付ける表現です" },
    { patterns: ["泣いても", "泣くな", "泣いたって", "めそめそ"], reason: "感情表現を無意味と切り捨てる表現です" },
    { patterns: ["結論は", "結局何", "要するに", "で、何が言いたい"], reason: "思考プロセスを軽視する表現です" },
    { patterns: ["でもさ、", "でも、", "だけど、", "だけどさ、", "しかし、"], reason: "逆接の多用は相手の意見を否定する印象を与えます" },
    { patterns: ["大げさ", "大げさすぎ", "オーバー", "オーバーすぎ"], reason: "感情の表出を過剰と切り捨てる表現です" },
    { patterns: ["それくらいで", "そのくらいで", "たかが", "たかだか"], reason: "感情の大きさを軽視し、感じること自体を否定します" },
    { patterns: ["落ち込むな", "凹むな", "へこむな", "くよくよするな"], reason: "ネガティブな感情を感じること自体を否定する表現です" }
  ],
  identity_attack: [
    { patterns: ["理屈っぽい", "理屈ばかり", "理屈じゃない"], reason: "論理的思考力を欠点扱いする表現です" },
    { patterns: ["冷たい", "冷たすぎ", "薄情", "ドライ"], reason: "冷静さを冷淡と決めつける表現です" },
    { patterns: ["繊細すぎ", "敏感すぎ", "打たれ弱い", "メンタル弱い"], reason: "感受性そのものを否定する人格攻撃です" },
    { patterns: ["仕切らないで", "仕切りすぎ", "出しゃばり", "でしゃばる"], reason: "自然なリーダーシップを否定する表現です" },
    { patterns: ["謙虚に", "偉そう", "上から目線", "傲慢", "何様", "威張る"], reason: "自信を傲慢と決めつける人格否定です" },
    { patterns: ["屁理屈", "理屈ばっかり", "ごちゃごちゃ言う", "ああ言えばこう言う"], reason: "議論や思考を楽しむ姿勢を全否定する表現です" },
    { patterns: ["偽善", "いい人ぶって", "ぶりっ子", "白々しい"], reason: "誠意を疑い、人格を否定する表現です" },
    { patterns: ["テンション高", "うるさい", "騒がしい", "はしゃぎすぎ"], reason: "感情の自由な表現を抑制する表現です" },
    { patterns: ["融通きかない", "融通がきかない", "頭が固い", "石頭"], reason: "一貫性と信頼性を欠点扱いする表現です" },
    { patterns: ["堅すぎ", "真面目すぎ", "堅物", "カタブツ"], reason: "誠実さを欠点として否定する表現です" },
    { patterns: ["自分の意見ないの", "意見がない", "主体性がない", "言いなり"], reason: "協調性を弱さとして批判する表現です" },
    { patterns: ["都合よく使われ", "利用されてる", "いいように使われ"], reason: "献身を利用と指摘する攻撃的な表現です" },
    { patterns: ["押し付け", "強制するな", "押しつけがましい"], reason: "指導や助けを強制と決めつける表現です" },
    { patterns: ["八方美人", "いい顔しすぎ", "誰にでもいい顔"], reason: "調和の努力を偽りと否定する表現です" },
    { patterns: ["嫌われたくない", "好かれたい", "人気取り", "媚び"], reason: "動機を疑う攻撃的な表現です" },
    { patterns: ["自分がない", "個性がない", "没個性", "流される"], reason: "協調性を個性の欠如と否定する表現です" },
    { patterns: ["優柔不断", "決められない", "迷いすぎ", "煮え切らない"], reason: "慎重さを弱点として批判する表現です" },
    { patterns: ["雑すぎ", "雑だね", "いい加減", "適当すぎ"], reason: "スピード感や自由さを雑と批判する表現です" },
    { patterns: ["空気読めてない", "KY", "場違い", "浮いてる"], reason: "社交性や自然体を否定する表現です" },
    { patterns: ["チャラい", "軽い", "軽薄", "薄っぺらい"], reason: "表面的と決めつける人格否定です" },
    { patterns: ["深みがない", "中身がない", "浅い"], reason: "人格の全否定につながる危険な表現です" }
  ],
  conformity: [
    { patterns: ["周りに合わせ", "合わせたら", "合わせろ", "合わせなよ"], reason: "独自の視点を否定し、多数派への同調を強要する表現です" },
    { patterns: ["みんなそうしてる", "普通はこう", "常識的に", "一般的には"], reason: "多数派論法で独自性を全否定する表現です" },
    { patterns: ["空気読", "場の雰囲気", "空気を"], reason: "暗黙のルールを強制する同調圧力です" },
    { patterns: ["協調性ない", "チームワーク", "みんなと一緒に", "一人で勝手に"], reason: "独立性を欠点として批判する表現です" },
    { patterns: ["普通は", "普通さ", "当然でしょ", "当然だろ"], reason: "「普通」「当然」は自分の基準を相手に押し付ける断定語です" }
  ],
  capability_deny: [
    { patterns: ["任せるのは不安", "任せられない", "心配だから"], reason: "能力への不信感を示す表現です" },
    { patterns: ["無理だと思う", "できないよ", "不可能", "どうせ無理"], reason: "可能性を否定する表現です" },
    { patterns: ["やり方が全てじゃない", "他にもやり方", "古い"], reason: "経験に基づく判断を否定する表現です" }
  ],
  freedom_restrict: [
    { patterns: ["計画的に", "計画を立てて", "行き当たりばったり", "無計画"], reason: "柔軟性を否定し、自由さを制限する表現です" },
    { patterns: ["柔軟に", "もっと柔軟", "臨機応変に", "適当でいい"], reason: "計画性を否定し、混乱を強要する表現です" },
    { patterns: ["報連相", "報告して", "連絡して", "逐一報告"], reason: "自由な行動を制限する管理的な表現です" },
    { patterns: ["後先考え", "先のこと考えて", "リスク考えろ"], reason: "行動力を軽率と決めつける表現です" },
    { patterns: ["ふざけ", "ふざけるな", "ふざけすぎ", "悪ふざけ"], reason: "楽しさを生み出す力の否定です" }
  ],
  goodwill_reject: [
    { patterns: ["お節介", "おせっかい", "余計なお世話", "頼んでない"], reason: "善意からの行動を否定する表現です" },
    { patterns: ["気を遣わなくて", "気遣い不要", "余計な心配"], reason: "気遣いを否定され、存在意義を疑わせます" }
  ],
  privacy_invade: [
    { patterns: ["本音を言", "本心は", "隠さないで", "正直に言って"], reason: "心を無理にこじ開けようとする表現です" }
  ],
  past_blame: [
    { patterns: ["飽きっぽい", "三日坊主", "続かない", "すぐ投げ出す"], reason: "多方面への興味を欠点扱いする批判です" },
    { patterns: ["途中でやめる", "どうせまた", "また飽きる"], reason: "過去の失敗を蒸し返し、成長を認めない表現です" },
    { patterns: ["反省してる", "反省しろ", "反省しな", "懲りない"], reason: "過去の失敗を蒸し返す攻撃的な表現です" }
  ],
  vague_criticism: [
    { patterns: ["ちゃんとして", "しっかりして", "だらしない", "しっかりしな", "ちゃんとしな", "もっとしっかり"], reason: "曖昧な基準の押しつけ。具体性のない批判です" },
    { patterns: ["曖昧"], reason: "控えめさを否定する表現です" }
  ],
  generalization: [
    { patterns: ["いつも", "毎回", "いっつも"], reason: "「いつも」は過度な一般化。実際には毎回ではないため反発を招きます" },
    { patterns: ["絶対", "絶対に", "必ず"], reason: "断定的な表現は相手の選択肢を奪うニュアンスがあります" }
  ],
  interrogation_pressure: [
    { patterns: ["なんで？", "なんでできない", "なぜできない", "ナンデ", "どうしてできない"], reason: "能力を疑う詰問は相手の自信を破壊します" },
    { patterns: ["何回言わせる", "何度言えば", "何回言ったら"], reason: "繰り返しの詰問は相手を追い詰め無力感を与えます" },
    { patterns: ["どうして毎回", "いつになったら"], reason: "過去の蒸し返しと詰問の複合で強い圧迫感を与えます" }
  ],
  passive_aggressive: [
    { patterns: ["期待してない", "期待しない", "期待できない"], reason: "暗に相手の能力・価値を否定する受動攻撃的な表現です" },
    { patterns: ["まあいいんじゃない", "別にいいけど", "好きにすれば", "どうでもいい"], reason: "関心の放棄を装った拒絶のメッセージです" },
    { patterns: ["別にいいよ", "ご自由に", "勝手にすれば"], reason: "投げやりな態度で相手を突き放す表現です" }
  ]
};

// --- 直接侮辱語（全MBTIに共通、固定減点） ---
const DIRECT_INSULTS = [
  { patterns: ["ばか", "バカ", "馬鹿"], category: "direct_insult", reason: "直接的な侮辱は相手の尊厳を根本から傷つけます" },
  { patterns: ["アホ", "あほ", "阿呆"], category: "direct_insult", reason: "知性を否定する侮辱表現です" },
  { patterns: ["無能", "能無し", "役立たず"], category: "direct_insult", reason: "存在価値そのものを否定する極めて攻撃的な表現です" },
  { patterns: ["死ね", "しね", "タヒね", "死んで", "死ねば"], category: "direct_insult", reason: "生存を否定する最も危険な言葉です", ultraSevere: true },
  { patterns: ["クズ", "くず", "カス", "ゴミ"], category: "direct_insult", reason: "人間としての価値を完全に否定する侮辱です" },
  { patterns: ["きもい", "キモい", "キモイ", "気持ち悪い"], category: "direct_insult", reason: "生理的嫌悪を示す深い侮辱表現です" },
  { patterns: ["うざい", "ウザい", "ウザイ"], category: "direct_insult", reason: "存在そのものを否定する攻撃的な表現です" },
  { patterns: ["お前", "てめえ", "てめぇ", "おまえ"], category: "direct_insult", reason: "人格を軽視する呼称は攻撃性を増幅させます" }
];

// --- 構造変換テーブル（命令→提案, 断定→質問, 否定→共感＋提案） ---
const TRANSFORM_RULES = {
  // 命令 → 提案
  command: [
    { match: /(.+)[しすき]ろ[。！!]?/g, replace: "$1してみるのはどうかな？" },
    { match: /(.+)しなさい[。！!]?/g, replace: "$1してみない？" },
    { match: /(.+)するな[。！!]?/g, replace: "$1しないほうがいいかもしれないけど、どう思う？" },
    { match: /やめろ/g, replace: "一度立ち止まって考えてみない？" },
    { match: /やめなさい/g, replace: "少し休んでみるのはどうかな？" },
    { match: /黙れ/g, replace: "少し落ち着いて話そう" },
    { match: /出ていけ/g, replace: "少し距離を置いて考えよう" },
    { match: /消えろ/g, replace: "お互い少し時間をおこう" },
    { match: /失せろ/g, replace: "お互い冷静になってから話そう" },
    { match: /帰れ/g, replace: "今日はここまでにしよう" },
    { match: /来るな/g, replace: "少し時間をおいてからにしよう" }
  ],
  // 断定 → 質問
  assertion: [
    { match: /絶対(.+)だ[。！!]?/g, replace: "$1かもしれないね。どう思う？" },
    { match: /(.+)に決まってる/g, replace: "$1の可能性もあるけど、他にも考えられるかな？" },
    { match: /間違いなく/g, replace: "もしかすると" },
    { match: /当然(.+)でしょ/g, replace: "$1という考え方もあるけど、あなたはどう思う？" }
  ],
  // 否定 → 共感＋提案
  denial: [
    { match: /(.+)なんて無駄/g, replace: "$1に取り組んでるんだね。もっと効果的な方法も一緒に探してみない？" },
    { match: /(.+)なんて意味ない/g, replace: "$1を頑張ってるんだね。別のアプローチも考えてみない？" },
    { match: /できるわけない/g, replace: "難しいかもしれないけど、一緒にやり方を考えてみよう" },
    { match: /無理に決まってる/g, replace: "大変そうだね。小さなステップから始めてみるのはどう？" },
    { match: /どうせ(.+)できない/g, replace: "$1は難しいかもしれないけど、まずやれることから始めてみない？" }
  ],
  // 比較 → 個別肯定
  comparison_transform: [
    { match: /(.+)を見習え/g, replace: "あなたにはあなたの強みがあるよね。$1のこういう部分は参考になるかも" },
    { match: /(.+)はできるのに/g, replace: "あなたにはあなたのペースがあるよね" },
    { match: /他の人は(.+)/g, replace: "それぞれ違うやり方があるよね。あなたはどうしたい？" }
  ]
};

// --- 入力正規化 ---
function normalizeText(text) {
  let t = text;
  // スペース除去（半角・全角）
  t = t.replace(/[\s\u3000]+/g, "");
  // 全角英数 → 半角
  t = t.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  // 半角カタカナ → 全角カタカナ
  const hankakuMap = "ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ";
  const zenkakuMap = "ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜";
  t = t.replace(/[ｦ-ﾟ]/g, (ch) => {
    const idx = hankakuMap.indexOf(ch);
    return idx >= 0 ? zenkakuMap[idx] : ch;
  });
  // 英字を小文字化
  t = t.toLowerCase();
  return t;
}

// --- 引用フィルター: 攻撃語が引用文脈かどうか判定 ---
const QUOTE_PATTERNS = ["って言われた", "と言われた", "言われたら", "って言うな", "って言われて", "と言われて"];
function isQuotedInsult(text, matchIndex) {
  const after = text.slice(matchIndex);
  for (const qp of QUOTE_PATTERNS) {
    if (after.includes(qp)) return true;
  }
  return false;
}

function analyzeLocal(text, targetMbti) {
  const multipliers = MBTI_MULTIPLIERS[targetMbti] || {};
  const found = [];
  const categoryBaseDamage = {};  // カテゴリ別: baseSeverity合計（MBTI無関係）
  const categoryMbtiDamage = {};  // カテゴリ別: baseSeverity × 倍率（MBTI適用後）
  let directInsultCount = 0;
  let hasUltraSevere = false;

  // 正規化テキストでパターンマッチ（表示は元テキストを使用）
  const normalized = normalizeText(text);

  // --- Phase 1: 直接侮辱チェック（MBTI無関係、固定減点） ---
  for (const di of DIRECT_INSULTS) {
    for (const pattern of di.patterns) {
      const idx = normalized.indexOf(pattern);
      if (idx !== -1) {
        // 引用フィルター
        if (isQuotedInsult(normalized, idx)) {
          break;
        }
        if (!found.some(f => f.keyword === pattern)) {
          const base = PSY_CATEGORIES.direct_insult.baseSeverity;
          categoryBaseDamage.direct_insult = (categoryBaseDamage.direct_insult || 0) + base;
          categoryMbtiDamage.direct_insult = (categoryMbtiDamage.direct_insult || 0) + base; // 倍率なし
          directInsultCount++;
          if (di.ultraSevere) hasUltraSevere = true;
          found.push({
            keyword: pattern,
            reason: di.reason,
            mbtiTypes: [targetMbti],
            _category: "direct_insult",
            _damage: base
          });
        }
        break;
      }
    }
  }

  // --- Phase 2: カテゴリ別パターンチェック ---
  for (const [catId, entries] of Object.entries(CATEGORY_PATTERNS)) {
    for (const entry of entries) {
      for (const pattern of entry.patterns) {
        if (normalized.includes(pattern)) {
          if (!found.some(f => f.keyword === pattern)) {
            const base = PSY_CATEGORIES[catId]?.baseSeverity || 3;
            const mult = multipliers[catId] || 1.0;
            const mbtiDamage = base * mult;
            categoryBaseDamage[catId] = (categoryBaseDamage[catId] || 0) + base;
            categoryMbtiDamage[catId] = (categoryMbtiDamage[catId] || 0) + mbtiDamage;
            found.push({
              keyword: pattern,
              reason: entry.reason,
              mbtiTypes: [targetMbti],
              _category: catId,
              _damage: mbtiDamage
            });
          }
          break; // この entry の最初のマッチで次の entry へ
        }
      }
    }
  }

  // --- トーン補正（強化版） ---
  let toneCorrection = 0;
  const toneReasons = [];

  if (/[！!]{2,}|[！!][？?]|[？?][！!]/.test(text)) {
    toneCorrection += 15;
    toneReasons.push("感嘆符・疑問符の連続が強い攻撃性・圧迫感を示しています");
  } else {
    const exclamCount = (text.match(/！|!/g) || []).length;
    if (exclamCount >= 3) {
      toneCorrection += 8;
      toneReasons.push("感嘆符の多用が心理的圧迫感を生んでいます");
    } else if (exclamCount >= 1) {
      toneCorrection += 1;
    }
  }

  if (/[？?]{3,}/.test(text)) {
    toneCorrection += 15;
    toneReasons.push("疑問符の連続が強い詰問・追及のプレッシャーを与えます");
  } else if (/[？?]{2,}/.test(text)) {
    toneCorrection += 8;
    toneReasons.push("連続する疑問符が詰問・追及のプレッシャーを与えます");
  }

  if (/ナンデ|マジデ|フツウ|ホント[ニ二]|イミ[ワハ]カ|ダカラ|ムリ[ダだ]|ウザ|キモ/.test(normalized)) {
    toneCorrection += 15;
    toneReasons.push("カタカナ強調が威圧的・嘲笑的なトーンを生んでいます");
  }

  if (/[しすき]ろ[。！!]?$|しなさい|するな|やめろ|やめなさい|黙れ|出ていけ|消えろ|どけ|失せろ|帰れ|来るな/m.test(normalized)) {
    toneCorrection += 10;
    toneReasons.push("命令口調は相手の自律性を脅かし、心理的安全性を破壊します");
  }

  const negCount = (normalized.match(/ない|ません|じゃない|ではない|できない|しない/g) || []).length;
  if (negCount >= 3) {
    toneCorrection += 5;
    toneReasons.push("否定表現の蓄積が無力感・絶望感を誘発します");
  }

  // --- 圧力補正 ---
  let pressureCorrection = 0;
  const pressureReasons = [];

  if (normalized.length > 200) {
    pressureCorrection += 2;
    pressureReasons.push("長文は受け手に処理の負担を与え、逃げ場のなさを感じさせます");
  }

  if (normalized.length < 5 && normalized.length > 0) {
    pressureCorrection += 3;
    pressureReasons.push("極端に短い言葉は突き放しや拒絶のシグナルとして受け取られます");
  }

  const uniqueCats = Object.keys(categoryMbtiDamage);
  if (uniqueCats.length >= 3) {
    pressureCorrection += 5;
    pressureReasons.push("複数の心理的攻撃が重なり、相手の防御機能を突破する危険があります");
  }

  // --- スコア算出（非線形 + 20点制限） ---
  const totalBaseDamage = Object.values(categoryBaseDamage).reduce((a, b) => a + b, 0);
  const totalMbtiDamage = Object.values(categoryMbtiDamage).reduce((a, b) => a + b, 0);

  // 基準スコア（MBTI無関係）
  const baseDeduction = Math.pow(totalBaseDamage, 1.3) * 2.0 + toneCorrection + pressureCorrection;
  const baseScore = Math.max(0, Math.min(100, Math.round(100 - baseDeduction)));

  // MBTI倍率適用後スコア
  const mbtiDeduction = Math.pow(totalMbtiDamage, 1.3) * 2.0 + toneCorrection + pressureCorrection;
  const mbtiRawScore = Math.max(0, Math.min(100, Math.round(100 - mbtiDeduction)));

  // 基準スコアから±10でクランプ（全タイプで最大20点差）
  let score = Math.max(0, Math.min(100, Math.max(baseScore - 10, Math.min(baseScore + 10, mbtiRawScore))));

  // direct_insult: 検出数に応じてスコア上限（MBTI無関係、固定）
  if (hasUltraSevere) {
    score = Math.min(score, 5);
  } else if (directInsultCount > 0) {
    const insultCap = Math.max(0, 30 - (directInsultCount - 1) * 20);
    score = Math.min(score, insultCap);
  }

  // --- 心理説明ベースのスコア理由 ---
  const scoreReason = [];

  if (found.length === 0 && toneCorrection === 0 && pressureCorrection === 0) {
    scoreReason.push(`${targetMbti} の心理的安全性を脅かす表現は検出されませんでした。`);
    scoreReason.push("相手の価値観を尊重した安全なメッセージです。");
  } else {
    // カテゴリ別ダメージの高い順に心理説明
    const sortedCats = Object.entries(categoryMbtiDamage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    for (const [catId, dmg] of sortedCats) {
      const catInfo = PSY_CATEGORIES[catId];
      const mult = multipliers[catId] || 1.0;
      if (catInfo) {
        if (mult >= 1.8) {
          scoreReason.push(`【危険】${catInfo.label}: ${targetMbti}はこの領域に極めて敏感です。${catInfo.desc}表現が深い傷を与えます。`);
        } else if (mult >= 1.3) {
          scoreReason.push(`【注意】${catInfo.label}: ${targetMbti}にとって敏感な領域です。${catInfo.desc}表現に注意が必要です。`);
        } else {
          scoreReason.push(`${catInfo.label}: ${catInfo.desc}表現が含まれています。`);
        }
      }
    }

    if (score <= 20) {
      scoreReason.push("相手の心理的防衛線を複数突破しており、深刻な信頼関係の破壊につながる恐れがあります。");
    } else if (score <= 40) {
      scoreReason.push("相手のコア・アイデンティティに触れる表現が多く、大幅な書き直しを強く推奨します。");
    } else if (score <= 60) {
      scoreReason.push("部分的に相手の価値観と衝突する表現があります。改善案を参考にしてください。");
    } else if (score <= 80) {
      scoreReason.push("概ね安全ですが、一部の表現を調整するとより良い関係構築につながります。");
    }

    for (const tr of toneReasons) scoreReason.push(tr);
    for (const pr of pressureReasons) scoreReason.push(pr);
  }

  // --- 構造変換による改善文生成 ---
  let improved = text;

  for (const item of found) {
    const cat = item._category;
    const ruleGroups = [];
    if (cat === "command" || cat === "freedom_restrict" || cat === "command_soft") ruleGroups.push("command");
    if (cat === "ideal_denial" || cat === "capability_deny") ruleGroups.push("denial");
    if (cat === "comparison") ruleGroups.push("comparison_transform");
    if (cat === "generalization") ruleGroups.push("assertion");

    let transformed = false;
    for (const groupName of ruleGroups) {
      const rules = TRANSFORM_RULES[groupName] || [];
      for (const rule of rules) {
        const before = improved;
        improved = improved.replace(rule.match, rule.replace);
        if (improved !== before) { transformed = true; break; }
      }
      if (transformed) break;
    }

    if (!transformed && improved.includes(item.keyword)) {
      const replacement = generatePsychologicalReplacement(item.keyword, cat, targetMbti);
      improved = improved.replaceAll(item.keyword, replacement);
    }
  }

  for (const rule of TRANSFORM_RULES.assertion) {
    improved = improved.replace(rule.match, rule.replace);
  }

  const cleanFound = found.map(({ _category, _damage, ...rest }) => rest);

  return { score, scoreReason, ngWords: cleanFound, improved };
}

// --- カテゴリベースの心理的言い換え生成 ---
function generatePsychologicalReplacement(keyword, category, mbti) {
  const templates = {
    direct_insult:          (kw) => `（${kw}→）【この表現は削除すべきです】`,
    ideal_denial:           (kw) => `（${kw}→）あなたの考えには価値があるよ。一緒に方法を探してみない？`,
    command:                (kw) => `（${kw}→）こうしてみるのはどうかな？`,
    command_soft:           (kw) => `（${kw}→）応援してるよ。自分のペースでいいからね`,
    comparison:             (kw) => `（${kw}→）あなたにはあなたの良さがあるよね`,
    emotional_dismiss:      (kw) => `（${kw}→）その気持ちは大切だよ。聞かせてくれてありがとう`,
    identity_attack:        (kw) => `（${kw}→）あなたのそういうところも個性だよね`,
    conformity:             (kw) => `（${kw}→）いろんなやり方があるよね。あなたのやり方も聞かせて`,
    capability_deny:        (kw) => `（${kw}→）難しいかもしれないけど、やり方を一緒に考えよう`,
    freedom_restrict:       (kw) => `（${kw}→）こういう方法もあるかも。どう思う？`,
    goodwill_reject:        (kw) => `（${kw}→）気にかけてくれてありがとう`,
    privacy_invade:         (kw) => `（${kw}→）話せるタイミングで教えてくれたら嬉しいな`,
    past_blame:             (kw) => `（${kw}→）これからどうするか一緒に考えよう`,
    vague_criticism:        (kw) => `（${kw}→）具体的にはこの部分をこうしてみない？`,
    generalization:         (kw) => `（${kw}→）今回の場合は`,
    interrogation_pressure: (kw) => `（${kw}→）どうしたらうまくいくかな？`,
    passive_aggressive:     (kw) => `（${kw}→）あなたのことを信じてるよ`
  };
  const fn = templates[category] || ((kw) => kw);
  return fn(keyword);
}

// --- analyzeLocal をエクスポート（server.js 等から直接利用可能に） ---
module.exports.analyzeLocal = analyzeLocal;
