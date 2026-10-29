// /api/_learning.js
// "학습하는 자동조정"의 규칙(계산)만 모아둔 파일입니다. KV를 읽고 쓰는 일은 auto-trade-check.js가 하고,
// 여기는 숫자만 다뤄서 따로 시험해 보기 쉬워요. _로 시작해서 Vercel 함수 개수에 안 잡혀요.
//
// 예전 자동조정의 문제(2026-10 실제 기록 104건으로 확인):
//   - 매일, 같은 근거(바꾸기 전 설정으로 한 거래)로 또 바꿔서 손절 7→9→12→15→10→13… 처럼 같은 자리를 맴돌았어요.
//   - 손해가 나면 비중·횟수만 계속 줄여서 대부분 전략이 "비중 1%, 하루 1번"까지 내려가 사실상 멈췄어요.
//   - 대조군(기준선)까지 바꿔서 비교 자체가 안 됐어요.
//   - 바꾼 뒤 좋아졌는지 확인도, 되돌리기도, 기억도 없었어요.
// 그래서 이제 변경 하나하나를 "실험"으로 다룹니다:
//   가설을 세우고 바꾼다 → 새 설정으로 거래 10건이 쌓일 때까지 기다린다 → 바꾸기 전 10건, 같은 기간의 대조군과 비교해
//   채점한다(좋아짐/효과 없음/나빠짐) → 나빠졌으면 가장 좋았던 설정으로 되돌린다 → 결과를 교훈으로 남겨 다음 실험에 넘긴다.

export const EXPERIMENTS_KEY = 'autotrade:experiments'; // 실험 기록(최신순)
export const BEST_RISK_KEY = 'autotrade:strategy-best'; // 전략별 "지금까지 가장 좋았던 설정"
export const FLAGS_KEY = 'autotrade:strategy-flags'; // 전략별 경고(예: 사는 조건 문제)
export const MAX_EXPERIMENTS = 300;

export const LEARN = {
  minTrades: 10, // 새 설정으로 이만큼 거래가 끝나야 채점해요
  maxDays: 14, // 이 기간이 지나도 다 안 쌓이면, 5건 이상일 때 그때까지로 채점해요
  minTradesAtMaxDays: 5,
  beforeTrades: 10, // 비교 기준: 바꾸기 직전 설정으로 한 마지막 거래 수
  effectPctPoint: 0.5, // 평균 손익이 이만큼(%p) 이상 달라져야 "효과 있음/나빠짐"으로 봐요(그보다 작으면 우연일 수 있어서)
  maxStepRatio: 0.3, // 한 번에 바꿀 수 있는 폭: 지금 값의 ±30%
  floors: { positionPct: 3, maxTradesPerDay: 2, stopLossPct: 1, takeProfitPct: 1 }, // 이 밑으로는 안 내려가요(바닥까지 줄어 멈추는 것 방지)
  ceilings: { positionPct: 15, maxTradesPerDay: 10, stopLossPct: 20, takeProfitPct: 40 },
  buyRuleWinRate: 20, // 최근 거래 20건의 승률이 이보다 낮으면 "숫자 문제가 아니라 사는 조건 문제"로 표시
  buyRuleWindow: 20,
  forbidAfterWorse: 2 // 같은 방향으로 바꿔서 2번 나빠졌으면 그 방향은 더 시도하지 않아요
};

export const RISK_FIELDS = ['stopLossPct', 'takeProfitPct', 'positionPct', 'maxTradesPerDay'];
export const RISK_LABELS = { stopLossPct: '손절', takeProfitPct: '익절', positionPct: '비중', maxTradesPerDay: '하루 횟수' };

// 거래 표본(손익률 목록)을 요약해요. samples: [{ pnlPct, side, entryChangePct? }]
export function summarize(samples) {
  const n = samples.length;
  if (!n) return { trades: 0, winRate: null, avgPnlPct: null, stopLossShare: null, chaseShare: null };
  const wins = samples.filter((s) => s.pnlPct > 0).length;
  const stops = samples.filter((s) => s.side === 'STOP_LOSS').length;
  // "고점 매수": 산 날 이미 어제보다 10% 넘게 오른 상태였던 거래(진입 정보가 기록된 거래만 셈)
  const known = samples.filter((s) => typeof s.entryChangePct === 'number');
  const chased = known.filter((s) => s.entryChangePct >= 10).length;
  const round = (v) => Math.round(v * 100) / 100;
  return {
    trades: n,
    winRate: round((wins / n) * 100),
    avgPnlPct: round(samples.reduce((a, s) => a + (s.pnlPct || 0), 0) / n),
    stopLossShare: round((stops / n) * 100),
    chaseShare: known.length ? round((chased / known.length) * 100) : null
  };
}

// 서버가 직접 지키는 안전장치: AI가 뭐라고 하든 한 번에 ±30% 안, 바닥·천장 안으로 자릅니다.
export function clampProposal(current, proposed) {
  const out = {};
  for (const f of RISK_FIELDS) {
    const cur = Number(current[f]);
    let v = Number(proposed[f]);
    if (!Number.isFinite(v)) v = cur;
    if (f === 'maxTradesPerDay') {
      v = Math.round(Math.max(cur - 1, Math.min(cur + 1, v))); // 횟수는 한 번에 ±1회
    } else {
      const step = Math.max(cur * LEARN.maxStepRatio, 0.5);
      v = Math.round(Math.max(cur - step, Math.min(cur + step, v)) * 10) / 10;
    }
    out[f] = Math.max(LEARN.floors[f], Math.min(LEARN.ceilings[f], v));
  }
  return out;
}

// 바닥 아래로 내려가 있는 옛 설정(예: 비중 1%, 하루 1번)을 바닥으로 끌어올려요.
export function liftToFloors(risk) {
  const out = Object.assign({}, risk);
  for (const f of RISK_FIELDS) out[f] = Math.max(LEARN.floors[f], Math.min(LEARN.ceilings[f], Number(out[f]) || LEARN.floors[f]));
  return out;
}

// 값마다 올렸는지/내렸는지: { stopLossPct: 'up' | 'down' | null, … }
export function directions(before, after) {
  const d = {};
  for (const f of RISK_FIELDS) d[f] = after[f] > before[f] ? 'up' : (after[f] < before[f] ? 'down' : null);
  return d;
}

// "손절 4%→5.5%(넓힘), 비중 5%→4%(줄임)" 같은 쉬운 설명
export function describeChange(before, after) {
  const words = { stopLossPct: ['넓힘', '좁힘'], takeProfitPct: ['높임', '낮춤'], positionPct: ['늘림', '줄임'], maxTradesPerDay: ['늘림', '줄임'] };
  const parts = [];
  for (const f of RISK_FIELDS) {
    if (after[f] === before[f]) continue;
    const unit = f === 'maxTradesPerDay' ? '번' : '%';
    parts.push(`${RISK_LABELS[f]} ${before[f]}${unit}→${after[f]}${unit}(${after[f] > before[f] ? words[f][0] : words[f][1]})`);
  }
  return parts.join(', ') || '변경 없음';
}

// 실험 채점. 대조군(기준선)의 같은 기간 변화만큼은 "시장 탓"으로 보고 빼서, 설정 변경의 효과만 남겨요.
// 반환: { verdict: 'improved'|'no-effect'|'worse'|'inconclusive', after, effectPctPoint, controlShift }
export function judge(exp) {
  const after = summarize(exp.samples || []);
  const before = exp.beforeStats || summarize([]);
  if (after.trades < LEARN.minTradesAtMaxDays || before.trades < LEARN.minTradesAtMaxDays) {
    return { verdict: 'inconclusive', after, effectPctPoint: null, controlShift: null };
  }
  const control = summarize(exp.controlSamples || []);
  const controlBefore = exp.controlBeforeStats || summarize([]);
  const controlShift = (control.trades >= 3 && controlBefore.trades >= 3) ? control.avgPnlPct - controlBefore.avgPnlPct : 0;
  const raw = after.avgPnlPct - before.avgPnlPct;
  const effect = Math.round((raw - controlShift) * 100) / 100;
  let verdict = 'no-effect';
  if (effect >= LEARN.effectPctPoint && raw > 0) verdict = 'improved';
  else if (effect <= -LEARN.effectPctPoint) verdict = 'worse';
  return { verdict, after, effectPctPoint: effect, controlShift: Math.round(controlShift * 100) / 100 };
}

export function readyToJudge(exp, now) {
  const n = (exp.samples || []).length;
  if (n >= LEARN.minTrades) return true;
  return now - exp.startedAt >= LEARN.maxDays * 86400000;
}

export const VERDICT_TEXT = { improved: '좋아짐', 'no-effect': '효과 없음', worse: '나빠짐', inconclusive: '근거 부족', cancelled: '중단됨' };

// 이 전략에서 "같은 방향으로 바꿨다가 나빠진" 횟수가 많은 방향 → 다시 시도 금지
export function forbiddenDirections(experiments) {
  const count = {};
  experiments.filter((e) => e.status === 'judged' && e.result && e.result.verdict === 'worse').forEach((e) => {
    const d = directions(e.before, e.after);
    for (const f of RISK_FIELDS) if (d[f]) count[f + ':' + d[f]] = (count[f + ':' + d[f]] || 0) + 1;
  });
  return Object.keys(count).filter((k) => count[k] >= LEARN.forbidAfterWorse);
}

// 금지된 방향으로 가려는 값은 지금 값 그대로 둡니다.
export function applyForbidden(current, proposal, forbidden) {
  const out = Object.assign({}, proposal);
  const d = directions(current, proposal);
  for (const f of RISK_FIELDS) if (d[f] && forbidden.includes(f + ':' + d[f])) out[f] = current[f];
  return out;
}

// 한 실험의 교훈 한 줄: "손절 4%→5.5%(넓힘) → 나빠짐(효과 -1.2%p, 거래 10건, 하락장)"
export function lessonLine(exp) {
  const r = exp.result || {};
  const v = VERDICT_TEXT[r.verdict] || r.verdict || '진행 중';
  const eff = typeof r.effectPctPoint === 'number' ? `효과 ${r.effectPctPoint >= 0 ? '+' : ''}${r.effectPctPoint}%p, ` : '';
  const n = r.after ? `거래 ${r.after.trades}건` : '';
  return `${describeChange(exp.before, exp.after)} → ${v}(${eff}${n}${exp.regimeLabel ? ', ' + exp.regimeLabel : ''})`;
}
