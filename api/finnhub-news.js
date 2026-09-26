// /api/finnhub-news.js
// Finnhub API로 특정 종목의 최신 뉴스를 가져옵니다. (원문 그대로, 감성점수는 없음 — AI 시그널이 직접 해석합니다)
// 쿼리: symbol (필수), market=KR|US (기본 US)

function toFinnhubSymbol(symbol, market) {
  if (market === 'KR') return `${symbol}.KS`; // 한국거래소 표기
  return symbol.toUpperCase();
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const symbol = (req.query.symbol || '').trim();
  const market = (req.query.market || 'US').toUpperCase();

  if (!symbol) {
    res.status(400).json({ error: '종목 코드가 필요합니다.' });
    return;
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'FINNHUB_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.' });
    return;
  }

  try {
    const fhSymbol = toFinnhubSymbol(symbol, market);
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 14);

    const url =
      `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(fhSymbol)}` +
      `&from=${fmtDate(from)}&to=${fmtDate(to)}&token=${apiKey}`;

    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      console.error('Finnhub news error:', r.status, text);
      res.status(502).json({ error: 'Finnhub 뉴스 조회 중 오류가 발생했습니다.' });
      return;
    }

    const data = await r.json();
    if (!Array.isArray(data)) {
      res.status(200).json({ symbol, market, articles: [] });
      return;
    }

    const articles = data.slice(0, 10).map((a) => ({
      headline: a.headline,
      summary: a.summary || '',
      url: a.url,
      source: a.source,
      datetime: a.datetime ? a.datetime * 1000 : null // ms 단위로 변환
    }));

    res.status(200).json({ symbol, market, articles });
  } catch (e) {
    console.error('finnhub-news.js error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}
