// /api/_strategies.js
// 내장 전략의 "이름"과 "기본 위험 규칙(손절/익절/비중/하루 한도)"을 한 곳에 모았습니다.
// 매매 엔진(auto-trade-check.js)과 설정·현황 화면(auto-trade-status.js)이 같은 값을 보도록 공유해요.
// (예전엔 두 파일에 따로 적혀 있어서, 한쪽만 고치면 화면에 보이는 숫자와 실제 매매 규칙이 어긋날 수 있었어요.)
// _로 시작해서 Vercel 함수 개수에 안 잡혀요.

// 화면에 보여줄 순서 그대로입니다.
export const STRATEGY_IDS = ['momentum', 'pullback', 'breakout', 'reversal', 'scalp', 'selective', 'wideswing', 'baseline', 'daytrade', 'evolved', 'regime-adaptive'];

export const STRATEGY_NAMES = {
  momentum: '모멘텀(추세 추종)', pullback: '눌림목(과열 회피)', breakout: '강한 돌파',
  reversal: '역추세(저가 반등)', scalp: '초단타(잦은 매매)', selective: '신중한 선별(엄격)',
  wideswing: '광폭 스윙(길게 보유)', baseline: '기준선(대조군)', daytrade: '데이트레이딩(당일 청산)',
  evolved: '진화형(자동탐색)', 'regime-adaptive': '시장적응형(구간별 자동전환)'
};

// 가중치 점수로 사는 전략 — 손절/익절이 전략연구실 탐색 결과를 그대로 따라가서 직접 수정 대상이 아님
export const WEIGHT_BASED_IDS = ['evolved', 'regime-adaptive'];
// 자기 전용 설정 화면이 있는 전략 — 일반 손절/익절 수정 대신 그 화면에서만 바꿈
export const OWN_SETTINGS_IDS = ['daytrade'];

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
  baseline: { positionPct: 5, stopLossPct: 5, takeProfitPct: 10, maxTradesPerDay: 3 }
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
