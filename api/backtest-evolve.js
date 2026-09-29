// /api/backtest-evolve.js
// "계속 더 나은 전략을 찾는" 반복 탐색 (수동 버튼용). 서로 다른 시작점의 계보 3개를 동시에 진화시켜서
// 한 조합에 갇히지 않게 하는 로직은 _evolve-core.js에 있어요 (자세한 설명은 그 파일 주석 참고).
// 매일 자동으로도 진행되게 하려면 evolve-auto.js를 크론에 등록하세요 — 그 파일과 이 파일은 같은
// 진화 상태(KV)를 공유해서 이어서 탐색합니다.

import { getKisToken } from './_kis.js';
import { fetchSymbolHistory, annotateWithFactors, STARTING_CASH } from './_backtest-core.js';
import { DEFAULT_LINEAGES, describeStrategy, advanceGeneration, MAX_HISTORY } from './_evolve-core.js';
import { kvGetJson, kvSetJson, kvReady } from './_kv.js';

export const config = { maxDuration: 30 };

const EVOLVE_KEY = 'backtest:evolution:v2';

async function askAiFeedback(before, after, apiKey) {
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

export default async function handler(req, res) {
  if (!kvReady()) {
    res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
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
  const reset = req.query.reset === '1';

  try {
    const state = reset ? null : await kvGetJson(EVOLVE_KEY, null);
    const lineages = (state && state.lineages) ? state.lineages : DEFAULT_LINEAGES.map((l) => ({ id: l.id, label: l.label, head: l.head, bestEver: null, bestStats: null, generation: 0 }));
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

    // bestEver가 없는 계보(첫 실행)는 head 자체를 기준으로 초기 평가
    const seededLineages = lineages.map((l) => l.bestStats ? l : Object.assign({}, l));
    const { lineages: newLineages, globalBest, globalImproved } = advanceGeneration(seededLineages, symbolMaps, dates);

    const historyEntry = { generation: newLineages.reduce((a, l) => a + l.generation, 0), totalReturnPct: globalBest.stats.totalReturnPct, maxDrawdownPct: globalBest.stats.maxDrawdownPct, lineage: globalBest.lineage, timestamp: Date.now() };
    const newHistory = [...history, historyEntry].slice(-MAX_HISTORY);

    const feedback = await askAiFeedback(prevGlobalBest, globalBest, process.env.ANTHROPIC_API_KEY);

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
    console.error('backtest-evolve.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
