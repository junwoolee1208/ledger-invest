// /api/auto-trade-status.js
// 자동매매 "설정"(켬/끔, 리스크 규칙, 감시종목)과 "현황 조회"(계좌/보유종목/매매기록)를 한 파일에
// 모았습니다. (예전엔 auto-trade-config.js / auto-trade-log.js 2개 파일이었는데, Vercel 무료
// (Hobby) 플랜의 "배포당 서버리스 함수 12개" 제한을 넘어서 배포가 실패하는 문제가 생겨 하나로
// 합쳤습니다. 각 기능의 내부 로직은 그대로입니다.)
//
// 쿼리: action=config (기본값) | log
//   action=config, GET  : 설정 조회 (인증 불필요 — auto-trade-check.js도 같이 씀)
//   action=config, POST : 설정 저장 (로그인한 본인만, Firebase ID 토큰 필요)
//   action=log,    GET  : 전략별 계좌 현황 + 보유종목(실시간 평가금액/손익 포함) + 매매기록 조회

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';
import { kvGetJson, kvSetJson, kvReady } from './_kv.js';

export const config = { maxDuration: 30 };

const FIREBASE_API_KEY = 'AIzaSyCI9mlo-KCsDagXdP4h07sPufTIns2FfZc';
const CONFIG_KEY = 'autotrade:config';
const LOG_KEY = 'autotrade:log';
const STARTING_CASH_KR = 10_000_000;
const STARTING_CASH_US = 7_000;

const STRATEGY_IDS = ['momentum', 'pullback', 'breakout', 'reversal', 'scalp', 'selective', 'wideswing', 'baseline'];
const STRATEGY_NAMES = {
  momentum: '모멘텀(추세 추종)', pullback: '눌림목(과열 회피)', breakout: '강한 돌파',
  reversal: '역추세(저가 반등)', scalp: '초단타(잦은 매매)', selective: '신중한 선별(엄격)',
  wideswing: '광폭 스윙(길게 보유)', baseline: '기준선(대조군)'
};

const DEFAULT_CONFIG = {
  enabled: false,
  mode: 'dryrun', // 'dryrun' | 'live' — 모의투자 키 연결 전까지는 dryrun 고정
  symbols: [], // 관심종목 외 추가로 감시할 종목 (보통은 프론트에서 관심종목을 합쳐서 채움)
  useAiCandidates: true, // AI 추천 종목도 감시 대상에 포함할지
  risk: {
    positionPct: 5, // 1회 매매당 총자산 대비 비중(%) — "모멘텀" 전략에 적용됨
    stopLossPct: 5, // 손절 기준(%)
    takeProfitPct: 10, // 익절 기준(%)
    maxTradesPerDay: 3 // 하루 최대 매매 횟수
  },
  strategies: {
    momentum: true, pullback: true, breakout: true, reversal: true,
    scalp: true, selective: true, wideswing: true, baseline: true
  },
  updatedAt: null
};

/* ==================== action=config ==================== */

async function verifyIdToken(idToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!r.ok) return null;
  const data = await r.json();
  const user = data.users && data.users[0];
  return user ? user.localId : null;
}

async function handleConfig(req, res) {
  if (req.method === 'GET') {
    const cfg = await kvGetJson(CONFIG_KEY, DEFAULT_CONFIG);
    res.status(200).json(cfg);
    return;
  }

  if (req.method === 'POST') {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({ error: '인증 토큰이 없습니다.' });
      return;
    }
    let uid;
    try {
      uid = await verifyIdToken(idToken);
    } catch (e) {
      res.status(500).json({ error: '인증 확인 중 오류가 발생했습니다.' });
      return;
    }
    if (!uid) {
      res.status(401).json({ error: '유효하지 않은 인증 토큰입니다.' });
      return;
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const risk = Object.assign({}, DEFAULT_CONFIG.risk, body.risk || {});
    const strategiesIn = body.strategies || {};
    const next = {
      enabled: !!body.enabled,
      mode: 'dryrun', // 실거래 전환은 모의투자 검증 후 서버 코드에서 명시적으로만 바꿉니다.
      symbols: Array.isArray(body.symbols) ? body.symbols.slice(0, 50) : [],
      useAiCandidates: body.useAiCandidates !== false,
      risk: {
        positionPct: Math.max(1, Math.min(50, Number(risk.positionPct) || DEFAULT_CONFIG.risk.positionPct)),
        stopLossPct: Math.max(1, Math.min(50, Number(risk.stopLossPct) || DEFAULT_CONFIG.risk.stopLossPct)),
        takeProfitPct: Math.max(1, Math.min(200, Number(risk.takeProfitPct) || DEFAULT_CONFIG.risk.takeProfitPct)),
        maxTradesPerDay: Math.max(1, Math.min(50, Number(risk.maxTradesPerDay) || DEFAULT_CONFIG.risk.maxTradesPerDay))
      },
      strategies: STRATEGY_IDS.reduce((acc, id) => {
        acc[id] = strategiesIn[id] !== false;
        return acc;
      }, {}),
      updatedAt: Date.now()
    };

    const ok = await kvSetJson(CONFIG_KEY, next);
    if (!ok) {
      res.status(500).json({ error: '설정 저장에 실패했습니다.' });
      return;
    }
    res.status(200).json(next);
    return;
  }

  res.status(405).json({ error: '허용되지 않은 메서드입니다.' });
}

/* ==================== action=log ==================== */

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

async function handleLog(req, res) {
  try {
    const strategies = {};
    for (const id of STRATEGY_IDS) {
      const [kr, us] = await Promise.all([loadAccount(id, 'KR'), loadAccount(id, 'US')]);
      strategies[id] = { name: STRATEGY_NAMES[id], kr, us };
    }

    const hasAnyPosition = Object.values(strategies).some((s) => Object.keys(s.kr.positions || {}).length || Object.keys(s.us.positions || {}).length);
    if (hasAnyPosition && process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET) {
      try {
        const token = await getKisToken();
        await attachLivePrices(strategies, token);
      } catch (e) {
        console.error('auto-trade-status.js(log) live price error:', e);
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
    console.error('auto-trade-status.js(log) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== 진입점 ==================== */

export default async function handler(req, res) {
  if (!kvReady()) {
    res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
    return;
  }
  const action = (req.query.action || 'config').trim();
  if (action === 'log') return handleLog(req, res);
  return handleConfig(req, res);
}
