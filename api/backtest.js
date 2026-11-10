// /api/backtest.js
// "전략연구실" 탭의 백테스트 + 진화형 탐색 기능을 모두 담당합니다 (원래 backtest.js / backtest-evolve.js /
// evolve-auto.js 세 개의 파일이었는데, Vercel 무료(Hobby) 플랜의 "배포당 서버리스 함수 12개" 제한을
// 넘어서 배포가 실패하는 문제가 생겨 하나의 함수로 합쳤습니다. 동작 로직은 그대로이고, 어떤 기능을
// 쓸지는 쿼리 파라미터 mode로 구분합니다.
//
// mode=presets (기본값, 생략 가능): 고정 9개 전략(가중치·청산·사이징 조합)을 과거 데이터로 한 번에
//   비교하고 AI가 피드백을 줍니다. 예전 /api/backtest 와 동일.
// mode=strategy-prep / strategy / method-search: 고정 50종목으로 실제 자동매매 전략을 기간 백테스트하고,
//   사는/파는 방법 조합을 비교해요(로직은 _strategy-sim.js, 설명은 아래 해당 함수 위 주석).
// mode=evolve: "계속 더 나은 전략을 찾는" 반복 탐색. 서로 다른 시작점의 계보(lineage) 3개를 동시에
//   진화시켜서 한 조합에 갇히지 않게 합니다 (로직은 _evolve-core.js).
//   - 프론트엔드 버튼이 부르는 수동 실행: mode=evolve&symbols=...&days=...
//   - 외부 크론(cron-job.org 등)이 매일 부르는 자동 실행: mode=evolve&auto=1&key=자동매매_시크릿키
//     (감시 종목은 자동매매 설정에 저장된 관심종목을 재사용하고, AI 피드백 호출은 생략해 가볍게 돕니다.
//     예전 /api/evolve-auto 와 동일.)
//
// 두 모드 모두 같은 진화 상태(KV: backtest:evolution:v2)를 공유해서 이어서 탐색하므로, 수동/자동 실행을
// 섞어 써도 기록이 끊기지 않습니다.

import { getKisToken, kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';
import {
  fetchSymbolHistory, fetchSymbolHistoryRange, fetchOverseasHistoryRange, fetchInvestorTrend,
  annotateWithFactors, runBacktest, classifyRegimeByDate, REGIME_LABELS, STARTING_CASH, FEE_PCT
} from './_backtest-core.js';
import { DEFAULT_LINEAGES, describeStrategy, advanceGeneration, MAX_HISTORY } from './_evolve-core.js';
import { kvGetJson, kvSetJson, kvReady, kvMGetJson, kvMSetJson } from './_kv.js';
import { FIXED_UNIVERSE, INVERSE_ETF } from './_universe.js';
import { METHODS_KEY } from './_methods.js';
import { prepareData, simulateStrategy, searchMethods, walkForward, benchmarks, SIM_STRATEGY_IDS, SIM_NOTES } from './_strategy-sim.js';
import { normalizeRule, describeRule } from './_rules.js';
import { strategyEnabled } from './_strategies.js';
import {
  MIN5_PREFIX, MIN5_INDEX_KEY, TOSS_META_KEY, KR_HOLIDAYS_KEY, INDEX_MIN_SYMBOL,
  validPacked, validMonth, validYmd, monthsBetween, minuteAccessor, unpackDay, MIN5_SUM_PREFIX, daySummary
} from './_minute-data.js';
const CUSTOM_KEY = 'autotrade:custom-strategies'; // auto-trade-status.js와 같은 키 — 조립한 전략(type:'rule')도 여기 있어요
import { loadCosts, buyCostPct, sellCostPct } from './_costs.js';
import { askClaude } from './_ai.js'; // AI 호출 공용 창구(사용량·예산·실패 이유 기록)

// 분봉으로 단타를 계산하면 저장소에서 읽는 양이 많아서 60초까지 기다려요(다른 모드는 여전히 금방 끝나요).
export const config = { maxDuration: 60 };

const EVOLVE_KEY = 'backtest:evolution:v2';
const EVOLVE_AUTO_LASTRUN_KEY = 'backtest:evolve-auto:lastrun'; // 자동(크론) 실행 주기 판단용 — auto-trade-status.js의 설정(evolveIntervalHours)을 따름
const CONFIG_KEY = 'autotrade:config';
// 자동 실행 때마다 이 중 하나를 무작위로 골라서 백테스트해요 — 특정 구간(예: 최근 1년만 좋았던 시기)에만
// 맞춰지는 걸 피하려고 1~4년 치 중 매번 다른 기간을 시도합니다.
const AUTO_LOOKBACK_OPTIONS_DAYS = [365, 730, 1095, 1460];
const CHANGES_KEY = 'autotrade:strategy-changes'; // auto-trade-check.js의 "전략 변경 이력"과 같은 키 — 소스만 'backtest'로 구분
const MAX_CHANGES = 200;
const STARTING_CASH_US = 7_000;

// ---- 시장 상황 적응형(regime) 탐색 — 상승/하락/횡보 × 평온/고변동 = 최대 6개 구간마다 따로 전략을 찾습니다 ----
const REGIME_KEY_PREFIX = 'backtest:evolution:regime:';
const REGIME_AUTO_LASTRUN_KEY = 'backtest:regime-evolve:lastrun';
const REGIME_ROTATION_KEY = 'backtest:regime-evolve:rotation'; // 매 실행마다 6구간 중 하나씩 돌아가며 탐색(한 번에 다 하면 느려서)
const REGIME_KOREAN = {
  bull: '상승장', bear: '하락장', sideways: '횡보장', calm: '평온', turbulent: '고변동'
};
function regimeLabelKo(label) {
  const [trend, vol] = label.split('-');
  return (REGIME_KOREAN[trend] || trend) + '·' + (REGIME_KOREAN[vol] || vol);
}

function todayKST() {
  // 서버 시간이 UTC라 KST(+9)로 보정해서 "날짜"를 계산합니다(auto-trade-check.js와 동일한 방식).
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/* ==================== mode=presets (고정 9개 전략 비교) ==================== */

const PRESETS = [
  { id: 'momentum_fixed', name: '모멘텀 중심 + 고정 손절/익절', weights: { momentum: 0.6, volume: 0.2, trend: 0.2, rsi: 0 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'trend_trailing', name: '추세추종 + 트레일링스탑', weights: { momentum: 0.2, volume: 0.1, trend: 0.7, rsi: 0 }, buyThreshold: 0.3, exit: { type: 'trailing', trailingPct: 8 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'reversal_fixed', name: '역추세(RSI 과매도) + 타이트 손절', weights: { momentum: -0.3, volume: 0.1, trend: -0.2, rsi: 0.6 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 3, takeProfitPct: 6 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'volume_fixed', name: '거래량 중심 + 고정 손절/익절', weights: { momentum: 0.2, volume: 0.6, trend: 0.2, rsi: 0 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'balanced', name: '복합 균형형', weights: { momentum: 0.25, volume: 0.25, trend: 0.25, rsi: 0.25 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'concentrated', name: '모멘텀 + 집중투자(상위 2종목)', weights: { momentum: 0.6, volume: 0.2, trend: 0.2, rsi: 0 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'concentrated', positionPct: 35, maxPositions: 2 } },
  { id: 'balanced_trailing', name: '복합 균형형 + 트레일링스탑', weights: { momentum: 0.25, volume: 0.25, trend: 0.25, rsi: 0.25 }, buyThreshold: 0.3, exit: { type: 'trailing', trailingPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'balanced_regime', name: '복합 균형형 + 시장상황 필터', weights: { momentum: 0.25, volume: 0.25, trend: 0.25, rsi: 0.25 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 }, regimeFilter: true },
  { id: 'baseline', name: '기준선(대조군, 조건 없음)', weights: { momentum: 0, volume: 0, trend: 0, rsi: 0 }, buyThreshold: -999, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } }
];

async function askPresetFeedback(results, apiKey) {
  if (!apiKey) return null;
  const lines = results.map((r, i) =>
    `${i + 1}. ${r.name} — 총수익 ${r.totalReturnPct}%, MDD ${r.maxDrawdownPct}%, 거래 ${r.trades}회, 승률 ${r.winRate ?? '—'}%, ` +
    `평균익절 ${r.avgWinPct ?? '—'}%, 평균손절 ${r.avgLossPct ?? '—'}%, 손익비 ${r.profitFactor ?? '—'}, 시장노출 ${r.timeInMarketPct}%`
  ).join('\n');

  const prompt =
`아래는 서로 다른 매매 전략 9개를 같은 과거 데이터로 백테스트한 결과야 (수익률 높은 순으로 정렬됨).

${lines}

이 결과를 보고:
1. 1위 전략이 왜 잘됐는지 (예: 승률이 높아서인지, 손익비가 좋아서인지, 거래를 적게 해서인지 등 숫자 근거로) 설명해줘.
2. 최하위 전략이 왜 부진했는지 숫자 근거로 설명해줘.
3. 다음에 시도해볼 만한 개선 방향을 2가지 정도 구체적으로 제안해줘 (예: "익절 폭을 넓혀보면 어떨까" 같은 식).

한국어로 5~7문장 이내, 너무 원론적인 말 말고 위 숫자들을 직접 인용하면서 설명해줘.`;

  const ai = await askClaude({ feature: 'backtest-feedback', prompt, maxTokens: 4000 });
  return ai.ok ? ai.text : null;
}

async function handlePresets(req, res) {
  const rawSymbols = (req.query.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  const krSymbols = rawSymbols.filter((s) => /^\d{6}$/.test(s)).slice(0, 15);
  const skippedNonKr = rawSymbols.length - krSymbols.length;

  if (krSymbols.length === 0) {
    res.status(400).json({ error: '백테스트할 국내 종목 코드가 없습니다. (해외 종목은 이번 백테스트에서 지원되지 않아요)' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  const lookbackDays = Math.min(1825, Math.max(180, Number(req.query.days) || 730));

  try {
    const token = await getKisToken();
    const symbolMaps = {};
    const dateSet = new Set();

    for (const symbol of krSymbols) {
      const history = await fetchSymbolHistory(token, symbol, lookbackDays);
      if (history.length < 25) continue;
      const annotated = annotateWithFactors(history);
      const map = new Map();
      annotated.forEach((row) => { map.set(row.date, row); dateSet.add(row.date); });
      symbolMaps[symbol] = map;
    }

    const usedSymbols = Object.keys(symbolMaps);
    if (usedSymbols.length === 0) {
      res.status(404).json({ error: '유효한 과거 데이터를 가져오지 못했습니다.' });
      return;
    }
    const dates = Array.from(dateSet).sort();

    const costs = await loadCosts();
    const results = PRESETS.map((preset) => Object.assign({ id: preset.id, name: preset.name }, runBacktest(preset, symbolMaps, dates, { costs })))
      .sort((a, b) => b.totalReturnPct - a.totalReturnPct);

    const feedback = await askPresetFeedback(results, process.env.ANTHROPIC_API_KEY);

    res.status(200).json({
      symbols: usedSymbols,
      skippedNonKr,
      periodFrom: dates[0], periodTo: dates[dates.length - 1],
      startingCash: STARTING_CASH,
      feePct: Math.round((buyCostPct(costs, 'KR') + sellCostPct(costs, 'KR')) * 1000) / 1000, // 왕복 비용(매수+매도, 설정값 기준)
      broker: costs.broker,
      results,
      feedback,
      note: '가격/거래량 기반 팩터만 백테스트 가능해요(수급·호가·AI의견은 과거 이력이 없어 제외). 체결가는 종가 기준 단순화, 슬리피지는 반영 안 됐어요.'
    });
  } catch (e) {
    console.error('backtest.js(presets) error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}

/* ==================== mode=evolve (진화형 탐색: 수동 / 자동) ==================== */

async function askEvolveFeedback(before, after, apiKey) {
  if (!apiKey) return null;
  const improved = before && after.stats.totalReturnPct <= before.stats.totalReturnPct ? false : true;
  const prompt =
`전략 진화 탐색을 한 세대 진행했어. 서로 다른 시작점을 가진 계보(lineage) 3개를 동시에 굴리는 방식이고,
매 세대 일부 후보는 완전 무작위, 일부는 기존 최고의 변형이야.

이전 전역 최고: ${before ? describeStrategy(before.strategy) + ` (수익률 ${before.stats.totalReturnPct}%, MDD ${before.stats.maxDrawdownPct}%, 승률 ${before.stats.winRate ?? '—'}%, 평균손절 ${before.stats.avgLossPct ?? '—'}%, 손익비 ${before.stats.profitFactor ?? '—'})` : '없음(첫 실행)'}
이번 전역 최고: ${describeStrategy(after.strategy)} (수익률 ${after.stats.totalReturnPct}%, MDD ${after.stats.maxDrawdownPct}%, 승률 ${after.stats.winRate ?? '—'}%, 평균손절 ${after.stats.avgLossPct ?? '—'}%, 손익비 ${after.stats.profitFactor ?? '—'})
전역 기록 갱신 여부: ${improved ? '갱신됨' : '갱신 안 됨(기존 유지)'}

아래 내용을 한국어로 4~5문장 이내로 설명해줘:
1. 이전 대비 가중치·매수문턱·청산방식 중 구체적으로 뭐가 바뀌었는지 (숫자로 짚어서)
2. ${improved ? '왜 이번 조합이 더 나았는지' : '왜 이번 시도들이 기존보다 못했는지(손실 원인 추정 — 평균손절폭이나 손익비 숫자를 근거로)'}
3. 다음 세대에서 시도해볼 만한 구체적인 방향 1가지

확정적으로 말하지 말고 추정 톤으로 써줘.`;

  const ai = await askClaude({ feature: 'backtest-feedback', prompt, maxTokens: 4000 });
  return ai.ok ? ai.text : null;
}

function freshLineages() {
  return DEFAULT_LINEAGES.map((l) => ({ id: l.id, label: l.label, head: l.head, bestEver: null, bestStats: null, generation: 0 }));
}

// 수동 실행: 프론트엔드 버튼이 symbols/days를 직접 넘겨주고, AI 피드백까지 받습니다.
async function handleEvolveManual(req, res) {
  const rawSymbols = (req.query.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  const krSymbols = rawSymbols.filter((s) => /^\d{6}$/.test(s)).slice(0, 15);
  if (krSymbols.length === 0) {
    res.status(400).json({ error: '백테스트할 국내 종목 코드가 없습니다.' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }
  const lookbackDays = Math.min(1825, Math.max(180, Number(req.query.days) || 730));
  const reset = req.query.reset === '1';

  try {
    const state = reset ? null : await kvGetJson(EVOLVE_KEY, null);
    const lineages = (state && state.lineages) ? state.lineages : freshLineages();
    const history = (state && state.history) || [];
    const prevGlobalBest = (state && state.globalBest) || null;

    const token = await getKisToken();
    const symbolMaps = {};
    const dateSet = new Set();
    for (const symbol of krSymbols) {
      const hist = await fetchSymbolHistory(token, symbol, lookbackDays);
      if (hist.length < 25) continue;
      const annotated = annotateWithFactors(hist);
      const map = new Map();
      annotated.forEach((row) => { map.set(row.date, row); dateSet.add(row.date); });
      symbolMaps[symbol] = map;
    }
    const usedSymbols = Object.keys(symbolMaps);
    if (usedSymbols.length === 0) {
      res.status(404).json({ error: '유효한 과거 데이터를 가져오지 못했습니다.' });
      return;
    }
    const dates = Array.from(dateSet).sort();

    const seededLineages = lineages.map((l) => l.bestStats ? l : Object.assign({}, l));
    const { lineages: newLineages, globalBest, globalImproved } = advanceGeneration(seededLineages, symbolMaps, dates, { costs: await loadCosts() });

    const historyEntry = { generation: newLineages.reduce((a, l) => a + l.generation, 0), totalReturnPct: globalBest.stats.totalReturnPct, maxDrawdownPct: globalBest.stats.maxDrawdownPct, lineage: globalBest.lineage, timestamp: Date.now() };
    const newHistory = [...history, historyEntry].slice(-MAX_HISTORY);

    const feedback = await askEvolveFeedback(prevGlobalBest, globalBest, process.env.ANTHROPIC_API_KEY);

    await kvSetJson(EVOLVE_KEY, { lineages: newLineages, globalBest, history: newHistory, updatedAt: Date.now() });

    res.status(200).json({
      lineages: newLineages.map((l) => ({
        id: l.id, label: l.label, generation: l.generation,
        headDescription: describeStrategy(l.head), headStats: l.headStats,
        bestDescription: describeStrategy(l.bestEver), bestStats: l.bestStats,
        improved: l.improved, wandered: l.wandered
      })),
      globalBest: { lineage: globalBest.lineage, description: describeStrategy(globalBest.strategy), stats: globalBest.stats, strategy: globalBest.strategy },
      globalImproved,
      history: newHistory,
      feedback,
      symbols: usedSymbols,
      startingCash: STARTING_CASH
    });
  } catch (e) {
    console.error('backtest.js(evolve/manual) error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}

// 자동(크론) 실행: 외부 스케줄러가 자주(예: 몇 분~1시간마다) 호출해도 되고, 설정에서 정한 주기
// (evolveIntervalHours, 기본 24시간)가 지나기 전엔 그냥 건너뜁니다. 감시종목은 자동매매 설정을 재사용하고,
// AI 피드백은 생략해서 가볍게 돕니다. AUTO_TRADE_SECRET으로 보호합니다.
async function handleEvolveAuto(req, res) {
  const secret = process.env.AUTO_TRADE_SECRET;
  if (!secret || (req.query.key || '') !== secret) {
    res.status(401).json({ error: '인증 키가 올바르지 않습니다.' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  try {
    const cfg = await kvGetJson(CONFIG_KEY, null);

    // 외부 스케줄러는 자주 호출돼도, 설정에서 정한 주기(기본 24시간)가 지나야 실제로 한 세대를 진행해요.
    // 주기는 자동매매 탭의 "진화형 탐색 실행 주기" 설정에서 바로 바꿀 수 있어요(스케줄러 쪽은 안 바꿔도 됨).
    const intervalHours = Math.max(1, Math.min(168, Number(cfg && cfg.evolveIntervalHours) || 24));
    const lastRunTs = await kvGetJson(EVOLVE_AUTO_LASTRUN_KEY, 0);
    const dueAt = (typeof lastRunTs === 'number' ? lastRunTs : 0) + intervalHours * 3600 * 1000;
    if (Date.now() < dueAt) {
      res.status(200).json({ skipped: true, reason: 'interval_not_elapsed', nextRunInMs: dueAt - Date.now() });
      return;
    }

    const krSymbols = ((cfg && cfg.symbols) || []).filter((s) => /^\d{6}$/.test(s)).slice(0, 15);
    if (krSymbols.length === 0) {
      res.status(200).json({ skipped: true, reason: 'no_kr_symbols' });
      return;
    }

    // 매번 다른 기간으로 백테스트 — 특정 구간에만 맞춰진 전략을 찾는 걸 피하려는 목적
    const lookbackDays = AUTO_LOOKBACK_OPTIONS_DAYS[Math.floor(Math.random() * AUTO_LOOKBACK_OPTIONS_DAYS.length)];

    const token = await getKisToken();
    const symbolMaps = {};
    const dateSet = new Set();
    for (const symbol of krSymbols) {
      const hist = await fetchSymbolHistory(token, symbol, lookbackDays);
      if (hist.length < 25) continue;
      const annotated = annotateWithFactors(hist);
      const map = new Map();
      annotated.forEach((row) => { map.set(row.date, row); dateSet.add(row.date); });
      symbolMaps[symbol] = map;
    }
    const usedSymbols = Object.keys(symbolMaps);
    if (usedSymbols.length === 0) {
      res.status(200).json({ skipped: true, reason: 'no_data' });
      return;
    }
    const dates = Array.from(dateSet).sort();

    const state = await kvGetJson(EVOLVE_KEY, null);
    const lineages = (state && state.lineages) ? state.lineages : freshLineages();
    const history = (state && state.history) || [];
    const prevGlobalBest = (state && state.globalBest) || null;

    const { lineages: newLineages, globalBest, globalImproved } = advanceGeneration(lineages, symbolMaps, dates, { costs: await loadCosts() });

    const historyEntry = {
      generation: newLineages.reduce((a, l) => a + l.generation, 0), totalReturnPct: globalBest.stats.totalReturnPct,
      maxDrawdownPct: globalBest.stats.maxDrawdownPct, lineage: globalBest.lineage, timestamp: Date.now(), auto: true, lookbackDays
    };
    const newHistory = [...history, historyEntry].slice(-MAX_HISTORY);

    await kvSetJson(EVOLVE_KEY, { lineages: newLineages, globalBest, history: newHistory, updatedAt: Date.now() });
    await kvSetJson(EVOLVE_AUTO_LASTRUN_KEY, Date.now());

    // globalImproved가 true면 "진화형(자동탐색)" 실거래 전략이 실제로 바뀐 것 — "전략 변경 이력"에도 남깁니다.
    if (globalImproved) {
      try {
        const changes = await kvGetJson(CHANGES_KEY, []);
        const s = globalBest.stats;
        const diagnosis = prevGlobalBest
          ? `백테스트(최근 ${lookbackDays}일) 결과 수익률 ${prevGlobalBest.stats.totalReturnPct}%→${s.totalReturnPct}%로 개선돼 가중치/청산/비중 조합을 갱신했어요. (승률 ${s.winRate ?? '—'}%, MDD ${s.maxDrawdownPct}%, 손익비 ${s.profitFactor ?? '—'})`
          : `백테스트(최근 ${lookbackDays}일)로 처음 전략을 찾아 "진화형(자동탐색)" 전략에 반영했어요. (수익률 ${s.totalReturnPct}%, 승률 ${s.winRate ?? '—'}%, MDD ${s.maxDrawdownPct}%)`;
        changes.unshift({
          id: Date.now() + '-evolved',
          ts: Date.now(), date: todayKST(), strategyId: 'evolved', strategyName: '진화형(자동탐색)',
          source: 'backtest', // 백테스트 결과로 조정됨 — 실거래 성과 기반(auto-trade-check.js)과 구분
          diagnosis,
          statsAtChange: { totalReturnPct: s.totalReturnPct, maxDrawdownPct: s.maxDrawdownPct, winRate: s.winRate, profitFactor: s.profitFactor, periodFrom: dates[0], periodTo: dates[dates.length - 1] },
          beforeDescription: prevGlobalBest ? describeStrategy(prevGlobalBest.strategy) : null,
          afterDescription: describeStrategy(globalBest.strategy)
        });
        if (changes.length > MAX_CHANGES) changes.length = MAX_CHANGES;
        await kvSetJson(CHANGES_KEY, changes);
      } catch (e) {
        console.error('backtest.js(evolve/auto) 변경 이력 기록 실패:', e);
        // 이력 기록이 실패해도 전략 자체는 이미 반영됐으니 요청은 계속 성공으로 응답합니다.
      }
    }

    res.status(200).json({
      ok: true, globalImproved, lookbackDays,
      globalBest: { lineage: globalBest.lineage, description: describeStrategy(globalBest.strategy), stats: globalBest.stats },
      generation: historyEntry.generation
    });
  } catch (e) {
    console.error('backtest.js(evolve/auto) error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}

/* ==================== mode=regime-evolve (시장 상황별 전용 전략 탐색) ====================
   trend(상승/하락/횡보) × volatility(평온/고변동) = 6개 구간 각각에, "그 구간에서만 매수"하도록
   고정한 채로 진화 탐색을 돌려서 구간별 최적 전략을 따로 찾습니다. 종목별 청산(손절/익절)은 구간과
   무관하게 항상 그대로 진행되니(_backtest-core.js의 runBacktest 참고) 날짜를 건너뛰지 않고도 포지션
   추적이 끊기지 않습니다. 한 번 호출에 6구간을 다 돌리면 느려지니, 호출마다 1구간씩 돌아가며 진행합니다. */

async function prepareSymbolMapsAndDates(token, krSymbols, lookbackDays) {
  const symbolMaps = {};
  const dateSet = new Set();
  for (const symbol of krSymbols) {
    const hist = await fetchSymbolHistory(token, symbol, lookbackDays);
    if (hist.length < 25) continue;
    const annotated = annotateWithFactors(hist);
    const map = new Map();
    annotated.forEach((row) => { map.set(row.date, row); dateSet.add(row.date); });
    symbolMaps[symbol] = map;
  }
  return { symbolMaps, dates: Array.from(dateSet).sort() };
}

// 자동(크론) 실행: auto-trade-check.js의 "시장적응형" 실거래 전략이 쓸 구간별 최적 전략을 찾아둡니다.
// AUTO_TRADE_SECRET으로 보호하고, evolveIntervalHours 주기를 똑같이 따릅니다(진화형 탐색과 같은 간격).
async function handleRegimeEvolveAuto(req, res) {
  const secret = process.env.AUTO_TRADE_SECRET;
  if (!secret || (req.query.key || '') !== secret) {
    res.status(401).json({ error: '인증 키가 올바르지 않습니다.' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  try {
    const cfg = await kvGetJson(CONFIG_KEY, null);
    const intervalHours = Math.max(1, Math.min(168, Number(cfg && cfg.evolveIntervalHours) || 24));
    const lastRunTs = await kvGetJson(REGIME_AUTO_LASTRUN_KEY, 0);
    const dueAt = (typeof lastRunTs === 'number' ? lastRunTs : 0) + intervalHours * 3600 * 1000;
    if (Date.now() < dueAt) {
      res.status(200).json({ skipped: true, reason: 'interval_not_elapsed', nextRunInMs: dueAt - Date.now() });
      return;
    }

    const krSymbols = ((cfg && cfg.symbols) || []).filter((s) => /^\d{6}$/.test(s)).slice(0, 15);
    if (krSymbols.length === 0) {
      res.status(200).json({ skipped: true, reason: 'no_kr_symbols' });
      return;
    }

    const rotation = await kvGetJson(REGIME_ROTATION_KEY, { index: 0 });
    const label = REGIME_LABELS[rotation.index % REGIME_LABELS.length];
    const lookbackDays = AUTO_LOOKBACK_OPTIONS_DAYS[Math.floor(Math.random() * AUTO_LOOKBACK_OPTIONS_DAYS.length)];

    const token = await getKisToken();
    const { symbolMaps, dates } = await prepareSymbolMapsAndDates(token, krSymbols, lookbackDays);
    if (Object.keys(symbolMaps).length === 0) {
      res.status(200).json({ skipped: true, reason: 'no_data' });
      return;
    }
    const regimeByDate = classifyRegimeByDate(symbolMaps, dates);

    const stateKey = REGIME_KEY_PREFIX + label;
    const state = await kvGetJson(stateKey, null);
    const lineages = (state && state.lineages) ? state.lineages : freshLineages();
    const prevGlobalBest = (state && state.globalBest) || null;

    const { lineages: newLineages, globalBest, globalImproved } = advanceGeneration(lineages, symbolMaps, dates, { forceRegimeFilter: label, regimeByDate, costs: await loadCosts() });

    await kvSetJson(stateKey, { lineages: newLineages, globalBest, updatedAt: Date.now(), lookbackDays });
    await kvSetJson(REGIME_ROTATION_KEY, { index: rotation.index + 1 });
    await kvSetJson(REGIME_AUTO_LASTRUN_KEY, Date.now());

    if (globalImproved) {
      try {
        const changes = await kvGetJson(CHANGES_KEY, []);
        const s = globalBest.stats;
        const koName = regimeLabelKo(label);
        const diagnosis = prevGlobalBest
          ? `"${koName}" 구간 전용 백테스트(최근 ${lookbackDays}일) 결과 수익률 ${prevGlobalBest.stats.totalReturnPct}%→${s.totalReturnPct}%로 개선돼 이 구간의 전략을 갱신했어요. (승률 ${s.winRate ?? '—'}%, MDD ${s.maxDrawdownPct}%)`
          : `"${koName}" 구간 전용 백테스트(최근 ${lookbackDays}일)로 처음 전략을 찾았어요. (수익률 ${s.totalReturnPct}%, 승률 ${s.winRate ?? '—'}%, MDD ${s.maxDrawdownPct}%)`;
        changes.unshift({
          id: Date.now() + '-regime-' + label,
          ts: Date.now(), date: todayKST(), strategyId: 'regime-adaptive', strategyName: '시장적응형(' + koName + ')',
          source: 'backtest',
          diagnosis,
          statsAtChange: { totalReturnPct: s.totalReturnPct, maxDrawdownPct: s.maxDrawdownPct, winRate: s.winRate, profitFactor: s.profitFactor, periodFrom: dates[0], periodTo: dates[dates.length - 1] },
          beforeDescription: prevGlobalBest ? describeStrategy(prevGlobalBest.strategy) : null,
          afterDescription: describeStrategy(globalBest.strategy)
        });
        if (changes.length > MAX_CHANGES) changes.length = MAX_CHANGES;
        await kvSetJson(CHANGES_KEY, changes);
      } catch (e) {
        console.error('backtest.js(regime-evolve/auto) 변경 이력 기록 실패:', e);
      }
    }

    res.status(200).json({ ok: true, label, globalImproved, lookbackDays, globalBest: { description: describeStrategy(globalBest.strategy), stats: globalBest.stats } });
  } catch (e) {
    console.error('backtest.js(regime-evolve/auto) error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}

// 수동 실행: 전략연구실에서 특정 구간을 골라 "지금 한 세대 탐색"해볼 수 있게 합니다(테스트/확인용).
async function handleRegimeEvolveManual(req, res) {
  const label = req.query.label;
  if (!REGIME_LABELS.includes(label)) {
    res.status(400).json({ error: 'label 파라미터가 올바르지 않습니다. (예: bull-calm)' });
    return;
  }
  const rawSymbols = (req.query.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  const krSymbols = rawSymbols.filter((s) => /^\d{6}$/.test(s)).slice(0, 15);
  if (krSymbols.length === 0) {
    res.status(400).json({ error: '백테스트할 국내 종목 코드가 없습니다.' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }
  const lookbackDays = Math.min(1825, Math.max(180, Number(req.query.days) || 730));

  try {
    const token = await getKisToken();
    const { symbolMaps, dates } = await prepareSymbolMapsAndDates(token, krSymbols, lookbackDays);
    if (Object.keys(symbolMaps).length === 0) {
      res.status(404).json({ error: '유효한 과거 데이터를 가져오지 못했습니다.' });
      return;
    }
    const regimeByDate = classifyRegimeByDate(symbolMaps, dates);

    const stateKey = REGIME_KEY_PREFIX + label;
    const state = await kvGetJson(stateKey, null);
    const lineages = (state && state.lineages) ? state.lineages : freshLineages();

    const { lineages: newLineages, globalBest, globalImproved } = advanceGeneration(lineages, symbolMaps, dates, { forceRegimeFilter: label, regimeByDate, costs: await loadCosts() });
    await kvSetJson(stateKey, { lineages: newLineages, globalBest, updatedAt: Date.now(), lookbackDays });

    // 이 구간에 해당하는 날짜가 과거 데이터에 얼마나 있었는지도 같이 보여줍니다(너무 적으면 신뢰하기 어려움).
    const daysInRegime = dates.filter((d) => regimeByDate.get(d) === label).length;

    res.status(200).json({
      ok: true, label, labelKo: regimeLabelKo(label), globalImproved, daysInRegime, totalDays: dates.length,
      globalBest: { description: describeStrategy(globalBest.strategy), stats: globalBest.stats }
    });
  } catch (e) {
    console.error('backtest.js(regime-evolve/manual) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

// 전략연구실에서 6개 구간의 현재 상태를 한 번에 보여줍니다.
async function handleRegimeStatus(req, res) {
  try {
    const entries = await Promise.all(REGIME_LABELS.map(async (label) => {
      const state = await kvGetJson(REGIME_KEY_PREFIX + label, null);
      if (!state || !state.globalBest) return { label, labelKo: regimeLabelKo(label), found: false };
      return {
        label, labelKo: regimeLabelKo(label), found: true,
        description: describeStrategy(state.globalBest.strategy),
        stats: state.globalBest.stats, lookbackDays: state.lookbackDays, updatedAt: state.updatedAt
      };
    }));
    res.status(200).json({ regimes: entries });
  } catch (e) {
    console.error('backtest.js(regime-status) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== mode=detail (전략 상세 분석: 날짜·시장·종목·전략을 직접 설정) ==================== */

async function findOverseasExchange(token, symbol, hint) {
  const ALL = ['NAS', 'NYS', 'AMS'];
  const order = hint && ALL.includes(hint) ? [hint, ...ALL.filter((e) => e !== hint)] : ALL;
  for (const excd of order) {
    try {
      const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/price-detail?AUTH=&EXCD=${excd}&SYMB=${symbol}`;
      const data = await fetchKisJson(url, kisHeaders(token, 'HHDFS76200200'));
      if (data && data.output && data.output.last) return excd;
    } catch (e) {
      // 다음 거래소 시도
    }
  }
  return null;
}

function cleanDateParam(v, fallback) {
  const s = String(v || '').replace(/[^0-9]/g, '');
  return /^\d{8}$/.test(s) ? s : fallback;
}

// 프론트에서 받은 전략 설정을 안전한 범위로 정리합니다(이상한 값이 와도 서버가 죽지 않도록).
function sanitizeStrategy(raw) {
  raw = raw || {};
  const w = raw.weights || {};
  const clipW = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
  const weights = {
    momentum: clipW(w.momentum), volume: clipW(w.volume), trend: clipW(w.trend),
    rsi: clipW(w.rsi), supply: clipW(w.supply)
  };
  const buyThreshold = Math.max(-1, Math.min(1, Number(raw.buyThreshold) || 0));

  const exitType = raw.exit && raw.exit.type === 'trailing' ? 'trailing' : 'fixed';
  const exit = exitType === 'trailing'
    ? { type: 'trailing', trailingPct: Math.max(1, Math.min(50, Number(raw.exit.trailingPct) || 8)) }
    : {
        type: 'fixed',
        stopLossPct: Math.max(1, Math.min(50, Number((raw.exit || {}).stopLossPct) || 5)),
        takeProfitPct: Math.max(1, Math.min(200, Number((raw.exit || {}).takeProfitPct) || 10))
      };

  const sizingType = raw.sizing && raw.sizing.type === 'concentrated' ? 'concentrated' : 'equal';
  const sizing = {
    type: sizingType,
    positionPct: Math.max(1, Math.min(100, Number((raw.sizing || {}).positionPct) || 10)),
    maxPositions: Math.max(1, Math.min(20, Math.round(Number((raw.sizing || {}).maxPositions) || 5)))
  };

  return { weights, buyThreshold, exit, sizing, regimeFilter: !!raw.regimeFilter };
}

async function handleDetail(req, res) {
  const market = (req.query.market || 'KR').toUpperCase() === 'US' ? 'US' : 'KR';
  const rawSymbols = (req.query.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  const symbols = (market === 'KR'
    ? rawSymbols.filter((s) => /^\d{6}$/.test(s))
    : rawSymbols.filter((s) => /^[A-Za-z.]{1,10}$/.test(s)).map((s) => s.toUpperCase())
  ).slice(0, 10);

  if (symbols.length === 0) {
    res.status(400).json({ error: market === 'KR' ? '국내 종목 코드(6자리 숫자)를 입력해 주세요.' : '해외 종목 티커를 입력해 주세요.' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  const todayYmd = (() => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  })();
  const defaultStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 365);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  })();
  const startYmd = cleanDateParam(req.query.startDate, defaultStart);
  const endYmd = cleanDateParam(req.query.endDate, todayYmd);
  if (startYmd >= endYmd) {
    res.status(400).json({ error: '시작일이 종료일보다 앞서야 합니다.' });
    return;
  }

  const strategy = sanitizeStrategy((() => {
    try { return typeof req.query.strategy === 'string' ? JSON.parse(req.query.strategy) : req.query.strategy; }
    catch (e) { return {}; }
  })());

  const wantSupply = market === 'KR' && req.query.useSupply === '1';

  try {
    const token = await getKisToken();
    const symbolMaps = {};
    const dateSet = new Set();
    let supplyUsedForAny = false;
    const skippedSymbols = [];

    for (const symbol of symbols) {
      let history = [];
      if (market === 'KR') {
        history = await fetchSymbolHistoryRange(token, symbol, startYmd, endYmd);
      } else {
        const excd = await findOverseasExchange(token, symbol);
        if (!excd) { skippedSymbols.push(symbol); continue; }
        history = await fetchOverseasHistoryRange(token, excd, symbol, startYmd, endYmd);
      }
      if (history.length < 20) { skippedSymbols.push(symbol); continue; }

      let supplyMap = null;
      if (wantSupply) {
        try {
          const trend = await fetchInvestorTrend(token, symbol);
          if (trend.length > 0) {
            supplyMap = new Map(trend.map((t) => [t.date, t.foreignNet]));
            supplyUsedForAny = true;
          }
        } catch (e) {
          // 수급 데이터는 "시도"일 뿐이라 실패해도 나머지 백테스트는 그대로 진행합니다.
        }
      }

      const annotated = annotateWithFactors(history, supplyMap);
      const map = new Map();
      annotated.forEach((row) => { map.set(row.date, row); dateSet.add(row.date); });
      symbolMaps[symbol] = map;
    }

    const usedSymbols = Object.keys(symbolMaps);
    if (usedSymbols.length === 0) {
      res.status(404).json({ error: '유효한 과거 데이터를 가져오지 못했습니다. (기간이 너무 짧거나 종목 코드를 확인해 주세요)' });
      return;
    }
    const dates = Array.from(dateSet).sort();
    const startingCash = market === 'US' ? STARTING_CASH_US : STARTING_CASH;

    const costs = await loadCosts();
    const stats = runBacktest(strategy, symbolMaps, dates, { startingCash, includeDetails: true, costs });

    res.status(200).json({
      market, symbols: usedSymbols, skippedSymbols,
      periodFrom: dates[0], periodTo: dates[dates.length - 1],
      startingCash, feePct: Math.round((buyCostPct(costs, market) + sellCostPct(costs, market)) * 1000) / 1000, broker: costs.broker,
      strategy,
      supplyRequested: wantSupply, supplyUsed: supplyUsedForAny,
      stats: {
        totalReturnPct: stats.totalReturnPct, maxDrawdownPct: stats.maxDrawdownPct, trades: stats.trades,
        winRate: stats.winRate, avgWinPct: stats.avgWinPct, avgLossPct: stats.avgLossPct,
        profitFactor: stats.profitFactor, timeInMarketPct: stats.timeInMarketPct, finalEquity: stats.finalEquity
      },
      equityCurve: stats.equityCurveFull,
      tradeList: stats.tradeList,
      note: wantSupply
        ? (supplyUsedForAny
            ? '외국인·기관 수급 데이터를 일부 반영했어요. 단, KIS가 과거 며칠치를 주는지는 공식적으로 확인되지 않아 짧은 기간만 반영됐을 수 있어요.'
            : '외국인·기관 수급 데이터 반영을 시도했지만, 이번 종목/기간에서는 가져오지 못해 가격·거래량 팩터만으로 계산됐어요.')
        : '가격/거래량 기반 팩터로 계산했어요. 체결가는 종가 기준 단순화, 슬리피지는 반영 안 됐어요.'
    });
  } catch (e) {
    console.error('backtest.js(detail) error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}


/* ==================== 기간 백테스트(전략 선택) · 방법 찾기 ====================
   고정 50종목 + 인버스 ETF + 코스피200의 일봉을 저장소에 하루 동안 보관해 두고(bt:bars:v1:종목),
   화면에서 고른 전략·기간으로 _strategy-sim.js가 계산해요.
   - mode=strategy-prep&batch=0..N : 일봉 준비(한 번에 다 받으면 30초 제한에 걸려서 나눠 받아요). 오늘 받은 건 건너뛰어요.
   - mode=strategy&ids=a,b&start=YYYYMMDD&end=YYYYMMDD&cash=10000000 : 기간 백테스트
   - mode=method-search&id=...&start=...&end=... : 사는/파는 방법 조합 비교(앞 2/3 기간에서 고르고 뒤 1/3에서 확인)
   조회·계산만 하고 매매나 설정은 바꾸지 않아서 로그인 없이 쓸 수 있어요(방법 "적용"은 auto-trade-status.js에서 로그인 후). */

const BARS_PREFIX = 'bt:bars:v1:';
const BARS_LOOKBACK_DAYS = 450; // 약 300거래일(14개월). 저장소 값 크기를 1MB 아래로 유지하려고 이만큼만 보관해요
const INDEX_BARS_SYMBOL = 'KOSPI200';
const PREP_BATCH = 9;

function barsSymbols() {
  return FIXED_UNIVERSE.map((u) => u.symbol).concat([INVERSE_ETF.symbol, INDEX_BARS_SYMBOL]);
}
function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function ymdDaysAgo(days) {
  return new Date(Date.now() + 9 * 3600 * 1000 - days * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
}
// 저장 크기를 줄이려고 "날짜,시가,고가,저가,종가,거래량;..." 한 줄 문자열로 보관해요.
function packRows(rows) {
  return rows.map((r) => [r.date, r.open, r.high, r.low, r.close, r.volume || 0].join(',')).join(';');
}
function unpackRows(s) {
  if (!s) return [];
  return String(s).split(';').map((x) => {
    const [date, open, high, low, close, volume] = x.split(',');
    return { date, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

// 코스피200 일봉. 실패하면 빈 배열(그때는 50종목 평균을 시장 대신 써요).
async function fetchIndexHistoryRange(token, startYmd, endYmd) {
  const rows = [];
  let curEnd = endYmd;
  let lastEarliest = null;
  for (let page = 0; page < 15; page++) {
    const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice` +
      `?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=2001&FID_INPUT_DATE_1=${startYmd}&FID_INPUT_DATE_2=${curEnd}&FID_PERIOD_DIV_CODE=D`;
    const data = await fetchKisJson(url, kisHeaders(token, 'FHKUP03500100'));
    const out = data && Array.isArray(data.output2) ? data.output2.filter((r) => r.stck_bsop_date) : [];
    if (!out.length) break;
    out.forEach((r) => rows.push({
      date: r.stck_bsop_date, open: num(r.bstp_nmix_oprc), high: num(r.bstp_nmix_hgpr), low: num(r.bstp_nmix_lwpr),
      close: num(r.bstp_nmix_prpr), volume: num(r.acml_vol) || 0
    }));
    const earliest = out[out.length - 1].stck_bsop_date;
    if (earliest <= startYmd || earliest === lastEarliest) break;
    lastEarliest = earliest;
    curEnd = String(Number(earliest) - 1);
  }
  const uniq = new Map();
  rows.forEach((r) => { if (r.date >= startYmd && r.date <= endYmd && r.open && r.close) uniq.set(r.date, r); });
  return Array.from(uniq.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function handleStrategyPrep(req, res) {
  const all = barsSymbols();
  const batches = Math.ceil(all.length / PREP_BATCH);
  const batch = Math.max(0, Math.min(batches - 1, Number(req.query.batch) || 0));
  const list = all.slice(batch * PREP_BATCH, (batch + 1) * PREP_BATCH);
  try {
    const today = kstToday();
    const cached = (await kvMGetJson(list.map((s) => BARS_PREFIX + s))) || {};
    const need = list.filter((s) => !(cached[BARS_PREFIX + s] && cached[BARS_PREFIX + s].at === today));
    const failed = [];
    if (need.length) {
      const token = await getKisToken();
      const start = ymdDaysAgo(BARS_LOOKBACK_DAYS), end = ymdDaysAgo(0);
      const fresh = {};
      for (let i = 0; i < need.length; i += 3) {
        await Promise.all(need.slice(i, i + 3).map(async (sym) => {
          try {
            const rows = sym === INDEX_BARS_SYMBOL ? await fetchIndexHistoryRange(token, start, end) : await fetchSymbolHistoryRange(token, sym, start, end);
            if (rows.length >= 20) fresh[BARS_PREFIX + sym] = { at: today, rows: packRows(rows) };
            else failed.push(sym);
          } catch (e) {
            failed.push(sym);
          }
        }));
      }
      if (Object.keys(fresh).length) await kvMSetJson(fresh);
    }
    res.status(200).json({ ok: true, batch, batches, done: batch === batches - 1, fetched: need.length - failed.length, failed });
  } catch (e) {
    console.error('backtest.js(strategy-prep) error:', e);
    res.status(500).json({ error: e.message === 'NO_KEYS' ? 'KIS 키가 설정되지 않았습니다.' : '서버 오류가 발생했습니다.' });
  }
}

// 저장해 둔 일봉을 4번에 나눠 읽어요(한 번에 너무 큰 값을 주고받지 않게).
async function loadSimInputs() {
  const syms = barsSymbols();
  const bars = {};
  let indexRows = null;
  const missing = [];
  for (let i = 0; i < syms.length; i += 14) {
    const part = syms.slice(i, i + 14);
    const got = await kvMGetJson(part.map((s) => BARS_PREFIX + s));
    if (!got) return { error: '저장소를 읽지 못했어요. 잠시 뒤 다시 해 주세요.' };
    part.forEach((s) => {
      const v = got[BARS_PREFIX + s];
      if (!v) { missing.push(s); return; }
      const rows = unpackRows(v.rows);
      if (s === INDEX_BARS_SYMBOL) indexRows = rows; else bars[s] = rows;
    });
  }
  const [cfg, methods, evolve, costs, overrides, customs] = await Promise.all([
    kvGetJson(CONFIG_KEY, null), kvGetJson(METHODS_KEY, {}), kvGetJson(EVOLVE_KEY, null), loadCosts(), kvGetJson('autotrade:strategy-overrides', {}),
    kvGetJson(CUSTOM_KEY, [])
  ]);
  // 실제 매매와 같은 숫자: 모멘텀은 설정의 손절/익절, 자동조정 값이 있으면 그 위에 덮어써요.
  const riskOverrides = {};
  Object.keys(overrides || {}).forEach((id) => {
    const o = overrides[id] || {};
    riskOverrides[id] = {};
    ['positionPct', 'stopLossPct', 'takeProfitPct', 'maxTradesPerDay'].forEach((f) => { if (typeof o[f] === 'number') riskOverrides[id][f] = o[f]; });
  });
  if (cfg && cfg.risk) riskOverrides.momentum = Object.assign({}, cfg.risk, riskOverrides.momentum || {});
  return {
    bars, indexRows, missing, customs: Array.isArray(customs) ? customs : [],
    opts: {
      costs, methods: methods || {}, daytrade: cfg && cfg.daytrade, riskOverrides,
      evolved: evolve && evolve.globalBest && evolve.globalBest.strategy ? evolve.globalBest.strategy : null
    }
  };
}

/* ==================== 토스증권 분봉·메타 (이 PC의 tools/toss-sync.mjs가 올려요) ====================
   - mode=toss-upload (POST, 헤더 x-ledger-key = AUTO_TRADE_SECRET): { kind:'min5', items:[{sym, month, days}] } 또는
     { kind:'meta', meta:{...}, holidays:{from,to,dates} }. 토스 API는 허용 IP(사용자 PC)에서만 불러서 서버는 받기만 해요.
   - mode=toss-status (GET): 받아 둔 분봉 범위·메타 요약(화면 표시용). */
const DAY_INTRADAY_IDS = ['daytrade', 'scalp', 'vwap-pullback', 'opening-breakout', 'staged-dip', 'dip-rebound'];
function minuteSymbols() {
  return FIXED_UNIVERSE.map((u) => u.symbol).concat([INVERSE_ETF.symbol, INDEX_MIN_SYMBOL]);
}

async function handleTossUpload(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST만 지원합니다.' }); return; }
  const secret = process.env.AUTO_TRADE_SECRET;
  if (!secret) { res.status(500).json({ error: 'AUTO_TRADE_SECRET 환경변수가 설정되지 않았습니다.' }); return; }
  if ((req.headers['x-ledger-key'] || '') !== secret) { res.status(401).json({ error: '올리기 열쇠(LEDGER_UPLOAD_KEY)가 맞지 않아요.' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  try {
    if (body.kind === 'min5') {
      const allowed = new Set(minuteSymbols());
      const items = Array.isArray(body.items) ? body.items.slice(0, 120) : [];
      const write = {};
      const index = (await kvGetJson(MIN5_INDEX_KEY, null)) || { months: {}, ranges: {} };
      index.months = index.months || {}; index.ranges = index.ranges || {};
      let bad = 0;
      for (const it of items) {
        if (!it || !allowed.has(it.sym) || !validMonth(it.month) || !it.days || typeof it.days !== 'object') { bad++; continue; }
        const days = {};
        const prefix = it.month.replace('-', '');
        Object.keys(it.days).slice(0, 31).forEach((d) => { if (validYmd(d) && d.startsWith(prefix) && validPacked(it.days[d])) days[d] = it.days[d]; });
        const keys = Object.keys(days).sort();
        if (!keys.length) { bad++; continue; }
        write[MIN5_PREFIX + it.sym + ':' + it.month] = { v: 1, sym: it.sym, month: it.month, days, at: Date.now() };
        index.months[it.sym] = Array.from(new Set((index.months[it.sym] || []).concat([it.month]))).sort();
        const r = index.ranges[it.sym] || {};
        index.ranges[it.sym] = { first: !r.first || keys[0] < r.first ? keys[0] : r.first, last: !r.last || keys[keys.length - 1] > r.last ? keys[keys.length - 1] : r.last };
      }
      if (!Object.keys(write).length) { res.status(400).json({ error: '올릴 수 있는 값이 없어요.', bad }); return; }
      // 데이터 점검표용 하루 요약(시가·고가·저가·종가·묶음 수)을 종목별로 합쳐 둬요.
      const touched = Array.from(new Set(Object.values(write).map((d) => d.sym)));
      const oldSums = (await kvMGetJson(touched.map((s) => MIN5_SUM_PREFIX + s))) || {};
      touched.forEach((s) => {
        const sum = Object.assign({}, oldSums[MIN5_SUM_PREFIX + s] || {});
        Object.values(write).filter((d) => d.sym === s).forEach((d) => Object.keys(d.days).forEach((ymd) => { const x = daySummary(d.days[ymd]); if (x) sum[ymd] = x; }));
        write[MIN5_SUM_PREFIX + s] = sum;
      });
      index.updatedAt = Date.now();
      write[MIN5_INDEX_KEY] = index;
      // 저장소 한 번 쓰기 크기를 넘지 않게 약 700KB씩 나눠 써요.
      let chunk = {}, size = 0;
      const flush = async () => {
        if (!Object.keys(chunk).length) return true;
        const ok = await kvMSetJson(chunk);
        chunk = {}; size = 0;
        return !!ok;
      };
      for (const k of Object.keys(write)) {
        const s = JSON.stringify(write[k]).length;
        if (size + s > 700_000 && !(await flush())) { res.status(503).json({ error: '저장소에 쓰지 못했어요.' }); return; }
        chunk[k] = write[k]; size += s;
      }
      if (!(await flush())) { res.status(503).json({ error: '저장소에 쓰지 못했어요.' }); return; }
      res.status(200).json({ ok: true, saved: Object.keys(write).filter((k) => k.startsWith(MIN5_PREFIX) && !k.startsWith(MIN5_SUM_PREFIX) && k !== MIN5_INDEX_KEY).length, bad });
      return;
    }
    if (body.kind === 'meta') {
      const meta = body.meta && typeof body.meta === 'object' ? body.meta : null;
      if (!meta || JSON.stringify(meta).length > 300_000) { res.status(400).json({ error: '메타 값이 이상해요.' }); return; }
      const hol = body.holidays || {};
      const dates = Array.isArray(hol.dates) ? hol.dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 60) : [];
      const ok = await kvMSetJson({
        [TOSS_META_KEY]: Object.assign({}, meta, { updatedAt: Date.now() }),
        [KR_HOLIDAYS_KEY]: { updatedAt: Date.now(), from: hol.from || null, to: hol.to || null, dates }
      });
      if (!ok) { res.status(503).json({ error: '저장소에 쓰지 못했어요.' }); return; }
      res.status(200).json({ ok: true, holidays: dates.length });
      return;
    }
    res.status(400).json({ error: 'kind는 min5 또는 meta여야 해요.' });
  } catch (e) {
    console.error('backtest.js(toss-upload) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

async function handleTossStatus(req, res) {
  try {
    const got = (await kvMGetJson([MIN5_INDEX_KEY, TOSS_META_KEY, KR_HOLIDAYS_KEY])) || {};
    const index = got[MIN5_INDEX_KEY] || null;
    const meta = got[TOSS_META_KEY] || null;
    let first = null, last = null, symbols = 0;
    if (index && index.ranges) {
      Object.keys(index.ranges).forEach((s) => {
        if (s === INDEX_MIN_SYMBOL) return;
        const r = index.ranges[s];
        symbols++;
        if (r.first && (!first || r.first < first)) first = r.first;
        if (r.last && (!last || r.last > last)) last = r.last;
      });
    }
    res.status(200).json({
      ok: true,
      minutes: index ? { updatedAt: index.updatedAt, symbols, first, last, hasIndex: !!(index.ranges && index.ranges[INDEX_MIN_SYMBOL]) } : null,
      meta: meta ? { updatedAt: meta.updatedAt, ranking1mo: meta.ranking1mo || null, warnings: meta.warnings || {}, sectorOf: meta.sectorOf || {} } : null,
      holidays: got[KR_HOLIDAYS_KEY] || null
    });
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

// 기간에 걸친 달의 분봉만 읽어요(단타 전략을 고른 경우에만). 없으면 null → 하루 가격 4개 방식으로 계산해요.
async function loadMinuteData(startYmd, endYmd) {
  const index = await kvGetJson(MIN5_INDEX_KEY, null);
  if (!index || !index.months) return null;
  const months = new Set(monthsBetween(startYmd, endYmd));
  const syms = FIXED_UNIVERSE.map((u) => u.symbol).concat([INVERSE_ETF.symbol, INDEX_MIN_SYMBOL]);
  // 지수는 기간 시작 전날 값이 필요해서 한 달 앞도 읽어요.
  const before = monthsBetween(startYmd, startYmd)[0];
  const keys = [];
  syms.forEach((s) => (index.months[s] || []).forEach((m) => {
    if (months.has(m) || (s === INDEX_MIN_SYMBOL && m < before && monthsBetween(m, before).length === 2)) keys.push(MIN5_PREFIX + s + ':' + m);
  }));
  if (!keys.length) return null;
  // 15개씩 묶어 4묶음을 동시에 읽어요(긴 기간도 몇 초 안에 끝나게).
  const docs = [];
  const chunks = [];
  for (let i = 0; i < keys.length; i += 15) chunks.push(keys.slice(i, i + 15));
  for (let i = 0; i < chunks.length; i += 4) {
    const got = await Promise.all(chunks.slice(i, i + 4).map((c) => kvMGetJson(c)));
    if (got.some((g) => !g)) return null;
    got.forEach((g) => Object.values(g).forEach((d) => docs.push(d)));
  }
  const acc = minuteAccessor(docs);
  return acc.size ? acc : null;
}

function simDates(data, startYmd, endYmd) {
  return data.allDates.filter((d) => d >= startYmd && d <= endYmd);
}
function cleanYmd(v, fb) {
  const s = String(v || '').replace(/-/g, '');
  return /^\d{8}$/.test(s) ? s : fb;
}

// 조립한 전략: 저장된 것(custom-…, type:'rule')이나 아직 저장 안 한 초안(?rule=JSON)
function ruleOptsFor(id, input, query) {
  if (id === 'draft' && query && query.rule) {
    let raw = null;
    try { raw = JSON.parse(String(query.rule)); } catch (e) { return { error: '초안 전략 모양이 이상해요.' }; }
    const nr = normalizeRule(raw);
    return nr.error ? { error: nr.error } : { rule: nr.rule };
  }
  const saved = (input.customs || []).find((c) => c.id === id && c.type === 'rule');
  if (!saved) return null;
  const nr = normalizeRule(saved);
  return nr.error ? { error: nr.error } : { rule: nr.rule };
}
function isKnownId(id, input) {
  return SIM_STRATEGY_IDS.includes(id) || id === 'draft' || (input.customs || []).some((c) => c.id === id && c.type === 'rule');
}
// 기간 안의 분봉을 읽어요(스윙도 분봉으로 계산하므로 항상). ?minutes=0이면 하루 가격만으로 빠르게 계산해요.
async function attachMinutes(data, req, startYmd, endYmd) {
  if (String(req.query.minutes || '1') === '0') return;
  data.minute = await loadMinuteData(startYmd, endYmd);
}
const fillOf = (req) => (req.query.fill === 'tick' ? 'tick' : 'pct');

async function handleStrategySim(req, res) {
  try {
    const input = await loadSimInputs();
    if (input.error) { res.status(503).json({ error: input.error }); return; }
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter((s) => isKnownId(s, input)).slice(0, 8);
    if (!ids.length) { res.status(400).json({ error: '전략을 하나 이상 골라 주세요.' }); return; }
    if (input.missing.length > 10) { res.status(409).json({ error: '과거 가격을 먼저 준비해야 해요.', needPrep: true, missing: input.missing.length }); return; }
    const data = prepareData(input.bars, input.indexRows);
    const startYmd = cleanYmd(req.query.start, ymdDaysAgo(180)), endYmd = cleanYmd(req.query.end, ymdDaysAgo(0));
    await attachMinutes(data, req, startYmd, endYmd);
    const dates = simDates(data, startYmd, endYmd);
    if (dates.length < 5) { res.status(400).json({ error: '고른 기간에 거래일이 너무 적어요(보관 중인 기간: ' + (data.allDates[25] || '') + ' ~ ' + (data.allDates[data.allDates.length - 1] || '') + ').' }); return; }
    const cash = Math.max(1_000_000, Math.min(1_000_000_000, Number(req.query.cash) || 10_000_000));
    const fill = fillOf(req);
    // 하루 안의 가격 순서를 두 가지로 계산해서, 나쁜 쪽을 대표 결과로 쓰고 범위(range)를 같이 보여줘요.
    const results = ids.map((id) => {
      const ro = ruleOptsFor(id, input, req.query);
      if (ro && ro.error) return { id, skipped: ro.error };
      const base = Object.assign({}, input.opts, { startingCash: cash, keepTrades: true, fill }, ro || {});
      const a = simulateStrategy(id, data, dates, base);
      if (a.skipped) return a;
      const b = simulateStrategy(id, data, dates, Object.assign({}, base, { pathMode: 'optimistic' }));
      const main = b.totalReturnPct < a.totalReturnPct ? b : a;
      main.range = { low: Math.min(a.totalReturnPct, b.totalReturnPct), high: Math.max(a.totalReturnPct, b.totalReturnPct) };
      if (ro && ro.rule) { main.isRule = true; main.ruleText = describeRule(ro.rule); }
      return main;
    });
    res.status(200).json({
      ok: true, period: [dates[0], dates[dates.length - 1]], tradingDays: dates.length, startingCash: cash, fill,
      available: [data.allDates[25] || data.allDates[0], data.allDates[data.allDates.length - 1]],
      results, benchmark: benchmarks(data, dates), missing: input.missing, notes: SIM_NOTES, hasMinutes: !!data.minute
    });
  } catch (e) {
    console.error('backtest.js(strategy) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

// 방법 찾기 / 여러 구간 검증(워크포워드) — 같은 준비 과정을 써요.
async function prepareOne(req, res, defaultDays) {
  const id = String(req.query.id || '');
  const input = await loadSimInputs();
  if (input.error) { res.status(503).json({ error: input.error }); return null; }
  if (!isKnownId(id, input)) { res.status(400).json({ error: '알 수 없는 전략입니다.' }); return null; }
  if (input.missing.length > 10) { res.status(409).json({ error: '과거 가격을 먼저 준비해야 해요.', needPrep: true }); return null; }
  const ro = ruleOptsFor(id, input, req.query);
  if (ro && ro.error) { res.status(400).json({ error: ro.error }); return null; }
  const data = prepareData(input.bars, input.indexRows);
  const startYmd = cleanYmd(req.query.start, ymdDaysAgo(defaultDays)), endYmd = cleanYmd(req.query.end, ymdDaysAgo(0));
  await attachMinutes(data, req, startYmd, endYmd);
  const dates = simDates(data, startYmd, endYmd);
  return { id, data, dates, opts: Object.assign({}, input.opts, { fill: fillOf(req) }, ro || {}) };
}

async function handleMethodSearch(req, res) {
  try {
    const p = await prepareOne(req, res, 365);
    if (!p) return;
    const out = searchMethods(p.id, p.data, p.dates, p.opts);
    if (out.error) { res.status(400).json(out); return; }
    res.status(200).json(Object.assign({ ok: true, notes: SIM_NOTES, hasMinutes: !!p.data.minute }, out));
  } catch (e) {
    console.error('backtest.js(method-search) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

async function handleWalkForward(req, res) {
  try {
    const p = await prepareOne(req, res, 365);
    if (!p) return;
    const out = walkForward(p.id, p.data, p.dates, p.opts, Number(req.query.folds) || 4);
    if (out.error) { res.status(400).json(out); return; }
    res.status(200).json(Object.assign({ ok: true, hasMinutes: !!p.data.minute }, out));
  } catch (e) {
    console.error('backtest.js(walk-forward) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

// 매매 기록 한 줄을 눌렀을 때 그날 5분 차트를 그리려고 하루치 분봉을 돌려줘요.
async function handleMinuteDay(req, res) {
  try {
    const sym = String(req.query.sym || '');
    const ymd = cleanYmd(req.query.date, '');
    if (!minuteSymbols().includes(sym) || !ymd) { res.status(400).json({ error: '종목·날짜가 올바르지 않아요.' }); return; }
    const doc = await kvGetJson(MIN5_PREFIX + sym + ':' + ymd.slice(0, 4) + '-' + ymd.slice(4, 6), null);
    const packed = doc && doc.days && doc.days[ymd];
    if (!packed) { res.status(404).json({ error: '그날 분봉이 없어요.' }); return; }
    res.status(200).json({ ok: true, sym, date: ymd, bars: unpackDay(packed) });
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

// 데이터 점검표: 종목별로 일봉 날짜 중 분봉이 빠진 날, 분봉이 덜 찬 날, 일봉과 값이 크게 다른 날을 찾아요.
async function handleDataCheck(req, res) {
  try {
    const index = await kvGetJson(MIN5_INDEX_KEY, null);
    if (!index || !index.ranges) { res.status(200).json({ ok: true, empty: true }); return; }
    const syms = FIXED_UNIVERSE.map((u) => u.symbol).concat([INVERSE_ETF.symbol]);
    const sums = {}, daily = {};
    for (let i = 0; i < syms.length; i += 13) {
      const part = syms.slice(i, i + 13);
      const got = await kvMGetJson(part.map((s) => MIN5_SUM_PREFIX + s).concat(part.map((s) => BARS_PREFIX + s)));
      if (!got) { res.status(503).json({ error: '저장소를 읽지 못했어요.' }); return; }
      part.forEach((s) => { sums[s] = got[MIN5_SUM_PREFIX + s] || null; daily[s] = got[BARS_PREFIX + s] ? unpackRows(got[BARS_PREFIX + s].rows) : []; });
    }
    let first = null, last = null;
    syms.forEach((s) => { const r = index.ranges[s]; if (r) { if (!first || r.first < first) first = r.first; if (!last || r.last > last) last = r.last; } });
    const rows = syms.map((s) => {
      const u = FIXED_UNIVERSE.find((x) => x.symbol === s) || INVERSE_ETF;
      const sum = sums[s];
      const days = daily[s].filter((d) => d.date >= first && d.date <= last);
      if (!sum) return { symbol: s, name: u.name, noSummary: true, expected: days.length, have: index.ranges[s] ? null : 0 };
      const missing = [], partial = [], mismatch = [];
      days.forEach((d) => {
        const x = sum[d.date];
        if (!x) { missing.push(d.date); return; }
        const [o, h, l, , n] = x;
        if (n < 70) partial.push(d.date);
        if (Math.abs(o / d.open - 1) > 0.01 || Math.abs(h / d.high - 1) > 0.02 || Math.abs(l / d.low - 1) > 0.02) mismatch.push(d.date);
      });
      return { symbol: s, name: u.name, expected: days.length, have: days.length - missing.length, missing: missing.length, partial: partial.length, mismatch: mismatch.length,
        examples: missing.slice(0, 3).map((d) => '빠짐 ' + d).concat(partial.slice(0, 2).map((d) => '덜 참 ' + d), mismatch.slice(0, 2).map((d) => '값 다름 ' + d)) };
    });
    const sumUp = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
    res.status(200).json({
      ok: true, first, last, updatedAt: index.updatedAt || null, hasIndex: !!index.ranges[INDEX_MIN_SYMBOL],
      totals: { expected: sumUp('expected'), have: sumUp('have'), missing: sumUp('missing'), partial: sumUp('partial'), mismatch: sumUp('mismatch'), noSummary: rows.filter((r) => r.noSummary).length },
      rows
    });
  } catch (e) {
    console.error('backtest.js(data-check) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

// 실제 매매와 맞춰보기: 그날 가상계좌가 실제로 한 매매와, 같은 날을 백테스트로 돌린 결과를 나란히 놓아요.
// 둘이 크게 다르면 백테스트나 매매 엔진 어딘가가 실제와 다르게 계산한다는 신호예요.
const toHm = (min) => (typeof min === 'number' ? String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0') : null);
async function handleReconcile(req, res) {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : kstToday();
    const ymd = date.replace(/-/g, '');
    const input = await loadSimInputs();
    if (input.error) { res.status(503).json({ error: input.error }); return; }
    const data = prepareData(input.bars, input.indexRows);
    if (!data.allDates.includes(ymd)) { res.status(400).json({ error: '그날 일봉이 아직 없어요(장이 끝난 뒤 과거 가격 준비를 다시 하면 생겨요).' }); return; }
    data.minute = await loadMinuteData(ymd, ymd);
    const [log, cfg] = await Promise.all([kvGetJson('autotrade:log', []), kvGetJson(CONFIG_KEY, null)]);
    const dayLog = (log || []).filter((e) => e.date === date && e.market === 'KR');
    const ids = new Set(dayLog.map((e) => e.strategy).filter((id) => isKnownId(id, input)));
    if (cfg) SIM_STRATEGY_IDS.forEach((id) => { if (strategyEnabled(cfg, id) && id !== 'evolved') ids.add(id); });
    const kstHm = (ts) => { const d = new Date(ts + 9 * 3600 * 1000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
    const rows = Array.from(ids).map((id) => {
      const ro = ruleOptsFor(id, input, null);
      if (ro && ro.error) return null;
      const sim = simulateStrategy(id, data, [ymd], Object.assign({}, input.opts, { keepTrades: true, recordBuys: true }, ro || {}));
      if (sim.skipped) return null;
      const mine = dayLog.filter((e) => e.strategy === id);
      const aBuys = mine.filter((e) => e.side === 'BUY' && !e.add).map((e) => ({ symbol: e.symbol, name: e.name, time: kstHm(e.ts), price: e.price }));
      const aSells = mine.filter((e) => e.side !== 'BUY');
      const sBuys = (sim.buyLog || []).map((b) => ({ symbol: b.symbol, time: toHm(b.t), price: b.price }));
      const sSells = (sim.trades || []).filter((t) => t.exitDate === ymd);
      const aSet = new Set(aBuys.map((b) => b.symbol)), sSet = new Set(sBuys.map((b) => b.symbol));
      return {
        id, name: ro && ro.rule ? ro.rule.name : (sim.name || id), usedMinutes: sim.reliability === 'minute' || (sim.reliability === 'mid' && !!data.minute),
        actual: { buys: aBuys, sells: aSells.length, pnl: Math.round(aSells.reduce((s, e) => s + (e.pnlAmount || 0), 0)) },
        sim: { buys: sBuys, sells: sSells.length, pnl: Math.round(sSells.reduce((s, t) => s + t.pnlAmount, 0)) },
        matched: Array.from(aSet).filter((s) => sSet.has(s)), onlyActual: Array.from(aSet).filter((s) => !sSet.has(s)), onlySim: Array.from(sSet).filter((s) => !aSet.has(s))
      };
    }).filter(Boolean).sort((a, b) => (b.actual.buys.length + b.sim.buys.length) - (a.actual.buys.length + a.sim.buys.length));
    res.status(200).json({
      ok: true, date, hasMinutes: !!(data.minute && data.minute.size), rows,
      names: Object.fromEntries(FIXED_UNIVERSE.map((u) => [u.symbol, u.name]).concat([[INVERSE_ETF.symbol, INVERSE_ETF.name]])),
      notes: [
        '백테스트는 그날 아침 빈 계좌에서 시작해요. 스윙은 실제 계좌에 이미 들고 있던 종목 수·현금 때문에 산 종목이 다를 수 있어요.',
        '실제 매매는 1분마다 코스피200을 보고, 백테스트는 5분 묶음 분봉과 코스피 분봉으로 판단해서 시각이 몇 분 다를 수 있어요.',
        '그날 분봉은 이 PC의 toss-sync가 장 마감 뒤 올린 다음부터 볼 수 있어요.'
      ]
    });
  } catch (e) {
    console.error('backtest.js(reconcile) error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

/* ==================== 진입점 ==================== */

export default async function handler(req, res) {
  const mode = (req.query.mode || 'presets').trim();

  if (mode === 'evolve') {
    if (!kvReady()) {
      res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
      return;
    }
    if (req.query.auto === '1') return handleEvolveAuto(req, res);
    return handleEvolveManual(req, res);
  }

  if (mode === 'regime-evolve') {
    if (!kvReady()) {
      res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
      return;
    }
    if (req.query.auto === '1') return handleRegimeEvolveAuto(req, res);
    return handleRegimeEvolveManual(req, res);
  }

  if (mode === 'regime-status') {
    if (!kvReady()) {
      res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
      return;
    }
    return handleRegimeStatus(req, res);
  }

  if (mode === 'detail') return handleDetail(req, res);

  if (['toss-upload', 'toss-status', 'walk-forward', 'minute-day', 'data-check', 'reconcile'].includes(mode)) {
    if (!kvReady()) {
      res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
      return;
    }
    if (mode === 'toss-upload') return handleTossUpload(req, res);
    if (mode === 'toss-status') return handleTossStatus(req, res);
    if (mode === 'walk-forward') return handleWalkForward(req, res);
    if (mode === 'minute-day') return handleMinuteDay(req, res);
    if (mode === 'data-check') return handleDataCheck(req, res);
    return handleReconcile(req, res);
  }

  if (mode === 'strategy-prep' || mode === 'strategy' || mode === 'method-search') {
    if (!kvReady()) {
      res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
      return;
    }
    if (mode === 'strategy-prep') return handleStrategyPrep(req, res);
    if (mode === 'strategy') return handleStrategySim(req, res);
    return handleMethodSearch(req, res);
  }

  return handlePresets(req, res);
}
