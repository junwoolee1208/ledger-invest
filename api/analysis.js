// /api/analysis.js
// 종목분석 화면에서 필요한 시세+차트+뉴스를 한 번의 요청으로 모두 가져옵니다.
// 기존에는 브라우저가 /api/kis-quote(-overseas), /api/kis-chart, /api/finnhub-news를
// 동시에 따로따로 호출했는데, 이렇게 하면 각 서버 함수가 독립적으로 실행되며 각자
// 한국투자증권 토큰을 발급받으려다 서로 경쟁하는 문제가 있었습니다.
// 이 함수는 하나의 실행 안에서 토큰을 한 번만 받아 시세 → 차트를 순서대로 조회하므로
// 그 경쟁이 원천적으로 사라집니다. 해외 종목의 경우 시세 조회에서 찾은 거래소(NAS/NYS/AMS)를
// 차트 조회에서도 그대로 재사용해서 불필요한 중복 조회도 줄입니다.
// 뉴스(Finnhub)는 한국투자증권과 무관한 별개 서비스라 시세/차트와 병렬로 호출해도 안전합니다.

import { getKisToken, kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';

// 여러 API를 순서대로 호출하다 보니 기본 실행시간 제한(10초)을 넘을 수 있어 여유를 둡니다.
export const config = { maxDuration: 30 };

const EXCHANGES = ['NAS', 'NYS', 'AMS'];
const PRDT_TYPE_CD = { NAS: '512', NYS: '513', AMS: '529' };

/* ---------------- 국내 ---------------- */

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

function todayYYYYMMDD() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function ymdMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchDomesticChart(token, symbol) {
  const url =
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` +
    `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}` +
    `&FID_INPUT_DATE_1=${ymdMinus(180)}&FID_INPUT_DATE_2=${todayYYYYMMDD()}` +
    `&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
  const data = await fetchKisJson(url, kisHeaders(token, 'FHKST03010100'));
  if (!data || !Array.isArray(data.output2)) return [];
  return data.output2
    .filter((row) => row.stck_bsop_date)
    .map((row) => ({
      date: row.stck_bsop_date,
      open: num(row.stck_oprc), high: num(row.stck_hgpr), low: num(row.stck_lwpr),
      close: num(row.stck_clpr), volume: num(row.acml_vol)
    }))
    .reverse();
}

/* ---------------- 해외 ---------------- */

async function fetchOverseasQuote(token, symbol) {
  for (const excd of EXCHANGES) {
    const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/price-detail?AUTH=&EXCD=${excd}&SYMB=${symbol}`;
    const data = await fetchKisJson(url, kisHeaders(token, 'HHDFS76200200'));
    if (data && data.output) return { excd, output: data.output };
  }
  return null;
}

async function fetchOverseasFundamentals(token, excd, symbol) {
  try {
    const typeCd = PRDT_TYPE_CD[excd];
    if (!typeCd) return null;
    const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/search-info?PRDT_TYPE_CD=${typeCd}&PDNO=${symbol}`;
    const data = await fetchKisJson(url, kisHeaders(token, 'CTPF1702R'));
    return data && data.output ? data.output : null;
  } catch (e) {
    console.error('analysis.js search-info error:', e);
    return null;
  }
}

async function fetchOverseasChart(token, excd, symbol) {
  const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/dailyprice?AUTH=&EXCD=${excd}&SYMB=${symbol}&GUBN=0&BYMD=&MODP=1`;
  const data = await fetchKisJson(url, kisHeaders(token, 'HHDFS76240000'));
  if (!data || !Array.isArray(data.output2)) return [];
  return data.output2
    .filter((row) => row.xymd)
    .map((row) => ({
      date: row.xymd, open: num(row.open), high: num(row.high), low: num(row.low),
      close: num(row.clos), volume: num(row.tvol)
    }))
    .reverse();
}

/* ---------------- 뉴스 (Finnhub, KIS와 무관) ---------------- */

function toFinnhubSymbol(symbol, market) {
  return market === 'KR' ? `${symbol}.KS` : symbol.toUpperCase();
}
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
async function fetchNewsArticles(symbol, market, apiKey) {
  if (!apiKey) return [];
  try {
    const fhSymbol = toFinnhubSymbol(symbol, market);
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 14);
    const url =
      `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(fhSymbol)}` +
      `&from=${fmtDate(from)}&to=${fmtDate(to)}&token=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    return data.slice(0, 10).map((a) => ({
      headline: a.headline, summary: a.summary || '', url: a.url,
      source: a.source, datetime: a.datetime ? a.datetime * 1000 : null
    }));
  } catch (e) {
    console.error('analysis.js news error:', e);
    return [];
  }
}

/* ---------------- Handler ---------------- */

export default async function handler(req, res) {
  const rawSymbol = (req.query.symbol || '').trim();
  const isKR = /^\d{6}$/.test(rawSymbol);
  const symbol = isKR ? rawSymbol : rawSymbol.toUpperCase();

  if (!symbol) {
    res.status(400).json({ error: '종목 코드가 필요합니다.' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.' });
    return;
  }

  try {
    const token = await getKisToken();
    const newsPromise = fetchNewsArticles(symbol, isKR ? 'KR' : 'US', process.env.FINNHUB_API_KEY);

    let quote = null;
    let chartRows = [];
    let exchange = null;

    if (isKR) {
      // 토큰은 이미 발급받았으므로(같은 실행 안에서 캐시됨) 시세/차트를 동시에 조회해도 안전합니다.
      const [q, c] = await Promise.all([fetchDomesticQuote(token, symbol), fetchDomesticChart(token, symbol)]);
      quote = q;
      chartRows = c;
    } else {
      const found = await fetchOverseasQuote(token, symbol);
      if (found) {
        exchange = found.excd;
        const o = found.output;
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
        let per = o.per ? num(o.per) : null;
        let pbr = o.pbr ? num(o.pbr) : null;
        let eps = o.eps ? num(o.eps) : null;
        if (per === null && pbr === null && eps === null) {
          const fund = await fetchOverseasFundamentals(token, exchange, symbol);
          if (fund) {
            per = fund.per ? num(fund.per) : null;
            pbr = fund.pbr ? num(fund.pbr) : null;
            eps = fund.eps ? num(fund.eps) : null;
          }
        }
        quote = {
          symbol, market: 'US', exchange,
          name: o.name || o.e_name || null,
          price, change, changePct, prevClose, per, pbr, eps,
          high52: num(o.h52p), low52: num(o.l52p),
          marketCapEok: null,
          marketCapUsd: o.tomv ? num(o.tomv) : null
        };
        chartRows = await fetchOverseasChart(token, exchange, symbol);
      }
    }

    const articles = await newsPromise;

    if (!quote) {
      res.status(404).json({ error: '해당 종목의 데이터를 찾을 수 없습니다.' });
      return;
    }

    res.status(200).json({
      symbol,
      market: isKR ? 'KR' : 'US',
      quote,
      chart: { symbol, market: isKR ? 'KR' : 'US', exchange, rows: chartRows },
      news: { symbol, market: isKR ? 'KR' : 'US', articles }
    });
  } catch (e) {
    console.error('analysis.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
