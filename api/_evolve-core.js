// /api/_evolve-core.js
// "계속 더 나은 전략을 찾되, 한 조합에 갇히지 않게" 만드는 탐색 로직입니다.
// backtest-evolve.js(수동 버튼)와 evolve-auto.js(매일 자동 실행되는 크론)가 공유합니다.
//
// 갇히지 않게 만드는 장치 3가지:
// 1) 서로 다른 시작점을 가진 "계보(lineage)" 3개를 동시에 굴립니다 — 한 계보가 나쁜 골짜기에
//    빠져도 다른 계보가 다른 방향을 계속 탐색하고 있어요.
// 2) 매 세대 후보 중 일부는 "기존 최고의 변형"이 아니라 "완전히 새로운 무작위 전략"이에요 — 지금까지
//    한 번도 안 가본 지점을 가끔 찔러봅니다.
// 3) 각 계보의 "탐색 기준점(head)"은 항상 가장 좋은 결과로만 이동하지 않고, 가끔(15%) 이번 세대에서
//    나온 결과 중 무작위로 하나를 골라 이동합니다 — 언덕 꼭대기에 딱 붙어있지 않고 주변을 배회하게
//    해서, 당장은 더 낫지 않아도 나중에 더 좋은 봉우리로 넘어갈 여지를 남겨둡니다.
//    (단, "지금까지 찾은 진짜 최고 기록(bestEver)"은 head가 어디로 가든 절대 후퇴하지 않고 계속 유지돼요.)

import { runBacktest } from './_backtest-core.js';

export const CHILDREN_PER_LINEAGE = 6;
export const MAX_HISTORY = 60;

// 세 계보는 서로 다른 성격의 출발점에서 시작해서, 처음부터 다른 방향을 탐색하게 합니다.
export const DEFAULT_LINEAGES = [
  {
    id: 'A', label: '균형형 출발',
    head: { weights: { momentum: 0.25, volume: 0.25, trend: 0.25, rsi: 0.25 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 }, regimeFilter: false },
  },
  {
    id: 'B', label: '모멘텀형 출발',
    head: { weights: { momentum: 0.7, volume: 0.2, trend: 0.1, rsi: 0 }, buyThreshold: 0.35, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 }, regimeFilter: false },
  },
  {
    id: 'C', label: '역추세형 출발',
    head: { weights: { momentum: -0.3, volume: 0.1, trend: -0.2, rsi: 0.6 }, buyThreshold: 0.25, exit: { type: 'trailing', trailingPct: 8 }, sizing: { type: 'equal', positionPct: 8, maxPositions: 5 }, regimeFilter: false },
  }
];

function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function randomStrategy() {
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const exitType = Math.random() < 0.5 ? 'fixed' : 'trailing';
  return {
    weights: { momentum: rand(-1, 1), volume: rand(-1, 1), trend: rand(-1, 1), rsi: rand(-1, 1) },
    buyThreshold: rand(0, 0.6),
    exit: exitType === 'fixed'
      ? { type: 'fixed', stopLossPct: rand(2, 12), takeProfitPct: rand(4, 30) }
      : { type: 'trailing', trailingPct: rand(3, 18) },
    sizing: { type: 'equal', positionPct: rand(4, 20), maxPositions: Math.round(rand(1, 8)) },
    regimeFilter: Math.random() < 0.3
  };
}

export function mutate(base) {
  const child = JSON.parse(JSON.stringify(base));
  ['momentum', 'volume', 'trend', 'rsi'].forEach((k) => {
    child.weights[k] = clip((child.weights[k] || 0) + (Math.random() * 0.3 - 0.15), -1, 1);
  });
  child.buyThreshold = clip(child.buyThreshold + (Math.random() * 0.2 - 0.1), 0, 0.8);

  if (Math.random() < 0.15) {
    child.exit = child.exit.type === 'fixed'
      ? { type: 'trailing', trailingPct: clip((child.exit.stopLossPct || 5) + (Math.random() * 6 - 1), 3, 20) }
      : { type: 'fixed', stopLossPct: clip(3 + Math.random() * 7, 2, 15), takeProfitPct: clip(6 + Math.random() * 15, 4, 35) };
  } else if (child.exit.type === 'fixed') {
    child.exit.stopLossPct = clip(child.exit.stopLossPct * (0.85 + Math.random() * 0.3), 1, 15);
    child.exit.takeProfitPct = clip(child.exit.takeProfitPct * (0.85 + Math.random() * 0.3), 3, 35);
  } else {
    child.exit.trailingPct = clip(child.exit.trailingPct * (0.85 + Math.random() * 0.3), 2, 25);
  }

  child.sizing.positionPct = clip(child.sizing.positionPct + (Math.random() * 4 - 2), 3, 30);
  if (Math.random() < 0.2) {
    const delta = Math.random() < 0.5 ? -1 : 1;
    child.sizing.maxPositions = clip(Math.round(child.sizing.maxPositions + delta), 1, 8);
    child.sizing.type = child.sizing.maxPositions <= 2 ? 'concentrated' : 'equal';
  }
  if (Math.random() < 0.15) child.regimeFilter = !child.regimeFilter;

  return child;
}

export function describeStrategy(s) {
  const w = s.weights;
  const parts = [`모멘텀 ${w.momentum.toFixed(2)}`, `거래량 ${w.volume.toFixed(2)}`, `추세 ${w.trend.toFixed(2)}`, `RSI ${w.rsi.toFixed(2)}`];
  const exitDesc = s.exit.type === 'trailing' ? `트레일링스탑 ${s.exit.trailingPct.toFixed(1)}%` : `손절 ${s.exit.stopLossPct.toFixed(1)}% / 익절 ${s.exit.takeProfitPct.toFixed(1)}%`;
  return `가중치(${parts.join(', ')}), 매수문턱 ${s.buyThreshold.toFixed(2)}, ${exitDesc}, 종목당 ${s.sizing.positionPct.toFixed(1)}%, 최대 ${s.sizing.maxPositions}종목${s.regimeFilter ? ', 시장필터 ON' : ''}`;
}

// lineagesState: [{ id, label, head, bestEver, bestStats, generation, headStats }]
// 반환: 새 lineagesState + 이번 세대 요약(각 계보의 개선 여부/무작위 이동 여부)
export function advanceGeneration(lineagesState, symbolMaps, dates) {
  const globalBestBefore = lineagesState.reduce((best, l) => (l.bestStats && (!best || l.bestStats.totalReturnPct > best.stats.totalReturnPct)) ? { lineage: l.id, stats: l.bestStats, strategy: l.bestEver } : best, null);

  const newLineages = lineagesState.map((lineage) => {
    const head = lineage.head;
    const children = [];
    // 4개: head의 변형(주된 탐색)
    for (let i = 0; i < 4; i++) children.push(mutate(head));
    // 1개: 완전 무작위(새로운 영역 탐색)
    children.push(randomStrategy());
    // 1개: 전역 최고 기록의 변형(다른 계보의 좋은 발견을 흡수 — 가벼운 교배 효과)
    if (globalBestBefore && globalBestBefore.lineage !== lineage.id) {
      children.push(mutate(globalBestBefore.strategy));
    } else {
      children.push(mutate(head));
    }

    const pool = [{ strategy: head, tag: 'head' }, ...children.map((c) => ({ strategy: c, tag: 'child' }))];
    const evaluated = pool.map((p) => ({ strategy: p.strategy, tag: p.tag, stats: runBacktest(p.strategy, symbolMaps, dates) }));
    evaluated.sort((a, b) => b.stats.totalReturnPct - a.stats.totalReturnPct);

    const genTop = evaluated[0];

    // bestEver는 절대 후퇴하지 않음
    let bestEver = lineage.bestEver, bestStats = lineage.bestStats;
    let improved = false;
    if (!bestStats || genTop.stats.totalReturnPct > bestStats.totalReturnPct) {
      bestEver = genTop.strategy; bestStats = genTop.stats; improved = true;
    }

    // head(탐색 기준점) 이동: 85%는 이번 세대 1위로, 15%는 이번 세대 결과 중 무작위로(배회)
    let newHead, wandered = false;
    if (Math.random() < 0.15) {
      newHead = evaluated[Math.floor(Math.random() * evaluated.length)].strategy;
      wandered = true;
    } else {
      newHead = genTop.strategy;
    }

    return {
      id: lineage.id, label: lineage.label,
      head: newHead, headStats: genTop.stats,
      bestEver, bestStats,
      generation: (lineage.generation || 0) + 1,
      improved, wandered
    };
  });

  const globalBestAfter = newLineages.reduce((best, l) => (!best || l.bestStats.totalReturnPct > best.stats.totalReturnPct) ? { lineage: l.id, stats: l.bestStats, strategy: l.bestEver } : best, null);

  return { lineages: newLineages, globalBest: globalBestAfter, globalImproved: !globalBestBefore || globalBestAfter.stats.totalReturnPct > globalBestBefore.stats.totalReturnPct };
}
