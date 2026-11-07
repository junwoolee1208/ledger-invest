// /api/_strategies.js
// 내장 전략의 "이름"과 "기본 위험 규칙(손절/익절/비중/하루 한도)"을 한 곳에 모았습니다.
// 매매 엔진(auto-trade-check.js)과 설정·현황 화면(auto-trade-status.js)이 같은 값을 보도록 공유해요.
// (예전엔 두 파일에 따로 적혀 있어서, 한쪽만 고치면 화면에 보이는 숫자와 실제 매매 규칙이 어긋날 수 있었어요.)
// _로 시작해서 Vercel 함수 개수에 안 잡혀요.

// 화면에 보여줄 순서 그대로입니다.
export const STRATEGY_IDS = ['momentum', 'pullback', 'breakout', 'reversal', 'scalp', 'selective', 'wideswing', 'baseline', 'daytrade', 'evolved', 'regime-adaptive', 'opening-breakout', 'vwap-pullback', 'longterm',
  'staged-dip', 'dip-rebound', 'dip-nextday', 'inverse'];

export const STRATEGY_NAMES = {
  momentum: '모멘텀(추세 추종)', pullback: '눌림목(과열 회피)', breakout: '강한 돌파',
  reversal: '역추세(저가 반등)', scalp: '초단타(잦은 매매)', selective: '신중한 선별(엄격)',
  wideswing: '광폭 스윙(길게 보유)', baseline: '기준선(대조군)', daytrade: '데이트레이딩(당일 청산)',
  evolved: '진화형(자동탐색)', 'regime-adaptive': '시장적응형(구간별 자동전환)',
  'opening-breakout': '장 초반 돌파', 'vwap-pullback': '강한 종목 눌림', longterm: '장기 분산(시가총액 상위)',
  'staged-dip': '단계별 저점 매수', 'dip-rebound': '급락 반등 단타', 'dip-nextday': '급락 다음날 매수', inverse: '인버스 ETF(하락장)'
};

// 하락장 전략: 하락장이거나 시장이 크게 빠지는 날 움직여요. 화면에서는 "하락장" 묶음으로 따로 보여줘요.
export const BEAR_IDS = ['dip-rebound', 'dip-nextday', 'inverse'];

// 전략 구성(2026-11-08, 고정 50종목 전환). 저장된 설정의 lineup이 이 번호가 아니면 아래 기본 켜짐/꺼짐을 써요.
// 예전 켜짐 값을 그대로 쓰면 14개가 다시 다 켜지므로, 번호로 "새 구성"인지 구분해요. 카드에서 스위치를 누르면 그때부터 저장된 값을 따라요.
// 꺼진 전략도 기록은 남아 있고, 언제든 다시 켤 수 있어요.
export const LINEUP_VERSION = 2;
export const LINEUP_DEFAULTS = {
  daytrade: true, scalp: true, 'vwap-pullback': true, 'opening-breakout': true, 'staged-dip': true,
  momentum: true, evolved: true,
  'dip-rebound': true, 'dip-nextday': true, inverse: true,
  baseline: true,
  pullback: false, breakout: false, reversal: false, selective: false, wideswing: false, 'regime-adaptive': false, longterm: false
};
export function enabledMapOf(cfg) {
  const c = cfg || {};
  if (c.lineup === LINEUP_VERSION && c.strategies) return Object.assign({}, LINEUP_DEFAULTS, c.strategies);
  return Object.assign({}, LINEUP_DEFAULTS);
}
export function strategyEnabled(cfg, id) {
  return enabledMapOf(cfg)[id] !== false;
}

// 보유 기간으로 나눈 갈래. 채점표와 화면이 같은 갈래끼리 묶어서 보여줘요. 기준선(base)은 어느 갈래에도 넣지 않아요.
export const HORIZONS = ['day', 'swing', 'long'];
const BUILTIN_HORIZON = {
  daytrade: 'day', scalp: 'day', 'opening-breakout': 'day', 'vwap-pullback': 'day',
  momentum: 'swing', pullback: 'swing', breakout: 'swing', reversal: 'swing', selective: 'swing', wideswing: 'swing',
  evolved: 'swing', 'regime-adaptive': 'swing', longterm: 'long', baseline: 'base',
  'staged-dip': 'day', 'dip-rebound': 'day', 'dip-nextday': 'swing', inverse: 'swing'
};
export function normalizeHorizon(v) {
  return HORIZONS.includes(v) ? v : 'swing'; // 갈래를 고르기 전에 저장한 내 전략은 며칠씩 들고 가던 대로 스윙이에요
}
export function horizonOf(id, customList) {
  if (BUILTIN_HORIZON[id]) return BUILTIN_HORIZON[id];
  const c = (customList || []).find((x) => x.id === id);
  return normalizeHorizon(c && c.horizon);
}

// 스윙 전략의 최대 보유 기간. 오래 물려 있는 돈이 새 기회를 막지 않게 해요.
export const SWING_MAX_HOLD_DAYS = 20;
// 두 날짜 사이의 평일 수(거래일 근사). 공휴일 달력은 없어서 공휴일도 하루로 세요.
export function weekdaysBetween(fromIso, toIso) {
  const from = Date.parse(fromIso), to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  let days = 0;
  for (let t = from + 86400000; t <= to; t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) days++;
  }
  return days;
}

// 가중치 점수로 사는 전략 — 손절/익절이 전략연구실 탐색 결과를 그대로 따라가서 직접 수정 대상이 아님
export const WEIGHT_BASED_IDS = ['evolved', 'regime-adaptive'];
// 자기 전용 설정 화면이 있는 전략 — 일반 손절/익절 수정 대신 그 화면에서만 바꿈
// 규칙이 코드에 고정된 전략 — 표본이 쌓이기 전에 숫자가 바뀌면 효과를 판단할 수 없어서, 수동 수정·AI 자동조정 대상에서 빼요
export const FIXED_RULE_IDS = ['opening-breakout', 'vwap-pullback', 'longterm', 'staged-dip', 'dip-rebound', 'dip-nextday', 'inverse'];
export const OWN_SETTINGS_IDS = ['daytrade', ...FIXED_RULE_IDS];

// 고정 규칙 전략들의 기본값. momentum은 자동매매 설정(cfg.risk)을 기본으로 쓰고, 없을 때만 아래 값을 씁니다.
// 실제 매매에는 이 위에 "수동 수정/AI 자동조정" 값(오버라이드)이 덮어써져요.
export const BASE_RISK = {
  momentum: { positionPct: 5, stopLossPct: 5, takeProfitPct: 10, maxTradesPerDay: 3 },
  pullback: { positionPct: 5, stopLossPct: 4, takeProfitPct: 8, maxTradesPerDay: 3 },
  breakout: { positionPct: 5, stopLossPct: 7, takeProfitPct: 15, maxTradesPerDay: 2 },
  reversal: { positionPct: 4, stopLossPct: 3, takeProfitPct: 6, maxTradesPerDay: 3 },
  scalp: { positionPct: 3, stopLossPct: 2, takeProfitPct: 3, maxTradesPerDay: 8 },
  selective: { positionPct: 8, stopLossPct: 5, takeProfitPct: 12, maxTradesPerDay: 2 },
  wideswing: { positionPct: 5, stopLossPct: 10, takeProfitPct: 25, maxTradesPerDay: 2 },
  baseline: { positionPct: 5, stopLossPct: 5, takeProfitPct: 10, maxTradesPerDay: 3 },
  // 새 전략(규칙 고정). 단계별 저점 매수의 비중은 세 번 나눠 사는 "전체" 금액이에요.
  'staged-dip': { positionPct: 15, stopLossPct: 3, takeProfitPct: 3, maxTradesPerDay: 4 },
  'dip-nextday': { positionPct: 10, stopLossPct: 4, takeProfitPct: 8, maxTradesPerDay: 3 },
  inverse: { positionPct: 30, stopLossPct: 3, takeProfitPct: 15, maxTradesPerDay: 1 }
};

// 모든 전략 공통 안전장치(2026-11 손실 분석에서 정한 값)
export const COMMON_RULES = {
  dailyLossLimitPct: 1.5, // 오늘 확정 손실이 원금의 1.5%에 닿으면 그 전략은 그날 더 사지 않아요
  swingMaxExposurePct: 30, // 며칠씩 들고 가는 종목은 계좌의 30%까지만(밤사이 급락 대비)
  riskCutIndexPct: -2, // 장 마감 전 코스피200이 이보다 낮으면 스윙 보유분의 절반을 미리 팔아요
  riskCutFromMin: 15 * 60 // 15:00부터 판단
};

export const STARTING_CASH_KR = 10_000_000; // 가상 원화 자금
export const STARTING_CASH_US = 7_000; // 가상 달러 자금

// 전략별 가상계좌(현금/보유종목)가 저장된 KV 키.
// momentum은 예전부터 쌓인 데이터를 그대로 이어가도록 옛 키를 그대로 씁니다.
export function keysFor(strategyId, marketKey) {
  if (strategyId === 'momentum') {
    return marketKey === 'KR'
      ? { positionsKey: 'autotrade:positions', cashKey: 'autotrade:cash', startingCash: STARTING_CASH_KR }
      : { positionsKey: 'autotrade:positions:usd', cashKey: 'autotrade:cash:usd', startingCash: STARTING_CASH_US };
  }
  return marketKey === 'KR'
    ? { positionsKey: `autotrade:strategy:${strategyId}:positions:kr`, cashKey: `autotrade:strategy:${strategyId}:cash:kr`, startingCash: STARTING_CASH_KR }
    : { positionsKey: `autotrade:strategy:${strategyId}:positions:us`, cashKey: `autotrade:strategy:${strategyId}:cash:us`, startingCash: STARTING_CASH_US };
}
