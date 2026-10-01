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
import { kvGetJson, kvSetJson, kvCommand, kvReady } from './_kv.js';

export const config = { maxDuration: 30 };

const FIREBASE_API_KEY = 'AIzaSyCI9mlo-KCsDagXdP4h07sPufTIns2FfZc';
const CONFIG_KEY = 'autotrade:config';
const LOG_KEY = 'autotrade:log';
const CHANGES_KEY = 'autotrade:strategy-changes'; // auto-trade-check.js의 하루 1회 자동조정이 쓰는 것과 같은 키
const OVERRIDES_KEY = 'autotrade:strategy-overrides'; // auto-trade-check.js와 같은 키 (AI 자동조정 + 수동편집이 같이 씀)
const CUSTOM_KEY = 'autotrade:custom-strategies'; // 사용자가 진화형 탐색 결과를 저장한 커스텀 전략 목록
const MAX_CHANGES = 200;
const STARTING_CASH_KR = 10_000_000;
const STARTING_CASH_US = 7_000;

function todayKST() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function clipRisk(r, fallback) {
  const f = fallback || { positionPct: 5, stopLossPct: 5, takeProfitPct: 10, maxTradesPerDay: 3 };
  return {
    positionPct: Math.max(1, Math.min(50, Number(r.positionPct) || f.positionPct)),
    stopLossPct: Math.max(1, Math.min(50, Number(r.stopLossPct) || f.stopLossPct)),
    takeProfitPct: Math.max(1, Math.min(200, Number(r.takeProfitPct) || f.takeProfitPct)),
    maxTradesPerDay: Math.max(1, Math.min(50, Math.round(Number(r.maxTradesPerDay) || f.maxTradesPerDay)))
  };
}

const STRATEGY_IDS = ['momentum', 'pullback', 'breakout', 'reversal', 'scalp', 'selective', 'wideswing', 'baseline', 'evolved', 'regime-adaptive'];
const STRATEGY_NAMES = {
  momentum: '모멘텀(추세 추종)', pullback: '눌림목(과열 회피)', breakout: '강한 돌파',
  reversal: '역추세(저가 반등)', scalp: '초단타(잦은 매매)', selective: '신중한 선별(엄격)',
  wideswing: '광폭 스윙(길게 보유)', baseline: '기준선(대조군)', evolved: '진화형(자동탐색)',
  'regime-adaptive': '시장적응형(구간별 자동전환)'
};
const WEIGHT_BASED_IDS = ['evolved', 'regime-adaptive']; // 가중치 기반 전략 — 리스크 수동편집 대상에서 제외

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
  // 외부 스케줄러(cron-job.org 등)는 자주 호출돼도, 아래 주기보다 적게 지났으면 auto-trade-check.js/backtest.js가
  // 실제 점검(전략 자동조정/진화형 탐색)을 건너뛰고 그냥 매매만 체크해요. 주기를 바꾸고 싶으면 여기 설정만 바꾸면 되고,
  // 스케줄러 쪽 호출 간격은 그대로 둬도 돼요.
  adjustIntervalHours: 24, // 전략 자동조정(실거래 성과 기반) 실행 주기
  evolveIntervalHours: 24, // 진화형 탐색 자동 실행 주기
  strategies: {
    momentum: true, pullback: true, breakout: true, reversal: true,
    scalp: true, selective: true, wideswing: true, baseline: true, evolved: true,
    'regime-adaptive': true
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
      adjustIntervalHours: Math.max(1, Math.min(168, Number(body.adjustIntervalHours) || DEFAULT_CONFIG.adjustIntervalHours)),
      evolveIntervalHours: Math.max(1, Math.min(168, Number(body.evolveIntervalHours) || DEFAULT_CONFIG.evolveIntervalHours)),
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

/* ==================== 공용 인증 helper ==================== */

async function requireUid(req, res) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: '인증 토큰이 없습니다.' });
    return null;
  }
  let uid;
  try {
    uid = await verifyIdToken(idToken);
  } catch (e) {
    res.status(500).json({ error: '인증 확인 중 오류가 발생했습니다.' });
    return null;
  }
  if (!uid) {
    res.status(401).json({ error: '유효하지 않은 인증 토큰입니다.' });
    return null;
  }
  return uid;
}

/* ==================== action=custom (커스텀 전략 추가/수정/삭제) ====================
   전략연구실의 "진화형 탐색" 결과를 사용자가 이름을 붙여 저장해둔, 가중치 기반 커스텀 전략 목록입니다.
   기존 8개 내장 전략과 달리 완전히 추가/수정/삭제가 가능합니다(단, 매수 로직이 가중치 점수 방식으로
   고정되어 있어 국내 종목만 지원 — "진화형(자동탐색)"과 같은 구조). */

async function handleCustom(req, res) {
  if (req.method === 'GET') {
    const list = await kvGetJson(CUSTOM_KEY, []);
    res.status(200).json({ strategies: list });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: '허용되지 않은 메서드입니다.' });
    return;
  }

  const uid = await requireUid(req, res);
  if (!uid) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};
  const op = body.op || 'save';

  try {
    const list = await kvGetJson(CUSTOM_KEY, []);

    if (op === 'save') {
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) { res.status(400).json({ error: '전략 이름을 입력해주세요.' }); return; }
      if (!body.weights || typeof body.buyThreshold !== 'number') {
        res.status(400).json({ error: '저장할 전략 데이터(weights/buyThreshold)가 올바르지 않습니다.' });
        return;
      }
      const entry = {
        id: 'custom-' + Date.now(),
        name,
        weights: body.weights,
        buyThreshold: body.buyThreshold,
        exit: body.exit || {},
        sizing: body.sizing || {},
        enabled: true,
        createdAt: Date.now()
      };
      list.unshift(entry);
      if (list.length > 20) list.length = 20; // 너무 많아지면 매 실행마다 종목별 팩터 계산이 느려지므로 상한
      await kvSetJson(CUSTOM_KEY, list);
      res.status(200).json({ ok: true, strategy: entry, strategies: list });
      return;
    }

    if (op === 'toggle') {
      const id = body.id;
      const item = list.find((s) => s.id === id);
      if (!item) { res.status(404).json({ error: '해당 전략을 찾을 수 없습니다.' }); return; }
      item.enabled = body.enabled !== false;
      await kvSetJson(CUSTOM_KEY, list);
      res.status(200).json({ ok: true, strategies: list });
      return;
    }

    if (op === 'delete') {
      const id = body.id;
      const next = list.filter((s) => s.id !== id);
      await kvSetJson(CUSTOM_KEY, next);
      // 그 전략이 쌓아둔 가상 현금/보유종목 기록도 같이 정리합니다.
      await Promise.all([
        kvCommand(['DEL', `autotrade:strategy:${id}:positions:kr`]),
        kvCommand(['DEL', `autotrade:strategy:${id}:cash:kr`]),
        kvCommand(['DEL', `autotrade:strategy:${id}:positions:us`]),
        kvCommand(['DEL', `autotrade:strategy:${id}:cash:us`])
      ]);
      res.status(200).json({ ok: true, strategies: next });
      return;
    }

    res.status(400).json({ error: 'op은 save, toggle, delete 중 하나여야 합니다.' });
  } catch (e) {
    console.error('auto-trade-status.js(custom) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== action=manual-edit (내장 전략 위험 파라미터 수동 수정) ====================
   8개 내장 전략은 매수 로직 자체는 고정이지만, 손절/익절/비중/일일한도는 사용자가 직접 바꿀 수 있습니다.
   (AI가 하루 1회 자동으로 조정하는 것과 같은 저장소(OVERRIDES_KEY)를 쓰기 때문에, 수동으로 바꾼 값도
   그대로 다음 자동매매 실행부터 적용되고, "전략 변경 이력"에도 남습니다.) */

async function handleManualEdit(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: '허용되지 않은 메서드입니다.' });
    return;
  }
  const uid = await requireUid(req, res);
  if (!uid) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};
  const strategyId = body.strategyId;
  const editableIds = STRATEGY_IDS.filter((id) => !WEIGHT_BASED_IDS.includes(id)); // 가중치 기반 전략은 리스크 수동편집 대상에서 제외
  if (!editableIds.includes(strategyId)) {
    res.status(400).json({ error: '수동 편집은 내장 전략(진화형/시장적응형 제외)에만 적용할 수 있습니다.' });
    return;
  }
  if (!body.risk || typeof body.risk !== 'object') {
    res.status(400).json({ error: 'risk 값이 필요합니다.' });
    return;
  }

  try {
    const overrides = await kvGetJson(OVERRIDES_KEY, {});
    const before = overrides[strategyId] || null;
    const after = clipRisk(body.risk, before || undefined);

    overrides[strategyId] = Object.assign({}, after, { updatedAt: Date.now() });
    await kvSetJson(OVERRIDES_KEY, overrides);

    const changes = await kvGetJson(CHANGES_KEY, []);
    changes.unshift({
      id: Date.now() + '-' + strategyId,
      ts: Date.now(), date: todayKST(),
      strategyId, strategyName: STRATEGY_NAMES[strategyId],
      source: 'manual', // 사용자가 직접 수정 — AI 자동조정(live)/백테스트(backtest)와 구분
      diagnosis: '사용자가 설정 화면에서 직접 위험 파라미터를 수정했습니다.',
      statsAtChange: null,
      before, after
    });
    if (changes.length > MAX_CHANGES) changes.length = MAX_CHANGES;
    await kvSetJson(CHANGES_KEY, changes);

    res.status(200).json({ ok: true, overrides: overrides[strategyId] });
  } catch (e) {
    console.error('auto-trade-status.js(manual-edit) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
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
    const customList = await kvGetJson(CUSTOM_KEY, []);
    const strategies = {};
    for (const id of STRATEGY_IDS) {
      const [kr, us] = await Promise.all([loadAccount(id, 'KR'), loadAccount(id, 'US')]);
      strategies[id] = { name: STRATEGY_NAMES[id], kr, us };
    }
    // 커스텀 전략(사용자가 진화형 탐색 결과를 저장한 것)도 같은 방식으로 계좌 현황을 합쳐서 보여줍니다.
    for (const c of customList) {
      const [kr, us] = await Promise.all([loadAccount(c.id, 'KR'), loadAccount(c.id, 'US')]);
      strategies[c.id] = { name: c.name, kr, us, custom: true, enabled: c.enabled !== false };
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

/* ==================== action=changes (전략 변경 이력) ==================== */

// "전략 변경 이력" 탭에서 보여줄 데이터: 각 변경이 언제/왜/어떻게 일어났는지(auto-trade-check.js가 이미 기록해둔 것)에,
// 그 변경 "이후"에 쌓인 거래들의 성과를 지금 시점에 계산해서 붙여줍니다 (변경 시점엔 아직 모르는 정보라 매번 새로 계산).
async function handleChanges(req, res) {
  try {
    const changes = await kvGetJson(CHANGES_KEY, []);
    const log = await kvGetJson(LOG_KEY, []);

    const enriched = changes.map((c) => {
      const after = log.filter((e) => e.strategy === c.strategyId && (e.side === 'STOP_LOSS' || e.side === 'TAKE_PROFIT') && e.ts > c.ts);
      let afterStats = null;
      if (after.length > 0) {
        const wins = after.filter((e) => e.pnlPct > 0);
        afterStats = {
          trades: after.length,
          winRate: Math.round((wins.length / after.length) * 1000) / 10,
          avgPnlPct: Math.round((after.reduce((a, e) => a + e.pnlPct, 0) / after.length) * 100) / 100
        };
      }
      return Object.assign({}, c, { afterStats });
    });

    res.status(200).json({ changes: enriched });
  } catch (e) {
    console.error('auto-trade-status.js(changes) error:', e);
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
  if (action === 'changes') return handleChanges(req, res);
  if (action === 'custom') return handleCustom(req, res);
  if (action === 'manual-edit') return handleManualEdit(req, res);
  return handleConfig(req, res);
}
