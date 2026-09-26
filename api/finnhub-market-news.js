// /api/finnhub-market-news.js
// Finnhub의 시장 전체 뉴스(category=general)를 가져온 뒤, Claude AI가 각 기사의 시장 영향도(감성)를
// 직접 평가해 정렬합니다. (Finnhub 무료 플랜은 감성점수를 제공하지 않으므로 Claude가 대신 분석)

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

async function scoreWithClaude(articles) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !articles.length) return articles.map(() => ({ score: 0, tickers: [] }));

  const list = articles
    .map((a, i) => `${i}. ${a.headline}${a.summary ? ' — ' + a.summary.slice(0, 140) : ''}`)
    .join('\n');

  const prompt =
    `다음은 오늘의 경제/증시 뉴스 헤드라인 목록입니다. 각 기사에 대해 아래 JSON 배열 형식으로만 답하세요.\n` +
    `각 항목: {"i": 번호, "score": -1.0~1.0 사이 숫자(시장에 미치는 영향, 음수=부정적/악재, 양수=긍정적/호재, 0=중립), ` +
    `"tickers": 관련이 높은 미국 주식 티커 배열(최대 3개, 없으면 빈 배열)}\n` +
    `다른 설명 없이 JSON 배열만 출력하세요.\n\n${list}`;

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) {
      console.error('Claude sentiment scoring error:', r.status, await r.text());
      return articles.map(() => ({ score: 0, tickers: [] }));
    }
    const data = await r.json();
    const text = data.content?.[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    const byIndex = new Map(parsed.map((p) => [p.i, p]));
    return articles.map((_, i) => {
      const p = byIndex.get(i);
      return p ? { score: Number(p.score) || 0, tickers: Array.isArray(p.tickers) ? p.tickers.slice(0, 3) : [] } : { score: 0, tickers: [] };
    });
  } catch (e) {
    console.error('scoreWithClaude error:', e);
    return articles.map(() => ({ score: 0, tickers: [] }));
  }
}

export default async function handler(req, res) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'FINNHUB_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.' });
    return;
  }

  try {
    const url = `https://finnhub.io/api/v1/news?category=general&token=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      console.error('Finnhub market news error:', r.status, text);
      res.status(502).json({ error: 'Finnhub 시장 뉴스 조회 중 오류가 발생했습니다.' });
      return;
    }
    const data = await r.json();
    const raw = Array.isArray(data) ? data.slice(0, 20) : [];
    const articles = raw.map((a) => ({
      headline: a.headline,
      summary: a.summary || '',
      url: a.url,
      source: a.source,
      datetime: a.datetime ? a.datetime * 1000 : null
    }));

    const scores = await scoreWithClaude(articles);
    const merged = articles
      .map((a, i) => ({ ...a, sentimentScore: scores[i].score, tickers: scores[i].tickers }))
      .sort((a, b) => Math.abs(b.sentimentScore) - Math.abs(a.sentimentScore));

    res.status(200).json({ articles: merged });
  } catch (e) {
    console.error('finnhub-market-news.js error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}
