// /api/finnhub-earnings.js
// Finnhub API로 최근 실적(EPS 실제치/예상치/서프라이즈)을 가져옵니다. (미국 종목만 지원)
// 쿼리: symbol (필수)

export default async function handler(req, res) {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
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
    const url = `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      console.error('Finnhub earnings error:', r.status, text);
      res.status(502).json({ error: 'Finnhub 실적 조회 중 오류가 발생했습니다.' });
      return;
    }
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) {
      res.status(404).json({ error: '실적 데이터를 찾을 수 없습니다.' });
      return;
    }
    const latest = data[0]; // Finnhub는 최신순으로 반환
    res.status(200).json({
      symbol,
      reportedDate: latest.period || null,
      reportedEPS: latest.actual ?? null,
      estimatedEPS: latest.estimate ?? null,
      surprisePercentage: latest.surprisePercent ?? null
    });
  } catch (e) {
    console.error('finnhub-earnings.js error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}
