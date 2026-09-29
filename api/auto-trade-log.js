// /api/auto-trade-log.js
// 자동매매(현재는 내부 시뮬레이션) 현황 조회 — 프론트엔드 "자동매매" 탭에서 사용합니다.
// 인증 없이 조회만 가능(개인용 앱이라 단순화). 매매 실행/설정 변경은 별도 파일에서 보호합니다.
// 여러 전략(momentum/pullback/breakout/…)이 각각 국내(원화)/해외(달러) 가상 계좌를 따로 운용하므로,
// 전략별 x 시장별 계좌 현황을 모두 모아서 반환해 "전략 경쟁" 비교 화면에서 씁니다.
// 보유 중인 종목은 현재가를 함께 조회해서 평가금액/미실현 손익(%,금액)도 같이 계산해줍니다.

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';
import { kvGetJson, kvReady } from './_kv.js';

export const config = { maxDuration: 30 };

const LOG_KEY = 'autotrade:log';
const STARTING_CASH_KR = 10_000_000;
const STARTING_CASH_US = 7_000;

const STRATEGY_IDS = ['momentum', 'pullback', 'breakout', 'reversal', 'scalp', 'selective', 'wideswing', 'baseline'];
const STRATEGY_NAMES = {
  momentum: '모멘텀(추세 추종)', pullback: '눌림목(과열 회피)', breakout: '강한 돌파',
  reversal: '역추세(저가 반등)', scalp: '초단타(잦은 매매)', selective: '신중한 선별(엄격)',
  wideswing: '광폭 스윙(길게 보유)', baseline: '기준선(대조군)'
};

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

async function loadAccount(strategyId, marketKey) {
  const keys = keysFor(strategyId, marketKey);
  const [positions, cash] = await Promise.all([
    kvGetJson(keys.positionsKey, {}),
    kvGetJson(keys.cashKey, keys.startingCash)
  ]);
  return { positions, cash: typeof cash === 'number' ? cash : keys.startingCash, startingCash: keys.startingCash };
}

async function fetchDomesticQuote(token, symbol) {
  try {
    const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
    const r = await fetch(url, { headers: kisHeaders(token, 'FHKST01010100') });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.rt_cd !== '0' || !data.output) return null;
    return { price: num(data.output.stck_prpr) };
  } catch (e) {
    return null;
  }
}

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
      if (o && o.last && num(o.last) !== null) return { price: num(o.last) };
    } catch (e) {
      // 다음 거래소 시도
    }
  }
  return null;
}

// 보유 종목에 현재가/평가금액/미실현 손익(%,금액)을 채워 넣습니다. 시세 조회는 종목당 한 번만(캐시 공유).
async function attachLivePrices(strategies, token) {
  const krCache = new Map();
  const usCache = new Map();

  async function getKr(symbol) {
    if (!krCache.has(symbol)) krCache.set(symbol, await fetchDomesticQuote(token, symbol));
    return krCache.get(symbol);
  }
  async function getUs(symbol, excd) {
    if (!usCache.has(symbol)) usCache.set(symbol, await fetchOverseasQuote(token, symbol, excd));
    return usCache.get(symbol);
  }

  for (const id of Object.keys(strategies)) {
    const s = strategies[id];
    for (const symbol of Object.keys(s.kr.positions || {})) {
      const pos = s.kr.positions[symbol];
      const q = await getKr(symbol);
      if (q && q.price !== null) {
        pos.currentPrice = q.price;
        pos.evalAmount = Math.round(pos.qty * q.price);
        pos.unrealizedPnlAmount = Math.round(pos.qty * (q.price - pos.avgPrice));
        pos.unrealizedPnlPct = Math.round(((q.price - pos.avgPrice) / pos.avgPrice) * 10000) / 100;
      }
    }
    for (const symbol of Object.keys(s.us.positions || {})) {
      const pos = s.us.positions[symbol];
      const q = await getUs(symbol, pos.excd);
      if (q && q.price !== null) {
        pos.currentPrice = q.price;
        pos.evalAmount = Math.round(pos.qty * q.price * 100) / 100;
        pos.unrealizedPnlAmount = Math.round(pos.qty * (q.price - pos.avgPrice) * 100) / 100;
        pos.unrealizedPnlPct = Math.round(((q.price - pos.avgPrice) / pos.avgPrice) * 10000) / 100;
      }
    }
  }
}

export default async function handler(req, res) {
  if (!kvReady()) {
    res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
    return;
  }
  try {
    const strategies = {};
    for (const id of STRATEGY_IDS) {
      const [kr, us] = await Promise.all([loadAccount(id, 'KR'), loadAccount(id, 'US')]);
      strategies[id] = { name: STRATEGY_NAMES[id], kr, us };
    }

    // 보유 종목이 하나라도 있을 때만 시세 조회(불필요한 KIS 호출 방지). 키가 없거나 조회 실패해도
    // 평가금액 없이 원가만 보여주도록 조용히 넘어갑니다(화면이 깨지지 않게).
    const hasAnyPosition = Object.values(strategies).some((s) => Object.keys(s.kr.positions || {}).length || Object.keys(s.us.positions || {}).length);
    if (hasAnyPosition && process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET) {
      try {
        const token = await getKisToken();
        await attachLivePrices(strategies, token);
      } catch (e) {
        console.error('auto-trade-log.js live price error:', e);
      }
    }

    const log = await kvGetJson(LOG_KEY, []);

    res.status(200).json({
      strategies,
      log: log.slice(0, 80),
      kr: strategies.momentum.kr, us: strategies.momentum.us,
      positions: strategies.momentum.kr.positions, cash: strategies.momentum.kr.cash, startingCash: strategies.momentum.kr.startingCash
    });
  } catch (e) {
    console.error('auto-trade-log.js error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}
