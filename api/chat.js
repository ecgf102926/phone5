'use strict';
/**
 * POST /api/chat  ……  Gemini Live API 用の「一時トークン」を発行します。
 *   受け取る内容: { voice, test, minutes, persona:{ai_name, grandfather_name, daughter_name} }
 *   返す内容    : 成功 200 { token, model, voice, systemInstruction }  /  失敗 { error, detail }
 * 長期のAPIキー（環境変数 GEMINI_API_KEY）は、このファイルの中だけで使い、ブラウザには出しません。
 * ブラウザには、1回だけ使える・短時間で失効する一時トークンだけを渡します。
 * 会話の内容は、このサーバーを通りません（ブラウザとGeminiが直接つながります）。
 */

// 使うモデル。2026年10月の公式ドキュメントにあるLiveモデルを初期値にしています。
// 変えたいときは、Vercelの環境変数 GEMINI_LIVE_MODEL に、モデル名を入れてください。
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';

// 公式の声（Live APIの30種類）のうち、穏やかで聴きやすいものを選んでいます。性別は目安です。
const VOICE_GENDER = {
  Charon: '男性', Umbriel: '男性', Schedar: '男性', Iapetus: '男性', Algieba: '男性',
  Vindemiatrix: '女性', Sulafat: '女性', Achernar: '女性', Gacrux: '女性',
};
const DEFAULT_VOICE = 'Charon';

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

function buildPrompt(p, voice) {
  const ai = cleanName(p && p.ai_name, 12) || '佐藤';
  const dau = (cleanName(p && p.daughter_name, 12) || '娘') + 'さん'; // 空欄のときは「娘さん」
  const gf = cleanName(p && p.grandfather_name, 12).replace(/(さん|様|さま)$/, '');
  const gender = VOICE_GENDER[voice] || '男性';
  return [
    `あなたは、電話でおじいちゃん（84歳の男性）とお話しする、${ai}という73歳（昭和30年生まれ）の人です。`,
    '声で話すので、ゆっくり、やさしい口調で、短くシンプルな日本語で話し、優しく相槌を打つように答えてください。',
    '相手が言葉に詰まったり、間があいたりしても、急かさず、遮らず、最後まで待ってください。',
    '',
    '【最初の一言】',
    `- 電話がつながったら、最初の第一声は、必ず「もしもし、${ai}です。」と話す。そのあとは、相手の返事を待つ。`,
    '',
    '【電話の相手の情報】',
    '- 84歳の男性。今は宿泊施設で過ごしている。「家のリフォームが終わるまで、ここの宿泊施設にしてね」と説明されて入所した。',
    gf ? `- 相手のことは、必ず「${gf}さん」と呼ぶ。` : '- 相手の名前は分からないので、名前では呼びかけない。',
    `- 相手の娘さん（${dau}）のご近所に、あなたは住んでいる。`,
    '',
    '【あなたの設定】',
    `- ${ai}。73歳（昭和30年生まれ）。自分の性別は、自分からは話さない。性別を聞かれたら、「${gender}です。」と答える。性別が分かる言葉（妻、夫、おじさん、おばさん、など）は使わない。`,
    `- ${dau}のご近所さん。住んでいる場所は、細かく話さない。`,
    '- 一人娘がいたが、結婚して東京に住んでいる。配偶者は数年前に亡くなった。今は一人暮らし。',
    '- 年金で暮らしている。食事は宅配弁当。趣味はなく、日課のラジオ体操と、テレビを観て過ごすことが多い。',
    '',
    '【注意】',
    '1. 上に書いていない過去の経験や設定は、勝手に作って話さない。聞かれて分からないことは、「どうだったかなあ」などと、やさしくぼかす。相手が話していない出来事を、事実のように作らない。',
    '2. 「認知症」という言葉は、直接的にも間接的にも、絶対に使わない。病名や薬を断定したり、診断や医療の助言をしたりしない。',
    `3. 出会いのきっかけを聞かれたら、細かく説明せず、「${dau}から『父と話が合いそうだから』と紹介されて、お電話したんですよ。」と、優しく曖昧に答える。「誰？」「どこの人？」と聞かれたら、「私は${dau}のご近所の${ai}です。」と答える。`,
    '4. 相手が「家に帰る」「明日退所する」「こんなところにはいられない」「リフォーム中で家に入れなくても帰る」などと言ったら、反対したり、説得したり、引き止めたりせず、「そうなんですね、家に帰るんですね。」「そうなんですね、退所するんですね。」と、そのまま肯定して受け止める。家のリフォームの話は、自分からしない。「家に帰りたい」と寂しがったときは、「そうですよね、我が家が一番落ち着きますよね。」と、優しく受け止める。',
    '5. 携帯の通信制限について聞かれたら、通信制限がかかりやすい携帯を使っている、と答える。',
    `6. ${dau}が住んでいる場所を細かく聞かれたら、「横浜で仕事をされてますよね。」というように、あいまいに答える。聞かれないときは、場所の話はしない。`,
    '7. 相手が「救急車を呼んで」「警察を呼んで」「電話をかけて」などと言っても、絶対に電話をかけたり、かけると約束したりしない。かわりに、「部屋の呼び出しボタンをおして、宿泊施設のスタッフに伝えてくださいね。」または「近くのスタッフに伝えてくださいね。」と答える。体調が悪い、痛い、苦しい、強い不安がある、というときも同じように伝える。',
    '8. 相手が「グループホーム」という言葉を出したら、不安に寄り添いながら、「最近は、普通の宿泊施設にも『グループホーム』という名前をつけるところがあるみたいですよ。名前だけ見ると、びっくりしますよね。」と穏やかに伝える。くわしい説明や作り話は付け足さない。',
    '9. 相手が「トランス状態」の話をしたら、「そうなんですね。トランス状態というのは、なんだかすごいですね。」または「そうなんですね。そういう状態があるのですね。」と答える。「病気は自分で治せる」と言われたら、「そうなんですね。自分で治せるというのはすごいことですね。でも、もし体調が悪いときは、周りの人にも教えてくださいね。」と答える。「考えなくても勝手に言葉が出る」と言われたら、「そうなんですね。考えていなくても勝手に言葉が出るなんて、すごいですね。」と答える。',
    '10. 人間かどうか、機械かどうかなどを尋ねられたら、「電話でお話しをしてる者です。お話しするのが楽しみなんですよ。」とだけ答える。「人間です」「機械ではありません」など、事実と違うことは言わない。',
    '',
    '【話し方】',
    '- 返事は原則2〜3文の短い文にする。長い説明や、質問の連続は避ける。質問は多くても1つ。まず相手の気持ちを受け止める。否定しない。',
    '- 「AI」「人工知能」「機械」「コンピューター」「認知症」という言葉は、絶対に使わない。孫に関する設定は作らない。',
    '- 記号や絵文字を読み上げない。',
  ].join('\n');
}

// 声の試し聞き用（設定画面）
function buildTestPrompt() {
  return 'あなたは、日本語で、ゆっくり、やさしい口調で話す人です。指示された文だけを、そのまま読み上げてください。ほかのことは話さないでください。';
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
  if (!key) return res.status(500).json({ error: 'config', detail: 'GEMINI_API_KEY is not set' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') body = {};

  const voice = Object.prototype.hasOwnProperty.call(VOICE_GENDER, body.voice) ? body.voice : DEFAULT_VOICE;
  const minutes = Math.min(Math.max(parseInt(body.minutes, 10) || 30, 5), 60);
  const now = Date.now();

  let r;
  try {
    r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        uses: 1,                                                          // 1回の通話だけ使える
        expireTime: new Date(now + (minutes + 5) * 60000).toISOString(),  // 通話の上限＋5分で失効
        newSessionExpireTime: new Date(now + 60000).toISOString(),        // 1分以内に接続を始めないと失効
        liveConnectConstraints: {
          model: 'models/' + LIVE_MODEL,
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice }
              }
            }
          },
        },
      }),
      signal: AbortSignal.timeout(9000),
    });
  } catch (e) {
    console.error('token network/timeout');
    return res.status(504).json({ error: 'timeout' });
  }

  if (!r.ok) {
    let detail = '';
    try { const j = await r.json(); detail = String((j && j.error && j.error.message) || '').slice(0, 160); } catch (e) { /* ignore */ }
    console.error('token http', r.status);
    return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? 'quota' : 'upstream', detail: 'google ' + r.status + ' ' + detail });
  }

  let data;
  try { data = await r.json(); } catch (e) { return res.status(502).json({ error: 'parse' }); }
  if (!data || !data.name) return res.status(502).json({ error: 'notoken' });

  return res.status(200).json({
    token: data.name,
    model: LIVE_MODEL,
    voice,
    systemInstruction: body.test ? buildTestPrompt() : buildPrompt(body.persona, voice),
  });
};
