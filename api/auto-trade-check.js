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
// 자동매매 종목은 고정 50종목(_universe.js)이에요(2026-11-08부터). 관심종목·해외 종목은 새로 사지 않고,
// 이미 들고 있던 해외 종목은 보유 종목 점검(손절·익절)으로 정리돼요.
// 사는 방법·파는 방법은 _methods.js, 시장 필터·하락장 전략·재매수 규칙은 _bear.js에 있어요.
//
// 보안: 아무나 이 URL을 호출해서 매매를 조작하지 못하도록, 쿼리 파라미터 key가
// 환경변수 AUTO_TRADE_SECRET과 일치할 때만 동작합니다.

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';
import { kvGetJson, kvSetJson, kvMGetJson, kvMSetJson, kvReady } from './_kv.js';
import { fetchSymbolHistory, annotateWithFactors, scoreForStrategy, classifyRegimeByDate } from './_backtest-core.js';
import { normalizeCosts, COST_CONFIG_KEY, planBuy, planSell, positionCostBasis, fetchUsdKrw, REALIZED_KEY_PREFIX } from './_costs.js';
import { normalizeDaytrade, hhmmToMin } from './_daytrade.js';
import { BASE_RISK, keysFor, STARTING_CASH_US, SWING_MAX_HOLD_DAYS, weekdaysBetween, normalizeHorizon, COMMON_RULES, strategyEnabled } from './_strategies.js';
import { universeCandidates, INVERSE_ETF } from './_universe.js';
import { METHODS_KEY, methodOf, normalizeMethod, exitDecision, addDecision, applyAdd, firstBuyShare, newPositionFields } from './_methods.js';
import {
  fetchIndexQuote, marketGate, stagedDipSignal, dipReboundSignal, dipNextDaySignal, inverseSignal, inverseShouldExit,
  reentryAllowed, REENTRY, DIP_NEXTDAY, INVERSE_RULE
} from './_bear.js';
import {
  INTRADAY_STATE_KEY, INTRADAY_RULES, DAY_CLOSE_RULES, sizeByVolatility, updateIntradayState, breakoutSignal, pullbackSignal
} from './_intraday.js';
import {
  LONGTERM_STATE_KEY, MIN_TARGETS, rebalanceDue, indexUpdateDue, planRebalance, fetchLongTermTargets, fetchKospi200
} from './_longterm.js';
import { isSellSide, recordEntries, ensureBackfilled } from './_ledger.js';
import { askClaude, extractJson } from './_ai.js'; // AI 호출 공용 창구(사용량·예산·실패 이유 기록)
import { RESET_INFO_KEY } from './_reset.js';
import {
  EXPERIMENTS_KEY, BEST_RISK_KEY, FLAGS_KEY, MAX_EXPERIMENTS, LEARN, RISK_FIELDS, RISK_LABELS,
  summarize, clampProposal, liftToFloors, judge, readyToJudge, forbiddenDirections, applyForbidden, lessonLine
} from './_learning.js';
import { DEEPEVAL_LATEST_KEY } from './_deepeval.js';

export const config = { maxDuration: 30 };

const CONFIG_KEY = 'autotrade:config';
const LOG_KEY = 'autotrade:log';
const MAX_LOG = 400;

// ---- 전략 자동 조정(설정한 주기마다, "전략 변경 이력" 탭에서 보이는 기록) ----
const OVERRIDES_KEY = 'autotrade:strategy-overrides'; // 전략별로 자동 조정된 손절/익절/비중/매매한도
const CHANGES_KEY = 'autotrade:strategy-changes'; // 왜/어떻게/언제 바꿨는지 기록 (auto-trade-status.js / backtest.js도 같은 키를 씀)
const ADJUST_LASTRUN_KEY = 'autotrade:strategy-adjust:lastrun';
const MAX_CHANGES = 200;

// ---- 진화형(자동탐색) 전략 — 전략연구실의 "진화형 탐색"이 찾아낸 최신 조합을 실시간으로 그대로 따라감 ----
const EVOLVE_KEY = 'backtest:evolution:v2'; // backtest.js와 같은 키 — 거기서 갱신한 globalBest를 여기서 읽기만 함
const EVOLVED_FACTOR_LOOKBACK_DAYS = 40; // 이동평균/RSI 계산에 필요한 최소한의 과거 일봉
// 종목별 팩터는 "하루치 일봉" 기준이라 같은 날 안에서는 바뀌지 않습니다. 외부 스케줄러가 몇 분 간격으로
// 자주 호출해도, 하루에 한 번만 계산해서 캐시해두고 재사용합니다(새 후보가 생기면 그 종목만 추가 계산).
const EVOLVED_FACTORS_KEY = 'autotrade:evolved-factors:cache';

// ---- 커스텀 전략 — 사용자가 전략연구실의 "진화형 탐색" 결과를 이름 붙여 저장해둔 것 ----
// "진화형(자동탐색)"과 완전히 같은 가중치 점수 매수 로직을 쓰고(그래서 국내 종목만 지원), 다른 점은
// backtest.js가 계속 갱신하는 최신 globalBest를 "그대로" 따르지 않고, 저장했던 시점의 조합을 그대로 고정해서 쓴다는 것입니다.
const CUSTOM_STRATEGIES_KEY = 'autotrade:custom-strategies'; // auto-trade-status.js와 같은 키

// ---- 시장적응형(regime) 전략 — 오늘의 시장 상황(상승/하락/횡보 × 평온/고변동)을 분류해서, backtest.js가
// 그 구간 전용으로 찾아둔 전략을 그날그날 갈아 끼웁니다 ----
const REGIME_KEY_PREFIX = 'backtest:evolution:regime:'; // backtest.js와 같은 키
const REGIME_CACHE_KEY = 'autotrade:regime:cache'; // 오늘 시장 상황 분류 결과 캐시(하루 1번만 계산)
const REGIME_LASTUSED_KEY = 'autotrade:regime:lastused'; // 구간이 바뀌었는지 비교해서 "전략 변경 이력"에 남기기 위함
const REGIME_SAMPLE_SIZE = 10; // 시장 상황 분류용으로 쓸 종목 수(너무 많이 돌리지 않도록 상한)
const REGIME_LOOKBACK_DAYS = 30; // trend(20일 누적수익률)+volatility 계산에 필요한 최소 기간
const REGIME_KOREAN = { bull: '상승장', bear: '하락장', sideways: '횡보장', calm: '평온', turbulent: '고변동' };
function regimeLabelKo(label) {
  const [trend, vol] = label.split('-');
  return (REGIME_KOREAN[trend] || trend) + '·' + (REGIME_KOREAN[vol] || vol);
}

// 오늘의 시장 상황(구간)을 분류합니다. 하루 안에서는 결과가 바뀌지 않으니 캐시해서 재사용합니다
// (진화형 팩터 캐시와 같은 원칙 — EVOLVED_FACTORS_KEY 주석 참고).
async function classifyTodayRegime(token, krCandidates, today, cached) {
  if (cached && cached.date === today) return cached.label;

  const sample = krCandidates.slice(0, REGIME_SAMPLE_SIZE);
  const symbolMaps = {};
  const dateSet = new Set();
  for (const cand of sample) {
    try {
      const hist = await fetchSymbolHistory(token, cand.symbol, REGIME_LOOKBACK_DAYS);
      if (hist.length < 20) continue;
      const annotated = annotateWithFactors(hist);
      const map = new Map();
      annotated.forEach((row) => { map.set(row.date, row); dateSet.add(row.date); });
      symbolMaps[cand.symbol] = map;
    } catch (e) {
      // 한 종목 실패해도 나머지로 계속 진행
    }
  }
  const dates = Array.from(dateSet).sort();
  const label = dates.length >= 20 ? (classifyRegimeByDate(symbolMaps, dates).get(dates[dates.length - 1]) || 'sideways-calm') : 'sideways-calm';
  await kvSetJson(REGIME_CACHE_KEY, { date: today, label });
  return label;
}

// 거래대금 상위에서 고른 후보인지(관심종목보다 조금 낮은 상승률에서도 삽니다).
function isRankCand(cand) {
  return cand.reason.indexOf('거래대금') === 0;
}

// 전략별 정의 — 매수 트리거(shouldBuy)와 리스크 규칙(risk)이 서로 다릅니다.
// momentum은 사용자가 설정 화면에서 조절하는 cfg.risk를 그대로 쓰고(기존 동작 유지),
// 나머지는 "경쟁 비교"가 목적이라 비교 기준이 흔들리지 않도록 고정값(_strategies.js의 BASE_RISK)을 씁니다.
// baseline(기준선)은 조건 없이 후보를 그대로 사는 전략으로, 다른 전략들이 "그냥 아무거나 사는 것"보다
// 실제로 나은지를 판단하는 비교 기준(대조군) 역할을 합니다.
// horizon: 보유 기간 갈래(day=당일 청산, swing=최대 20거래일, base=비교용).
// ownRules: 규칙을 사용자 설정이나 코드가 정해서 AI 자동조정·수동 수정 값을 덮어쓰지 않는 전략.
const STRATEGY_DEFS = [
  {
    id: 'momentum',
    name: '모멘텀(추세 추종)',
    horizon: 'swing',
    getRisk: (cfg) => Object.assign({}, BASE_RISK.momentum, cfg.risk || {}),
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isRankCand(cand) ? 1 : 3)
  },
  {
    id: 'pullback',
    name: '눌림목(과열 회피)',
    horizon: 'swing',
    getRisk: () => BASE_RISK.pullback,
    // 이미 많이 오른 급등주보다, 완만하게 움직이기 시작한(0~2%) 종목을 선호합니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct > 0 && q.changePct <= 2
  },
  {
    id: 'breakout',
    name: '강한 돌파',
    horizon: 'swing',
    getRisk: () => BASE_RISK.breakout,
    // 더 강한 상승 모멘텀만 선택하고, 손절/익절 폭도 더 크게 잡아 추세를 오래 태웁니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isRankCand(cand) ? 4 : 6)
  },
  {
    id: 'reversal',
    name: '역추세(저가 반등)',
    horizon: 'swing',
    getRisk: () => BASE_RISK.reversal,
    // 최근 하락폭이 있는(-2%~-6%) 종목의 단기 반등을 노립니다. 실패 시 빨리 손절하도록 폭을 좁게 잡습니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct <= -2 && q.changePct >= -6
  },
  {
    id: 'scalp',
    name: '초단타(잦은 매매)',
    horizon: 'day',
    // 잦게 사고파는 전략이라 단타로 옮겼어요. 사는 조건은 그대로이고 장 마감 전에 모두 팔아요.
    // 미국장은 한국 날짜가 자정에 바뀌어서 "오늘 산 종목" 판단이 어긋나므로, 다른 단타처럼 국내만 해요.
    intraday: true,
    krOnly: true,
    dayRules: () => DAY_CLOSE_RULES,
    getRisk: () => BASE_RISK.scalp,
    // 문턱을 낮춰 자주 매매하고, 손절/익절 폭도 아주 좁게 잡아 빠르게 치고 빠집니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isRankCand(cand) ? 0.5 : 1.5)
  },
  {
    id: 'selective',
    name: '신중한 선별(엄격)',
    horizon: 'swing',
    getRisk: () => BASE_RISK.selective,
    // 아주 강한 조건에서만 매매하되, 한 번 살 때 비중을 크게 실어(8%) 소수 정예로 갑니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isRankCand(cand) ? 2.5 : 4)
  },
  {
    id: 'wideswing',
    name: '광폭 스윙(길게 보유)',
    horizon: 'swing',
    getRisk: () => BASE_RISK.wideswing,
    // 모멘텀과 매수 조건은 비슷하지만, 손절/익절 폭을 훨씬 넓게 잡아 추세를 오래 들고 갑니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isRankCand(cand) ? 1.5 : 3)
  },
  {
    id: 'baseline',
    name: '기준선(대조군, 조건 없음)',
    horizon: 'base',
    getRisk: () => BASE_RISK.baseline,
    // 등락률 조건 없이 후보에 오르면 그냥 삽니다 — 다른 전략들이 "무조건 사는 것"보다 실제로 나은지 비교하는 대조군.
    shouldBuy: () => true
  },
  {
    id: 'daytrade',
    name: '데이트레이딩(당일 청산)',
    // 다른 전략은 며칠씩 들고 가는 "스윙"이고, 이 전략만 하루 안에 사고팔고 장 마감 전에 전부 정리합니다.
    // 국내 종목만 지원(미국장은 한국 시간 밤이라 우선 국내로 검증).
    // 모든 숫자(사는 조건·시간·손절/익절·손실한도·매수 횟수)는 사용자가 "데이트레이딩 설정"에서 정한 값(cfg.daytrade)을 따르고,
    // 기본값은 _daytrade.js에 있어요. 그래서 AI 자동조정·수동 수정 대상에서는 빠집니다(설정이 한 곳에서만 바뀌도록).
    horizon: 'day',
    ownRules: true,
    intraday: true,
    krOnly: true,
    dayRules: (cfg) => normalizeDaytrade(cfg.daytrade),
    getRisk: (cfg) => {
      const s = normalizeDaytrade(cfg.daytrade);
      return { positionPct: s.positionPct, stopLossPct: s.stopLossPct, takeProfitPct: s.takeProfitPct, maxTradesPerDay: s.maxBuysPerDay };
    },
    // 전일 종가가 아니라 "오늘 시가 대비" 정해둔 범위만큼 오르고, 오늘 고가에서 많이 밀리지 않은(버티는) 종목만 삽니다.
    // 전일 대비 너무 급등한 종목은 상한가 근처라 변동이 커서 피합니다.
    shouldBuy: (cand, q, cfg) => {
      if (!q.open || !q.high || q.changePct === null) return false;
      const s = normalizeDaytrade(cfg.daytrade);
      const fromOpenPct = ((q.price - q.open) / q.open) * 100;
      const offHighPct = ((q.high - q.price) / q.high) * 100;
      return fromOpenPct >= s.minFromOpenPct && fromOpenPct <= s.maxFromOpenPct &&
        offHighPct <= s.maxOffHighPct && q.changePct <= s.maxChangePct;
    }
  },
  ...[
    // 장 초반 돌파는 09:45부터 사요. 장 시작 직후 급락하는 종목을 쫓아 사던 문제(11/6 09:34 매수 4건이 15분 안에 모두 손절)를 막으려고요.
    { id: 'opening-breakout', name: '장 초반 돌파', rules: Object.assign({}, INTRADAY_RULES, { buyStart: '09:45' }), signal: (q, cfg) => breakoutSignal(q, cfg._intraday) },
    { id: 'vwap-pullback', name: '강한 종목 눌림', signal: (q, cfg) => pullbackSignal(q, cfg._intraday, Date.now()) }
  ].map((d) => ({
    id: d.id,
    name: d.name,
    horizon: 'day',
    ownRules: true,
    intraday: true,
    krOnly: true,
    usesIntradayState: true,
    maxPositions: INTRADAY_RULES.maxPositions,
    dayRules: () => d.rules || INTRADAY_RULES,
    // 손절·익절·금액은 살 때 종목마다 정해요(sizeFor). 아래 값은 그 값이 없는 예외 상황의 안전한 기본값이에요.
    getRisk: () => ({ positionPct: 10, stopLossPct: 2, takeProfitPct: 4, maxTradesPerDay: INTRADAY_RULES.maxBuysPerDay }),
    sizeFor: sizeByVolatility,
    shouldBuy: (cand, q, cfg) => d.signal(q, cfg)
  })),
  {
    id: 'staged-dip',
    name: '단계별 저점 매수',
    // 시가보다 -2~-4% 내려온 종목의 첫 1/3을 사고, 더 떨어지면 매매 방식(나눠 사기)이 나머지를 사요. 반등하면 나눠 팔고 당일 정리해요.
    horizon: 'day', ownRules: true, intraday: true, krOnly: true, gate: 'dip', maxPositions: 4,
    dayRules: () => ({ buyStart: '09:15', buyEnd: '14:30', closeAt: '15:10', dailyLossLimitPct: 1.5, cooldownMin: 10 }),
    getRisk: () => BASE_RISK['staged-dip'],
    shouldBuy: (cand, q, cfg) => stagedDipSignal(q, cfg._minutes)
  },
  {
    id: 'dip-rebound',
    name: '급락 반등 단타',
    // 하락장 전략: 크게 빠진 종목이 바닥에서 반등하는 걸 확인하고 사서, 작은 이익에 팔고 당일 정리해요.
    horizon: 'day', ownRules: true, intraday: true, krOnly: true, gate: 'bear', maxPositions: 3,
    dayRules: () => ({ buyStart: '10:00', buyEnd: '14:30', closeAt: '15:10', dailyLossLimitPct: 1.5, cooldownMin: 10 }),
    getRisk: () => ({ positionPct: 10, stopLossPct: 2, takeProfitPct: 3, maxTradesPerDay: 4 }),
    sizeFor: sizeByVolatility,
    shouldBuy: (cand, q, cfg) => dipReboundSignal(q, cfg._minutes)
  },
  {
    id: 'dip-nextday',
    name: '급락 다음날 매수',
    // 하락장 전략: 어제 크게 빠진 종목이 오늘 버티면 사서 2~5일 들고 가요. 떨어진 "다음에" 사니까 사기 전 밤사이 급락은 피해요.
    horizon: 'swing', ownRules: true, krOnly: true, gate: 'dip', usesDaily: true, maxPositions: 5, maxHoldDays: DIP_NEXTDAY.maxHoldDays,
    getRisk: () => BASE_RISK['dip-nextday'],
    shouldBuy: (cand, q, cfg) => dipNextDaySignal(q, cfg._daily && cfg._daily[cand.symbol], cfg._minutes)
  },
  {
    id: 'inverse',
    name: '인버스 ETF(하락장)',
    // 하락장 전략: 시장이 떨어질수록 오르는 상품을 사요. 하락장이 끝나면 팔고, 여러 날 들고 갈 수 있어요.
    // 50종목 밖의 예외 상품이라 후보를 따로 줘요. 시장이 빠질수록 버는 상품이라 "위험 줄이기(절반 매도)"는 하지 않아요.
    horizon: 'swing', ownRules: true, krOnly: true, gate: 'none', etf: true, noRiskCut: true, maxPositions: 1,
    maxHoldDays: INVERSE_RULE.maxHoldDays,
    candidates: () => [Object.assign({ reason: '하락장 대비(인버스)' }, INVERSE_ETF)],
    getRisk: () => BASE_RISK.inverse,
    shouldBuy: (cand, q, cfg) => inverseSignal(cfg._index, cfg._regime),
    exitSignal: (cfg) => inverseShouldExit(cfg._regime)
  }
];

// 시장 필터 종류(_bear.js marketGate): 오르는 장 단타는 'up', 며칠 들고 가는 전략은 'swing'(하락장이면 쉼),
// 떨어진 종목을 사는 전략은 'dip', 기준선은 비교를 위해 'none'(조건 없음). 새 전략은 위 정의에 직접 적었어요.
const GATE_OF = { momentum: 'swing', pullback: 'swing', breakout: 'swing', reversal: 'dip', selective: 'swing', wideswing: 'swing', baseline: 'none' };
STRATEGY_DEFS.forEach((d) => { if (!d.gate) d.gate = GATE_OF[d.id] || 'up'; });


function todayKST() {
  // 서버 시간이 UTC라 KST(+9)로 보정해서 "날짜"를 계산합니다.
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ---- 장 운영시간 ----
// 장이 닫혀 있을 때 받은 시세는 "마지막 체결가"라 실제로는 그 가격에 사고팔 수 없어요. 예전엔 스케줄러가 밤에 불러도
// 그대로 가상매매가 일어나 결과가 부풀려질 수 있었기 때문에, 이제 모든 전략이 장중에만 매매합니다.
// 국내는 15:20부터 동시호가(한 번에 체결되는 마감 경매)라 그 전까지만, 미국은 정규장(뉴욕 09:30~16:00)만 봅니다.
// 공휴일 달력은 따로 없어서, 평일 공휴일엔 시세가 안 움직여 사실상 매수 조건에 잘 안 걸리는 정도로만 걸러져요.
const KR_OPEN_MIN = 9 * 60;
const KR_CLOSE_MIN = 15 * 60 + 20;
const US_OPEN_MIN = 9 * 60 + 30; // 뉴욕 현지 시각 — 서머타임은 Intl이 알아서 반영
const US_CLOSE_MIN = 16 * 60;

// minutes: 그 시장 현지 시각을 "자정부터 몇 분"으로 바꾼 값 (단타 전략의 시간대 규칙에 씀)
function marketClock(marketKey) {
  if (marketKey === 'KR') {
    const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const day = d.getUTCDay();
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    return { open: day >= 1 && day <= 5 && minutes >= KR_OPEN_MIN && minutes < KR_CLOSE_MIN, minutes };
  }
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = parts.weekday !== 'Sat' && parts.weekday !== 'Sun';
  return { open: weekday && minutes >= US_OPEN_MIN && minutes < US_CLOSE_MIN, minutes };
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
    price: num(o.stck_prpr), changePct: num(o.prdy_ctrt),
    // 오늘 시가·고가·저가와 평균 체결가(거래량을 반영한 평균 가격) — 단타 전략이 장중 흐름을 볼 때 써요(추가 API 호출 없음)
    open: num(o.stck_oprc), high: num(o.stck_hgpr), low: num(o.stck_lwpr), vwap: num(o.wghn_avrg_stck_prc)
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

  const ai = await askClaude({ feature: 'stoploss-reason', prompt, maxTokens: 2000, timeoutMs: 15_000 });
  return ai.ok ? ai.text : null;
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

// ---- 학습하는 자동조정 (규칙은 _learning.js) ----
// 전략마다 기록이 "관찰 중(observing) → 실험 중(running) → 채점 완료(judged)" 순서로 돌아요.
//   관찰 중: 지금 설정으로 거래 10건을 모아요(이게 다음 실험의 "바꾸기 전" 비교 기준이 돼요).
//   실험 중: AI가 가설을 세워 숫자를 바꾸고, 새 설정으로 거래 10건이 쌓일 때까지 기다려요.
//   채점: 바꾸기 전 10건 + 같은 기간의 대조군(기준선)과 비교해 좋아짐/효과 없음/나빠짐을 매기고,
//         나빠졌으면 지금까지 가장 좋았던 설정으로 되돌려요. 결과는 교훈으로 남아 다음 실험 때 AI에게 전달돼요.
// 기준선(대조군)은 비교 기준이라 절대 바꾸지 않고, 규칙이 따로 정해진 전략(ownRules)도 대상이 아니에요.
function isAdjustable(def) {
  return !def.ownRules && def.id !== 'baseline';
}

function sellSamplesFromLog(log, strategyId, sinceTs, limit) {
  return log
    .filter((e) => e.strategy === strategyId && isSellSide(e.side) && e.ts >= (sinceTs || 0))
    .sort((a, b) => a.ts - b.ts)
    .slice(-(limit || 50))
    .map((e) => ({ ts: e.ts, pnlPct: e.pnlPct, side: e.side, entryChangePct: e.entryChangePct }));
}

function riskOnly(r) {
  return { stopLossPct: r.stopLossPct, takeProfitPct: r.takeProfitPct, positionPct: r.positionPct, maxTradesPerDay: r.maxTradesPerDay };
}

// AI에게 다음 실험을 설계하게 합니다. 지금까지의 실험 결과(교훈)와 다시 하면 안 되는 방향을 함께 줘서,
// 이미 실패한 쪽으로 또 바꾸지 않고 "무엇을 배웠고, 그래서 이번엔 무엇을 왜 시도하는지"를 쓰게 해요.
async function askNextExperiment(def, current, stats, history, forbidden, regimeText, weeklyAdvice) {
  const lessons = history.length
    ? history.map((e, i) => `${i + 1}. ${lessonLine(e)}${e.hypothesis ? ` / 그때 가설: ${e.hypothesis}` : ''}`).join('\n')
    : '아직 없음(첫 실험)';
  const forbiddenText = forbidden.length
    ? forbidden.map((k) => { const [f, d] = k.split(':'); return `${RISK_LABELS[f]} ${d === 'up' ? '올리기' : '내리기'}`; }).join(', ')
    : '없음';
  const prompt =
`너는 자동매매 전략의 숫자 설정을 "실험"으로 개선하는 연구원이야. 아래 자료를 보고 다음에 할 일을 하나 골라.

전략: ${def.name}
오늘 시장 상황: ${regimeText || '알 수 없음'}
지금 설정: 손절 ${current.stopLossPct}%, 익절 ${current.takeProfitPct}%, 1회 매수 비중 ${current.positionPct}%, 하루 최대 매수 ${current.maxTradesPerDay}회

지금 설정으로 한 최근 거래 ${stats.trades}건(수수료·세금 뺀 손익 기준):
- 승률 ${stats.winRate}%, 평균 손익 ${stats.avgPnlPct}%
- 손절로 끝난 비율 ${stats.stopLossShare}%
- 고점 매수 비율(산 날 이미 어제보다 10% 넘게 오른 상태) ${stats.chaseShare === null ? '기록 없음' : stats.chaseShare + '%'}

지금까지의 실험과 결과(교훈):
${lessons}

다시 시도하면 안 되는 방향(같은 방향으로 바꿔서 2번 이상 나빠짐): ${forbiddenText}

주간 AI 심층 평가서의 제안(참고만, 위 규칙이 우선): ${weeklyAdvice || '없음'}

규칙:
- 한 번에 바꿀 수 있는 폭은 지금 값의 ±30%, 하루 횟수는 ±1회. 비중은 최소 3%, 하루 횟수는 최소 2회.
- 결과를 해석할 수 있게, 가능하면 한두 개 값만 바꿔.
- 승률이 매우 낮고(20% 미만) 손절 비율이 높거나 고점 매수가 많으면, 손절·익절 숫자보다 "사는 조건"이 문제일 가능성이 커. 그럴 땐 숫자를 바꾸지 말고 buy-rule-problem을 골라.
- 지금 설정이 괜찮아 보이면 hold를 골라도 돼.

아래 JSON 형식으로만 답해(다른 설명 없이):
{"action":"experiment 또는 hold 또는 buy-rule-problem","lessonUsed":"지금까지 실험에서 배운 점을 1문장으로","hypothesis":"이번에 바꾸면 왜 나아질지 1~2문장","expected":"어떤 숫자가 어떻게 변할지(예: 손절 비율 70%→50% 이하)","diagnosis":"지금 성적의 원인 2문장, 숫자 근거","stopLossPct":숫자,"takeProfitPct":숫자,"positionPct":숫자,"maxTradesPerDay":숫자}`;

  const ai = await askClaude({ feature: 'adjust', prompt, maxTokens: 8000, timeoutMs: 20_000 });
  return ai.ok ? extractJson(ai.text, 'object') : null;
}

function pushChange(changes, entry) {
  changes.unshift(Object.assign({ id: Date.now() + '-' + entry.strategyId + '-' + Math.random().toString(36).slice(2, 6), ts: Date.now() }, entry));
}

// 설정에서 정한 주기(cfg.adjustIntervalHours, 기본 24시간)마다 한 번 돌아요(스케줄러가 더 자주 불러도 건너뜀).
// 돌려받는 overrides(전략별 지금 적용 중인 숫자)는 이번 매매에 바로 쓰여요.
async function maybeRunLearningCycle(cfg, today, log, snap) {
  const overrides = snap[OVERRIDES_KEY] || {};
  const intervalHours = Math.max(1, Math.min(168, Number(cfg.adjustIntervalHours) || 24));
  const lastRunTs = snap[ADJUST_LASTRUN_KEY] || 0;
  if (Date.now() < (typeof lastRunTs === 'number' ? lastRunTs : 0) + intervalHours * 3600 * 1000) return overrides;
  await kvSetJson(ADJUST_LASTRUN_KEY, Date.now()); // 중간에 실패해도 같은 주기 안에서 무한 재시도하지 않게 먼저 기록

  try {
    const [experiments, best, flags, changes, regimeCache, deepEval, resetInfo] = await Promise.all([
      kvGetJson(EXPERIMENTS_KEY, []), kvGetJson(BEST_RISK_KEY, {}), kvGetJson(FLAGS_KEY, {}),
      kvGetJson(CHANGES_KEY, []), kvGetJson(REGIME_CACHE_KEY, null), kvGetJson(DEEPEVAL_LATEST_KEY, null), kvGetJson(RESET_INFO_KEY, {})
    ]);
    const learnSince = (resetInfo && resetInfo.learnSince) || 0; // 전략을 초기화했다면 그 전 거래로는 판단하지 않아요
    // 주간 심층 평가서가 전략별로 제안한 "다음 실험"을 자동조정 AI에게 참고자료로 넘겨요(평가 → 실험이 이어지도록).
    const adviceFor = (id) => {
      const s = deepEval && deepEval.report && Array.isArray(deepEval.report.strategies) ? deepEval.report.strategies.find((x) => x.id === id) : null;
      if (!s || !Array.isArray(s.nextExperiments) || !s.nextExperiments.length) return null;
      return `${deepEval.date} 평가: ` + s.nextExperiments.map((n) => `${n.what} (이유: ${n.why})`).join(' / ');
    };
    const regimeLabel = regimeCache && regimeCache.label ? regimeLabelKo(regimeCache.label) : null;
    const now = Date.now();

    // (1회) 대조군 복구 — 예전 자동조정이 기준선까지 바꿔놔서 비교가 안 되던 것을 원래 값으로 돌려요.
    if (overrides.baseline) {
      pushChange(changes, {
        date: today, strategyId: 'baseline', strategyName: '기준선(대조군)', source: 'system',
        diagnosis: '기준선은 다른 전략과 비교하는 "대조군"이라 바뀌면 안 돼요. 예전 자동조정이 바꿔둔 값을 원래 값으로 되돌렸어요.',
        before: riskOnly(overrides.baseline), after: riskOnly(BASE_RISK.baseline)
      });
      delete overrides.baseline;
    }

    for (const def of STRATEGY_DEFS.filter((d) => isAdjustable(d) && strategyEnabled(cfg, d.id))) {
      let current = riskOnly(Object.assign({}, def.getRisk(cfg), overrides[def.id] || {}));

      // (1회) 바닥 아래로 내려가 있던 설정(비중 1%, 하루 1번 등)을 최소값으로 올려요 — 그대로면 거의 매매를 안 해서 배울 수가 없어요.
      const lifted = liftToFloors(current);
      if (RISK_FIELDS.some((f) => lifted[f] !== current[f])) {
        pushChange(changes, {
          date: today, strategyId: def.id, strategyName: def.name, source: 'system',
          diagnosis: '비중·하루 횟수가 너무 작아져서 거의 매매를 하지 않는 상태였어요. 배울 데이터가 쌓이도록 최소값(비중 3%, 하루 2번)까지 올렸어요.',
          before: current, after: lifted
        });
        overrides[def.id] = Object.assign({}, lifted, { updatedAt: now });
        current = lifted;
      }

      const mine = experiments.filter((e) => e.strategyId === def.id);
      const running = mine.find((e) => e.status === 'running');
      let observing = mine.find((e) => e.status === 'observing');

      // ① 실험 중이고 거래가 충분히 쌓였으면 → 채점
      if (running && readyToJudge(running, now)) {
        const res = judge(running);
        running.status = 'judged';
        running.result = Object.assign({}, res, { judgedAt: now });
        let rolledBack = null;
        if (res.verdict === 'worse') {
          rolledBack = (best[def.id] && best[def.id].risk) || running.before;
          overrides[def.id] = Object.assign({}, rolledBack, { updatedAt: now });
          running.result.rolledBackTo = rolledBack;
        }
        if (res.verdict === 'improved' && (!best[def.id] || res.after.avgPnlPct > best[def.id].avgPnlPct)) {
          best[def.id] = { risk: running.after, avgPnlPct: res.after.avgPnlPct, at: now, experimentId: running.id };
        }
        pushChange(changes, {
          date: today, strategyId: def.id, strategyName: def.name, source: 'system', experimentId: running.id,
          diagnosis: `실험 채점: ${lessonLine(running)}` + (rolledBack ? ` → 나빠져서 ${best[def.id] ? '지금까지 가장 좋았던' : '바꾸기 전'} 설정으로 되돌렸어요.` : ''),
          statsAtChange: res.after, before: running.after, after: rolledBack || running.after
        });
        // 되돌리지 않았으면 이번 실험의 거래가 곧 "지금 설정"의 기록이라, 다음 실험의 비교 기준으로 바로 써요.
        if (!observing) {
          observing = { id: 'obs-' + now + '-' + def.id, strategyId: def.id, strategyName: def.name, status: 'observing',
            startedAt: now, risk: rolledBack || running.after, samples: rolledBack ? [] : (running.samples || []).slice(-LEARN.beforeTrades) };
          experiments.unshift(observing);
        }
        continue; // 같은 날 바로 또 바꾸지 않아요
      }
      if (running) continue; // 아직 거래가 덜 쌓였어요

      // ② 관찰 기록이 없으면 만들어요. 처음엔 남아 있는 매매 기록에서 "지금 설정으로 한 거래"를 가져와 바로 시작해요.
      if (!observing) {
        const since = Math.max(overrides[def.id] && overrides[def.id].updatedAt ? overrides[def.id].updatedAt : 0, learnSince);
        observing = { id: 'obs-' + now + '-' + def.id, strategyId: def.id, strategyName: def.name, status: 'observing',
          startedAt: now, risk: current, samples: sellSamplesFromLog(log, def.id, since, LEARN.beforeTrades) };
        experiments.unshift(observing);
      }

      // 사는 조건 문제 자동 감지: 최근 20건 승률이 20% 미만이면 숫자를 더 바꾸지 않고 표시만 해요(30% 이상 회복하면 해제).
      const recent = summarize(sellSamplesFromLog(log, def.id, learnSince, LEARN.buyRuleWindow));
      if (recent.trades >= LEARN.buyRuleWindow && recent.winRate < LEARN.buyRuleWinRate) {
        if (!flags[def.id]) flags[def.id] = { type: 'buy-rule', at: now, winRate: recent.winRate,
          note: `최근 ${recent.trades}건 승률 ${recent.winRate}% — 손절·익절 숫자보다 "사는 조건"이 안 맞을 가능성이 커요. 끄거나 전략연구실에서 검증해 보세요.` };
        continue;
      }
      if (flags[def.id] && flags[def.id].type === 'buy-rule' && recent.winRate !== null && recent.winRate >= 30) delete flags[def.id];
      if (flags[def.id]) continue;

      // ③ 관찰한 거래가 모이면 → AI에게 다음 실험을 설계하게 해요.
      // 초기화 뒤 첫 실험은 매도 30건이 쌓인 뒤에 해요(표본이 적을 때 숫자를 바꾸면 배우는 게 아니라 흔들리기만 해요 — 11월 교훈).
      const judgedSinceReset = mine.some((e) => e.status === 'judged' && (e.startedAt || 0) >= learnSince);
      const need = judgedSinceReset ? LEARN.beforeTrades : LEARN.firstExperimentTrades;
      if ((observing.samples || []).length < need) continue;
      const stats = summarize(observing.samples.slice(-LEARN.beforeTrades));
      const history = mine.filter((e) => e.status === 'judged').slice(0, 10);
      const forbidden = forbiddenDirections(mine);
      const proposal = await askNextExperiment(def, current, stats, history, forbidden, regimeLabel, adviceFor(def.id));
      if (!proposal) continue; // AI 실패 — 다음 주기에 다시 시도(관찰 기록은 그대로)

      if (proposal.action === 'buy-rule-problem') {
        flags[def.id] = { type: 'buy-rule', at: now, winRate: stats.winRate, note: String(proposal.diagnosis || '').slice(0, 300) };
        observing.samples = [];
        continue;
      }
      if (proposal.action !== 'experiment') { // hold: 지금 설정 유지, 다음 10건을 더 보고 다시 판단
        observing.samples = [];
        observing.holds = (observing.holds || 0) + 1;
        continue;
      }

      const after = applyForbidden(current, clampProposal(current, proposal), forbidden);
      if (RISK_FIELDS.every((f) => after[f] === current[f])) { observing.samples = []; continue; }

      const exp = {
        id: 'exp-' + now + '-' + def.id, strategyId: def.id, strategyName: def.name, status: 'running',
        startedAt: now, startDate: today, regimeLabel,
        before: current, after,
        hypothesis: String(proposal.hypothesis || '').slice(0, 300),
        expected: String(proposal.expected || '').slice(0, 200),
        lessonUsed: String(proposal.lessonUsed || '').slice(0, 300),
        diagnosis: String(proposal.diagnosis || '').slice(0, 400),
        beforeStats: stats,
        controlBeforeStats: summarize(sellSamplesFromLog(log, 'baseline', learnSince, LEARN.beforeTrades)),
        samples: [], controlSamples: []
      };
      experiments.splice(experiments.indexOf(observing), 1); // 관찰 기록은 이 실험의 "바꾸기 전" 기준이 됐으니 정리
      experiments.unshift(exp);
      overrides[def.id] = Object.assign({}, after, { updatedAt: now });
      pushChange(changes, {
        date: today, strategyId: def.id, strategyName: def.name, source: 'live', experimentId: exp.id,
        diagnosis: `${exp.diagnosis} 가설: ${exp.hypothesis}${exp.expected ? ' (기대: ' + exp.expected + ')' : ''}`,
        statsAtChange: stats, before: current, after
      });
    }

    if (experiments.length > MAX_EXPERIMENTS) experiments.length = MAX_EXPERIMENTS;
    if (changes.length > MAX_CHANGES) changes.length = MAX_CHANGES;
    await Promise.all([
      kvSetJson(OVERRIDES_KEY, overrides), kvSetJson(EXPERIMENTS_KEY, experiments),
      kvSetJson(BEST_RISK_KEY, best), kvSetJson(FLAGS_KEY, flags), kvSetJson(CHANGES_KEY, changes)
    ]);
  } catch (e) {
    console.error('auto-trade-check.js(learning cycle) error:', e);
  }
  return overrides;
}

// 이번 실행에서 생긴 매도들을 진행 중인 실험·관찰 기록에 표본으로 더합니다(매 실행마다, AI 호출 없이 계산만).
// 기준선(대조군)의 매도는 진행 중인 모든 실험의 "같은 기간 대조군" 표본이 돼요.
async function recordLearningSamples(actions) {
  const sells = actions.filter((a) => isSellSide(a.side));
  if (!sells.length) return;
  const experiments = await kvGetJson(EXPERIMENTS_KEY, []);
  let dirty = false;
  for (const a of sells) {
    const sample = { ts: a.ts, pnlPct: a.pnlPct, side: a.side, entryChangePct: a.entryChangePct };
    for (const e of experiments) {
      if (e.status !== 'running' && e.status !== 'observing') continue;
      if (e.strategyId === a.strategy) {
        e.samples = (e.samples || []).concat(sample).slice(-50);
        dirty = true;
      }
      if (a.strategy === 'baseline' && e.status === 'running') {
        e.controlSamples = (e.controlSamples || []).concat(sample).slice(-50);
        dirty = true;
      }
    }
  }
  if (dirty) await kvSetJson(EXPERIMENTS_KEY, experiments);
}

// 여러 전략이 같은 후보군을 동시에 평가하므로, 이번 실행 동안은 종목별 시세를 한 번만 조회해서
// 캐시로 재사용합니다. 전략들이 동시에 돌기 때문에 결과가 아니라 "진행 중인 요청"을 저장해요.
// 결과를 저장하면 첫 응답이 오기 전에 전략마다 같은 종목을 또 조회해서, KIS 초당 호출 제한에 걸릴 수 있어요.
function makeQuoteFetcher(token, marketKey, cache) {
  return function fetchQuote(symbol, preferredExcd) {
    if (!cache.has(symbol)) {
      const request = marketKey === 'KR' ? fetchDomesticQuote(token, symbol) : fetchOverseasQuote(token, symbol, preferredExcd);
      cache.set(symbol, request.catch(() => null)); // 한 종목이 실패해도 그 종목만 이번 실행에서 건너뛰어요
    }
    return cache.get(symbol);
  };
}

// 한 전략 x 한 마켓에 대한 손절/익절 + 신규매수 평가를 수행합니다.
// log는 handler에서 실행 시작 시 딱 한 번만 읽어서 넘겨주는 전체 매매 로그입니다(읽기 전용으로만 씀) —
// 여러 전략이 매번 전체 로그를 KV에서 다시 읽던 것을 없애서 호출 수를 줄입니다.
// costs: _costs.js의 매매 비용 설정(수수료·거래세·환전) — 살 때/팔 때 실제로 빠지는 돈을 반영해서,
// 가상계좌 현금과 기록되는 손익(pnlPct/pnlAmount)이 실제 계좌에 남는 돈과 최대한 같아지게 합니다.
// 손절/익절 "발동" 기준은 증권사 주문처럼 주가 등락률(가격 기준) 그대로 두고, 기록되는 손익만 비용을 뺀 값으로 남깁니다.
// accounts: handler가 명령 1번으로 함께 읽어 둔 계좌 값이에요.
async function processStrategyMarket(strategyDef, marketKey, fetchQuote, cfg, candidates, today, risk, apiKey, log, costs, accounts) {
  // 장이 닫혀 있으면 아무것도 하지 않습니다(손절·익절도 — 닫힌 장의 가격으론 실제로 팔 수 없으니까요).
  const clock = marketClock(marketKey);
  if (!clock.open) return { actions: [], cash: null, positions: null };

  const keys = keysFor(strategyDef.id, marketKey);
  const positions = accounts[keys.positionsKey] || {};
  let cash = accounts[keys.cashKey];
  if (typeof cash !== 'number') cash = keys.startingCash;
  const intraday = !!strategyDef.intraday;
  const dt = intraday ? strategyDef.dayRules(cfg) : null; // 단타 규칙(시간·손실한도·재매수 대기)
  const method = methodOf(strategyDef.id, cfg._methods); // 사는 방법·파는 방법(_methods.js)
  const sellOpts = strategyDef.etf ? { etf: true } : undefined; // ETF는 팔 때 거래세가 없어요
  const nowMs = Date.now();
  const digits = marketKey === 'KR' ? 1 : 100;
  const mine = (e) => e.strategy === strategyDef.id && e.market === marketKey;
  const isFirstBuy = (e) => e.side === 'BUY' && !e.add; // 나눠 사기·더 사기는 "새로 산 횟수"에 넣지 않아요

  // 오늘 새로 산 횟수(하루 한도용). 파는 건 한도와 상관없이 언제든 해요(손실 방어·이익 확정이 막히면 안 돼요).
  const tradesToday = log.filter((e) => e.date === today && mine(e) && isFirstBuy(e)).length;
  const positionPct = risk.positionPct || 5;
  const stopLossPct = risk.stopLossPct || 5;
  const takeProfitPct = risk.takeProfitPct || 10;
  const maxTradesPerDay = risk.maxTradesPerDay || 3;
  const maxHoldDays = strategyDef.maxHoldDays || (strategyDef.horizon === 'swing' ? SWING_MAX_HOLD_DAYS : null);
  const methodFor = (pos) => (pos.method ? normalizeMethod(pos.method, method) : method); // 산 때의 방식을 끝까지 따라요

  const actions = [];
  let dirty = false; // 매매는 없어도 최고가 기록 등이 바뀌어 저장해야 하는지

  // 일부 또는 전부 팔고 기록을 남겨요. 일부만 팔면 원가도 판 비율만큼만 빼요.
  function recordSell(symbol, pos, q, side, qty) {
    const sell = planSell(costs, marketKey, qty, q.price, sellOpts);
    const fullBasis = positionCostBasis(costs, marketKey, pos); // 매수금액 + 매수비용
    const basis = fullBasis * (qty / pos.qty);
    const netPnlAmount = sell.proceeds - basis; // 이번 매도로 실제로 남은(잃은) 돈
    const grossPnlPct = ((q.price - pos.avgPrice) / pos.avgPrice) * 100;
    cash += sell.proceeds;
    const partial = qty < pos.qty;
    if (partial) positions[symbol] = Object.assign({}, pos, { qty: pos.qty - qty, costBasis: Math.round((fullBasis - basis) * digits) / digits });
    else delete positions[symbol];
    const entry = {
      ts: nowMs, date: today, market: marketKey, strategy: strategyDef.id,
      symbol, name: pos.name || q.name || symbol, side,
      qty, price: q.price,
      pnlPct: Math.round((netPnlAmount / basis) * 10000) / 100, // 비용(수수료·세금·환전) 뺀 실제 수익률
      grossPnlPct: Math.round(grossPnlPct * 100) / 100, // 단순 주가 등락률(참고용)
      amount: Math.round(sell.proceeds * digits) / digits,
      pnlAmount: Math.round(netPnlAmount * digits) / digits,
      fee: Math.round(sell.fee * digits) / digits,
      mode: 'dryrun',
      reason: pos.reason || null,
      entryChangePct: typeof pos.entryChangePct === 'number' ? pos.entryChangePct : null, // 산 날의 전일 대비 등락률(고점 매수 분석용)
      // 채점표 상세 분석용: 산 날·산 때 시장 상황 → 보유 기간, 시장 상황별 성적을 계산해요
      entryDate: pos.entryDate || null, entryRegime: pos.entryRegime || null, regime: cfg._regime || null,
      ...(partial ? { partial: true } : {})
    };
    actions.push(entry);
    return entry;
  }

  // 1) 보유 종목 점검 — 당일 청산 / 흐름 전환 / 손절·익절·나눠 팔기·따라가는 손절 / 보유 기한 / 장 마감 전 위험 줄이기
  for (const symbol of Object.keys(positions)) {
    let pos = positions[symbol];
    const q = await fetchQuote(symbol, pos.excd);
    if (!q || q.price === null) continue;
    const m = methodFor(pos);
    const stopPct = pos.stopPct || stopLossPct, takePct = pos.takePct || takeProfitPct;

    let decision = null;
    // 단타: 청산 시각이 넘었거나, (스케줄러가 멈췄던 등의 이유로) 어제 산 게 남아 있으면 손익과 상관없이 정리합니다.
    if (intraday && (clock.minutes >= hhmmToMin(dt.closeAt) || pos.entryDate !== today)) decision = { side: 'DAY_CLOSE' };
    else if (strategyDef.exitSignal && strategyDef.exitSignal(cfg)) decision = { side: 'SIGNAL_EXIT' };
    else {
      decision = exitDecision(pos, q.price, m, stopPct, takePct);
      if (!decision && maxHoldDays && pos.entryDate && weekdaysBetween(pos.entryDate, today) >= maxHoldDays) decision = { side: 'MAX_HOLD' };
      // 장 마감 전에 시장이 크게 빠지고 있으면, 밤사이 더 빠질 위험에 대비해 스윙 보유분의 절반을 미리 팔아요(하루 한 번).
      if (!decision && !intraday && marketKey === 'KR' && strategyDef.horizon === 'swing' && !strategyDef.noRiskCut &&
        cfg._index && typeof cfg._index.changePct === 'number' && cfg._index.changePct <= COMMON_RULES.riskCutIndexPct &&
        clock.minutes >= COMMON_RULES.riskCutFromMin && pos.cutDate !== today) decision = { side: 'RISK_CUT', frac: 0.5 };
    }

    if (decision) {
      const qty = decision.frac ? Math.max(1, Math.floor(pos.qty * decision.frac)) : pos.qty;
      const entry = recordSell(symbol, pos, q, decision.side, qty);
      if (positions[symbol]) {
        // 일부만 팔았으면: 나눠 팔기는 손절선을 본전으로 올리고, 위험 줄이기는 오늘 다시 줄이지 않게 표시해요.
        if (decision.side === 'PARTIAL_TAKE') positions[symbol] = Object.assign({}, positions[symbol], { partialDone: true, breakeven: true });
        if (decision.side === 'RISK_CUT') positions[symbol] = Object.assign({}, positions[symbol], { cutDate: today });
      }
      if (decision.breakeven) entry.note = '본전 손절(이익 일부를 확정한 뒤 본전으로 올린 손절선)';
      // 단타는 손절이 자주 나서, 매번 AI에게 원인을 묻지 않습니다(API 비용 절약).
      if (decision.side === 'STOP_LOSS' && !intraday && !decision.breakeven) {
        const holdingDays = Math.max(0, Math.round((Date.parse(today) - Date.parse(pos.entryDate)) / 86400000));
        entry.aiReason = await explainStopLoss({
          strategyName: strategyDef.name, stopLossPct: stopPct,
          name: entry.name, symbol, buyReason: pos.reason,
          avgPrice: pos.avgPrice, price: q.price, pnlPct: entry.pnlPct,
          holdingDays, entryDate: pos.entryDate, today
        }, apiKey);
      }
      continue;
    }
    // 따라가는 손절에 쓰는 "산 뒤 최고가"는 0.5% 넘게 올랐을 때만 새로 적어요(1분마다 저장하지 않게).
    if (q.price > (pos.peak || pos.avgPrice) * 1.005) {
      positions[symbol] = Object.assign({}, pos, { peak: q.price });
      dirty = true;
    }
  }

  // 2) 새로 사도 되는지: 시장 필터 + 오늘 손실 한도 + (단타) 매수 시간대
  const todaysSells = log.filter((e) => mine(e) && e.date === today && isSellSide(e.side)).concat(actions.filter((a) => isSellSide(a.side)));
  const realizedToday = todaysSells.reduce((sum, e) => sum + (e.pnlAmount || 0), 0);
  const ownLimit = dt && typeof dt.dailyLossLimitPct === 'number' ? dt.dailyLossLimitPct : COMMON_RULES.dailyLossLimitPct;
  const lossLimitPct = Math.min(ownLimit, COMMON_RULES.dailyLossLimitPct);
  const underLossLimit = realizedToday > -keys.startingCash * (lossLimitPct / 100);
  const inWindow = !intraday || (clock.minutes >= hhmmToMin(dt.buyStart) && clock.minutes < hhmmToMin(dt.buyEnd));
  const gate = marketKey === 'KR' ? marketGate(strategyDef.gate || 'up', cfg._index, cfg._regime) : { ok: true };
  const buyAllowed = underLossLimit && inWindow && gate.ok;

  const exposureNow = () => Object.values(positions).reduce((sum, p) => sum + positionCostBasis(costs, marketKey, p), 0);
  const accountValueNow = () => cash + exposureNow();
  // 며칠씩 들고 가는 전략은 계좌의 30%까지만 들고 있어요(밤사이 급락에 한꺼번에 물리지 않게).
  const capBudget = (budget) => {
    if (strategyDef.horizon !== 'swing') return Math.min(budget, cash);
    const room = accountValueNow() * (COMMON_RULES.swingMaxExposurePct / 100) - exposureNow();
    return Math.max(0, Math.min(budget, cash, room));
  };

  // 3) 나눠 사기·더 사기: 이미 산 종목이 정한 가격에 닿으면 남겨둔 몫을 더 사요.
  if (buyAllowed) {
    for (const symbol of Object.keys(positions)) {
      const pos = positions[symbol];
      const m = methodFor(pos);
      if (m.buy.type === 'single' || (intraday && pos.entryDate !== today)) continue;
      const q = await fetchQuote(symbol, pos.excd);
      if (!q || q.price === null) continue;
      const add = addDecision(pos, q.price, m, pos.stopPct || stopLossPct, pos.takePct || takeProfitPct);
      if (!add) continue;
      const buy = planBuy(costs, marketKey, capBudget(add.budget), q.price);
      if (buy.qty < 1) continue;
      cash -= buy.total;
      const next = applyAdd(pos, add.kind, buy.qty, q.price, buy.total);
      next.avgPrice = Math.round(next.avgPrice * 100) / 100;
      next.costBasis = Math.round(next.costBasis * digits) / digits;
      positions[symbol] = next;
      actions.push({
        ts: nowMs, date: today, market: marketKey, strategy: strategyDef.id,
        symbol, name: pos.name || symbol, side: 'BUY', add: true,
        qty: buy.qty, price: q.price, amount: Math.round(buy.total * digits) / digits,
        fee: Math.round(buy.fee * digits) / digits, mode: 'dryrun', regime: cfg._regime || null,
        reason: add.kind === 'ladder' ? `나눠 사기 ${next.tranches}번째(첫 매수가보다 싸짐)` : '오르는 중이라 더 사기(손절선은 본전으로)'
      });
    }
  }

  // 4) 새로 사기 (하루 한도 안에서만)
  const lastSellToday = (symbol) => {
    const list = actions.filter((a) => a.symbol === symbol && isSellSide(a.side) && !a.partial);
    if (list.length) return list[list.length - 1];
    return log.find((e) => mine(e) && e.date === today && e.symbol === symbol && isSellSide(e.side) && !e.partial) || null; // 기록은 최신순
  };
  const minGapMin = dt && dt.cooldownMin ? dt.cooldownMin : REENTRY.minGapMin;
  const cands = strategyDef.candidates ? strategyDef.candidates() : candidates;
  if (buyAllowed) {
    for (const cand of cands) {
      if (positions[cand.symbol]) continue; // 이미 보유 중이면 스킵
      if (strategyDef.maxPositions && Object.keys(positions).length >= strategyDef.maxPositions) break;
      const remainingSlots = maxTradesPerDay - (tradesToday + actions.filter(isFirstBuy).length);
      if (remainingSlots <= 0) break;

      const q = await fetchQuote(cand.symbol);
      if (!q || q.price === null || q.changePct === null) continue;
      if (!strategyDef.shouldBuy(cand, q, cfg)) continue;
      // 오늘 판 종목을 다시 살 때는 "다른 근거"가 있어야 해요(_bear.js reentryAllowed).
      const re = reentryAllowed(lastSellToday(cand.symbol), q, nowMs, minGapMin);
      if (!re.ok) continue;

      const accountValue = accountValueNow();
      const sized = strategyDef.sizeFor ? strategyDef.sizeFor(q, accountValue, cash) : null;
      if (strategyDef.sizeFor && !sized) continue;
      const budget = capBudget(sized ? sized.budget : cash * (positionPct / 100));
      // 나눠 사기·더 사기는 처음엔 일부만 사고 나머지를 남겨둬요(합쳐도 예산 안).
      const buy = planBuy(costs, marketKey, budget * firstBuyShare(method), q.price);
      if (buy.qty < 1) continue; // 1주도 못 사면(비싼 종목) 비중을 넘겨서 사지 않고 건너뛰어요
      const qty = buy.qty;

      cash -= buy.total;
      const displayName = cand.name || q.name || cand.symbol;
      const reason = cand.reason ? cand.reason + (re.note ? ` · ${re.note}` : '') : (re.note || null);
      positions[cand.symbol] = {
        qty, avgPrice: q.price, costBasis: Math.round(buy.total * digits) / digits,
        entryDate: today, name: displayName, excd: q.excd || null, reason,
        entryChangePct: q.changePct, // 산 순간 이미 어제보다 몇 % 올라 있었는지 — 팔 때 기록에 옮겨 "고점 매수" 여부를 따져요
        entryRegime: cfg._regime || null, // 산 날의 시장 상황(상승장·하락장…) — 시장 상황별 성적용
        ...(sized ? { stopPct: sized.stopPct, takePct: sized.takePct } : {}),
        ...newPositionFields(method, q.price, budget),
        method
      };
      actions.push({
        ts: nowMs, date: today, market: marketKey, strategy: strategyDef.id,
        symbol: cand.symbol, name: displayName, side: 'BUY',
        qty, price: q.price, amount: Math.round(buy.total * digits) / digits,
        fee: Math.round(buy.fee * digits) / digits, reason, mode: 'dryrun', entryChangePct: q.changePct, regime: cfg._regime || null
      });
    }
  }

  // 바뀐 게 없으면 계좌가 그대로라 저장하지 않아요. 저장에 실패하면 이번 매매를 기록하지 않아요:
  // 계좌는 그대로인데 매매 기록만 남으면 장부가 어긋나고, 그대로 두면 다음 실행 때 같은 판단을 다시 할 수 있어요.
  if (actions.length || dirty) {
    const saved = await kvMSetJson({ [keys.positionsKey]: positions, [keys.cashKey]: cash });
    if (!saved) {
      console.error('auto-trade-check.js: 계좌 저장 실패', strategyDef.id, marketKey);
      return { actions: [], cash: null, positions: null };
    }
  }

  return { actions, cash, positions, gate: gate.ok ? null : gate.why };
}

// backtest.js의 진화형 탐색이 찾아낸 가중치 점수(weights/buyThreshold)와 청산/비중(exit/sizing)을 그대로
// 실제 매매 규칙 모양({positionPct, stopLossPct, takeProfitPct, maxTradesPerDay})으로 옮깁니다.
// trailing 청산은 이 봇의 손절/익절 로직이 아직 못 쫓아가서, 트레일링폭을 손절폭으로 쓰고 익절폭은
// 넉넉하게(트레일링폭의 2.5배) 잡는 근사치로 처리해요 — 완벽히 같진 않지만 안전하게 작동은 해요.
function evolvedRiskFrom(strategy) {
  const sizing = strategy.sizing || {};
  const exit = strategy.exit || {};
  const raw = exit.type === 'trailing'
    ? { stopLossPct: exit.trailingPct, takeProfitPct: (exit.trailingPct || 8) * 2.5 }
    : { stopLossPct: exit.stopLossPct, takeProfitPct: exit.takeProfitPct };
  return clipRisk({
    positionPct: sizing.positionPct,
    stopLossPct: raw.stopLossPct,
    takeProfitPct: raw.takeProfitPct,
    maxTradesPerDay: sizing.maxPositions
  }, { positionPct: 5, stopLossPct: 5, takeProfitPct: 10, maxTradesPerDay: 3 });
}

// 진화형 전략의 매수 판단에 필요한 "오늘까지의" 팩터 점수를 후보 종목마다 계산해둡니다.
// (국내 종목만 지원 — 진화형 탐색 자체가 국내 일봉 데이터로만 돌아가기 때문)
// 후보가 늘어도 하루 첫 실행이 30초 제한에 걸리지 않게, 한 종목씩이 아니라 5개씩 나눠서 받아요.
// daily: 오늘을 뺀 "끝난 날" 기준 값(어제 등락률 d1) — 급락 다음날 매수 전략이 써요.
async function buildFactorMap(token, krCandidates, today) {
  const map = new Map();
  const todayYmd = today.replace(/-/g, '');
  for (let i = 0; i < krCandidates.length; i += 5) {
    await Promise.all(krCandidates.slice(i, i + 5).map(async (cand) => {
      try {
        const hist = await fetchSymbolHistory(token, cand.symbol, EVOLVED_FACTOR_LOOKBACK_DAYS);
        if (hist.length < 20) return;
        const annotated = annotateWithFactors(hist);
        const done = hist.filter((r) => r.date < todayYmd);
        const n = done.length;
        const daily = n >= 2 && done[n - 2].close ? { d1: Math.round(((done[n - 1].close - done[n - 2].close) / done[n - 2].close) * 10000) / 100, prevClose: done[n - 1].close } : null;
        map.set(cand.symbol, { factors: annotated[annotated.length - 1].factors, daily });
      } catch (e) {
        // 한 종목 실패해도 나머지는 계속 진행
      }
    }));
  }
  return map;
}

// 장기 분산 전략: 한 달에 한 번 시가총액 상위 10개로 비중을 맞춰요(규칙은 _longterm.js).
// 매달 첫 조정 때만 계좌를 읽어서, 평소 실행에는 저장소 호출이 늘지 않아요.
async function runLongTermRebalance(token, today, savedState, fetchQuote, costs, cfg) {
  const keys = keysFor('longterm', 'KR');
  const state = Object.assign({}, savedState || {}, { lastTryAt: Date.now() });
  const accounts = await kvMGetJson([keys.positionsKey, keys.cashKey]);
  if (!accounts) return []; // 읽기 실패: 시도 시각도 남기지 않아 다음 실행에서 다시 해요

  const positions = accounts[keys.positionsKey] || {};
  let cash = typeof accounts[keys.cashKey] === 'number' ? accounts[keys.cashKey] : keys.startingCash;
  const targets = await fetchLongTermTargets(token);
  const prices = {};
  targets.forEach((t) => { prices[t.symbol] = t.price; });
  await Promise.all(Object.keys(positions).filter((s) => !prices[s]).map(async (s) => {
    const q = await fetchQuote(s);
    if (q && q.price) prices[s] = q.price;
  }));
  const plan = targets.length >= MIN_TARGETS ? planRebalance(positions, cash, targets, prices) : null;
  if (!plan) {
    console.error('auto-trade-check.js(longterm): 조정을 미뤘어요. 받은 후보', targets.length);
    await kvSetJson(LONGTERM_STATE_KEY, state);
    return [];
  }

  const base = { date: today, market: 'KR', strategy: 'longterm', mode: 'dryrun', regime: cfg._regime || null };
  const actions = [];
  for (const o of plan.sells) {
    const pos = positions[o.symbol];
    const sell = planSell(costs, 'KR', o.qty, prices[o.symbol]);
    const basis = positionCostBasis(costs, 'KR', pos) * (o.qty / pos.qty); // 일부만 팔면 원가도 그 비율만큼만 빼요
    cash += sell.proceeds;
    actions.push(Object.assign({}, base, {
      ts: Date.now(), symbol: o.symbol, name: pos.name || o.symbol, side: 'REBALANCE', qty: o.qty, price: prices[o.symbol],
      pnlPct: Math.round(((sell.proceeds - basis) / basis) * 10000) / 100,
      grossPnlPct: Math.round(((prices[o.symbol] - pos.avgPrice) / pos.avgPrice) * 10000) / 100,
      amount: Math.round(sell.proceeds), pnlAmount: Math.round(sell.proceeds - basis), fee: Math.round(sell.fee),
      reason: '월간 비중 조정', entryDate: pos.entryDate || null, entryRegime: pos.entryRegime || null
    }));
    if (o.qty >= pos.qty) delete positions[o.symbol];
    else positions[o.symbol] = Object.assign({}, pos, { qty: pos.qty - o.qty, costBasis: Math.round(positionCostBasis(costs, 'KR', pos) - basis) });
  }
  for (const o of plan.buys) {
    const buy = planBuy(costs, 'KR', Math.min(o.budget, cash), o.price);
    if (buy.qty < 1) continue;
    cash -= buy.total;
    const held = positions[o.symbol];
    positions[o.symbol] = held
      ? Object.assign({}, held, {
        qty: held.qty + buy.qty,
        avgPrice: Math.round((held.qty * held.avgPrice + buy.qty * o.price) / (held.qty + buy.qty)),
        costBasis: Math.round(positionCostBasis(costs, 'KR', held) + buy.total)
      })
      : { qty: buy.qty, avgPrice: o.price, costBasis: Math.round(buy.total), entryDate: today, name: o.name, excd: null,
        reason: '시가총액 상위', entryChangePct: null, entryRegime: cfg._regime || null };
    actions.push(Object.assign({}, base, {
      ts: Date.now(), symbol: o.symbol, name: o.name, side: 'BUY', qty: buy.qty, price: o.price,
      amount: Math.round(buy.total), fee: Math.round(buy.fee), reason: '시가총액 상위', entryChangePct: null
    }));
  }

  const index = await fetchKospi200(token);
  state.lastMonth = today.slice(0, 7);
  state.startDate = state.startDate || today;
  state.rebalances = (state.rebalances || 0) + 1;
  if (index) { state.startIndex = state.startIndex || index; state.lastIndex = index; state.indexDate = today; }
  // 계좌와 조정 기록을 함께 저장해요. 실패하면 이번 매매를 기록하지 않고, 다음 실행에서 다시 판단해요.
  const saved = await kvMSetJson({ [keys.positionsKey]: positions, [keys.cashKey]: cash, [LONGTERM_STATE_KEY]: state });
  if (!saved) {
    console.error('auto-trade-check.js(longterm): 계좌 저장 실패');
    return [];
  }
  return actions;
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

  // 국내·미국 둘 다 장이 닫혀 있으면 저장소도 안 읽고 바로 끝냅니다(스케줄러가 1분마다 불러도 낭비 없음).
  const krOpen = marketClock('KR').open, usOpen = marketClock('US').open;
  if (!krOpen && !usOpen) {
    res.status(200).json({ skipped: true, reason: 'market-closed' });
    return;
  }

  // 저장소 무료 한도가 "명령 횟수" 기준이라, 이번 실행에 필요한 값을 명령 1번으로 함께 읽어요.
  // 읽기에 실패하면 이번 실행을 통째로 건너뜁니다. 그대로 진행하면 계좌가 빈 것으로 보여서 덮어쓸 수 있어요.
  // 진화형·커스텀·시장적응형은 국내 전용이라, 국내장이 닫혀 있으면 읽지 않아요.
  const snap = await kvMGetJson([
    CONFIG_KEY, LOG_KEY, OVERRIDES_KEY, ADJUST_LASTRUN_KEY, COST_CONFIG_KEY, REGIME_CACHE_KEY, METHODS_KEY,
    ...(krOpen ? [CUSTOM_STRATEGIES_KEY, EVOLVE_KEY, REGIME_LASTUSED_KEY, EVOLVED_FACTORS_KEY, INTRADAY_STATE_KEY, LONGTERM_STATE_KEY] : [])
  ]);
  if (!snap) {
    res.status(503).json({ error: '저장소를 읽지 못해 이번 실행을 건너뛰었어요.' });
    return;
  }
  const cfg = snap[CONFIG_KEY];
  if (!cfg || !cfg.enabled) {
    res.status(200).json({ skipped: true, reason: 'disabled' });
    return;
  }

  try {
    const token = await getKisToken();
    const today = todayKST();

    // 자동매매 종목은 고정 50종목(_universe.js)이에요. 관심종목·해외 종목은 더 이상 새로 사지 않고,
    // 이미 들고 있던 해외 종목은 아래 각 전략의 보유 종목 점검(손절·익절)으로 자연스럽게 정리돼요.
    const krCandidates = krOpen ? universeCandidates() : [];
    const usCandidates = [];

    const krQuoteCache = new Map();
    const usQuoteCache = new Map();
    const fetchKrQuote = makeQuoteFetcher(token, 'KR', krQuoteCache);
    const fetchUsQuote = makeQuoteFetcher(token, 'US', usQuoteCache);

    const isOn = (id) => strategyEnabled(cfg, id); // 새 전략 구성(_strategies.js LINEUP) 기준 켜짐/꺼짐
    const activeDefs = STRATEGY_DEFS.filter((def) => isOn(def.id));
    cfg._methods = snap[METHODS_KEY] || {}; // 전략별 사는/파는 방법(이번 실행 동안만 쓰는 값)
    cfg._minutes = marketClock('KR').minutes;
    // 코스피200(시장 필터·인버스·위험 줄이기에 써요). 실행마다 한 번만 받아요.
    cfg._index = krOpen ? await fetchIndexQuote(token) : null;

    // 오늘의 시장 상황(상승장·하락장·횡보장 × 평온·고변동)을 매매 기록마다 남겨서, 채점표의 "시장 적응력"을 계산해요.
    // 하루 한 번만 계산해 저장하니(classifyTodayRegime 캐시) 자주 불려도 부담이 없어요. 실패해도 매매는 계속돼요.
    // cfg._regime은 이번 실행 동안만 쓰는 값이에요(설정에 저장되지 않음).
    try {
      // 09:30 전처럼 후보가 너무 적으면 한두 종목만 보고 하루치를 판단하게 되니, 저장된 값을 그대로 써요.
      cfg._regime = krCandidates.length >= 3 ? await classifyTodayRegime(token, krCandidates, today, snap[REGIME_CACHE_KEY]) : (snap[REGIME_CACHE_KEY] || {}).label || null;
    } catch (e) {
      cfg._regime = null;
    }

    const results = {};
    const allActions = [];

    // 전체 매매 로그는 이번 실행에서 딱 한 번만 읽어옵니다. 각 전략이 "오늘 몇 번 매매했는지" 셀 때
    // 이 메모리 안의 log만 참조하고, 새로 생긴 매매는 맨 끝에서 한 번만 합쳐서 저장합니다
    // (전략마다 매번 KV에서 로그를 다시 읽고/쓰던 것을 없애, 동시 실행 시 덮어쓰기 충돌 위험도 줄입니다).
    const log = snap[LOG_KEY] || [];

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const overrides = await maybeRunLearningCycle(cfg, today, log, snap);
    const costs = normalizeCosts(snap[COST_CONFIG_KEY] || null); // 매매 비용 설정(기본: 토스증권) — 자동매매 탭에서 바꿀 수 있음

    // 가중치 전략(진화형·커스텀·시장적응형)은 국내 전용이에요. 국내장이 닫혀 있으면 아래 목록이 비어서 건너뛰어요.
    const customList = krOpen ? (snap[CUSTOM_STRATEGIES_KEY] || []).filter((c) => c.enabled !== false) : [];
    const evolveState = krOpen && isOn('evolved') ? snap[EVOLVE_KEY] : null;
    const evolvedStrategy = evolveState && evolveState.globalBest && evolveState.globalBest.strategy;
    const regimeLabel = krOpen && isOn('regime-adaptive')
      ? (cfg._regime || await classifyTodayRegime(token, krCandidates, today, snap[REGIME_CACHE_KEY]))
      : null;

    // 이번 실행에서 쓸 계좌를 명령 1번으로 함께 읽어요. 열린 시장의 계좌만 읽습니다.
    const accountKeys = [];
    const addAccount = (id, market) => { const k = keysFor(id, market); accountKeys.push(k.positionsKey, k.cashKey); };
    activeDefs.forEach((def) => {
      if (krOpen) addAccount(def.id, 'KR');
      if (usOpen && !def.krOnly) addAccount(def.id, 'US');
    });
    if (evolvedStrategy) addAccount('evolved', 'KR');
    customList.forEach((c) => addAccount(c.id, 'KR'));
    if (regimeLabel) { addAccount('regime-adaptive', 'KR'); accountKeys.push(REGIME_KEY_PREFIX + regimeLabel); }
    const accounts = await kvMGetJson(accountKeys);
    if (!accounts) {
      res.status(503).json({ error: '저장소를 읽지 못해 이번 실행을 건너뛰었어요.' });
      return;
    }

    // 새 단타 전략은 장 초반 범위와 "평균 체결가에 닿은 시각"을 봐요. 바뀐 게 있을 때만 저장해서 평소엔 쓰기가 늘지 않아요.
    // 시세는 8개씩 나눠 먼저 받아 둬요. 뒤에 도는 전략들은 받아 둔 값을 다시 써서 한꺼번에 몰리지 않아요.
    const krMinutes = marketClock('KR').minutes;
    // 50종목 시세를 10개씩 나눠 먼저 받아 둬요. 뒤에 동시에 도는 전략들은 받아 둔 값을 다시 써서 초당 호출 제한에 걸리지 않아요.
    const krQuotesNow = [];
    if (krOpen) {
      for (let i = 0; i < krCandidates.length; i += 10) {
        const batch = await Promise.all(krCandidates.slice(i, i + 10).map((c) => fetchKrQuote(c.symbol)));
        batch.forEach((q) => { if (q && q.price !== null) krQuotesNow.push(q); });
      }
    }
    if (krOpen && activeDefs.some((d) => d.usesIntradayState) &&
      krMinutes >= hhmmToMin(INTRADAY_RULES.buyStart) - 1 && krMinutes < hhmmToMin(INTRADAY_RULES.buyEnd)) {
      const quotes = krQuotesNow;
      const { state, dirty } = updateIntradayState(snap[INTRADAY_STATE_KEY], quotes, krMinutes, today, Date.now());
      cfg._intraday = state; // 이번 실행 동안만 쓰는 값(cfg._regime과 같은 방식, 설정에 저장되지 않음)
      if (dirty) await kvSetJson(INTRADAY_STATE_KEY, state);
    }

    // 일봉으로 계산하는 값(진화형 점수 팩터, 급락 다음날 매수의 "어제 등락률")은 하루 안에서 바뀌지 않아서
    // 하루 한 번만 계산해 저장해 두고 다시 써요. 오늘 계산해 둔 종목은 건너뛰고, 빠진 종목만 새로 받아요.
    const needDaily = evolvedStrategy || customList.length || regimeLabel || activeDefs.some((d) => d.usesDaily);
    let factorMap = new Map();
    if (krOpen && needDaily) {
      const cachedEntry = snap[EVOLVED_FACTORS_KEY] || null;
      const fresh = cachedEntry && cachedEntry.date === today && cachedEntry.v === 2;
      const cachedFactors = fresh && cachedEntry.factors ? cachedEntry.factors : {};
      const cachedDaily = fresh && cachedEntry.daily ? cachedEntry.daily : {};
      const missing = krCandidates.filter((c) => !cachedFactors[c.symbol]);
      let factorsObj = cachedFactors, dailyObj = cachedDaily;
      if (missing.length) {
        const freshMap = await buildFactorMap(token, missing, today);
        factorsObj = Object.assign({}, cachedFactors);
        dailyObj = Object.assign({}, cachedDaily);
        for (const [sym, v] of freshMap) { factorsObj[sym] = v.factors; if (v.daily) dailyObj[sym] = v.daily; }
        // 일봉이 부족한 종목은 계속 비어 있으니, 새로 계산된 값이 있을 때만 저장해요.
        if (freshMap.size) await kvSetJson(EVOLVED_FACTORS_KEY, { v: 2, date: today, factors: factorsObj, daily: dailyObj });
      }
      factorMap = new Map(Object.entries(factorsObj));
      cfg._daily = dailyObj;
    }

    // 전략끼리는 서로 다른 KV 키(현금/보유종목)를 쓰기 때문에 서로 영향을 주지 않아, 동시에(병렬로)
    // 처리해도 안전합니다 — 순서대로 하나씩 기다리던 것보다 전체 실행 시간이 훨씬 짧아집니다.
    await Promise.all(activeDefs.map(async (def) => {
      // 전략별로 AI가 자동 조정한 값(오버라이드)이 있으면 하드코딩된 기본값/사용자 설정 위에 덮어씁니다.
      // (규칙이 따로 정해진 전략은 오버라이드를 적용하지 않음)
      const risk = def.ownRules ? def.getRisk(cfg) : Object.assign({}, def.getRisk(cfg), overrides[def.id] || {});
      const [krResult, usResult] = await Promise.all([
        processStrategyMarket(def, 'KR', fetchKrQuote, cfg, krCandidates, today, risk, apiKey, log, costs, accounts),
        def.krOnly
          ? { actions: [], cash: STARTING_CASH_US, positions: {} } // 국내 전용 전략(단타)은 해외 계좌를 쓰지 않음
          : processStrategyMarket(def, 'US', fetchUsQuote, cfg, usCandidates, today, risk, apiKey, log, costs, accounts)
      ]);
      results[def.id] = { kr: { cash: krResult.cash, positions: krResult.positions }, us: { cash: usResult.cash, positions: usResult.positions } };
      allActions.push(...krResult.actions, ...usResult.actions);
    }));

    // ---- 진화형(자동탐색) + 커스텀 전략 — 둘 다 "가중치 점수 ≥ 매수기준"이면 사는 같은 방식이라
    // (국내 종목만 지원), 종목별 팩터 계산을 한 번만 해서 같이 씁니다.
    // 위에서 이미 데운(캐시에 들어있는) 시세를 그대로 재사용하도록, 다른 전략들 처리가 끝난 뒤에 실행합니다.
    // 시장적응형: 오늘의 시장 상황(구간)을 분류하고, backtest.js가 그 구간 전용으로 찾아둔 전략을 가져옵니다.
    let regimeStrategy = null;
    if (regimeLabel) {
      const regimeState = accounts[REGIME_KEY_PREFIX + regimeLabel];
      regimeStrategy = regimeState && regimeState.globalBest && regimeState.globalBest.strategy;

      // 어제와 구간이 달라졌으면("상승장" → "하락장" 등) 전략 변경 이력에 남겨서, 왜 전략이 바뀌었는지 보이게 합니다.
      const lastUsed = snap[REGIME_LASTUSED_KEY] || null;
      if (regimeStrategy && lastUsed !== regimeLabel) {
        try {
          const changes = await kvGetJson(CHANGES_KEY, []);
          changes.unshift({
            id: Date.now() + '-regime-switch',
            ts: Date.now(), date: today, strategyId: 'regime-adaptive', strategyName: '시장적응형(' + regimeLabelKo(regimeLabel) + ')',
            source: 'backtest',
            diagnosis: lastUsed
              ? `시장 상황이 "${regimeLabelKo(lastUsed)}"에서 "${regimeLabelKo(regimeLabel)}"으로 바뀌어, 그 구간 전용으로 찾아둔 전략으로 전환했습니다.`
              : `시장 상황을 "${regimeLabelKo(regimeLabel)}"으로 분류해, 이 구간 전용 전략을 처음 적용했습니다.`,
            statsAtChange: null,
            beforeDescription: null, afterDescription: null
          });
          if (changes.length > MAX_CHANGES) changes.length = MAX_CHANGES;
          await kvSetJson(CHANGES_KEY, changes);
        } catch (e) {
          console.error('auto-trade-check.js(regime switch log) error:', e);
        }
        await kvSetJson(REGIME_LASTUSED_KEY, regimeLabel);
      }
    }

    if (evolvedStrategy || customList.length || regimeStrategy) {
      // 팩터는 위에서 하루 한 번 계산해 둔 factorMap을 그대로 써요.

      // 가중치 기반 전략(진화형 1개 + 커스텀 여러 개)을 돌릴 목록으로 모읍니다 — 서로 다른 KV 키를 쓰니 병렬 처리 가능.
      const weightDefs = [];
      if (evolvedStrategy) weightDefs.push({ id: 'evolved', name: '진화형(자동탐색)', strategy: evolvedStrategy, horizon: 'swing' });
      customList.forEach((c) => weightDefs.push({ id: c.id, name: c.name, strategy: c, horizon: normalizeHorizon(c.horizon) }));
      if (regimeStrategy) weightDefs.push({ id: 'regime-adaptive', name: '시장적응형(' + regimeLabelKo(regimeLabel) + ')', strategy: regimeStrategy, horizon: 'swing' });

      await Promise.all(weightDefs.map(async (wd) => {
        const def = {
          id: wd.id, name: wd.name, horizon: wd.horizon, gate: wd.horizon === 'day' ? 'up' : 'swing',
          ...(wd.horizon === 'day' ? { intraday: true, dayRules: () => DAY_CLOSE_RULES } : {}),
          shouldBuy: (cand) => {
            const factors = factorMap.get(cand.symbol);
            if (!factors) return false;
            return scoreForStrategy(factors, wd.strategy.weights) >= wd.strategy.buyThreshold;
          }
        };
        const risk = evolvedRiskFrom(wd.strategy);
        const result = await processStrategyMarket(def, 'KR', fetchKrQuote, cfg, krCandidates, today, risk, apiKey, log, costs, accounts);
        results[wd.id] = { kr: { cash: result.cash, positions: result.positions }, us: { cash: STARTING_CASH_US, positions: {} } };
        allActions.push(...result.actions);
      }));
    }

    // 장기 분산: 조정할 달이면 조정하고, 아니면 하루 한 번 코스피200만 적어요. 실패해도 다른 전략의 매매에는 영향이 없어요.
    if (krOpen && isOn('longterm')) {
      try {
        const ltState = snap[LONGTERM_STATE_KEY];
        if (rebalanceDue(ltState, today, krMinutes, Date.now())) {
          allActions.push(...await runLongTermRebalance(token, today, ltState, fetchKrQuote, costs, cfg));
        } else if (indexUpdateDue(ltState, today, krMinutes)) {
          const index = await fetchKospi200(token);
          if (index) await kvSetJson(LONGTERM_STATE_KEY, Object.assign({}, ltState, { startIndex: ltState.startIndex || index, lastIndex: index, indexDate: today }));
        }
      } catch (e) {
        console.error('auto-trade-check.js(longterm) error:', e);
      }
    }

    // 이번 실행에서 생긴 모든 매매 기록을 한 번에 합쳐서 딱 한 번만 저장합니다.
    if (allActions.length) {
      for (const entry of allActions) log.unshift(entry);
      if (log.length > MAX_LOG) log.length = MAX_LOG;
      await kvSetJson(LOG_KEY, log);
    }

    // 학습하는 자동조정: 이번 매도들을 진행 중인 실험의 표본으로 더해요(계산만, AI 호출 없음).
    try {
      await recordLearningSamples(allActions);
    } catch (e) {
      console.error('auto-trade-check.js(learning samples) error:', e);
    }

    // 손익 캘린더용 날짜별 장부(_ledger.js) — 위 매매 기록은 400건만 남지만, 이 장부는 지워지지 않아요.
    // 장부가 처음 만들어지는 순간엔 방금 매매까지 포함된 log 전체로 채우니, 그때는 따로 더하지 않습니다(두 번 더해짐 방지).
    try {
      if (allActions.length) {
        const backfilled = await ensureBackfilled(log);
        if (!backfilled) await recordEntries(allActions);
      }
    } catch (e) {
      console.error('auto-trade-check.js(daily ledger) error:', e);
    }

    // 연간 실현손익 장부 — 해외주식 양도세(연 단위 합산)를 계산하려면 1년치 합계가 필요한데,
    // 매매 기록은 최근 400건만 남으니 매도가 생길 때마다 여기에 따로 누적합니다.
    // 달러 손익은 "매도 당시" 환율로 원화 환산해서 쌓습니다(실제 신고도 거래일 환율 기준이라 이게 더 정확해요).
    const isSell = (a) => isSellSide(a.side);
    const newSells = allActions.filter(isSell);
    if (newSells.length) {
      try {
        const year = today.slice(0, 4);
        const ledgerKey = REALIZED_KEY_PREFIX + year;
        let ledger = await kvGetJson(ledgerKey, null);
        // 장부가 처음 만들어지는 경우: 이미 남아있는 올해 매매 기록(방금 추가한 것 포함)으로 한 번 채워 넣습니다.
        // (이 기능 전 기록은 비용이 안 빠진 손익이라 약간 높게 잡히고, 달러 손익은 지금 환율로 환산된 근사치예요.)
        const sells = ledger ? newSells : log.filter((e) => isSell(e) && String(e.date || '').startsWith(year));
        ledger = ledger || {};
        const usdKrw = sells.some((a) => a.market === 'US') ? await fetchUsdKrw() : null;
        for (const a of sells) {
          const row = ledger[a.strategy] || { krPnlKrw: 0, krTrades: 0, usPnlUsd: 0, usPnlKrw: 0, usTrades: 0, usFxMissing: 0 };
          if (a.market === 'KR') {
            row.krPnlKrw += a.pnlAmount || 0;
            row.krTrades += 1;
          } else {
            row.usPnlUsd += a.pnlAmount || 0;
            if (usdKrw) row.usPnlKrw += (a.pnlAmount || 0) * usdKrw;
            else row.usFxMissing += 1; // 환율 조회 실패 — 원화 합계에서 빠졌다는 표시
            row.usTrades += 1;
          }
          ledger[a.strategy] = row;
        }
        await kvSetJson(ledgerKey, ledger);
      } catch (e) {
        console.error('auto-trade-check.js(realized ledger) error:', e);
      }
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
