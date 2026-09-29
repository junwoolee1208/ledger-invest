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

import { getKisToken } from './_kis.js';
import { fetchSymbolHistory, annotateWithFactors, runBacktest, STARTING_CASH, FEE_PCT } from './_backtest-core.js';
import { DEFAULT_LINEAGES, describeStrategy, advanceGeneration, MAX_HISTORY } from './_evolve-core.js';
import { kvGetJson, kvSetJson, kvReady } from './_kv.js';

export const config = { maxDuration: 30 };

const EVOLVE_KEY = 'backtest:evolution:v2';
const CONFIG_KEY = 'autotrade:config';
const AUTO_LOOKBACK_DAYS = 730;

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
      globalBest: { lineage: globalBest.lineage, description: describeStrategy(globalBest.strategy), stats: globalBest.stats },
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

// 자동(크론) 실행: 외부 스케줄러가 하루 1번 호출. 감시종목은 자동매매 설정을 재사용하고,
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
    const krSymbols = ((cfg && cfg.symbols) || []).filter((s) => /^\d{6}$/.test(s)).slice(0, 15);
    if (krSymbols.length === 0) {
      res.status(200).json({ skipped: true, reason: 'no_kr_symbols' });
      return;
    }

    const token = await getKisToken();
    const symbolMaps = {};
    const dateSet = new Set();
    for (const symbol of krSymbols) {
      const hist = await fetchSymbolHistory(token, symbol, AUTO_LOOKBACK_DAYS);
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

    const { lineages: newLineages, globalBest, globalImproved } = advanceGeneration(lineages, symbolMaps, dates);

    const historyEntry = { generation: newLineages.reduce((a, l) => a + l.generation, 0), totalReturnPct: globalBest.stats.totalReturnPct, maxDrawdownPct: globalBest.stats.maxDrawdownPct, lineage: globalBest.lineage, timestamp: Date.now(), auto: true };
    const newHistory = [...history, historyEntry].slice(-MAX_HISTORY);

    await kvSetJson(EVOLVE_KEY, { lineages: newLineages, globalBest, history: newHistory, updatedAt: Date.now() });

    res.status(200).json({
      ok: true, globalImproved,
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

  return handlePresets(req, res);
}
