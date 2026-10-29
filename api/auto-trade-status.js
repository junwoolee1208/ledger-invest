// /api/auto-trade-status.js
// 자동매매 "설정"(켬/끔, 리스크 규칙, 감시종목)과 "현황 조회"(계좌/보유종목/매매기록)를 한 파일에
// 모았습니다. (예전엔 auto-trade-config.js / auto-trade-log.js 2개 파일이었는데, Vercel 무료
// (Hobby) 플랜의 "배포당 서버리스 함수 12개" 제한을 넘어서 배포가 실패하는 문제가 생겨 하나로
// 합쳤습니다. 각 기능의 내부 로직은 그대로입니다.)
//
// 쿼리: action=config (기본값) | log | changes | custom | manual-edit | cost-config | daytrade-config
//       | strategies | strategy-toggle | reset-account | calendar | calendar-day
//   action=config, GET  : 설정 조회 (인증 불필요 — auto-trade-check.js도 같이 씀)
//   action=config, POST : 설정 저장 (로그인한 본인만, Firebase ID 토큰 필요)
//   action=log,    GET  : 전략별 계좌 현황 + 보유종목(실시간 평가금액/손익 포함) + 매매기록 조회
//   action=strategies,      GET  : "내 전략" 카드용 목록(켜짐/숨김 여부 + 지금 적용 중인 손절·익절 등)
//   action=strategy-toggle, POST : 전략 켜기/끄기/숨기기를 즉시 저장
//   action=reset-account,   POST : 한 전략의 가상계좌만 처음 상태(현금 원금, 보유종목 없음)로 되돌림
//   action=calendar,        GET  : month=YYYY-MM 의 날짜별 손익 요약(손익 캘린더)
//   action=calendar-day,    GET  : date=YYYY-MM-DD 의 매매 하나하나(캘린더 "자세히 보기")
//   action=ai-usage,        GET  : 이번 달 AI 사용액(기능별)·예산·기능별 모델·AI 연결 상태(마지막 실패 이유)
//   action=ai-config,       POST : 월 AI 예산과 기능별 모델 저장(로그인한 본인만)

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';
import { kvGetJson, kvSetJson, kvCommand, kvReady } from './_kv.js';
import {
  COST_CONFIG_KEY, REALIZED_KEY_PREFIX, DEFAULT_COSTS, normalizeCosts, loadCosts,
  planSell, positionCostBasis, estimateOverseasTax
} from './_costs.js';
import { DEFAULT_DAYTRADE, normalizeDaytrade, describeDaytrade } from './_daytrade.js';
import { STRATEGY_IDS, STRATEGY_NAMES, WEIGHT_BASED_IDS, OWN_SETTINGS_IDS, BASE_RISK, keysFor } from './_strategies.js';
import { isSellSide, ensureBackfilled, DAILY_KEY_PREFIX, TRADES_KEY_PREFIX } from './_ledger.js';
import {
  AI_CONFIG_KEY, AI_MODELS, AI_FEATURES, AI_LAST_OK_KEY, AI_LAST_ERROR_KEY, AI_REASON_TEXT,
  normalizeAiConfig, loadAiUsage, modelFor
} from './_ai.js';

export const config = { maxDuration: 30 };

const FIREBASE_API_KEY = 'AIzaSyCI9mlo-KCsDagXdP4h07sPufTIns2FfZc';
const CONFIG_KEY = 'autotrade:config';
const LOG_KEY = 'autotrade:log';
const CHANGES_KEY = 'autotrade:strategy-changes'; // auto-trade-check.js의 하루 1회 자동조정이 쓰는 것과 같은 키
const OVERRIDES_KEY = 'autotrade:strategy-overrides'; // auto-trade-check.js와 같은 키 (AI 자동조정 + 수동편집이 같이 씀)
const CUSTOM_KEY = 'autotrade:custom-strategies'; // 사용자가 진화형 탐색 결과를 저장한 커스텀 전략 목록
const MAX_CHANGES = 200;

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
    scalp: true, selective: true, wideswing: true, baseline: true, daytrade: true, evolved: true,
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

    // 데이트레이딩 설정·전략 켜기/끄기·숨김은 "내 전략" 카드에서 따로 바로 저장돼서, 이 "설정 저장" 버튼이 덮어쓰지 않도록
    // 요청에 안 들어 있으면 기존 값을 그대로 이어받습니다. momentum 손절/익절(risk)도 이제 카드에서 바꾸므로 같은 방식이에요.
    const prev = (await kvGetJson(CONFIG_KEY, null)) || {};
    const risk = Object.assign({}, DEFAULT_CONFIG.risk, prev.risk || {}, body.risk || {});
    const strategiesIn = body.strategies || prev.strategies || {};
    const next = {
      daytrade: normalizeDaytrade(prev.daytrade),
      hidden: Array.isArray(prev.hidden) ? prev.hidden : [],
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

/* ==================== action=cost-config (매매 비용·세금 설정) ====================
   GET : 현재 설정(없으면 토스증권 기준 기본값) + 기본값을 같이 돌려줍니다(화면의 "기본값으로" 버튼용).
   POST: 로그인한 본인만 저장. body: { costs } 또는 { reset: true } */
async function handleCostConfig(req, res) {
  if (req.method === 'GET') {
    const costs = await loadCosts();
    res.status(200).json({ costs, defaults: DEFAULT_COSTS });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'GET 또는 POST만 지원합니다.' });
    return;
  }
  const uid = await requireUid(req, res);
  if (!uid) return;
  const body = req.body || {};
  const next = body.reset ? normalizeCosts(DEFAULT_COSTS) : normalizeCosts(body.costs);
  next.updatedAt = Date.now();
  await kvSetJson(COST_CONFIG_KEY, next);
  res.status(200).json({ ok: true, costs: next });
}

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  return body || {};
}

/* ==================== action=strategies ("내 전략" 카드 목록) ====================
   카드마다 필요한 것: 이름, 종류(일반/단타/가중치/커스텀), 켜짐·숨김 여부, 지금 실제로 적용 중인 손절·익절·비중·한도.
   "지금 적용 중인 값" = 기본값(_strategies.js) 위에 수동 수정/AI 자동조정 값(오버라이드)을 덮어쓴 것 — 매매 엔진과 같은 계산이에요. */
async function handleStrategies(req, res) {
  try {
    const [cfgRaw, overrides, customList] = await Promise.all([
      kvGetJson(CONFIG_KEY, null), kvGetJson(OVERRIDES_KEY, {}), kvGetJson(CUSTOM_KEY, [])
    ]);
    const cfg = cfgRaw || DEFAULT_CONFIG;
    const enabledMap = cfg.strategies || {};
    const hidden = Array.isArray(cfg.hidden) ? cfg.hidden : [];
    const list = STRATEGY_IDS.map((id) => {
      let kind = 'builtin', risk = null, daytrade = null;
      if (WEIGHT_BASED_IDS.includes(id)) kind = 'weight';
      else if (id === 'daytrade') {
        kind = 'daytrade';
        daytrade = normalizeDaytrade(cfg.daytrade);
        risk = { positionPct: daytrade.positionPct, stopLossPct: daytrade.stopLossPct, takeProfitPct: daytrade.takeProfitPct, maxTradesPerDay: daytrade.maxBuysPerDay };
      } else {
        const base = id === 'momentum' ? Object.assign({}, BASE_RISK.momentum, cfg.risk || {}) : BASE_RISK[id];
        risk = clipRisk(Object.assign({}, base, overrides[id] || {}), base);
      }
      return { id, name: STRATEGY_NAMES[id], kind, enabled: enabledMap[id] !== false, hidden: hidden.includes(id), risk, daytrade };
    });
    customList.forEach((c) => list.push({
      id: c.id, name: c.name, kind: 'custom', enabled: c.enabled !== false, hidden: false, risk: null, createdAt: c.createdAt || null
    }));
    res.status(200).json({ strategies: list, daytradeDefaults: DEFAULT_DAYTRADE });
  } catch (e) {
    console.error('auto-trade-status.js(strategies) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== action=strategy-toggle (켜기/끄기/숨기기 즉시 저장) ====================
   body: { strategyId, enabled?: boolean, hidden?: boolean }
   숨기면 자동으로 꺼져요(안 보이는 전략이 몰래 매매하면 안 되니까). 커스텀 전략은 커스텀 목록의 켜짐 여부를 바꿉니다. */
async function handleStrategyToggle(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST만 지원합니다.' }); return; }
  const uid = await requireUid(req, res);
  if (!uid) return;
  const body = readBody(req);
  const id = String(body.strategyId || '');
  try {
    if (id.startsWith('custom-')) {
      const list = await kvGetJson(CUSTOM_KEY, []);
      const item = list.find((s) => s.id === id);
      if (!item) { res.status(404).json({ error: '해당 전략을 찾을 수 없습니다.' }); return; }
      if (typeof body.enabled === 'boolean') item.enabled = body.enabled;
      await kvSetJson(CUSTOM_KEY, list);
      res.status(200).json({ ok: true });
      return;
    }
    if (!STRATEGY_IDS.includes(id)) { res.status(400).json({ error: '알 수 없는 전략입니다.' }); return; }
    const cfg = (await kvGetJson(CONFIG_KEY, null)) || Object.assign({}, DEFAULT_CONFIG);
    cfg.strategies = Object.assign({}, DEFAULT_CONFIG.strategies, cfg.strategies || {});
    let hidden = Array.isArray(cfg.hidden) ? cfg.hidden.slice() : [];
    if (typeof body.hidden === 'boolean') {
      hidden = hidden.filter((h) => h !== id);
      if (body.hidden) { hidden.push(id); cfg.strategies[id] = false; }
    }
    if (typeof body.enabled === 'boolean') cfg.strategies[id] = body.enabled;
    cfg.hidden = hidden;
    cfg.updatedAt = Date.now();
    await kvSetJson(CONFIG_KEY, cfg);
    res.status(200).json({ ok: true, enabled: cfg.strategies[id] !== false, hidden: hidden.includes(id) });
  } catch (e) {
    console.error('auto-trade-status.js(strategy-toggle) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== action=reset-account (가상계좌 초기화) ====================
   body: { strategyId } — 그 전략의 국내·해외 가상계좌를 처음 상태로 되돌립니다(현금=원금, 보유종목 없음).
   설정은 그대로 두고 "새 출발"만 하는 기능이라, 설정을 크게 바꾼 뒤 공정하게 다시 비교하고 싶을 때 써요.
   지난 매매 기록과 손익 캘린더는 지우지 않아요(그날그날 있었던 일이니까). "전략 변경 이력"에 기록을 남깁니다. */
async function handleResetAccount(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST만 지원합니다.' }); return; }
  const uid = await requireUid(req, res);
  if (!uid) return;
  const id = String(readBody(req).strategyId || '');
  try {
    const customList = await kvGetJson(CUSTOM_KEY, []);
    const custom = customList.find((c) => c.id === id);
    if (!STRATEGY_IDS.includes(id) && !custom) { res.status(400).json({ error: '알 수 없는 전략입니다.' }); return; }
    const kr = keysFor(id, 'KR'), us = keysFor(id, 'US');
    await Promise.all([kr.positionsKey, kr.cashKey, us.positionsKey, us.cashKey].map((k) => kvCommand(['DEL', k])));

    const name = custom ? custom.name : STRATEGY_NAMES[id];
    const changes = await kvGetJson(CHANGES_KEY, []);
    changes.unshift({
      id: Date.now() + '-reset-' + id,
      ts: Date.now(), date: todayKST(),
      strategyId: id, strategyName: name,
      source: 'manual',
      diagnosis: '사용자가 이 전략의 가상계좌를 처음 상태로 초기화했습니다. 전략 설정은 그대로예요.',
      statsAtChange: null,
      beforeDescription: '그동안 쌓인 가상계좌(현금·보유종목)',
      afterDescription: `국내 ${kr.startingCash.toLocaleString()}원 · 해외 ${us.startingCash.toLocaleString()}달러, 보유종목 없음`
    });
    if (changes.length > MAX_CHANGES) changes.length = MAX_CHANGES;
    await kvSetJson(CHANGES_KEY, changes);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('auto-trade-status.js(reset-account) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== action=calendar / calendar-day (손익 캘린더) ====================
   _ledger.js의 날짜별 장부를 읽습니다. 장부가 아직 없으면(이 기능이 생기기 전) 남아 있는 매매 기록으로 한 번 채워요. */
async function strategyNameMap() {
  const names = Object.assign({}, STRATEGY_NAMES);
  (await kvGetJson(CUSTOM_KEY, [])).forEach((c) => { names[c.id] = c.name; });
  return names;
}

async function handleCalendar(req, res) {
  const month = String(req.query.month || todayKST().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) { res.status(400).json({ error: 'month는 YYYY-MM 형식이어야 합니다.' }); return; }
  try {
    await ensureBackfilled(await kvGetJson(LOG_KEY, []));
    const [days, names] = await Promise.all([kvGetJson(DAILY_KEY_PREFIX + month, {}), strategyNameMap()]);
    res.status(200).json({ month, today: todayKST(), days, names });
  } catch (e) {
    console.error('auto-trade-status.js(calendar) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

async function handleCalendarDay(req, res) {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'date는 YYYY-MM-DD 형식이어야 합니다.' }); return; }
  try {
    const [trades, month, names] = await Promise.all([
      kvGetJson(TRADES_KEY_PREFIX + date, []), kvGetJson(DAILY_KEY_PREFIX + date.slice(0, 7), {}), strategyNameMap()
    ]);
    res.status(200).json({ date, summary: month[date] || null, trades, names });
  } catch (e) {
    console.error('auto-trade-status.js(calendar-day) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== action=ai-usage / ai-config (AI 사용량과 예산) ====================
   _ai.js가 AI를 부를 때마다 쌓아둔 사용량(토큰 × 가격)을 읽어서 설정 탭의 계기판에 보여줍니다.
   status: 마지막 실패가 마지막 성공보다 나중이면 "지금 AI가 끊긴 상태"로 보고, 이유를 쉬운 말로 알려줘요. */
async function handleAiUsage(req, res) {
  try {
    const [cfgRaw, usage, lastOk, lastError] = await Promise.all([
      kvGetJson(AI_CONFIG_KEY, null), loadAiUsage(), kvGetJson(AI_LAST_OK_KEY, null), kvGetJson(AI_LAST_ERROR_KEY, null)
    ]);
    const cfg = normalizeAiConfig(cfgRaw);
    const failing = !!(lastError && (!lastOk || lastError.at > lastOk.at));
    const features = Object.keys(AI_FEATURES).map((id) => Object.assign(
      { id, label: AI_FEATURES[id].label, heavy: AI_FEATURES[id].heavy, model: modelFor(cfg, id) },
      usage.byFeature[id] || { usd: 0, calls: 0, inTok: 0, outTok: 0, fails: 0 }
    ));
    res.status(200).json({
      month: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7),
      budgetUsd: cfg.monthlyBudgetUsd,
      totalUsd: usage.totalUsd, totalCalls: usage.totalCalls,
      features,
      models: Object.keys(AI_MODELS).map((id) => ({ id, label: AI_MODELS[id].label, inUsd: AI_MODELS[id].inUsd, outUsd: AI_MODELS[id].outUsd })),
      status: {
        failing,
        lastOkAt: lastOk ? lastOk.at : null,
        lastError: lastError ? Object.assign({}, lastError, { text: AI_REASON_TEXT[lastError.reason] || lastError.message }) : null,
        hasKey: !!process.env.ANTHROPIC_API_KEY
      }
    });
  } catch (e) {
    console.error('auto-trade-status.js(ai-usage) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

async function handleAiConfig(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST만 지원합니다.' }); return; }
  const uid = await requireUid(req, res);
  if (!uid) return;
  const body = readBody(req);
  const next = normalizeAiConfig({ monthlyBudgetUsd: body.monthlyBudgetUsd, models: body.models });
  next.updatedAt = Date.now();
  await kvSetJson(AI_CONFIG_KEY, next);
  res.status(200).json({ ok: true, config: next });
}

/* ==================== action=daytrade-config (데이트레이딩 설정) ====================
   GET : 현재 설정(없으면 기본값) + 기본값(화면의 "기본값으로" 버튼용)
   POST: 로그인한 본인만 저장. body: { daytrade } 또는 { reset: true }
   자동매매 설정(CONFIG_KEY) 안의 daytrade 칸에만 저장하고, 다른 설정은 건드리지 않습니다.
   바뀐 내용은 "전략 변경 이력"에도 남겨서, 설정을 바꾼 뒤 성과가 어땠는지 비교할 수 있게 합니다. */
async function handleDaytradeConfig(req, res) {
  if (req.method === 'GET') {
    const cfg = await kvGetJson(CONFIG_KEY, null);
    res.status(200).json({ daytrade: normalizeDaytrade(cfg && cfg.daytrade), defaults: DEFAULT_DAYTRADE });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'GET 또는 POST만 지원합니다.' });
    return;
  }
  const uid = await requireUid(req, res);
  if (!uid) return;
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  try {
    const cfg = (await kvGetJson(CONFIG_KEY, null)) || Object.assign({}, DEFAULT_CONFIG);
    const before = normalizeDaytrade(cfg.daytrade);
    const after = body.reset ? normalizeDaytrade(DEFAULT_DAYTRADE) : normalizeDaytrade(body.daytrade);
    cfg.daytrade = after;
    cfg.updatedAt = Date.now();
    const ok = await kvSetJson(CONFIG_KEY, cfg);
    if (!ok) {
      res.status(500).json({ error: '설정 저장에 실패했습니다.' });
      return;
    }

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const changes = await kvGetJson(CHANGES_KEY, []);
      changes.unshift({
        id: Date.now() + '-daytrade',
        ts: Date.now(), date: todayKST(),
        strategyId: 'daytrade', strategyName: STRATEGY_NAMES.daytrade,
        source: 'manual',
        diagnosis: body.reset ? '사용자가 데이트레이딩 설정을 기본값으로 되돌렸습니다.' : '사용자가 데이트레이딩 설정을 직접 수정했습니다.',
        statsAtChange: null,
        beforeDescription: describeDaytrade(before),
        afterDescription: describeDaytrade(after)
      });
      if (changes.length > MAX_CHANGES) changes.length = MAX_CHANGES;
      await kvSetJson(CHANGES_KEY, changes);
    }

    res.status(200).json({ ok: true, daytrade: after });
  } catch (e) {
    console.error('auto-trade-status.js(daytrade-config) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
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
  const editableIds = STRATEGY_IDS.filter((id) => !WEIGHT_BASED_IDS.includes(id) && !OWN_SETTINGS_IDS.includes(id));
  if (!editableIds.includes(strategyId)) {
    res.status(400).json({ error: '수동 편집은 내장 전략(진화형/시장적응형/데이트레이딩 제외)에만 적용할 수 있습니다. 데이트레이딩은 "데이트레이딩 설정"에서 바꿔주세요.' });
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

// 보유 종목의 손익을 "지금 팔면 실제로 남는 돈" 기준으로 계산합니다:
// (현재가×수량 − 예상 매도비용[수수료·거래세·환전]) − (매수금액 + 매수비용)
function fillNetPnl(pos, costs, market, price, digits) {
  const round = (v) => Math.round(v * digits) / digits;
  const basis = positionCostBasis(costs, market, pos);
  const sell = planSell(costs, market, pos.qty, price);
  pos.currentPrice = price;
  pos.evalAmount = round(sell.gross);
  pos.netEvalAmount = round(sell.proceeds);
  pos.costBasis = round(basis);
  pos.unrealizedPnlAmount = round(sell.proceeds - basis);
  pos.unrealizedPnlPct = Math.round(((sell.proceeds - basis) / basis) * 10000) / 100;
}

// 보유 종목에 현재가/평가금액/미실현 손익(%,금액)을 채워 넣습니다. 시세 조회는 종목당 한 번만(캐시 공유).
async function attachLivePrices(strategies, token, costs) {
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
      if (q && q.price !== null) fillNetPnl(pos, costs, 'KR', q.price, 1);
    }
    for (const symbol of Object.keys(s.us.positions || {})) {
      const pos = s.us.positions[symbol];
      const q = await getUs(symbol, pos.excd);
      if (q && q.price !== null) fillNetPnl(pos, costs, 'US', q.price, 100);
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

    const costs = await loadCosts();
    const hasAnyPosition = Object.values(strategies).some((s) => Object.keys(s.kr.positions || {}).length || Object.keys(s.us.positions || {}).length);
    if (hasAnyPosition && process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET) {
      try {
        const token = await getKisToken();
        await attachLivePrices(strategies, token, costs);
      } catch (e) {
        console.error('auto-trade-status.js(log) live price error:', e);
      }
    }

    const log = await kvGetJson(LOG_KEY, []);

    // 올해 실현손익(전략별 가상계좌 기준)과 해외주식 양도세 추정치.
    // 매매 기록(log)은 최근 400건까지만 남기 때문에, 1년치 합계는 auto-trade-check.js가 매도할 때마다
    // 따로 누적해두는 연간 장부(REALIZED_KEY_PREFIX+연도)에서 읽습니다. 달러 손익은 매도 당시 환율로 원화 환산돼 있어요.
    const year = todayKST().slice(0, 4);
    const realized = await kvGetJson(REALIZED_KEY_PREFIX + year, {});
    const taxByStrategy = {};
    Object.keys(realized || {}).forEach((id) => {
      const r = realized[id] || {};
      taxByStrategy[id] = Object.assign({
        usPnlUsd: Math.round((r.usPnlUsd || 0) * 100) / 100,
        usPnlKrw: Math.round(r.usPnlKrw || 0),
        krPnlKrw: Math.round(r.krPnlKrw || 0),
        usTrades: r.usTrades || 0,
        krTrades: r.krTrades || 0
      }, estimateOverseasTax(costs, r.usPnlKrw || 0));
    });

    // "오늘 단타 성적" — 화면에 보내는 log는 최근 80건뿐이라, 하루 매매가 많아도 정확하도록 전체 log에서 여기서 계산합니다.
    const today = todayKST();
    const dtToday = log.filter((e) => e.strategy === 'daytrade' && e.date === today);
    const dtSells = dtToday.filter((e) => isSellSide(e.side));
    const daytradeToday = {
      date: today,
      buys: dtToday.filter((e) => e.side === 'BUY').length,
      sells: dtSells.length,
      wins: dtSells.filter((e) => e.pnlPct > 0).length,
      pnlAmount: Math.round(dtSells.reduce((a, e) => a + (e.pnlAmount || 0), 0)),
      feeAmount: Math.round(dtToday.reduce((a, e) => a + (e.fee || 0), 0)) // 수수료·세금·슬리피지 합계
    };

    res.status(200).json({
      strategies,
      costs,
      daytradeToday,
      taxSummary: { year, byStrategy: taxByStrategy },
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
      const after = log.filter((e) => e.strategy === c.strategyId && isSellSide(e.side) && e.ts > c.ts);
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
  if (action === 'cost-config') return handleCostConfig(req, res);
  if (action === 'daytrade-config') return handleDaytradeConfig(req, res);
  if (action === 'strategies') return handleStrategies(req, res);
  if (action === 'strategy-toggle') return handleStrategyToggle(req, res);
  if (action === 'reset-account') return handleResetAccount(req, res);
  if (action === 'calendar') return handleCalendar(req, res);
  if (action === 'calendar-day') return handleCalendarDay(req, res);
  if (action === 'ai-usage') return handleAiUsage(req, res);
  if (action === 'ai-config') return handleAiConfig(req, res);
  return handleConfig(req, res);
}
