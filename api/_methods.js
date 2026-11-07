// /api/_methods.js
// "어떻게 사고팔지"(매매 방식)를 "언제 살지"(전략의 신호)와 따로 정해요. _로 시작해서 Vercel 함수 개수에 안 잡혀요.
// 실제 자동매매(auto-trade-check.js)와 기간 백테스트(_strategy-sim.js)가 이 파일의 같은 계산을 써서,
// 백테스트에서 좋았던 방식이 실제 매매에서도 같은 뜻으로 움직이게 해요.
//
// 사는 방법:  single(한 번에) / ladder(떨어질 때 나눠 사기) / pyramid(오를 때 더 사기)
// 파는 방법:  single(한 번에) / split(목표 절반에서 반 팔고 나머지는 본전 지키기) / trail(최고가에서 일정 % 밀리면 팔기)
// 숫자는 정답이 아니라 출발점이에요. 전략연구실의 "방법 찾기"로 수익이 더 나은 조합을 찾으면 바꿔요.

export const METHODS_KEY = 'autotrade:methods'; // { [전략 id]: method } — 화면/방법 찾기에서 바꾼 값

export const BREAKEVEN_PCT = 0.4; // "본전" 손절선: 왕복 비용(약 0.33%)을 빼도 손해가 거의 없는 가격

const SINGLE = { buy: { type: 'single' }, sell: { type: 'single' } };
const SPLIT = (rest) => ({ type: 'split', firstAtPct: null, firstFrac: 0.5, rest: rest || 'take', trailPct: 3, activatePct: 0 });

// 전략별 출발점. 데이트레이딩·초단타·기준선은 지금까지 하던 대로(한 번에 사고 한 번에 팔기) 둬요.
export const DEFAULT_METHODS = {
  daytrade: SINGLE,
  scalp: SINGLE,
  baseline: SINGLE,
  'vwap-pullback': { buy: { type: 'single' }, sell: SPLIT('take') },
  'opening-breakout': { buy: { type: 'single' }, sell: SPLIT('take') },
  'staged-dip': { buy: { type: 'ladder', steps: [2, 4], tranches: 3 }, sell: SPLIT('take') },
  momentum: { buy: { type: 'pyramid', addAtPct: 3, times: 1 }, sell: { type: 'trail', trailPct: 5, activatePct: 3 } },
  evolved: { buy: { type: 'single' }, sell: SPLIT('take') },
  'dip-rebound': { buy: { type: 'single' }, sell: SPLIT('take') },
  'dip-nextday': { buy: { type: 'single' }, sell: SPLIT('trail') },
  inverse: { buy: { type: 'single' }, sell: { type: 'trail', trailPct: 3, activatePct: 1 } }
};

const clip = (v, lo, hi, fb) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? fb : Math.max(lo, Math.min(hi, n));
};

// 저장된 값이나 화면에서 보낸 값을 안전한 모양으로 맞춰요. 이상한 값은 출발점(fallback)으로 돌려요.
export function normalizeMethod(raw, fallback) {
  const fb = fallback || SINGLE;
  const r = raw || {};
  const b = r.buy || {}, s = r.sell || {};
  const fbB = fb.buy || {}, fbS = fb.sell || {};
  let buy;
  const bt = ['single', 'ladder', 'pyramid'].includes(b.type) ? b.type : (fbB.type || 'single');
  if (bt === 'ladder') {
    const stepsIn = Array.isArray(b.steps) ? b.steps : (fbB.steps || [2, 4]);
    let steps = stepsIn.map((x) => clip(x, 0.5, 20, null)).filter((x) => x !== null).slice(0, 3);
    if (!steps.length) steps = [2, 4];
    steps = steps.sort((x, y) => x - y);
    buy = { type: 'ladder', steps, tranches: steps.length + 1 };
  } else if (bt === 'pyramid') {
    buy = { type: 'pyramid', addAtPct: clip(b.addAtPct, 0.5, 20, fbB.addAtPct || 3), times: Math.round(clip(b.times, 1, 3, fbB.times || 1)) };
  } else buy = { type: 'single' };
  let sell;
  const st = ['single', 'split', 'trail'].includes(s.type) ? s.type : (fbS.type || 'single');
  if (st === 'split') {
    sell = {
      type: 'split',
      firstAtPct: s.firstAtPct === null || s.firstAtPct === undefined ? (fbS.firstAtPct ?? null) : clip(s.firstAtPct, 0.3, 50, null),
      firstFrac: clip(s.firstFrac, 0.2, 0.8, fbS.firstFrac || 0.5),
      rest: s.rest === 'trail' || (s.rest === undefined && fbS.rest === 'trail') ? 'trail' : 'take',
      trailPct: clip(s.trailPct, 0.5, 20, fbS.trailPct || 3),
      activatePct: clip(s.activatePct, 0, 30, fbS.activatePct || 0)
    };
  } else if (st === 'trail') {
    sell = { type: 'trail', trailPct: clip(s.trailPct, 0.5, 20, fbS.trailPct || 4), activatePct: clip(s.activatePct, 0, 30, fbS.activatePct ?? 2) };
  } else sell = { type: 'single' };
  return { buy, sell };
}

export function methodOf(id, saved) {
  return normalizeMethod(saved && saved[id], DEFAULT_METHODS[id] || SINGLE);
}

// 화면·변경 이력에 쓰는 한 줄 설명
export function describeMethod(m) {
  const b = m.buy, s = m.sell;
  const buy = b.type === 'ladder' ? `나눠 사기(${b.tranches}번, 첫 매수가에서 -${b.steps.join('%/-')}%마다)`
    : b.type === 'pyramid' ? `오르면 더 사기(+${b.addAtPct}%마다 ${b.times}번)` : '한 번에 사기';
  const sell = s.type === 'split'
    ? `나눠 팔기(${s.firstAtPct ? '+' + s.firstAtPct + '%' : '목표 절반'}에서 ${Math.round(s.firstFrac * 100)}% 팔고, 나머지는 ${s.rest === 'trail' ? `최고가 -${s.trailPct}%에서` : '목표가에서'} 팔기)`
    : s.type === 'trail' ? `따라가는 손절(최고가에서 -${s.trailPct}%${s.activatePct ? `, +${s.activatePct}% 넘은 뒤부터` : ''})` : '한 번에 팔기';
  return `${buy} · ${sell}`;
}

// 처음 살 때 전체 예산 중 얼마를 쓰는지. 나눠 사기·더 사기는 나머지를 나중을 위해 남겨둬요(합쳐도 예산을 넘지 않게).
export function firstBuyShare(m) {
  if (m.buy.type === 'ladder') return 1 / m.buy.tranches;
  if (m.buy.type === 'pyramid') return 1 / (1 + m.buy.times);
  return 1;
}

// 새로 산 포지션에 붙여 둘 정보(방식 계산에 필요한 값)
export function newPositionFields(m, price, budget) {
  const f = { firstPrice: price, lastAddPrice: price, peak: price, tranches: 1, adds: 0 };
  if (m.buy.type !== 'single') f.trancheBudget = Math.round(budget * firstBuyShare(m));
  return f;
}

// 지금 상태에서 각 "가격선"을 계산해요. 실시간(1분마다 가격 비교)과 백테스트(하루 가격 경로를 따라가며 선을 넘었는지)가 같이 써요.
// pos: { avgPrice, firstPrice, lastAddPrice, peak, tranches, adds, partialDone, breakeven }
export function levelsOf(pos, m, stopPct, takePct) {
  const avg = pos.avgPrice;
  const b = m.buy, s = m.sell;
  const L = { stop: null, add: null, addDir: null, partial: null, take: null, trail: null };
  // 손절선: 나눠 사는 중이면 마지막 단계 아래로 잡아요(그렇지 않으면 다음 단계를 사기도 전에 손절돼요).
  if (pos.breakeven) L.stop = avg * (1 + BREAKEVEN_PCT / 100);
  else if (b.type === 'ladder' && (pos.tranches || 1) < b.tranches) {
    L.stop = pos.firstPrice * (1 - b.steps[b.steps.length - 1] / 100) * (1 - stopPct / 100);
  } else L.stop = avg * (1 - stopPct / 100);
  // 더 사기
  if (b.type === 'ladder' && (pos.tranches || 1) < b.tranches) {
    L.add = pos.firstPrice * (1 - b.steps[(pos.tranches || 1) - 1] / 100); L.addDir = 'down';
  } else if (b.type === 'pyramid' && (pos.adds || 0) < b.times && !pos.partialDone) {
    L.add = (pos.lastAddPrice || avg) * (1 + b.addAtPct / 100); L.addDir = 'up';
  }
  // 팔기
  const trailing = s.type === 'trail' || (s.type === 'split' && pos.partialDone && s.rest === 'trail');
  if (s.type === 'split' && !pos.partialDone) {
    const first = s.firstAtPct ? s.firstAtPct : takePct / 2;
    L.partial = avg * (1 + first / 100);
  }
  if (s.type === 'single' || (s.type === 'split' && (!pos.partialDone ? true : s.rest === 'take'))) L.take = avg * (1 + takePct / 100);
  if (trailing) {
    const peak = Math.max(pos.peak || avg, avg);
    const activated = peak >= avg * (1 + (s.activatePct || 0) / 100);
    if (activated) L.trail = peak * (1 - s.trailPct / 100);
  }
  return L;
}

// 실시간 판단: 지금 가격으로 팔아야 하는지. 반환 { side, frac? } (frac 없으면 전부)
export function exitDecision(pos, price, m, stopPct, takePct) {
  const L = levelsOf(pos, m, stopPct, takePct);
  if (L.trail !== null && price <= L.trail && L.trail >= L.stop) return { side: 'TRAIL_STOP' };
  if (price <= L.stop) return { side: 'STOP_LOSS', breakeven: !!pos.breakeven };
  if (L.trail !== null && price <= L.trail) return { side: 'TRAIL_STOP' };
  if (L.partial !== null && price >= L.partial) {
    return pos.qty >= 2 ? { side: 'PARTIAL_TAKE', frac: m.sell.firstFrac } : { side: 'TAKE_PROFIT' };
  }
  if (L.take !== null && price >= L.take) return { side: 'TAKE_PROFIT' };
  return null;
}

// 실시간 판단: 지금 가격에서 더 사야 하는지. 반환 { budget, kind } 또는 null
export function addDecision(pos, price, m, stopPct, takePct) {
  const L = levelsOf(pos, m, stopPct, takePct);
  if (L.add === null || !pos.trancheBudget) return null;
  if (L.addDir === 'down' && price <= L.add) return { budget: pos.trancheBudget, kind: 'ladder' };
  if (L.addDir === 'up' && price >= L.add) return { budget: pos.trancheBudget, kind: 'pyramid' };
  return null;
}

// 더 산 뒤 포지션 정보 갱신(평균 단가·원가·단계)
export function applyAdd(pos, kind, qty, price, total) {
  const newQty = pos.qty + qty;
  const next = Object.assign({}, pos, {
    qty: newQty,
    avgPrice: (pos.qty * pos.avgPrice + qty * price) / newQty,
    costBasis: (pos.costBasis || pos.qty * pos.avgPrice) + total,
    lastAddPrice: price
  });
  if (kind === 'ladder') next.tranches = (pos.tranches || 1) + 1;
  else { next.adds = (pos.adds || 0) + 1; next.breakeven = true; } // 오를 때 더 샀으면 손절선을 본전으로 올려요
  return next;
}

// 반만 판 뒤 남은 포지션: 원가는 판 비율만큼 줄이고, 손절선은 본전으로 올려요
export function applyPartial(pos, soldQty) {
  const ratio = soldQty / pos.qty;
  return Object.assign({}, pos, {
    qty: pos.qty - soldQty,
    costBasis: (pos.costBasis || pos.qty * pos.avgPrice) * (1 - ratio),
    partialDone: true,
    breakeven: true
  });
}

// 백테스트·방법 찾기에서 시험해 볼 조합 목록
export function methodGrid() {
  const buys = [
    { type: 'single' },
    { type: 'ladder', steps: [2, 4] },
    { type: 'ladder', steps: [3, 6] },
    { type: 'pyramid', addAtPct: 3, times: 1 }
  ];
  const sells = [
    { type: 'single' },
    { type: 'split', rest: 'take' },
    { type: 'split', rest: 'trail', trailPct: 3 },
    { type: 'trail', trailPct: 3, activatePct: 1 },
    { type: 'trail', trailPct: 5, activatePct: 3 }
  ];
  const out = [];
  buys.forEach((b) => sells.forEach((s) => out.push(normalizeMethod({ buy: b, sell: s }))));
  return out;
}
