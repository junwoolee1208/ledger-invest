// /api/kis-chart.js
// 한국투자증권(KIS) Open API로 국내/해외 주식의 일별 시세(차트용)를 조회합니다.
// 쿼리: symbol (필수), market=KR|US (기본 KR)

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';

const EXCHANGES = ['NAS', 'NYS', 'AMS'];
const exchangeCache = new Map();

function todayYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function ymdMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function fetchDomesticDaily(token, symbol) {
  const url =
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` +
    `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}` +
    `&FID_INPUT_DATE_1=${ymdMinus(180)}&FID_INPUT_DATE_2=${todayYYYYMMDD()}` +
    `&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
  const r = await fetch(url, { headers: kisHeaders(token, 'FHKST03010100') });
  if (!r.ok) return null;
  const data = await r.json();
  if (data.rt_cd !== '0' || !Array.isArray(data.output2)) return null;
  return data.output2
    .filter((row) => row.stck_bsop_date)
    .map((row) => ({
      date: row.stck_bsop_date, // YYYYMMDD
      open: num(row.stck_oprc),
      high: num(row.stck_hgpr),
      low: num(row.stck_lwpr),
      close: num(row.stck_clpr),
      volume: num(row.acml_vol)
    }))
    .reverse(); // KIS는 최신순으로 주므로 오래된 순으로 뒤집음
}

async function fetchOverseasDaily(token, excd, symbol) {
  const url =
    `${KIS_BASE}/uapi/overseas-price/v1/quotations/dailyprice` +
    `?AUTH=&EXCD=${excd}&SYMB=${symbol}&GUBN=0&BYMD=&MODP=1`;
  const r = await fetch(url, { headers: kisHeaders(token, 'HHDFS76240000') });
  if (!r.ok) return null;
  const data = await r.json();
  if (data.rt_cd !== '0' || !Array.isArray(data.output2)) return null;
  return data.output2
    .filter((row) => row.xymd)
    .map((row) => ({
      date: row.xymd, // YYYYMMDD
      open: num(row.open),
      high: num(row.high),
      low: num(row.low),
      close: num(row.clos),
      volume: num(row.tvol)
    }))
    .reverse();
}

export default async function handler(req, res) {
  const symbol = (req.query.symbol || '').trim();
  const market = (req.query.market || 'KR').toUpperCase();

  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.' });
    return;
  }

  try {
    const token = await getKisToken();

    if (market === 'KR') {
      if (!/^\d{6}$/.test(symbol)) {
        res.status(400).json({ error: '국내 종목코드(6자리 숫자)가 필요합니다.' });
        return;
      }
      const rows = await fetchDomesticDaily(token, symbol);
      if (!rows) {
        res.status(404).json({ error: '차트 데이터를 찾을 수 없습니다.' });
        return;
      }
      res.status(200).json({ symbol, market: 'KR', rows });
      return;
    }

    // 해외
    const upper = symbol.toUpperCase();
    const tryOrder = exchangeCache.has(upper)
      ? [exchangeCache.get(upper), ...EXCHANGES.filter((e) => e !== exchangeCache.get(upper))]
      : EXCHANGES;

    let rows = null;
    let usedExcd = null;
    for (const excd of tryOrder) {
      const r = await fetchOverseasDaily(token, excd, upper);
      if (r && r.length) {
        rows = r;
        usedExcd = excd;
        break;
      }
    }

    if (!rows) {
      res.status(404).json({ error: '차트 데이터를 찾을 수 없습니다.' });
      return;
    }
    exchangeCache.set(upper, usedExcd);
    res.status(200).json({ symbol: upper, market: 'US', exchange: usedExcd, rows });
  } catch (e) {
    console.error('kis-chart.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
