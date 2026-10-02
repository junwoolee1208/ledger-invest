// /api/_sentiment.js
// Claude(Haiku)로 뉴스 헤드라인 목록의 시장/주가 영향(긍정·부정) 점수를 한 번의 호출로 매깁니다.
// market-data.js(시장 전체 이슈 탭)와 analysis.js(종목분석 관련 뉴스)가 공유합니다.
// (원래 market-data.js 안에만 있던 로직을 분리 — 종목분석 뉴스에도 같은 방식으로 긍정/부정
//  뱃지를 붙이기 위해 공통 함수로 뺐습니다. _로 시작하는 파일이라 Vercel 함수 개수에 안 잡힙니다.)

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// articles: [{ headline, summary }]
// opts.tickers: true면 관련 티커도 같이 추출(시장 전체 이슈용), false면 점수만(종목별 뉴스는 이미 종목이 정해져 있어 불필요)
// opts.context: 프롬프트에 들어갈 설명 문구
// 반환: [{ score: -1~1, tickers: string[] }] (articles와 같은 순서/길이)
export async function scoreNewsSentiment(articles, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !articles.length) return articles.map(() => ({ score: 0, tickers: [] }));

  const wantTickers = opts.tickers !== false;
  const list = articles
    .map((a, i) => `${i}. ${a.headline}${a.summary ? ' — ' + a.summary.slice(0, 140) : ''}`)
    .join('\n');

  const tickerField = wantTickers ? `, "tickers": 관련이 높은 미국 주식 티커 배열(최대 3개, 없으면 빈 배열)` : '';
  const prompt =
    `다음은 ${opts.context || '경제/증시'} 뉴스 헤드라인 목록입니다. 각 기사에 대해 아래 JSON 배열 형식으로만 답하세요.\n` +
    `각 항목: {"i": 번호, "score": -1.0~1.0 사이 숫자(주가/시장에 미치는 영향, 음수=부정적/악재, 양수=긍정적/호재, 0=중립)${tickerField}}\n` +
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
      console.error('_sentiment.js scoreNewsSentiment error:', r.status, await r.text());
      return articles.map(() => ({ score: 0, tickers: [] }));
    }
    const data = await r.json();
    const text = data.content?.[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    const byIndex = new Map(parsed.map((p) => [p.i, p]));
    return articles.map((_, i) => {
      const p = byIndex.get(i);
      return p
        ? { score: Number(p.score) || 0, tickers: Array.isArray(p.tickers) ? p.tickers.slice(0, 3) : [] }
        : { score: 0, tickers: [] };
    });
  } catch (e) {
    console.error('_sentiment.js scoreNewsSentiment error:', e);
    return articles.map(() => ({ score: 0, tickers: [] }));
  }
}
