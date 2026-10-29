// /api/_scorecard.js
// "채점표" — 전략마다 7개 부문을 0~100점으로 매기고 종합 등급(A~F)을 냅니다. 전부 계산식이라 공짜이고,
// 늘 같은 결과가 나오고, 점수마다 "왜 이 점수인지" 근거 문장을 같이 돌려줘요.
// 데이터를 모으는 일(KV·시세 조회)은 auto-trade-status.js가 하고, 여기는 숫자 계산만 해요(시험하기 쉽게).
// _로 시작해서 Vercel 함수 개수에 안 잡혀요.

export const SCORECARD_CACHE_KEY = 'scorecard:cache';
export const SCORECARD_HISTORY_KEY = 'scorecard:history';
export const SCORECARD_WEIGHTS_KEY = 'scorecard:weights';

export const CATEGORIES = [
  { id: 'profit', label: '수익성', icon: '💰', easy: '아무거나 산 것(기준선)보다 잘 벌었나?' },
  { id: 'stability', label: '안정성', icon: '🛡️', easy: '한 번에 크게 무너지지 않나?' },
  { id: 'winloss', label: '승률·손익비', icon: '🎯', easy: '이길 때 크게, 질 때 작게?' },
  { id: 'entry', label: '매수 정확도', icon: '🛒', easy: '좋은 때 샀나? (산 뒤 1일·3일 뒤 가격)' },
  { id: 'exit', label: '매도 타이밍', icon: '🏁', easy: '너무 일찍/늦게 팔지 않았나? (판 뒤 3일 가격)' },
  { id: 'cost', label: '비용 효율', icon: '💸', easy: '수수료·세금이 번 돈을 다 먹지 않나?' },
  { id: 'learning', label: '학습·개선', icon: '📈', easy: '바꿀수록 나아지나? (실험 채점 결과)' }
];
export const DEFAULT_WEIGHTS = { profit: 1, stability: 1, winloss: 1, entry: 1, exit: 1, cost: 1, learning: 1 };
export const MIN_SAMPLES = 5; // 이보다 적으면 그 부문은 "근거 부족"으로 점수를 안 매겨요

const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
const r2 = (v) => Math.round(v * 100) / 100;
const isSell = (s) => s === 'STOP_LOSS' || s === 'TAKE_PROFIT' || s === 'DAY_CLOSE';

export function gradeOf(score) {
  if (score === null || score === undefined) return null;
  return score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
}

export function normalizeWeights(raw) {
  const w = {};
  CATEGORIES.forEach((c) => {
    const given = raw && raw[c.id] !== undefined && raw[c.id] !== null && raw[c.id] !== '';
    const v = given ? Number(raw[c.id]) : NaN; // 저장된 값이 없으면 기본값(1) — Number(null)=0이 되는 함정 피하기
    w[c.id] = Number.isFinite(v) && v >= 0 ? Math.min(v, 5) : DEFAULT_WEIGHTS[c.id];
  });
  return w;
}

// 거래일 날짜(YYYYMMDD) 목록에서 date(YYYY-MM-DD) 이후 n번째 거래일의 종가
function closeAfter(history, isoDate, n) {
  if (!history || !history.length) return null;
  const ymd = isoDate.replace(/-/g, '');
  const idx = history.findIndex((h) => h.date > ymd);
  if (idx === -1) return null;
  const row = history[idx + n - 1];
  return row && row.close ? row.close : null;
}

// 전략 하나 채점.
// input: { id, trades: [그 전략의 매매 기록], accountPct, baselinePct, experiments: [그 전략 실험], histories: { 종목: 일봉[] },
//          startingCash: { KR, US }, isBaseline, learnable }
export function scoreStrategy(input) {
  const trades = (input.trades || []).slice().sort((a, b) => a.ts - b.ts);
  const sells = trades.filter((t) => isSell(t.side));
  const buys = trades.filter((t) => t.side === 'BUY');
  const cats = {};

  // 💰 수익성: 가짜 계좌 수익률을 기준선(대조군)과 비교 — 기준선보다 10%p 앞서면 100점, 같으면 50점
  if (typeof input.accountPct === 'number') {
    if (input.isBaseline) {
      cats.profit = { score: 50, why: `기준선 자신이라 비교 기준점(50점)이에요. 수익률 ${r2(input.accountPct)}%.` };
    } else if (typeof input.baselinePct === 'number') {
      const diff = input.accountPct - input.baselinePct;
      cats.profit = { score: clamp(50 + diff * 5), why: `수익률 ${r2(input.accountPct)}% vs 기준선 ${r2(input.baselinePct)}% → ${diff >= 0 ? '+' : ''}${r2(diff)}%p` };
    }
  }

  // 🛡️ 안정성: 확정 손익을 순서대로 쌓았을 때 고점에서 가장 크게 떨어진 폭(최대 낙폭)과 연속 손실
  if (sells.length >= MIN_SAMPLES) {
    let eq = 0, peak = 0, mdd = 0, streak = 0, maxStreak = 0;
    for (const s of sells) {
      const base = s.market === 'US' ? input.startingCash.US : input.startingCash.KR;
      eq += ((s.pnlAmount || 0) / base) * 100;
      peak = Math.max(peak, eq);
      mdd = Math.max(mdd, peak - eq);
      streak = (s.pnlPct || 0) <= 0 ? streak + 1 : 0;
      maxStreak = Math.max(maxStreak, streak);
    }
    cats.stability = {
      score: clamp(100 - mdd * 8 - Math.max(0, maxStreak - 3) * 5),
      why: `최대 낙폭 ${r2(mdd)}%p(원금 대비), 최장 연속 손실 ${maxStreak}번`
    };
  }

  // 🎯 승률·손익비: 번 거래의 합 ÷ 잃은 거래의 합(손익비). 1이면 본전(50점), 2면 100점
  if (sells.length >= MIN_SAMPLES) {
    const gains = sells.filter((s) => s.pnlPct > 0);
    const plus = gains.reduce((a, s) => a + s.pnlPct, 0);
    const minus = Math.abs(sells.filter((s) => s.pnlPct <= 0).reduce((a, s) => a + s.pnlPct, 0));
    const pf = minus === 0 ? (plus > 0 ? 3 : 1) : plus / minus;
    cats.winloss = {
      score: clamp((pf / 2) * 100),
      why: `승률 ${r2((gains.length / sells.length) * 100)}%, 손익비 ${r2(pf)} (번 합 ${r2(plus)}% ÷ 잃은 합 ${r2(minus)}%)`
    };
  }

  // 🛒 매수 정확도: 국내 종목은 산 날 다음 1·3거래일 종가를 산 가격과 비교(해외는 일봉이 없어 제외)
  const evalBuys = buys.map((b) => {
    const h = input.histories[b.symbol];
    const c1 = closeAfter(h, b.date, 1), c3 = closeAfter(h, b.date, 3);
    return (c1 && c3) ? { up1: c1 > b.price, ret3: (c3 / b.price - 1) * 100 } : null;
  }).filter(Boolean);
  if (evalBuys.length >= MIN_SAMPLES) {
    const up1 = evalBuys.filter((e) => e.up1).length / evalBuys.length * 100;
    const avg3 = evalBuys.reduce((a, e) => a + e.ret3, 0) / evalBuys.length;
    cats.entry = {
      score: clamp(up1 * 0.5 + clamp(50 + avg3 * 10) * 0.5),
      why: `산 다음 날 오른 비율 ${r2(up1)}%, 3거래일 뒤 평균 ${avg3 >= 0 ? '+' : ''}${r2(avg3)}% (${evalBuys.length}건)`
    };
  }

  // 🏁 매도 타이밍: 판 뒤 3거래일 종가 — 손절 뒤 3% 넘게 반등하면 "너무 일찍 손절", 익절 뒤 5% 넘게 더 오르면 "너무 일찍 익절"
  const evalSells = sells.map((s) => {
    const c3 = closeAfter(input.histories[s.symbol], s.date, 3);
    if (!c3) return null;
    const after = (c3 / s.price - 1) * 100;
    const early = (s.side === 'STOP_LOSS' && after > 3) || (s.side !== 'STOP_LOSS' && after > 5);
    return { early, stop: s.side === 'STOP_LOSS' };
  }).filter(Boolean);
  if (evalSells.length >= MIN_SAMPLES) {
    const early = evalSells.filter((e) => e.early);
    cats.exit = {
      score: clamp((1 - early.length / evalSells.length) * 100),
      why: `판 뒤 다시 크게 오른 경우 ${early.length}/${evalSells.length}건 (손절 뒤 반등 ${early.filter((e) => e.stop).length}건, 익절 뒤 더 상승 ${early.filter((e) => !e.stop).length}건)`
    };
  }

  // 💸 비용 효율: 수수료·세금이 "확정 손익 크기 + 비용"에서 차지하는 비율 — 비용이 손익을 다 먹을수록 낮아요(국내 기준)
  const kr = trades.filter((t) => t.market !== 'US');
  if (kr.filter((t) => isSell(t.side)).length >= MIN_SAMPLES) {
    const fee = kr.reduce((a, t) => a + (t.fee || 0), 0);
    const net = Math.abs(kr.filter((t) => isSell(t.side)).reduce((a, t) => a + (t.pnlAmount || 0), 0));
    const ratio = fee / (net + fee || 1);
    cats.cost = { score: clamp((1 - ratio) * 100), why: `비용 ${Math.round(fee).toLocaleString()}원 vs 확정 손익 크기 ${Math.round(net).toLocaleString()}원 (비용 비중 ${r2(ratio * 100)}%)` };
  }

  // 📈 학습·개선: 채점된 실험 중 좋아짐/나빠짐 비율 (실험 대상이 아닌 전략은 해당 없음)
  if (input.learnable) {
    const judged = (input.experiments || []).filter((e) => e.status === 'judged' && e.result && ['improved', 'worse', 'no-effect'].includes(e.result.verdict));
    if (judged.length) {
      const imp = judged.filter((e) => e.result.verdict === 'improved').length;
      const wor = judged.filter((e) => e.result.verdict === 'worse').length;
      cats.learning = { score: clamp(50 + ((imp - wor) / judged.length) * 50), why: `채점된 실험 ${judged.length}개 중 좋아짐 ${imp}, 나빠짐 ${wor}` };
    }
  }

  return { cats, sells: sells.length, buys: buys.length, confidence: sells.length < 10 ? '낮음' : sells.length < 30 ? '보통' : '높음' };
}

export function totalOf(cats, weights) {
  let sum = 0, wsum = 0;
  CATEGORIES.forEach((c) => {
    const s = cats[c.id];
    if (!s || typeof s.score !== 'number') return;
    sum += s.score * weights[c.id];
    wsum += weights[c.id];
  });
  return wsum > 0 ? Math.round(sum / wsum) : null;
}
