// /api/market-data.js
// 시세/순위(한국투자증권) + 실적/시장뉴스(Finnhub) 조회를 한 파일에 모았습니다.
// (예전엔 kis-quote-batch.js / kis-rankings.js / finnhub-earnings.js / finnhub-market-news.js
//  4개 파일이었는데, Vercel 무료(Hobby) 플랜의 "배포당 서버리스 함수 12개" 제한을 넘어서
//  배포가 실패하는 문제가 생겨 하나로 합쳤습니다. 각 기능의 내부 로직은 그대로입니다.)
//
// 쿼리: source=kis|finnhub (필수), type=... (source별로 다름)
//   source=kis, type=quote-batch : symbols=005930,000660,AAPL (콤마구분, 국내/해외 혼합 가능)
//   source=kis, type=rankings    : rank=rise|fall|volume
//   source=finnhub, type=earnings     : symbol=AAPL (미국 종목만)
//   source=finnhub, type=market-news  : (파라미터 없음)

import { getKisToken, kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';
import { scoreNewsSentiment } from './_sentiment.js';

export const config = { maxDuration: 30 };

/* ==================== source=kis, type=quote-batch ==================== */

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

async function handleQuoteBatch(req, res) {
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

    for (const symbol of symbols) {
      try {
        const isKR = /^\d{6}$/.test(symbol);
        const q = isKR
          ? await fetchDomesticQuote(token, symbol)
          : await fetchOverseasQuote(token, symbol.toUpperCase());
        if (q) quotes[symbol] = q;
        else errors[symbol] = 'NOT_FOUND';
      } catch (e) {
        console.error('market-data.js(quote-batch) item error:', symbol, e);
        errors[symbol] = 'ERROR';
      }
    }

    res.status(200).json({ quotes, errors });
  } catch (e) {
    console.error('market-data.js(quote-batch) error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}

/* ==================== source=kis, type=rankings ==================== */

async function fetchFluctuation(token, sortCls) {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J',
    fid_cond_scr_div_code: '20170',
    fid_input_iscd: '0000',
    fid_rank_sort_cls_code: sortCls,
    fid_input_cnt_1: '0',
    fid_prc_cls_code: '0',
    fid_input_price_1: '',
    fid_input_price_2: '',
    fid_vol_cnt: '',
    fid_trgt_cls_code: '0',
    fid_trgt_exls_cls_code: '0',
    fid_div_cls_code: '0',
    fid_rsfl_rate1: '',
    fid_rsfl_rate2: ''
  });
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/ranking/fluctuation?${params.toString()}`;
  const r = await fetch(url, { headers: kisHeaders(token, 'FHPST01700000') });
  if (!r.ok) return null;
  const data = await r.json();
  if (data.rt_cd !== '0' || !Array.isArray(data.output)) return null;
  return data.output.slice(0, 15).map((row) => ({
    symbol: row.stck_shrn_iscd,
    name: row.hts_kor_isnm,
    price: num(row.stck_prpr),
    changePct: num(row.prdy_ctrt)
  }));
}

async function fetchVolumeRank(token) {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J',
    fid_cond_scr_div_code: '20171',
    fid_input_iscd: '0000',
    fid_div_cls_code: '0',
    fid_blng_cls_code: '0',
    fid_trgt_cls_code: '111111111',
    fid_trgt_exls_cls_code: '0000000000',
    fid_input_price_1: '',
    fid_input_price_2: '',
    fid_vol_cnt: '',
    fid_input_date_1: ''
  });
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/volume-rank?${params.toString()}`;
  const r = await fetch(url, { headers: kisHeaders(token, 'FHPST01710000') });
  if (!r.ok) return null;
  const data = await r.json();
  if (data.rt_cd !== '0' || !Array.isArray(data.output)) return null;
  return data.output.slice(0, 15).map((row) => ({
    symbol: row.mksc_shrn_iscd,
    name: row.hts_kor_isnm,
    price: num(row.stck_prpr),
    changePct: num(row.prdy_ctrt),
    volume: num(row.acml_vol)
  }));
}

async function handleRankings(req, res) {
  const type = (req.query.rank || 'rise').trim();

  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  try {
    const token = await getKisToken();
    let rows = null;

    if (type === 'rise') rows = await fetchFluctuation(token, '0');
    else if (type === 'fall') rows = await fetchFluctuation(token, '1');
    else if (type === 'volume') rows = await fetchVolumeRank(token);
    else {
      res.status(400).json({ error: 'rank는 rise, fall, volume 중 하나여야 합니다.' });
      return;
    }

    if (!rows) {
      res.status(502).json({ error: '순위 데이터를 불러오지 못했습니다.' });
      return;
    }

    res.status(200).json({ type, rows });
  } catch (e) {
    console.error('market-data.js(rankings) error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}

/* ==================== source=finnhub, type=earnings ==================== */

async function handleEarnings(req, res) {
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
      console.error('market-data.js(earnings) Finnhub error:', r.status, text);
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
    console.error('market-data.js(earnings) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== source=finnhub, type=market-news ==================== */

async function handleMarketNews(req, res) {
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
      console.error('market-data.js(market-news) Finnhub error:', r.status, text);
      res.status(502).json({ error: 'Finnhub 시장 뉴스 조회 중 오류가 발생했습니다.' });
      return;
    }
    const data = await r.json();
    // 이슈 탭에서 "관심종목/핫한 종목" 기준으로 걸러내려면, 걸러내기 전에 모수가 좀 넉넉해야
    // 필터링 후에도 결과가 너무 적게 남지 않습니다. 20 → 40개로 늘렸습니다.
    const raw = Array.isArray(data) ? data.slice(0, 40) : [];
    const articles = raw.map((a) => ({
      headline: a.headline,
      summary: a.summary || '',
      url: a.url,
      source: a.source,
      datetime: a.datetime ? a.datetime * 1000 : null
    }));

    const scores = await scoreNewsSentiment(articles, { tickers: true, context: '오늘의 경제/증시' });
    const merged = articles
      .map((a, i) => ({ ...a, sentimentScore: scores[i].score, tickers: scores[i].tickers }))
      .sort((a, b) => Math.abs(b.sentimentScore) - Math.abs(a.sentimentScore));

    res.status(200).json({ articles: merged });
  } catch (e) {
    console.error('market-data.js(market-news) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== source=fx, type=usdkrw (원/달러 환율) ==================== */
// API 키가 필요 없는 무료 공개 API를 씁니다. 60초간 메모리 캐시해서(서버리스 함수가 warm 상태인 동안)
// 짧은 간격으로 여러 번 불러도 외부 API를 과하게 호출하지 않도록 합니다.
let fxCache = { at: 0, rate: null };
async function handleFx(req, res) {
  try {
    const now = Date.now();
    if (fxCache.rate !== null && now - fxCache.at < 60_000) {
      res.status(200).json({ pair: 'USD/KRW', rate: fxCache.rate, cached: true });
      return;
    }
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!r.ok) throw new Error('FX_FETCH_FAILED');
    const data = await r.json();
    const rate = data && data.rates ? data.rates.KRW : null;
    if (!rate) throw new Error('FX_NO_RATE');
    fxCache = { at: now, rate };
    res.status(200).json({ pair: 'USD/KRW', rate, cached: false });
  } catch (e) {
    console.error('market-data.js(fx) error:', e);
    // 환율 조회 실패는 사소한 부가기능이라, 500 대신 rate:null로 응답해서 화면이 깨지지 않게 합니다.
    res.status(200).json({ pair: 'USD/KRW', rate: null, error: '환율 조회에 실패했습니다.' });
  }
}

/* ==================== source=finnhub, type=earnings-calendar (실적 발표 캘린더) ==================== */
// 다가오는 실적 발표일을 모아서 보여줍니다. Finnhub 무료 티어 기준 해외(미국) 종목만 지원합니다.
async function handleEarningsCalendar(req, res) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'FINNHUB_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.' });
    return;
  }
  const symbolsRaw = (req.query.symbols || '').trim();
  const wanted = symbolsRaw ? new Set(symbolsRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) : null;

  try {
    const from = new Date();
    const to = new Date(Date.now() + 30 * 86400000); // 앞으로 30일
    const fmt = (d) => d.toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fmt(from)}&to=${fmt(to)}&token=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) {
      console.error('market-data.js(earnings-calendar) Finnhub error:', r.status, await r.text());
      res.status(200).json({ events: [], error: '실적 캘린더 조회에 실패했습니다.' });
      return;
    }
    const data = await r.json();
    const rows = Array.isArray(data.earningsCalendar) ? data.earningsCalendar : [];
    const events = rows
      .filter((e) => !wanted || wanted.has(String(e.symbol || '').toUpperCase()))
      .map((e) => ({
        symbol: e.symbol, date: e.date,
        epsEstimate: e.epsEstimate ?? null, hour: e.hour || null
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    res.status(200).json({ events });
  } catch (e) {
    console.error('market-data.js(earnings-calendar) error:', e);
    res.status(200).json({ events: [], error: '실적 캘린더 조회에 실패했습니다.' });
  }
}

/* ==================== 진입점 ==================== */

export default async function handler(req, res) {
  const source = (req.query.source || '').trim();
  const type = (req.query.type || '').trim();

  if (source === 'kis' && type === 'quote-batch') return handleQuoteBatch(req, res);
  if (source === 'kis' && type === 'rankings') return handleRankings(req, res);
  if (source === 'finnhub' && type === 'earnings') return handleEarnings(req, res);
  if (source === 'finnhub' && type === 'earnings-calendar') return handleEarningsCalendar(req, res);
  if (source === 'finnhub' && type === 'market-news') return handleMarketNews(req, res);
  if (source === 'fx' && type === 'usdkrw') return handleFx(req, res);

  res.status(400).json({ error: 'source/type 파라미터 조합이 올바르지 않습니다.' });
}
