// /api/evolve-auto.js
// "항상 생각하고 발전"하도록 전략 진화 탐색을 매일 자동으로 한 세대씩 진행하는 엔드포인트입니다.
// cron-job.org 같은 외부 스케줄러에 하루 1번(자주 할 필요 없어요 — 과거 데이터라 자주 돌려도
// 결과가 똑같아요) 호출하도록 등록해두면, 사용자가 버튼을 누르지 않아도 계속 탐색이 진행됩니다.
// 감시 종목은 "자동매매" 설정에 저장된 관심종목(autotrade:config.symbols)을 그대로 재사용해요.
//
// 이 파일과 backtest-evolve.js(수동 버튼)는 같은 진화 상태(KV: backtest:evolution:v2)를 공유해서
// 이어서 탐색하므로, 자동 실행과 수동 실행을 섞어 써도 기록이 끊기지 않습니다.
//
// 보안: auto-trade-check.js와 동일하게 AUTO_TRADE_SECRET 쿼리 파라미터로 보호합니다.

import { getKisToken } from './_kis.js';
import { fetchSymbolHistory, annotateWithFactors } from './_backtest-core.js';
import { DEFAULT_LINEAGES, advanceGeneration, describeStrategy, MAX_HISTORY } from './_evolve-core.js';
import { kvGetJson, kvSetJson, kvReady } from './_kv.js';

export const config = { maxDuration: 30 };

const EVOLVE_KEY = 'backtest:evolution:v2';
const CONFIG_KEY = 'autotrade:config';
const LOOKBACK_DAYS = 730;

export default async function handler(req, res) {
  if (!kvReady()) {
    res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
    return;
  }
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
      const hist = await fetchSymbolHistory(token, symbol, LOOKBACK_DAYS);
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
    const lineages = (state && state.lineages) ? state.lineages : DEFAULT_LINEAGES.map((l) => ({ id: l.id, label: l.label, head: l.head, bestEver: null, bestStats: null, generation: 0 }));
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
    console.error('evolve-auto.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
