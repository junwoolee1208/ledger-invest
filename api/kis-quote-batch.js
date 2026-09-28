// /api/kis-quote-batch.js
// 대시보드/포트폴리오처럼 여러 종목의 시세를 한꺼번에 보여줘야 할 때 사용합니다.
// 예전에는 종목마다 브라우저가 따로따로 /api/kis-quote(-overseas)를 호출해서,
// 관심종목이 10개면 서버 함수가 동시에 10번 실행되며 각자 한국투자증권 토큰을
// 받으려다 서로 경쟁하는 문제가 있었습니다.
// 이 함수는 하나의 실행 안에서 토큰을 한 번만 받고 여러 종목을 순서대로 조회하므로
// 그 경쟁이 원천적으로 사라집니다.
// 쿼리: symbols=005930,000660,AAPL,MSFT (콤마로 구분, 국내/해외 섞어서 가능)

import { getKisToken, kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';

// 종목 수가 많으면 순서대로 조회하는 시간이 길어질 수 있어 여유를 둡니다.
export const config = { maxDuration: 30 };

const EXCHANGES = ['NAS', 'NYS', 'AMS'];
const exchangeCache = new Map(); // symbol -> excd (같은 실행 중 웜 상태 동안 재사용)

async function fetchDomesticQuote(token, symbol) {
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  const data = await fetchKisJson(url, kisHeaders(token, 'FHKST01010100'));
  if (!data || !data.output) return null;
  const o = data.output;
  return {
    symbol,
    market: 'KR',
    exchange: null,
    name: o.hts_kor_isnm || null,
    price: num(o.stck_prpr),
    change: num(o.prdy_vrss),
    changePct: num(o.prdy_ctrt),
    prevClose: o.stck_prpr && o.prdy_vrss !== undefined ? num(o.stck_prpr) - num(o.prdy_vrss) : null,
    per: o.per && o.per !== '0.00' ? num(o.per) : null,
    pbr: o.pbr && o.pbr !== '0.00' ? num(o.pbr) : null,
    eps: o.eps && o.eps !== '0' ? num(o.eps) : null,
    high52: num(o.w52_hgpr),
    low52: num(o.w52_lwpr),
    marketCapEok: num(o.hts_avls),
    marketCapUsd: null
  };
}

async function fetchOverseasQuote(token, symbol) {
  const tryOrder = exchangeCache.has(symbol)
    ? [exchangeCache.get(symbol), ...EXCHANGES.filter((e) => e !== exchangeCache.get(symbol))]
    : EXCHANGES;

  for (const excd of tryOrder) {
    const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/price-detail?AUTH=&EXCD=${excd}&SYMB=${symbol}`;
    const data = await fetchKisJson(url, kisHeaders(token, 'HHDFS76200200'));
    if (data && data.output) {
      exchangeCache.set(symbol, excd);
      const o = data.output;
      const price = num(o.last);
      const prevClose = num(o.base);
      let change = num(o.diff);
      let changePct = num(o.rate);
      if ((change === null || change === undefined) && price !== null && prevClose !== null) {
        change = price - prevClose;
      }
      if ((changePct === null || changePct === undefined) && change !== null && prevClose) {
        changePct = (change / prevClose) * 100;
      }
      return {
        symbol, market: 'US', exchange: excd,
        name: o.name || o.e_name || null,
        price, change, changePct, prevClose,
        // 배치 조회는 목록 화면(가격/등락률)용이라 PER/PBR/EPS 보강 조회는 생략해 호출 수를 줄입니다.
        // 상세 재무지표는 종목분석 화면(/api/analysis)에서 확인할 수 있습니다.
        per: o.per ? num(o.per) : null,
        pbr: o.pbr ? num(o.pbr) : null,
        eps: o.eps ? num(o.eps) : null,
        high52: num(o.h52p), low52: num(o.l52p),
        marketCapEok: null,
        marketCapUsd: o.tomv ? num(o.tomv) : null
      };
    }
  }
  return null;
}

export default async function handler(req, res) {
  const raw = (req.query.symbols || '').trim();
  if (!raw) {
    res.status(400).json({ error: 'symbols 파라미터가 필요합니다.' });
    return;
  }
  const symbols = Array.from(new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))).slice(0, 50);

  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.' });
    return;
  }

  try {
    const token = await getKisToken();
    const quotes = {};
    const errors = {};

    // 한국투자증권 호출 제한을 고려해 동시에 여러 개 쏘지 않고 순서대로 조회합니다.
    for (const symbol of symbols) {
      try {
        const isKR = /^\d{6}$/.test(symbol);
        const q = isKR
          ? await fetchDomesticQuote(token, symbol)
          : await fetchOverseasQuote(token, symbol.toUpperCase());
        if (q) quotes[symbol] = q;
        else errors[symbol] = 'NOT_FOUND';
      } catch (e) {
        console.error('kis-quote-batch.js item error:', symbol, e);
        errors[symbol] = 'ERROR';
      }
    }

    res.status(200).json({ quotes, errors });
  } catch (e) {
    console.error('kis-quote-batch.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
