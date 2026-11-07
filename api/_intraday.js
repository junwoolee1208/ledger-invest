// /api/_intraday.js
// 하루 안에 사고파는 새 단타 전략(장 초반 돌파, 강한 종목 눌림)의 판단 규칙입니다.
// 저장소·시세 조회 없이 계산만 해서 시험하기 쉽게 따로 뒀어요. _로 시작해서 Vercel 함수 개수에 안 잡혀요.
//
// 왜 손절폭을 종목마다 다르게 하나: 등락이 큰 종목에 좁은 손절을 쓰면 평범한 흔들림에도 바로 팔려요.
// 그래서 오늘 변동폭에 맞춰 손절을 넓히되, 그만큼 사는 금액을 줄여서 한 번 손절로 잃는 돈은 비슷하게 맞춰요.

export const INTRADAY_STATE_KEY = 'autotrade:intraday-state'; // { date, ranges: {종목:{high,low}}, touches: {종목:시각} }

// 새 단타 전략 2개의 규칙. 14:30 뒤에 사면 목표가까지 갈 시간이 짧아서 그때부터는 안 사요.
export const INTRADAY_RULES = {
  buyStart: '09:31', buyEnd: '14:30', closeAt: '15:10',
  // 재매수 대기는 10분이에요. 대신 "다른 근거"가 있어야 다시 사요(_bear.js reentryAllowed).
  dailyLossLimitPct: 1.5, cooldownMin: 10, maxBuysPerDay: 6, maxPositions: 4
};

// 사는 조건은 그대로 두고 "당일 청산"만 더하는 전략(초단타, 단타로 저장한 내 전략)의 규칙.
// 하루 손실 한도는 모든 전략 공통 1.5%(_strategies.js COMMON_RULES)를 따르고, 재매수 대기는 공통 10분이에요.
export const DAY_CLOSE_RULES = {
  buyStart: '09:00', buyEnd: '15:00', closeAt: '15:10', dailyLossLimitPct: null, cooldownMin: 0
};

const RISK_PER_TRADE_PCT = 0.5; // 한 번 손절할 때 계좌에서 잃는 비율 목표
const MIN_STOP_PCT = 1;
const MAX_STOP_PCT = 4;
const MAX_POSITION_PCT = 25; // 한 종목에 계좌의 25%를 넘기지 않아요
const TAKE_PROFIT_MULTIPLE = 2; // 익절폭 = 손절폭의 2배

const RANGE_START_MIN = 9 * 60 + 30;
const RANGE_END_MIN = 9 * 60 + 40; // 이보다 늦게 처음 본 종목은 "장 초반 최고가"를 알 수 없어서 기록하지 않아요
const VWAP_TOUCH_LOW = 0.99; // 평균 체결가의 99%까지는 "닿았다"로 봐요(그 아래는 흐름이 무너진 것일 수 있어요)
const VWAP_RECLAIM = 1.003; // 평균 체결가보다 0.3% 위로 올라서야 "다시 올라섰다"로 봐요
const VWAP_MAX_CHASE = 1.015; // 평균 체결가에서 1.5% 넘게 멀어졌으면 이미 늦었다고 봐요
const TOUCH_VALID_MS = 30 * 60 * 1000; // 닿은 지 30분이 지나면 다른 흐름으로 봐요
const TOUCH_REFRESH_MS = 15 * 60 * 1000; // 저장소 쓰기를 줄이려고 닿은 시각은 15분에 한 번만 새로 적어요
const BREAKOUT_MAX_CHASE = 1.01; // 장 초반 최고가보다 1% 넘게 오른 뒤에는 쫓아가지 않아요
const BREAKOUT_MAX_CHANGE_PCT = 20; // 상한가(+30%)에 가까운 종목은 사고팔기 어려워요
const PULLBACK_MIN_CHANGE_PCT = 3;
const PULLBACK_MAX_CHANGE_PCT = 15;

const round1 = (v) => Math.round(v * 10) / 10;

// 오늘 변동폭의 절반을 손절폭으로 쓰고, 손절폭에 맞춰 살 금액을 정해요.
export function sizeByVolatility(q, accountValue, cash) {
  if (!q.open || !q.high || !q.low) return null;
  const dayRangePct = ((q.high - q.low) / q.open) * 100;
  const stopPct = round1(Math.max(MIN_STOP_PCT, Math.min(MAX_STOP_PCT, dayRangePct / 2)));
  const positionPct = Math.min(MAX_POSITION_PCT, (RISK_PER_TRADE_PCT / stopPct) * 100);
  return {
    stopPct,
    takePct: round1(stopPct * TAKE_PROFIT_MULTIPLE),
    budget: Math.min(cash, accountValue * (positionPct / 100))
  };
}

// 시세를 보고 오늘의 장 초반 범위와 "평균 체결가에 닿은 시각"을 갱신해요. 바뀐 게 있을 때만 dirty=true(그때만 저장).
export function updateIntradayState(saved, quotes, minutes, today, nowMs) {
  const fresh = !saved || saved.date !== today;
  const state = fresh ? { date: today, ranges: {}, touches: {} } : saved;
  let dirty = fresh;
  for (const q of quotes) {
    if (minutes >= RANGE_START_MIN && minutes <= RANGE_END_MIN && !state.ranges[q.symbol] && q.high && q.low) {
      state.ranges[q.symbol] = { high: q.high, low: q.low };
      dirty = true;
    }
    if (minutes < RANGE_START_MIN || !q.vwap || q.changePct === null) continue;
    const strong = q.changePct >= PULLBACK_MIN_CHANGE_PCT && q.changePct <= PULLBACK_MAX_CHANGE_PCT;
    const touching = q.price >= q.vwap * VWAP_TOUCH_LOW && q.price < q.vwap * VWAP_RECLAIM;
    const last = state.touches[q.symbol] || 0;
    if (strong && touching && nowMs - last >= TOUCH_REFRESH_MS) {
      state.touches[q.symbol] = nowMs;
      dirty = true;
    }
  }
  return { state, dirty };
}

// 전략 A: 장 초반(09:30까지) 최고가를 넘었고, 평균 체결가보다 위에 있을 때
export function breakoutSignal(q, state) {
  const range = state && state.ranges && state.ranges[q.symbol];
  if (!range || !q.vwap || q.changePct === null) return false;
  return q.price > range.high && q.price <= range.high * BREAKOUT_MAX_CHASE &&
    q.price > q.vwap && q.changePct <= BREAKOUT_MAX_CHANGE_PCT;
}

// 전략 B: 오늘 강한 종목이 평균 체결가까지 내려왔다가(최근 30분 안) 다시 올라섰을 때
export function pullbackSignal(q, state, nowMs) {
  const touchedAt = state && state.touches && state.touches[q.symbol];
  if (!touchedAt || !q.vwap || q.changePct === null) return false;
  if (nowMs - touchedAt > TOUCH_VALID_MS) return false;
  return q.changePct >= PULLBACK_MIN_CHANGE_PCT && q.changePct <= PULLBACK_MAX_CHANGE_PCT &&
    q.price >= q.vwap * VWAP_RECLAIM && q.price <= q.vwap * VWAP_MAX_CHASE;
}
