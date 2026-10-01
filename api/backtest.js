// /api/backtest.js
// "전략연구실" 탭의 백테스트 + 진화형 탐색 기능을 모두 담당합니다 (원래 backtest.js / backtest-evolve.js /
// evolve-auto.js 세 개의 파일이었는데, Vercel 무료(Hobby) 플랜의 "배포당 서버리스 함수 12개" 제한을
// 넘어서 배포가 실패하는 문제가 생겨 하나의 함수로 합쳤습니다. 동작 로직은 그대로이고, 어떤 기능을
// 쓸지는 쿼리 파라미터 mode로 구분합니다.
//
// mode=presets (기본값, 생략 가능): 고정 9개 전략(가중치·청산·사이징 조합)을 과거 데이터로 한 번에
//   비교하고 AI가 피드백을 줍니다. 예전 /api/backtest 와 동일.
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
import { kvGetJson, kvSetJson, kvReady } from './_kv.js';

export const config = { maxDuration: 30 };

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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) return null;
  const data = await response.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return text || null;
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

    const results = PRESETS.map((preset) => Object.assign({ id: preset.id, name: preset.name }, runBacktest(preset, symbolMaps, dates)))
      .sort((a, b) => b.totalReturnPct - a.totalReturnPct);

    const feedback = await askPresetFeedback(results, process.env.ANTHROPIC_API_KEY);

    res.status(200).json({
      symbols: usedSymbols,
      skippedNonKr,
      periodFrom: dates[0], periodTo: dates[dates.length - 1],
      startingCash: STARTING_CASH,
      feePct: FEE_PCT,
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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) return null;
  const data = await response.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return text || null;
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
    const { lineages: newLineages, globalBest, globalImproved } = advanceGeneration(seededLineages, symbolMaps, dates);

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

    const { lineages: newLineages, globalBest, globalImproved } = advanceGeneration(lineages, symbolMaps, dates);

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

    const { lineages: newLineages, globalBest, globalImproved } = advanceGeneration(lineages, symbolMaps, dates, { forceRegimeFilter: label, regimeByDate });

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

    const { lineages: newLineages, globalBest, globalImproved } = advanceGeneration(lineages, symbolMaps, dates, { forceRegimeFilter: label, regimeByDate });
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

    const stats = runBacktest(strategy, symbolMaps, dates, { startingCash, includeDetails: true });

    res.status(200).json({
      market, symbols: usedSymbols, skippedSymbols,
      periodFrom: dates[0], periodTo: dates[dates.length - 1],
      startingCash, feePct: FEE_PCT,
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

  return handlePresets(req, res);
}
