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
      console.error('market-data.js(market-news) Claude sentiment scoring error:', r.status, await r.text());
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
    console.error('market-data.js(market-news) scoreWithClaude error:', e);
    return articles.map(() => ({ score: 0, tickers: [] }));
  }
}

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
    console.error('market-data.js(market-news) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== 진입점 ==================== */

export default async function handler(req, res) {
  const source = (req.query.source || '').trim();
  const type = (req.query.type || '').trim();

  if (source === 'kis' && type === 'quote-batch') return handleQuoteBatch(req, res);
  if (source === 'kis' && type === 'rankings') return handleRankings(req, res);
  if (source === 'finnhub' && type === 'earnings') return handleEarnings(req, res);
  if (source === 'finnhub' && type === 'market-news') return handleMarketNews(req, res);

  res.status(400).json({ error: 'source/type 파라미터 조합이 올바르지 않습니다.' });
}
