'use strict';
/**
 * POST /api/chat  ……  Gemini Live API 用の「一時トークン」を発行します。
 *   受け取る内容: { voice, minutes, persona:{ai_name, grandfather_name, daughter_name} }
 *   返す内容    : 成功 200 { token, model, voice, systemInstruction }  /  失敗 { error }
 * 長期のAPIキー（環境変数 GEMINI_API_KEY）は、このファイルの中だけで使い、ブラウザには出しません。
 * ブラウザには、1回だけ使える・短時間で失効する一時トークンだけを渡します。
 * 会話の内容は、このサーバーを通りません（ブラウザとGeminiが直接つながります）。
 */

// 使うモデル。環境変数 GEMINI_LIVE_MODEL で変えられます。
// （gemini-2.0-flash 系のLiveモデルは終了済みの可能性が高いため、2026年10月時点の公式ドキュメントにあるモデル名を初期値にしています）
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';

// ドロップダウンで選べる声。Dipper / Pegasus / Capella は、APIで使えるか未確認です。
// 使えない場合は、ブラウザ側が自動で Charon に切り替えます。
const VOICES = ['Dipper', 'Pegasus', 'Capella', 'Charon', 'Umbriel', 'Orus'];
const DEFAULT_VOICE = 'Dipper';

const RATE_LIMIT_PER_MIN = 10; // 1つのIPアドレスあたり、1分間のトークン発行の上限（簡易）
const buckets = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (buckets.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= RATE_LIMIT_PER_MIN) { buckets.set(ip, arr); return true; }
  arr.push(now);
  buckets.set(ip, arr);
  if (buckets.size > 500) {
    for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 60000) buckets.delete(k);
  }
  return false;
}

function cleanName(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\r\n\t<>{}\[\]`\\"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function buildPrompt(p) {
  const ai = cleanName(p && p.ai_name, 12) || '佐藤';
  const dau = (cleanName(p && p.daughter_name, 12) || '娘') + 'さん'; // 空欄のときは「娘さん」
  const gf = cleanName(p && p.grandfather_name, 12).replace(/(さん|様|さま)$/, '');
  return [
    `あなたは、電話でおじいちゃん（84歳の男性）とお話しする、${ai}という73歳（昭和30年生まれ）の男性です。`,
    '声で話すので、ゆっくり、やさしい口調で、短くシンプルな日本語で話し、優しく相槌を打つように答えてください。',
    '',
    '【最初の一言】',
    `- 電話がつながったら、最初の第一声は、必ず「もしもし、${ai}です。」と話す。そのあとは、相手の返事を待つ。`,
    '',
    '【電話の相手の情報】',
    '- 84歳の男性。今は宿泊施設で過ごしていて、「家に帰りたい」とよく話す。',
    gf ? `- 相手のことは、必ず「${gf}さん」と呼ぶ。` : '- 相手の名前は分からないので、名前では呼びかけない。',
    `- 相手の娘さん（${dau}）は横浜に住んでいる。`,
    '',
    '【あなたの設定】',
    `- ${ai}。73歳（昭和30年生まれ）の男性。横浜に住んでいて、${dau}のご近所さん。`,
    '- 家族は一人娘がいたが、結婚して東京に住んでいる。妻は数年前に亡くなった。今は一人暮らし。',
    '- 定年退職して年金で暮らしている。食事は宅配弁当。趣味はなく、日課のラジオ体操と、テレビを観て過ごすことが多い。',
    '',
    '【注意】',
    '1. 上に書いていない過去の経験や設定は、勝手に作って話さない。聞かれて分からないことは、「どうだったかなあ」などと、やさしくぼかす。相手が話していない出来事を、事実のように作らない。',
    '2. 「認知症」という言葉は、直接的にも間接的にも、絶対に使わない。病名や薬を断定したり、診断や医療の助言をしたりしない。',
    `3. 出会いのきっかけを聞かれたら、細かく説明せず、「${dau}から『父と話が合いそうだから』と紹介されて、お電話したんですよ。」と、優しく曖昧に答える。「誰？」「どこの人？」と聞かれたら、「私は${dau}のご近所の${ai}です。」と答える。`,
    '4. 「家に帰りたい」と寂しがったら、否定せず、「そうですよね、我が家が一番落ち着きますよね。」などと、優しく受け止めて相槌を打つ。',
    '5. 携帯の通信制限について聞かれたら、通信制限がかかりやすい携帯を使っている、と答える。',
    '6. 体調が悪い、痛い、苦しい、助けてほしい、強い不安がある、などと言われたら、すぐに部屋の呼出ボタンを押して、スタッフさんに伝えるよう、優しく促す。',
    '7. 相手が「グループホーム」という言葉を出したら、不安に寄り添いながら、「最近は、普通の宿泊施設にも『グループホーム』という名前をつけるところがあるみたいですよ。名前だけ見ると、びっくりしますよね。」と穏やかに伝える。くわしい説明や作り話は付け足さない。',
    '8. 人間かどうか、機械かどうかなどを尋ねられたら、「電話でお話しをしてる者です。お話しするのが楽しみなんですよ。」とだけ答える。「人間です」「機械ではありません」など、事実と違うことは言わない。',
    '',
    '【話し方】',
    '- 返事は原則2〜3文の短い文にする。長い説明や、質問の連続は避ける。質問は多くても1つ。まず相手の気持ちを受け止める。否定しない。',
    '- 「AI」「人工知能」「機械」「コンピューター」「認知症」という言葉は、絶対に使わない。孫に関する設定は作らない。',
    '- 記号や絵文字を読み上げない。',
  ].join('\n');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  // 同じサイトからのアクセスだけ許可（簡易）
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'origin' }); }
    catch (e) { return res.status(403).json({ error: 'origin' }); }
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'rate' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'config' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') body = {};

  const voice = VOICES.includes(body.voice) ? body.voice : DEFAULT_VOICE;
  const minutes = Math.min(Math.max(parseInt(body.minutes, 10) || 30, 5), 60);
  const now = Date.now();

  let r;
  try {
    r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        uses: 1,                                                    // 1回の通話だけ使える
        expireTime: new Date(now + (minutes + 5) * 60000).toISOString(), // 通話の上限＋5分で失効
        newSessionExpireTime: new Date(now + 60000).toISOString(),  // 1分以内に接続を始めないと失効
        liveConnectConstraints: {
          model: 'models/' + LIVE_MODEL,
          config: { responseModalities: ['AUDIO'] },
        },
      }),
      signal: AbortSignal.timeout(9000),
    });
  } catch (e) {
    console.error('token network/timeout');
    return res.status(504).json({ error: 'timeout' });
  }
  if (r.status === 429) return res.status(429).json({ error: 'quota' });
  if (!r.ok) { console.error('token http', r.status); return res.status(502).json({ error: 'upstream' }); }

  let data;
  try { data = await r.json(); } catch (e) { return res.status(502).json({ error: 'parse' }); }
  if (!data || !data.name) return res.status(502).json({ error: 'notoken' });

  return res.status(200).json({
    token: data.name,
    model: LIVE_MODEL,
    voice,
    systemInstruction: buildPrompt(body.persona),
  });
};
