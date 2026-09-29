// /api/auto-trade-check.js
// 외부 무료 스케줄러(cron-job.org 등)가 주기적으로 호출하는 자동매매 실행 엔드포인트입니다.
//
// 지금은 아직 한국투자증권 "모의투자" API 키가 없는 상태라, 실제 모의투자 주문을 넣는 대신
// Vercel KV 안에서 가상의 현금과 보유종목을 직접 추적하는 "내부 시뮬레이션"으로
// 매매 신호/리스크 규칙 로직을 미리 검증합니다.
//
// 여러 매매 전략(STRATEGY_DEFS)을 서로 다른 가상계좌로 동시에 "경쟁"시켜서, 나중에 수익률이
// 가장 좋은 전략을 골라 실거래(모의투자 → 추후 실전)에 채택하는 방식으로 설계했습니다.
// 각 전략은 시장(국내/해외)별로 완전히 독립된 가상 현금/보유종목을 가집니다.
//
// 국내(KR)와 해외(US) 종목을 각각 별도의 가상 계좌(원화/달러)로 나눠서 동시에 운용합니다.
// AI 추천 종목 스크리닝(screen-candidates.js)은 현재 국내 종목만 지원하므로, 해외 종목은
// 관심종목(watchlist)에 등록된 것만 자동매매 대상이 됩니다.
//
// 보안: 아무나 이 URL을 호출해서 매매를 조작하지 못하도록, 쿼리 파라미터 key가
// 환경변수 AUTO_TRADE_SECRET과 일치할 때만 동작합니다.

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';
import { kvGetJson, kvSetJson, kvReady } from './_kv.js';

export const config = { maxDuration: 30 };

const CONFIG_KEY = 'autotrade:config';
const LOG_KEY = 'autotrade:log';
const MAX_LOG = 400;
const STARTING_CASH_KR = 10_000_000; // 가상 원화 자금
const STARTING_CASH_US = 7_000; // 가상 달러 자금

function isAiCand(cand) {
  return cand.reason.indexOf('AI 추천') === 0;
}

// 전략별 정의 — 매수 트리거(shouldBuy)와 리스크 규칙(risk)이 서로 다릅니다.
// momentum은 사용자가 설정 화면에서 조절하는 cfg.risk를 그대로 쓰고(기존 동작 유지),
// 나머지는 "경쟁 비교"가 목적이라 비교 기준이 흔들리지 않도록 고정값을 씁니다.
// baseline(기준선)은 조건 없이 후보를 그대로 사는 전략으로, 다른 전략들이 "그냥 아무거나 사는 것"보다
// 실제로 나은지를 판단하는 비교 기준(대조군) 역할을 합니다.
const STRATEGY_DEFS = [
  {
    id: 'momentum',
    name: '모멘텀(추세 추종)',
    getRisk: (cfg) => cfg.risk || {},
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isAiCand(cand) ? 1 : 3)
  },
  {
    id: 'pullback',
    name: '눌림목(과열 회피)',
    getRisk: () => ({ positionPct: 5, stopLossPct: 4, takeProfitPct: 8, maxTradesPerDay: 3 }),
    // 이미 많이 오른 급등주보다, 완만하게 움직이기 시작한(0~2%) 종목을 선호합니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct > 0 && q.changePct <= 2
  },
  {
    id: 'breakout',
    name: '강한 돌파',
    getRisk: () => ({ positionPct: 5, stopLossPct: 7, takeProfitPct: 15, maxTradesPerDay: 2 }),
    // 더 강한 상승 모멘텀만 선택하고, 손절/익절 폭도 더 크게 잡아 추세를 오래 태웁니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isAiCand(cand) ? 4 : 6)
  },
  {
    id: 'reversal',
    name: '역추세(저가 반등)',
    getRisk: () => ({ positionPct: 4, stopLossPct: 3, takeProfitPct: 6, maxTradesPerDay: 3 }),
    // 최근 하락폭이 있는(-2%~-6%) 종목의 단기 반등을 노립니다. 실패 시 빨리 손절하도록 폭을 좁게 잡습니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct <= -2 && q.changePct >= -6
  },
  {
    id: 'scalp',
    name: '초단타(잦은 매매)',
    getRisk: () => ({ positionPct: 3, stopLossPct: 2, takeProfitPct: 3, maxTradesPerDay: 8 }),
    // 문턱을 낮춰 자주 매매하고, 손절/익절 폭도 아주 좁게 잡아 빠르게 치고 빠집니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isAiCand(cand) ? 0.5 : 1.5)
  },
  {
    id: 'selective',
    name: '신중한 선별(엄격)',
    getRisk: () => ({ positionPct: 8, stopLossPct: 5, takeProfitPct: 12, maxTradesPerDay: 2 }),
    // 아주 강한 조건에서만 매매하되, 한 번 살 때 비중을 크게 실어(8%) 소수 정예로 갑니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isAiCand(cand) ? 2.5 : 4)
  },
  {
    id: 'wideswing',
    name: '광폭 스윙(길게 보유)',
    getRisk: () => ({ positionPct: 5, stopLossPct: 10, takeProfitPct: 25, maxTradesPerDay: 2 }),
    // 모멘텀과 매수 조건은 비슷하지만, 손절/익절 폭을 훨씬 넓게 잡아 추세를 오래 들고 갑니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isAiCand(cand) ? 1.5 : 3)
  },
  {
    id: 'baseline',
    name: '기준선(대조군, 조건 없음)',
    getRisk: () => ({ positionPct: 5, stopLossPct: 5, takeProfitPct: 10, maxTradesPerDay: 3 }),
    // 등락률 조건 없이 후보에 오르면 그냥 삽니다 — 다른 전략들이 "무조건 사는 것"보다 실제로 나은지 비교하는 대조군.
    shouldBuy: () => true
  }
];

// momentum 전략은 기존에 쌓인 시뮬레이션 데이터를 그대로 이어가도록 기존 KV 키를 그대로 씁니다.
// 나머지 전략은 새 키 네임스페이스를 씁니다.
function keysFor(strategyId, marketKey) {
  if (strategyId === 'momentum') {
    return marketKey === 'KR'
      ? { positionsKey: 'autotrade:positions', cashKey: 'autotrade:cash', startingCash: STARTING_CASH_KR }
      : { positionsKey: 'autotrade:positions:usd', cashKey: 'autotrade:cash:usd', startingCash: STARTING_CASH_US };
  }
  return marketKey === 'KR'
    ? { positionsKey: `autotrade:strategy:${strategyId}:positions:kr`, cashKey: `autotrade:strategy:${strategyId}:cash:kr`, startingCash: STARTING_CASH_KR }
    : { positionsKey: `autotrade:strategy:${strategyId}:positions:us`, cashKey: `autotrade:strategy:${strategyId}:cash:us`, startingCash: STARTING_CASH_US };
}

function todayKST() {
  // 서버 시간이 UTC라 KST(+9)로 보정해서 "날짜"를 계산합니다.
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function fetchDomesticQuote(token, symbol) {
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  const r = await fetch(url, { headers: kisHeaders(token, 'FHKST01010100') });
  if (!r.ok) return null;
  const data = await r.json();
  if (data.rt_cd !== '0' || !data.output) return null;
  const o = data.output;
  return {
    symbol, name: o.hts_kor_isnm || symbol,
    price: num(o.stck_prpr), changePct: num(o.prdy_ctrt)
  };
}

// 해외 종목은 거래소(NAS/NYS/AMS)를 모를 때 하나씩 순서대로 조회합니다.
async function fetchOverseasQuote(token, symbol, preferredExcd) {
  const ALL = ['NAS', 'NYS', 'AMS'];
  const order = preferredExcd ? [preferredExcd, ...ALL.filter((e) => e !== preferredExcd)] : ALL;
  for (const excd of order) {
    try {
      const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/price-detail?AUTH=&EXCD=${excd}&SYMB=${symbol}`;
      const r = await fetch(url, { headers: kisHeaders(token, 'HHDFS76200200') });
      if (!r.ok) continue;
      const data = await r.json();
      const o = data && data.output;
      if (o && o.last && num(o.last) !== null) {
        return { symbol, name: o.name || o.e_name || symbol, price: num(o.last), changePct: num(o.rate), excd };
      }
    } catch (e) {
      // 다음 거래소로 계속 시도
    }
  }
  return null;
}

async function loadCandidateSymbols(cfg, req) {
  const symbols = new Map();
  (cfg.symbols || []).forEach((s) => symbols.set(s, { symbol: s, name: null, reason: '관심종목' }));

  if (cfg.useAiCandidates) {
    try {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host;
      const r = await fetch(`${proto}://${host}/api/screen-candidates`);
      if (r.ok) {
        const data = await r.json();
        (data.candidates || []).forEach((c) => {
          // (AI 스크리닝은 현재 국내 종목만 지원합니다.)
          if (!symbols.has(c.symbol)) symbols.set(c.symbol, { symbol: c.symbol, name: c.name || null, reason: 'AI 추천: ' + c.reason });
        });
      }
    } catch (e) {
      console.error('auto-trade-check: AI 후보 조회 실패', e);
    }
  }
  return Array.from(symbols.values()).slice(0, 20); // 과호출 방지로 상한
}

// 손절매가 발생했을 때 "왜 손해를 봤는지"를 AI가 짧게 추정해서 설명해줍니다.
// (익절은 원인 설명이 필요 없으니 손절에만 호출 — API 호출 횟수를 아낍니다.)
async function explainStopLoss(ctx, apiKey) {
  if (!apiKey) return null;
  const prompt =
`자동매매 전략이 아래 종목을 손절매했어. 왜 손해를 봤을지 2문장 이내로 짧게 한국어로 추정해줘.
확정적으로 말하지 말고 추정 톤으로("~때문일 수 있어요" 같은 식으로) 써줘. 종목명 반복은 최소화하고 바로 원인 추정부터 말해줘.

전략: ${ctx.strategyName} (손절 기준: -${ctx.stopLossPct}%)
종목: ${ctx.name} (${ctx.symbol})
매수 사유: ${ctx.buyReason || '정보 없음'}
매수가: ${ctx.avgPrice} → 손절가: ${ctx.price} (${ctx.pnlPct}%)
보유 기간: ${ctx.holdingDays}일 (매수일 ${ctx.entryDate} → 매도일 ${ctx.today})`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text || null;
  } catch (e) {
    return null;
  }
}

async function appendLog(entry) {
  const log = await kvGetJson(LOG_KEY, []);
  log.unshift(entry);
  if (log.length > MAX_LOG) log.length = MAX_LOG;
  await kvSetJson(LOG_KEY, log);
}

// 여러 전략이 같은 후보군을 동시에 평가하므로, 이번 실행 동안은 종목별 시세를 한 번만 조회해서
// 캐시로 재사용합니다(전략 3개 x 시장 2개 = 최대 6번 반복 조회하던 걸 줄여서 실행시간 제한을 지킵니다).
function makeQuoteFetcher(token, marketKey, cache) {
  return async function fetchQuote(symbol, preferredExcd) {
    if (cache.has(symbol)) return cache.get(symbol);
    const q = marketKey === 'KR' ? await fetchDomesticQuote(token, symbol) : await fetchOverseasQuote(token, symbol, preferredExcd);
    cache.set(symbol, q);
    return q;
  };
}

// 한 전략 x 한 마켓에 대한 손절/익절 + 신규매수 평가를 수행합니다.
async function processStrategyMarket(strategyDef, marketKey, fetchQuote, cfg, candidates, today, risk, apiKey) {
  const keys = keysFor(strategyDef.id, marketKey);
  const positions = await kvGetJson(keys.positionsKey, {});
  let cash = await kvGetJson(keys.cashKey, keys.startingCash);
  if (typeof cash !== 'number') cash = keys.startingCash;

  const log = await kvGetJson(LOG_KEY, []);
  const tradesToday = log.filter((e) => e.date === today && e.market === marketKey && e.strategy === strategyDef.id && e.side !== 'STOP_LOSS').length;
  const positionPct = risk.positionPct || 5;
  const stopLossPct = risk.stopLossPct || 5;
  const takeProfitPct = risk.takeProfitPct || 10;
  const maxTradesPerDay = risk.maxTradesPerDay || 3;

  const actions = [];

  // 1) 보유 종목 먼저 점검 — 손절/익절 (손절은 일일 매매 한도와 무관하게 항상 실행: 손실 방어가 우선)
  for (const symbol of Object.keys(positions)) {
    const pos = positions[symbol];
    const q = await fetchQuote(symbol, pos.excd);
    if (!q || q.price === null) continue;
    const pnlPct = ((q.price - pos.avgPrice) / pos.avgPrice) * 100;

    let side = null;
    if (pnlPct <= -stopLossPct) side = 'STOP_LOSS';
    else if (pnlPct >= takeProfitPct && tradesToday < maxTradesPerDay) side = 'TAKE_PROFIT';

    if (side) {
      const proceeds = pos.qty * q.price;
      const pnlAmount = proceeds - pos.qty * pos.avgPrice; // 이번 매매로 실현된 손익 금액(원화/달러, 시장 통화 기준)
      cash += proceeds;
      delete positions[symbol];
      const entry = {
        ts: Date.now(), date: today, market: marketKey, strategy: strategyDef.id,
        symbol, name: pos.name || q.name || symbol, side,
        qty: pos.qty, price: q.price, pnlPct: Math.round(pnlPct * 100) / 100,
        amount: Math.round(proceeds), pnlAmount: Math.round(pnlAmount), mode: 'dryrun',
        reason: pos.reason || null
      };
      if (side === 'STOP_LOSS') {
        const holdingDays = Math.max(0, Math.round((Date.parse(today) - Date.parse(pos.entryDate)) / 86400000));
        entry.aiReason = await explainStopLoss({
          strategyName: strategyDef.name, stopLossPct,
          name: entry.name, symbol, buyReason: pos.reason,
          avgPrice: pos.avgPrice, price: q.price, pnlPct: entry.pnlPct,
          holdingDays, entryDate: pos.entryDate, today
        }, apiKey);
      }
      await appendLog(entry);
      actions.push(entry);
    }
  }

  // 2) 신규 매수 후보 평가 (일일 매매 한도 내에서만)
  const currentTradesToday = tradesToday + actions.filter((a) => a.side === 'TAKE_PROFIT').length;
  if (currentTradesToday < maxTradesPerDay) {
    for (const cand of candidates) {
      if (positions[cand.symbol]) continue; // 이미 보유 중이면 스킵
      const remainingSlots = maxTradesPerDay - (tradesToday + actions.filter((a) => a.side === 'BUY').length);
      if (remainingSlots <= 0) break;

      const q = await fetchQuote(cand.symbol);
      if (!q || q.price === null || q.changePct === null) continue;
      if (!strategyDef.shouldBuy(cand, q)) continue;

      const budget = cash * (positionPct / 100);
      const qty = Math.floor(budget / q.price);
      if (qty < 1) continue;

      const cost = qty * q.price;
      cash -= cost;
      const displayName = cand.name || q.name || cand.symbol;
      positions[cand.symbol] = { qty, avgPrice: q.price, entryDate: today, name: displayName, excd: q.excd || null, reason: cand.reason || null };
      const entry = {
        ts: Date.now(), date: today, market: marketKey, strategy: strategyDef.id,
        symbol: cand.symbol, name: displayName, side: 'BUY',
        qty, price: q.price, amount: Math.round(cost), reason: cand.reason, mode: 'dryrun'
      };
      await appendLog(entry);
      actions.push(entry);
    }
  }

  await kvSetJson(keys.positionsKey, positions);
  await kvSetJson(keys.cashKey, cash);

  return { actions, cash, positions };
}

export default async function handler(req, res) {
  if (!kvReady()) {
    res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
    return;
  }
  const secret = process.env.AUTO_TRADE_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'AUTO_TRADE_SECRET 환경변수가 설정되지 않았습니다.' });
    return;
  }
  if ((req.query.key || '') !== secret) {
    res.status(401).json({ error: '인증 키가 올바르지 않습니다.' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  const cfg = await kvGetJson(CONFIG_KEY, null);
  if (!cfg || !cfg.enabled) {
    res.status(200).json({ skipped: true, reason: 'disabled' });
    return;
  }

  try {
    const token = await getKisToken();
    const today = todayKST();

    const allCandidates = await loadCandidateSymbols(cfg, req);
    const krCandidates = allCandidates.filter((c) => /^\d{6}$/.test(c.symbol));
    const usCandidates = allCandidates.filter((c) => !/^\d{6}$/.test(c.symbol));

    const krQuoteCache = new Map();
    const usQuoteCache = new Map();
    const fetchKrQuote = makeQuoteFetcher(token, 'KR', krQuoteCache);
    const fetchUsQuote = makeQuoteFetcher(token, 'US', usQuoteCache);

    const strategiesEnabled = cfg.strategies || {};
    const activeDefs = STRATEGY_DEFS.filter((def) => strategiesEnabled[def.id] !== false);

    const results = {};
    const allActions = [];

    const apiKey = process.env.ANTHROPIC_API_KEY;
    for (const def of activeDefs) {
      const risk = def.getRisk(cfg);
      const krResult = await processStrategyMarket(def, 'KR', fetchKrQuote, cfg, krCandidates, today, risk, apiKey);
      const usResult = await processStrategyMarket(def, 'US', fetchUsQuote, cfg, usCandidates, today, risk, apiKey);
      results[def.id] = { kr: { cash: krResult.cash, positions: krResult.positions }, us: { cash: usResult.cash, positions: usResult.positions } };
      allActions.push(...krResult.actions, ...usResult.actions);
    }

    res.status(200).json({ ok: true, actions: allActions, strategies: results, checkedAt: Date.now() });
  } catch (e) {
    console.error('auto-trade-check.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
