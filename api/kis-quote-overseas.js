// /api/kis-quote-overseas.js
// 한국투자증권(KIS) Open API로 해외(미국) 주식 현재가 + 기본 재무지표를 조회합니다.
// KIS는 거래소 코드(NAS/NYS/AMS)를 요구하므로, 어느 거래소인지 모를 때는 순서대로 시도합니다.

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';

const EXCHANGES = ['NAS', 'NYS', 'AMS'];

// 거래소를 알아낸 종목은 짧게 캐싱해서(웜 상태 동안) 매번 3번씩 시도하지 않도록 합니다.
const exchangeCache = new Map(); // symbol -> excd

async function fetchPriceDetail(token, excd, symbol) {
  const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/price-detail?AUTH=&EXCD=${excd}&SYMB=${symbol}`;
  const r = await fetch(url, { headers: kisHeaders(token, 'HHDFS76200200') });
  if (!r.ok) return null;
  const data = await r.json();
  if (data.rt_cd !== '0' || !data.output) return null;
  return data.output;
}

export default async function handler(req, res) {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z.]{1,10}$/.test(symbol)) {
    res.status(400).json({ error: '해외 종목 티커가 올바르지 않습니다.' });
    return;
  }

  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.' });
    return;
  }

  try {
    const token = await getKisToken();

    const tryOrder = exchangeCache.has(symbol)
      ? [exchangeCache.get(symbol), ...EXCHANGES.filter((e) => e !== exchangeCache.get(symbol))]
      : EXCHANGES;

    let output = null;
    let usedExcd = null;
    for (const excd of tryOrder) {
      const o = await fetchPriceDetail(token, excd, symbol);
      if (o) {
        output = o;
        usedExcd = excd;
        break;
      }
    }

    if (!output) {
      res.status(404).json({ error: '해당 티커의 해외 종목 정보를 찾을 수 없습니다.' });
      return;
    }
    exchangeCache.set(symbol, usedExcd);

    // price-detail 응답 주요 필드: last(현재가), base(전일종가), diff(전일대비), rate(등락율),
    // tvol(거래량), per, pbr, eps, bps, h52p(52주 최고), l52p(52주 최저), tomv(시가총액, 천달러 단위)
    const price = num(output.last);
    const prevClose = num(output.base);
    const change = num(output.diff);
    const changePct = num(output.rate);

    res.status(200).json({
      symbol,
      market: 'US',
      exchange: usedExcd,
      name: output.name || output.e_name || null,
      price,
      change,
      changePct,
      prevClose,
      per: output.per ? num(output.per) : null,
      pbr: output.pbr ? num(output.pbr) : null,
      eps: output.eps ? num(output.eps) : null,
      high52: num(output.h52p),
      low52: num(output.l52p),
      marketCapEok: null // 해외는 억원 환산을 하지 않고 아래 marketCapUsdK를 사용합니다.
      ,
      marketCapUsdK: output.tomv ? num(output.tomv) : null // 시가총액, 천달러(USD) 단위
    });
  } catch (e) {
    console.error('kis-quote-overseas.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
