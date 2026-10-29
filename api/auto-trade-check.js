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
import { fetchSymbolHistory, annotateWithFactors, scoreForStrategy, classifyRegimeByDate } from './_backtest-core.js';
import { loadCosts, planBuy, planSell, positionCostBasis, fetchUsdKrw, REALIZED_KEY_PREFIX } from './_costs.js';
import { normalizeDaytrade, hhmmToMin } from './_daytrade.js';
import { BASE_RISK, keysFor, STARTING_CASH_US } from './_strategies.js';
import { isSellSide, recordEntries, ensureBackfilled } from './_ledger.js';
import { askClaude, extractJson } from './_ai.js'; // AI 호출 공용 창구(사용량·예산·실패 이유 기록)
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
async function classifyTodayRegime(token, krCandidates, today) {
  const cached = await kvGetJson(REGIME_CACHE_KEY, null);
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

function isAiCand(cand) {
  return cand.reason.indexOf('AI 추천') === 0;
}

// 전략별 정의 — 매수 트리거(shouldBuy)와 리스크 규칙(risk)이 서로 다릅니다.
// momentum은 사용자가 설정 화면에서 조절하는 cfg.risk를 그대로 쓰고(기존 동작 유지),
// 나머지는 "경쟁 비교"가 목적이라 비교 기준이 흔들리지 않도록 고정값(_strategies.js의 BASE_RISK)을 씁니다.
// baseline(기준선)은 조건 없이 후보를 그대로 사는 전략으로, 다른 전략들이 "그냥 아무거나 사는 것"보다
// 실제로 나은지를 판단하는 비교 기준(대조군) 역할을 합니다.
const STRATEGY_DEFS = [
  {
    id: 'momentum',
    name: '모멘텀(추세 추종)',
    getRisk: (cfg) => Object.assign({}, BASE_RISK.momentum, cfg.risk || {}),
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isAiCand(cand) ? 1 : 3)
  },
  {
    id: 'pullback',
    name: '눌림목(과열 회피)',
    getRisk: () => BASE_RISK.pullback,
    // 이미 많이 오른 급등주보다, 완만하게 움직이기 시작한(0~2%) 종목을 선호합니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct > 0 && q.changePct <= 2
  },
  {
    id: 'breakout',
    name: '강한 돌파',
    getRisk: () => BASE_RISK.breakout,
    // 더 강한 상승 모멘텀만 선택하고, 손절/익절 폭도 더 크게 잡아 추세를 오래 태웁니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isAiCand(cand) ? 4 : 6)
  },
  {
    id: 'reversal',
    name: '역추세(저가 반등)',
    getRisk: () => BASE_RISK.reversal,
    // 최근 하락폭이 있는(-2%~-6%) 종목의 단기 반등을 노립니다. 실패 시 빨리 손절하도록 폭을 좁게 잡습니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct <= -2 && q.changePct >= -6
  },
  {
    id: 'scalp',
    name: '초단타(잦은 매매)',
    getRisk: () => BASE_RISK.scalp,
    // 문턱을 낮춰 자주 매매하고, 손절/익절 폭도 아주 좁게 잡아 빠르게 치고 빠집니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isAiCand(cand) ? 0.5 : 1.5)
  },
  {
    id: 'selective',
    name: '신중한 선별(엄격)',
    getRisk: () => BASE_RISK.selective,
    // 아주 강한 조건에서만 매매하되, 한 번 살 때 비중을 크게 실어(8%) 소수 정예로 갑니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isAiCand(cand) ? 2.5 : 4)
  },
  {
    id: 'wideswing',
    name: '광폭 스윙(길게 보유)',
    getRisk: () => BASE_RISK.wideswing,
    // 모멘텀과 매수 조건은 비슷하지만, 손절/익절 폭을 훨씬 넓게 잡아 추세를 오래 들고 갑니다.
    shouldBuy: (cand, q) => q.changePct !== null && q.changePct >= (isAiCand(cand) ? 1.5 : 3)
  },
  {
    id: 'baseline',
    name: '기준선(대조군, 조건 없음)',
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
    intraday: true,
    krOnly: true,
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
  }
];


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
    open: num(o.stck_oprc), high: num(o.stck_hgpr) // 오늘 시가·고가 — 데이트레이딩 전략이 장중 흐름을 볼 때 씀(추가 API 호출 없음)
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
// 기준선(대조군)은 비교 기준이라 절대 바꾸지 않고, 단타는 사용자가 직접 정하는 설정이라 대상이 아니에요.
function isAdjustable(def) {
  return !def.intraday && def.id !== 'baseline';
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
async function maybeRunLearningCycle(cfg, today, log) {
  const overrides = await kvGetJson(OVERRIDES_KEY, {});
  const intervalHours = Math.max(1, Math.min(168, Number(cfg.adjustIntervalHours) || 24));
  const lastRunTs = await kvGetJson(ADJUST_LASTRUN_KEY, 0);
  if (Date.now() < (typeof lastRunTs === 'number' ? lastRunTs : 0) + intervalHours * 3600 * 1000) return overrides;
  await kvSetJson(ADJUST_LASTRUN_KEY, Date.now()); // 중간에 실패해도 같은 주기 안에서 무한 재시도하지 않게 먼저 기록

  try {
    const [experiments, best, flags, changes, regimeCache, deepEval] = await Promise.all([
      kvGetJson(EXPERIMENTS_KEY, []), kvGetJson(BEST_RISK_KEY, {}), kvGetJson(FLAGS_KEY, {}),
      kvGetJson(CHANGES_KEY, []), kvGetJson(REGIME_CACHE_KEY, null), kvGetJson(DEEPEVAL_LATEST_KEY, null)
    ]);
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

    for (const def of STRATEGY_DEFS.filter(isAdjustable)) {
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
        const since = overrides[def.id] && overrides[def.id].updatedAt ? overrides[def.id].updatedAt : 0;
        observing = { id: 'obs-' + now + '-' + def.id, strategyId: def.id, strategyName: def.name, status: 'observing',
          startedAt: now, risk: current, samples: sellSamplesFromLog(log, def.id, since, LEARN.beforeTrades) };
        experiments.unshift(observing);
      }

      // 사는 조건 문제 자동 감지: 최근 20건 승률이 20% 미만이면 숫자를 더 바꾸지 않고 표시만 해요(30% 이상 회복하면 해제).
      const recent = summarize(sellSamplesFromLog(log, def.id, 0, LEARN.buyRuleWindow));
      if (recent.trades >= LEARN.buyRuleWindow && recent.winRate < LEARN.buyRuleWinRate) {
        if (!flags[def.id]) flags[def.id] = { type: 'buy-rule', at: now, winRate: recent.winRate,
          note: `최근 ${recent.trades}건 승률 ${recent.winRate}% — 손절·익절 숫자보다 "사는 조건"이 안 맞을 가능성이 커요. 끄거나 전략연구실에서 검증해 보세요.` };
        continue;
      }
      if (flags[def.id] && flags[def.id].type === 'buy-rule' && recent.winRate !== null && recent.winRate >= 30) delete flags[def.id];
      if (flags[def.id]) continue;

      // ③ 관찰한 거래가 10건 모이면 → AI에게 다음 실험을 설계하게 해요
      if ((observing.samples || []).length < LEARN.beforeTrades) continue;
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
        controlBeforeStats: summarize(sellSamplesFromLog(log, 'baseline', 0, LEARN.beforeTrades)),
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
// log는 handler에서 실행 시작 시 딱 한 번만 읽어서 넘겨주는 전체 매매 로그입니다(읽기 전용으로만 씀) —
// 여러 전략이 매번 전체 로그를 KV에서 다시 읽던 것을 없애서 호출 수를 줄입니다.
// costs: _costs.js의 매매 비용 설정(수수료·거래세·환전) — 살 때/팔 때 실제로 빠지는 돈을 반영해서,
// 가상계좌 현금과 기록되는 손익(pnlPct/pnlAmount)이 실제 계좌에 남는 돈과 최대한 같아지게 합니다.
// 손절/익절 "발동" 기준은 증권사 주문처럼 주가 등락률(가격 기준) 그대로 두고, 기록되는 손익만 비용을 뺀 값으로 남깁니다.
async function processStrategyMarket(strategyDef, marketKey, fetchQuote, cfg, candidates, today, risk, apiKey, log, costs) {
  const keys = keysFor(strategyDef.id, marketKey);
  const positions = await kvGetJson(keys.positionsKey, {});
  let cash = await kvGetJson(keys.cashKey, keys.startingCash);
  if (typeof cash !== 'number') cash = keys.startingCash;

  // 장이 닫혀 있으면 아무것도 하지 않습니다(손절·익절도 — 닫힌 장의 가격으론 실제로 팔 수 없으니까요).
  const clock = marketClock(marketKey);
  if (!clock.open) return { actions: [], cash, positions };
  const intraday = !!strategyDef.intraday;
  const dt = intraday ? normalizeDaytrade(cfg.daytrade) : null; // 단타 설정(시간·손실한도·재매수 대기)

  // 오늘 매매 횟수: 스윙 전략은 기존처럼 "매수+익절"을 세고, 단타는 "매수"만 셉니다
  // (단타는 파는 건 언제든 할 수 있어야 하니까 — 익절/청산이 한도에 막혀 못 팔면 안 돼요).
  const tradesToday = log.filter((e) => e.date === today && e.market === marketKey && e.strategy === strategyDef.id &&
    (intraday ? e.side === 'BUY' : e.side !== 'STOP_LOSS')).length;
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
    // 단타: 청산 시각이 넘었거나, (스케줄러가 멈췄던 등의 이유로) 어제 산 게 남아 있으면 손익과 상관없이 정리합니다.
    if (intraday && (clock.minutes >= hhmmToMin(dt.closeAt) || pos.entryDate !== today)) side = 'DAY_CLOSE';
    else if (pnlPct <= -stopLossPct) side = 'STOP_LOSS';
    else if (pnlPct >= takeProfitPct && (intraday || tradesToday < maxTradesPerDay)) side = 'TAKE_PROFIT';

    if (side) {
      const sell = planSell(costs, marketKey, pos.qty, q.price);
      const costBasis = positionCostBasis(costs, marketKey, pos); // 매수금액 + 매수비용
      const netPnlAmount = sell.proceeds - costBasis; // 이번 매매로 실제로 남은(잃은) 돈 — 시장 통화 기준
      const netPnlPct = (netPnlAmount / costBasis) * 100;
      const digits = marketKey === 'KR' ? 1 : 100;
      cash += sell.proceeds;
      delete positions[symbol];
      const entry = {
        ts: Date.now(), date: today, market: marketKey, strategy: strategyDef.id,
        symbol, name: pos.name || q.name || symbol, side,
        qty: pos.qty, price: q.price,
        pnlPct: Math.round(netPnlPct * 100) / 100, // 비용(수수료·세금·환전) 뺀 실제 수익률
        grossPnlPct: Math.round(pnlPct * 100) / 100, // 단순 주가 등락률(참고용)
        amount: Math.round(sell.proceeds * digits) / digits,
        pnlAmount: Math.round(netPnlAmount * digits) / digits,
        fee: Math.round(sell.fee * digits) / digits,
        mode: 'dryrun',
        reason: pos.reason || null,
        entryChangePct: typeof pos.entryChangePct === 'number' ? pos.entryChangePct : null // 산 날의 전일 대비 등락률(고점 매수 분석용)
      };
      // 단타는 손절이 자주 나서, 매번 AI에게 원인을 묻지 않습니다(API 비용 절약).
      if (side === 'STOP_LOSS' && !intraday) {
        const holdingDays = Math.max(0, Math.round((Date.parse(today) - Date.parse(pos.entryDate)) / 86400000));
        entry.aiReason = await explainStopLoss({
          strategyName: strategyDef.name, stopLossPct,
          name: entry.name, symbol, buyReason: pos.reason,
          avgPrice: pos.avgPrice, price: q.price, pnlPct: entry.pnlPct,
          holdingDays, entryDate: pos.entryDate, today
        }, apiKey);
      }
      actions.push(entry);
    }
  }

  // 단타 전용 매수 제한: 매수 가능 시간대 + 오늘 손실한도 + 판 지 30분 안 된 종목 제외
  let intradayBuyAllowed = true;
  const recentlySold = new Set();
  if (intraday) {
    const mine = (e) => e.strategy === strategyDef.id && e.market === marketKey;
    const todaysSells = log.filter((e) => mine(e) && e.date === today && isSellSide(e.side)).concat(actions);
    const realizedToday = todaysSells.reduce((sum, e) => sum + (e.pnlAmount || 0), 0);
    const lossLimit = keys.startingCash * (dt.dailyLossLimitPct / 100);
    intradayBuyAllowed = clock.minutes >= hhmmToMin(dt.buyStart) && clock.minutes < hhmmToMin(dt.buyEnd) && realizedToday > -lossLimit;
    const cooldownFrom = Date.now() - dt.cooldownMin * 60 * 1000;
    log.filter((e) => mine(e) && isSellSide(e.side) && e.ts >= cooldownFrom).concat(actions)
      .forEach((e) => recentlySold.add(e.symbol));
  }

  // 2) 신규 매수 후보 평가 (일일 매매 한도 내에서만)
  const currentTradesToday = tradesToday + (intraday ? 0 : actions.filter((a) => a.side === 'TAKE_PROFIT').length);
  if (currentTradesToday < maxTradesPerDay && intradayBuyAllowed) {
    for (const cand of candidates) {
      if (positions[cand.symbol]) continue; // 이미 보유 중이면 스킵
      if (recentlySold.has(cand.symbol)) continue; // 단타: 방금 판 종목은 잠시 쉬었다가
      const remainingSlots = maxTradesPerDay - (tradesToday + actions.filter((a) => a.side === 'BUY').length);
      if (remainingSlots <= 0) break;

      const q = await fetchQuote(cand.symbol);
      if (!q || q.price === null || q.changePct === null) continue;
      if (!strategyDef.shouldBuy(cand, q, cfg)) continue;

      const budget = cash * (positionPct / 100);
      // 매수비용(수수료, 해외는 환전비용까지)을 포함해도 예산을 넘지 않는 최대 수량
      const buy = planBuy(costs, marketKey, budget, q.price);
      if (buy.qty < 1) continue;
      const qty = buy.qty;
      const digits = marketKey === 'KR' ? 1 : 100;

      cash -= buy.total;
      const displayName = cand.name || q.name || cand.symbol;
      positions[cand.symbol] = {
        qty, avgPrice: q.price, costBasis: Math.round(buy.total * digits) / digits,
        entryDate: today, name: displayName, excd: q.excd || null, reason: cand.reason || null,
        entryChangePct: q.changePct // 산 순간 이미 어제보다 몇 % 올라 있었는지 — 팔 때 기록에 옮겨 "고점 매수" 여부를 따져요
      };
      const entry = {
        ts: Date.now(), date: today, market: marketKey, strategy: strategyDef.id,
        symbol: cand.symbol, name: displayName, side: 'BUY',
        qty, price: q.price, amount: Math.round(buy.total * digits) / digits,
        fee: Math.round(buy.fee * digits) / digits, reason: cand.reason, mode: 'dryrun', entryChangePct: q.changePct
      };
      actions.push(entry);
    }
  }

  await kvSetJson(keys.positionsKey, positions);
  await kvSetJson(keys.cashKey, cash);

  return { actions, cash, positions };
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
async function buildFactorMap(token, krCandidates) {
  const map = new Map();
  for (const cand of krCandidates) {
    try {
      const hist = await fetchSymbolHistory(token, cand.symbol, EVOLVED_FACTOR_LOOKBACK_DAYS);
      if (hist.length < 20) continue;
      const annotated = annotateWithFactors(hist);
      map.set(cand.symbol, annotated[annotated.length - 1].factors);
    } catch (e) {
      // 한 종목 실패해도 나머지는 계속 진행
    }
  }
  return map;
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
  // 국내·미국 둘 다 장이 닫혀 있으면 시세 조회·AI 호출 없이 바로 끝냅니다(스케줄러가 자주 불러도 낭비 없음).
  if (!marketClock('KR').open && !marketClock('US').open) {
    res.status(200).json({ skipped: true, reason: 'market-closed' });
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

    // 전체 매매 로그는 이번 실행에서 딱 한 번만 읽어옵니다. 각 전략이 "오늘 몇 번 매매했는지" 셀 때
    // 이 메모리 안의 log만 참조하고, 새로 생긴 매매는 맨 끝에서 한 번만 합쳐서 저장합니다
    // (전략마다 매번 KV에서 로그를 다시 읽고/쓰던 것을 없애, 동시 실행 시 덮어쓰기 충돌 위험도 줄입니다).
    const log = await kvGetJson(LOG_KEY, []);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const overrides = await maybeRunLearningCycle(cfg, today, log);
    const costs = await loadCosts(); // 매매 비용 설정(기본: 토스증권) — 자동매매 탭에서 바꿀 수 있음

    // 전략끼리는 서로 다른 KV 키(현금/보유종목)를 쓰기 때문에 서로 영향을 주지 않아, 동시에(병렬로)
    // 처리해도 안전합니다 — 순서대로 하나씩 기다리던 것보다 전체 실행 시간이 훨씬 짧아집니다.
    await Promise.all(activeDefs.map(async (def) => {
      // 전략별로 AI가 자동 조정한 값(오버라이드)이 있으면 하드코딩된 기본값/사용자 설정 위에 덮어씁니다.
      // (단타는 사용자 설정만 따르므로 오버라이드를 적용하지 않음)
      const risk = def.intraday ? def.getRisk(cfg) : Object.assign({}, def.getRisk(cfg), overrides[def.id] || {});
      const [krResult, usResult] = await Promise.all([
        processStrategyMarket(def, 'KR', fetchKrQuote, cfg, krCandidates, today, risk, apiKey, log, costs),
        def.krOnly
          ? { actions: [], cash: STARTING_CASH_US, positions: {} } // 국내 전용 전략(단타)은 해외 계좌를 쓰지 않음
          : processStrategyMarket(def, 'US', fetchUsQuote, cfg, usCandidates, today, risk, apiKey, log, costs)
      ]);
      results[def.id] = { kr: { cash: krResult.cash, positions: krResult.positions }, us: { cash: usResult.cash, positions: usResult.positions } };
      allActions.push(...krResult.actions, ...usResult.actions);
    }));

    // ---- 진화형(자동탐색) + 커스텀 전략 — 둘 다 "가중치 점수 ≥ 매수기준"이면 사는 같은 방식이라
    // (국내 종목만 지원), 종목별 팩터 계산을 한 번만 해서 같이 씁니다.
    // 위에서 이미 데운(캐시에 들어있는) 시세를 그대로 재사용하도록, 다른 전략들 처리가 끝난 뒤에 실행합니다.
    const customList = (await kvGetJson(CUSTOM_STRATEGIES_KEY, [])).filter((c) => c.enabled !== false);
    const evolveState = strategiesEnabled.evolved !== false ? await kvGetJson(EVOLVE_KEY, null) : null;
    const evolvedStrategy = evolveState && evolveState.globalBest && evolveState.globalBest.strategy;

    // 시장적응형: 오늘의 시장 상황(구간)을 분류하고, backtest.js가 그 구간 전용으로 찾아둔 전략을 가져옵니다.
    let regimeStrategy = null, regimeLabel = null;
    if (strategiesEnabled['regime-adaptive'] !== false) {
      regimeLabel = await classifyTodayRegime(token, krCandidates, today);
      const regimeState = await kvGetJson(REGIME_KEY_PREFIX + regimeLabel, null);
      regimeStrategy = regimeState && regimeState.globalBest && regimeState.globalBest.strategy;

      // 어제와 구간이 달라졌으면("상승장" → "하락장" 등) 전략 변경 이력에 남겨서, 왜 전략이 바뀌었는지 보이게 합니다.
      const lastUsed = await kvGetJson(REGIME_LASTUSED_KEY, null);
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
      // 팩터(이동평균/RSI 등)는 "그날의 일봉" 기준이라 하루 안에서는 바뀌지 않습니다. 이미 오늘 계산해둔
      // 종목은 캐시에서 그대로 쓰고, 새로 생긴 후보 종목만 추가로 계산해서 캐시를 채웁니다.
      const cachedEntry = await kvGetJson(EVOLVED_FACTORS_KEY, null);
      const cachedFactors = (cachedEntry && cachedEntry.date === today && cachedEntry.factors) ? cachedEntry.factors : {};
      const missingCandidates = krCandidates.filter((c) => !cachedFactors[c.symbol]);
      let factorsObj = cachedFactors;
      if (missingCandidates.length) {
        const freshMap = await buildFactorMap(token, missingCandidates);
        const freshObj = {};
        for (const [sym, factors] of freshMap) freshObj[sym] = factors;
        factorsObj = Object.assign({}, cachedFactors, freshObj);
        await kvSetJson(EVOLVED_FACTORS_KEY, { date: today, factors: factorsObj });
      }
      const factorMap = new Map(Object.entries(factorsObj));

      // 가중치 기반 전략(진화형 1개 + 커스텀 여러 개)을 돌릴 목록으로 모읍니다 — 서로 다른 KV 키를 쓰니 병렬 처리 가능.
      const weightDefs = [];
      if (evolvedStrategy) weightDefs.push({ id: 'evolved', name: '진화형(자동탐색)', strategy: evolvedStrategy });
      customList.forEach((c) => weightDefs.push({ id: c.id, name: c.name, strategy: c }));
      if (regimeStrategy) weightDefs.push({ id: 'regime-adaptive', name: '시장적응형(' + regimeLabelKo(regimeLabel) + ')', strategy: regimeStrategy });

      await Promise.all(weightDefs.map(async (wd) => {
        const def = {
          id: wd.id, name: wd.name,
          shouldBuy: (cand) => {
            const factors = factorMap.get(cand.symbol);
            if (!factors) return false;
            return scoreForStrategy(factors, wd.strategy.weights) >= wd.strategy.buyThreshold;
          }
        };
        const risk = evolvedRiskFrom(wd.strategy);
        const result = await processStrategyMarket(def, 'KR', fetchKrQuote, cfg, krCandidates, today, risk, apiKey, log, costs);
        results[wd.id] = { kr: { cash: result.cash, positions: result.positions }, us: { cash: STARTING_CASH_US, positions: {} } };
        allActions.push(...result.actions);
      }));
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
      const backfilled = await ensureBackfilled(log);
      if (!backfilled && allActions.length) await recordEntries(allActions);
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
