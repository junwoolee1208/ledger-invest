// /api/_scorecard.js
// "채점표" — 전략마다 9개 부문을 0~100점으로 매기고 종합 등급(A~F)을 냅니다. 전부 계산식이라 공짜이고,
// 늘 같은 결과가 나오고, 점수마다 "왜 이 점수인지" 근거 문장을 같이 돌려줘요.
// 상세 성적표(analyzeStrategy)는 부문마다 세부 지표 3~5개, 개선 가이드(원인이 된 거래 목록 포함),
// 종목·시장·월·시간대별로 나눠 본 결과까지 계산해요. 기준선(대조군)도 같은 함수로 계산해서 나란히 비교해요.
// 데이터를 모으는 일(KV·시세 조회)은 auto-trade-status.js가 하고, 여기는 숫자 계산만 해요(시험하기 쉽게).
// _로 시작해서 Vercel 함수 개수에 안 잡혀요.

export const SCORECARD_CACHE_KEY = 'scorecard:cache';
export const SCORECARD_HISTORY_KEY = 'scorecard:history';
export const SCORECARD_WEIGHTS_KEY = 'scorecard:weights';
export const SCORECARD_DETAIL_PREFIX = 'scorecard:detail:'; // + 전략:기간

// rubric: "자세히 보기"에 쓰는 점수 기준(쉬운 말)
export const CATEGORIES = [
  { id: 'profit', label: '수익성', icon: '💰', easy: '아무거나 산 것(기준선)보다 잘 벌었나?',
    rubric: '이 기간에 팔아서 확정한 손익(원금 대비 %)을 기준선과 비교해요. 같으면 50점, 기준선보다 1%p 더 벌 때마다 +5점(10%p 앞서면 100점).' },
  { id: 'stability', label: '안정성', icon: '🛡️', easy: '한 번에 크게 무너지지 않나?',
    rubric: '확정 손익을 순서대로 쌓았을 때 가장 높았던 때에서 가장 많이 떨어진 폭(최대 낙폭)이 1%p마다 -8점, 연속 손실이 3번을 넘으면 1번마다 -5점.' },
  { id: 'winloss', label: '승률·손익비', icon: '🎯', easy: '이길 때 크게, 질 때 작게?',
    rubric: '번 거래의 % 합 ÷ 잃은 거래의 % 합(손익비). 1이면 본전이라 50점, 2면 100점.' },
  { id: 'entry', label: '매수 정확도', icon: '🛒', easy: '좋은 때 샀나? (산 뒤 가격)',
    rubric: '산 다음 날 오른 비율(절반 반영) + 3거래일 뒤 평균 수익(0%면 50점, 1%마다 ±10점, 절반 반영). 국내 종목만 계산해요.' },
  { id: 'exit', label: '매도 타이밍', icon: '🏁', easy: '너무 일찍/늦게 팔지 않았나? (판 뒤 가격)',
    rubric: '판 뒤 3거래일 안에 다시 크게 오른 경우(손절 뒤 +3% 넘게 반등, 익절 뒤 +5% 넘게 상승)의 비율만큼 깎아요. 하나도 없으면 100점.' },
  { id: 'cost', label: '비용 효율', icon: '💸', easy: '수수료·세금이 번 돈을 다 먹지 않나?',
    rubric: '비용 ÷ (확정 손익 크기 + 비용). 비용 비중이 0%면 100점, 50%면 50점(국내 기준).' },
  { id: 'consistency', label: '꾸준함', icon: '📆', easy: '한 번에 크게 번 건지, 꾸준히 번 건지?',
    rubric: '주 단위로 나눴을 때 번 주의 비율이에요. 매매한 주가 3주 이상일 때만 매겨요.' },
  { id: 'regime', label: '시장 적응력', icon: '🌦️', easy: '상승장·하락장·횡보장 어디서도 버티나?',
    rubric: '시장 상황별 평균 손익 중 가장 나쁜 상황의 평균이 0%면 50점, 1%마다 ±15점. 2가지 이상 상황에서 3번 이상씩 팔았을 때만 매겨요.' },
  { id: 'learning', label: '학습·개선', icon: '📈', easy: '바꿀수록 나아지나? (실험 채점 결과)',
    rubric: '채점된 실험 중 (좋아짐 − 나빠짐) ÷ 전체가 0이면 50점, 전부 좋아지면 100점, 전부 나빠지면 0점.' }
];
export const DEFAULT_WEIGHTS = { profit: 1, stability: 1, winloss: 1, entry: 1, exit: 1, cost: 1, consistency: 1, regime: 1, learning: 1 };
export const MIN_SAMPLES = 5; // 이보다 적으면 그 부문은 "근거 부족"으로 점수를 안 매겨요
export const REGIME_TREND_KO = { bull: '상승장', bear: '하락장', sideways: '횡보장' };

const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const isSell = (s) => s === 'STOP_LOSS' || s === 'TAKE_PROFIT' || s === 'DAY_CLOSE';
const pctStr = (v) => (v === null ? '—' : (v >= 0 ? '+' : '') + r2(v) + '%');

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

// 거래일(YYYYMMDD) 일봉에서 날짜(YYYY-MM-DD) 다음 n번째 거래일의 행
function rowAfter(history, isoDate, n) {
  if (!history || !history.length || !isoDate) return null;
  const ymd = isoDate.replace(/-/g, '');
  const idx = history.findIndex((h) => h.date > ymd);
  if (idx === -1) return null;
  return history[idx + n - 1] || null;
}
function closeAfter(history, isoDate, n) {
  const r = rowAfter(history, isoDate, n);
  return r && r.close ? r.close : null;
}
// 산 뒤 n거래일 안에 가장 많이 빠진 폭(%) — 저가 기준
function worstDipAfter(history, isoDate, n, price) {
  let low = null;
  for (let k = 1; k <= n; k++) {
    const r = rowAfter(history, isoDate, k);
    if (!r) return null;
    if (r.low && (low === null || r.low < low)) low = r.low;
  }
  return low ? (low / price - 1) * 100 : null;
}

function isoWeek(date) {
  const d = new Date(date + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

// 판 거래에 맞는 산 거래(같은 전략·종목, 판 시각 이전의 가장 최근 매수)를 찾아 보유 기간을 구해요.
// 새 기록에는 entryDate가 있지만, 예전 기록은 이렇게 짝을 지어 근사해요.
function holdingDaysOf(sell, buys) {
  let entryDate = sell.entryDate || null;
  if (!entryDate) {
    const b = buys.filter((x) => x.symbol === sell.symbol && x.ts < sell.ts).sort((a, c) => c.ts - a.ts)[0];
    entryDate = b ? b.date : null;
  }
  return entryDate ? Math.round((Date.parse(sell.date) - Date.parse(entryDate)) / 86400000) : null;
}

const tradeRef = (t) => ({ ts: t.ts, date: t.date, symbol: t.symbol, name: t.name, side: t.side, price: t.price, pnlPct: t.pnlPct, entryChangePct: t.entryChangePct });

// 전략 하나 분석.
// input: { id, trades: [그 전략의 매매 기록(이 기간)], accountPct, histories: { 종목: 일봉[] },
//          startingCash: { KR, US }, experiments: [그 전략 실험], learnable, isDaytrade }
// 반환: { cats: { 부문: {score, why} }, metrics: { 부문: [{label, value, unit, better, raw}] }, guides, breakdowns, sells, buys, confidence }
export function analyzeStrategy(input) {
  const trades = (input.trades || []).slice().sort((a, b) => a.ts - b.ts);
  const sells = trades.filter((t) => isSell(t.side));
  const buys = trades.filter((t) => t.side === 'BUY');
  const sc = input.startingCash || { KR: 10_000_000, US: 7_000 };
  const pctOfCash = (t) => ((t.pnlAmount || 0) / (t.market === 'US' ? sc.US : sc.KR)) * 100;
  const cats = {}, metrics = {}, guides = [], breakdowns = {};
  const M = (cat, label, value, unit, better, extra) => {
    (metrics[cat] = metrics[cat] || []).push(Object.assign({ label, value: r2(value), unit: unit || '', better: better || null }, extra || {}));
  };

  // 💰 수익성 — 확정 손익(원금 대비 %)
  const krSells = sells.filter((s) => s.market !== 'US'), usSells = sells.filter((s) => s.market === 'US');
  const realizedKr = krSells.reduce((a, s) => a + pctOfCash(s), 0);
  const realizedUs = usSells.reduce((a, s) => a + pctOfCash(s), 0);
  const realized = (realizedKr * sc.KR + realizedUs * sc.US) / (sc.KR + sc.US);
  M('profit', '확정 손익(원금 대비)', realized, '%', 'high', { key: 'realizedPct' });
  M('profit', '국내 확정 손익', realizedKr, '%', 'high');
  M('profit', '해외 확정 손익', realizedUs, '%', 'high');
  if (typeof input.accountPct === 'number') M('profit', '지금 계좌 수익률(보유 주식 포함, 전체 기간)', input.accountPct, '%', 'high');
  const byMonth = {};
  sells.forEach((s) => { const m = s.date.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + pctOfCash(s); });
  breakdowns.byMonth = Object.keys(byMonth).sort().map((m) => ({ month: m, pnlPct: r2(byMonth[m]) }));

  // 🛡️ 안정성
  if (sells.length >= MIN_SAMPLES) {
    let eq = 0, peak = 0, mdd = 0, streak = 0, maxStreak = 0, troughIdx = -1, peakBeforeTrough = 0;
    const path = [];
    sells.forEach((s, i) => {
      eq += pctOfCash(s);
      path.push({ date: s.date, eq });
      if (eq > peak) peak = eq;
      if (peak - eq > mdd) { mdd = peak - eq; troughIdx = i; peakBeforeTrough = peak; }
      streak = (s.pnlPct || 0) <= 0 ? streak + 1 : 0;
      maxStreak = Math.max(maxStreak, streak);
    });
    const byDay = {};
    sells.forEach((s) => { byDay[s.date] = (byDay[s.date] || 0) + pctOfCash(s); });
    const worstDay = Object.keys(byDay).reduce((w, d) => (w === null || byDay[d] < byDay[w] ? d : w), null);
    let recovery = null;
    if (troughIdx >= 0) {
      const back = path.slice(troughIdx + 1).find((p) => p.eq >= peakBeforeTrough);
      recovery = back ? Math.round((Date.parse(back.date) - Date.parse(path[troughIdx].date)) / 86400000) : null;
    }
    cats.stability = { score: clamp(100 - mdd * 8 - Math.max(0, maxStreak - 3) * 5), why: `최대 낙폭 ${r2(mdd)}%p(원금 대비), 최장 연속 손실 ${maxStreak}번` };
    M('stability', '최대 낙폭', mdd, '%p', 'low');
    M('stability', '최장 연속 손실', maxStreak, '번', 'low');
    if (worstDay) M('stability', `최악의 하루(${worstDay})`, byDay[worstDay], '%', 'high');
    M('stability', '최대 낙폭에서 회복까지', recovery, '일', 'low', { note: recovery === null && mdd > 0 ? '아직 회복 못 함' : null });
    if (maxStreak >= 5) guides.push({ cat: 'stability', level: 'warn', text: `연속 손실이 ${maxStreak}번까지 이어졌어요. 시장 상황별 성적을 보고, 나쁜 상황에서는 쉬는 규칙을 검토해 보세요.` });
  }

  // 🎯 승률·손익비
  if (sells.length >= MIN_SAMPLES) {
    const gains = sells.filter((s) => s.pnlPct > 0), losses = sells.filter((s) => s.pnlPct <= 0);
    const plus = gains.reduce((a, s) => a + s.pnlPct, 0);
    const minus = Math.abs(losses.reduce((a, s) => a + s.pnlPct, 0));
    const pf = minus === 0 ? (plus > 0 ? 3 : 1) : plus / minus;
    const winRate = (gains.length / sells.length) * 100;
    const avgWin = avg(gains.map((s) => s.pnlPct)), avgLoss = avg(losses.map((s) => s.pnlPct));
    cats.winloss = { score: clamp((pf / 2) * 100), why: `승률 ${r2(winRate)}%, 손익비 ${r2(pf)} (번 합 ${r2(plus)}% ÷ 잃은 합 ${r2(minus)}%)` };
    M('winloss', '승률', winRate, '%', 'high');
    M('winloss', '이긴 거래 평균', avgWin, '%', 'high');
    M('winloss', '진 거래 평균', avgLoss, '%', 'high');
    M('winloss', '손익비(번 합 ÷ 잃은 합)', pf, '', 'high');
    M('winloss', '거래 1번당 기대 손익', avg(sells.map((s) => s.pnlPct || 0)), '%', 'high');
    if (winRate < 40 && avgWin !== null && avgLoss !== null && avgWin < Math.abs(avgLoss)) {
      guides.push({ cat: 'winloss', level: 'bad', text: `자주 지고(승률 ${r2(winRate)}%), 이길 때 버는 것(${pctStr(avgWin)})보다 질 때 잃는 것(${pctStr(avgLoss)})이 커요. 익절을 높이거나 손절을 좁히는 실험이 필요해요.`,
        trades: losses.slice(-15).map(tradeRef), tradesLabel: '진 거래' });
    }
  }

  // 🛒 매수 정확도 (국내만 — 해외는 일봉이 없어 제외)
  const evalBuys = buys.map((b) => {
    const h = input.histories[b.symbol];
    const c1 = closeAfter(h, b.date, 1), c3 = closeAfter(h, b.date, 3), c5 = closeAfter(h, b.date, 5);
    if (!c1 || !c3) return null;
    return { b, up1: c1 > b.price, ret1: (c1 / b.price - 1) * 100, ret3: (c3 / b.price - 1) * 100, ret5: c5 ? (c5 / b.price - 1) * 100 : null, dip: worstDipAfter(h, b.date, 5, b.price) };
  }).filter(Boolean);
  const chased = buys.filter((b) => typeof b.entryChangePct === 'number' && b.entryChangePct >= 10);
  const knownEntry = buys.filter((b) => typeof b.entryChangePct === 'number');
  const chaseShare = knownEntry.length ? (chased.length / knownEntry.length) * 100 : null;
  if (evalBuys.length >= MIN_SAMPLES) {
    const up1 = (evalBuys.filter((e) => e.up1).length / evalBuys.length) * 100;
    const avg3 = avg(evalBuys.map((e) => e.ret3));
    cats.entry = { score: clamp(up1 * 0.5 + clamp(50 + avg3 * 10) * 0.5), why: `산 다음 날 오른 비율 ${r2(up1)}%, 3거래일 뒤 평균 ${pctStr(avg3)} (${evalBuys.length}건)` };
    M('entry', '산 다음 날 오른 비율', up1, '%', 'high');
    M('entry', '1거래일 뒤 평균', avg(evalBuys.map((e) => e.ret1)), '%', 'high');
    M('entry', '3거래일 뒤 평균', avg3, '%', 'high');
    const r5 = evalBuys.filter((e) => e.ret5 !== null).map((e) => e.ret5);
    if (r5.length) M('entry', '5거래일 뒤 평균', avg(r5), '%', 'high');
    const dips = evalBuys.filter((e) => e.dip !== null).map((e) => e.dip);
    if (dips.length) M('entry', '산 뒤 5일 안에 가장 많이 빠진 폭(평균)', avg(dips), '%', 'high');
  }
  if (chaseShare !== null) M('entry', '고점 매수 비율(어제보다 +10% 넘게 오른 날 삼)', chaseShare, '%', 'low');
  if (chaseShare !== null && chaseShare >= 30 && chased.length >= 3) {
    guides.push({ cat: 'entry', level: 'bad', text: `고점 매수가 ${r2(chaseShare)}%예요(이미 +10% 넘게 오른 날 산 거래). 종목 고르기에서 많이 오른 종목을 빼거나, 매수 조건에 상한을 두는 실험이 좋아요.`,
      trades: chased.slice(-15).map(tradeRef), tradesLabel: '고점 매수한 거래' });
  }

  // 🏁 매도 타이밍
  const evalSells = sells.map((s) => {
    const c3 = closeAfter(input.histories[s.symbol], s.date, 3);
    if (!c3) return null;
    const after = (c3 / s.price - 1) * 100;
    return { s, after, earlyStop: s.side === 'STOP_LOSS' && after > 3, earlyTake: s.side !== 'STOP_LOSS' && after > 5 };
  }).filter(Boolean);
  if (evalSells.length >= MIN_SAMPLES) {
    const earlyStops = evalSells.filter((e) => e.earlyStop), earlyTakes = evalSells.filter((e) => e.earlyTake);
    const stops = evalSells.filter((e) => e.s.side === 'STOP_LOSS'), takes = evalSells.filter((e) => e.s.side !== 'STOP_LOSS');
    const early = earlyStops.length + earlyTakes.length;
    cats.exit = { score: clamp((1 - early / evalSells.length) * 100), why: `판 뒤 다시 크게 오른 경우 ${early}/${evalSells.length}건 (손절 뒤 반등 ${earlyStops.length}건, 익절 뒤 더 상승 ${earlyTakes.length}건)` };
    M('exit', '손절한 뒤 3일 안에 +3% 넘게 반등한 비율', stops.length ? (earlyStops.length / stops.length) * 100 : null, '%', 'low');
    M('exit', '익절한 뒤 3일 안에 +5% 넘게 더 오른 비율', takes.length ? (earlyTakes.length / takes.length) * 100 : null, '%', 'low');
    M('exit', '판 뒤 3거래일 평균 가격 변화', avg(evalSells.map((e) => e.after)), '%', 'low');
    if (stops.length >= 3 && earlyStops.length / stops.length >= 0.3) {
      guides.push({ cat: 'exit', level: 'bad', text: `손절한 뒤 다시 오른 경우가 ${r2((earlyStops.length / stops.length) * 100)}%예요. 손절 폭이 너무 좁아 흔들림에 팔리는 것 같아요. 손절을 조금 넓히는 실험을 해볼 만해요.`,
        trades: earlyStops.slice(-15).map((e) => Object.assign(tradeRef(e.s), { after3: r2(e.after) })), tradesLabel: '손절 뒤 반등한 거래' });
    }
    if (takes.length >= 3 && earlyTakes.length / takes.length >= 0.3) {
      guides.push({ cat: 'exit', level: 'warn', text: `익절한 뒤 더 오른 경우가 ${r2((earlyTakes.length / takes.length) * 100)}%예요. 너무 일찍 파는 것 같아요. 익절을 높이는 실험을 해볼 만해요.`,
        trades: earlyTakes.slice(-15).map((e) => Object.assign(tradeRef(e.s), { after3: r2(e.after) })), tradesLabel: '익절 뒤 더 오른 거래' });
    }
  }
  const holds = sells.map((s) => holdingDaysOf(s, buys)).filter((d) => d !== null);
  if (holds.length) M('exit', '평균 보유 기간', avg(holds), '일', null);
  if (sells.length) M('exit', '손절로 끝난 비율', (sells.filter((s) => s.side === 'STOP_LOSS').length / sells.length) * 100, '%', 'low');
  if (input.isDaytrade && sells.length) M('exit', '장마감 청산 비율(시간이 다 돼서 판 것)', (sells.filter((s) => s.side === 'DAY_CLOSE').length / sells.length) * 100, '%', null);

  // 💸 비용 효율 (국내)
  const kr = trades.filter((t) => t.market !== 'US');
  const krS = kr.filter((t) => isSell(t.side));
  if (kr.length) {
    const fee = kr.reduce((a, t) => a + (t.fee || 0), 0);
    const turnover = kr.reduce((a, t) => a + Math.abs(t.amount || (t.qty || 0) * (t.price || 0)), 0);
    const net = Math.abs(krS.reduce((a, t) => a + (t.pnlAmount || 0), 0));
    const ratio = fee / (net + fee || 1);
    if (krS.length >= MIN_SAMPLES) cats.cost = { score: clamp((1 - ratio) * 100), why: `비용 ${Math.round(fee).toLocaleString()}원 vs 확정 손익 크기 ${Math.round(net).toLocaleString()}원 (비용 비중 ${r2(ratio * 100)}%)` };
    M('cost', '총 비용(수수료·세금·슬리피지)', Math.round(fee), '원', 'low');
    M('cost', '거래 1번당 비용', fee / kr.length, '원', 'low');
    M('cost', '거래액 대비 비용', turnover ? (fee / turnover) * 100 : null, '%', 'low');
    M('cost', '비용 비중(비용 ÷ (확정 손익 크기 + 비용))', ratio * 100, '%', 'low');
    if (krS.length >= MIN_SAMPLES && ratio >= 0.5) guides.push({ cat: 'cost', level: 'warn', text: `비용이 손익 크기의 절반 이상이에요(${r2(ratio * 100)}%). 너무 자주 사고팔고 있어요. 하루 매수 횟수를 줄이는 실험을 해보세요.` });
  }

  // 📆 꾸준함 — 주 단위
  const weeks = {};
  sells.forEach((s) => { const w = isoWeek(s.date); weeks[w] = (weeks[w] || 0) + pctOfCash(s); });
  const weekKeys = Object.keys(weeks).sort();
  breakdowns.byWeek = weekKeys.map((w) => ({ week: w, pnlPct: r2(weeks[w]) }));
  if (weekKeys.length >= 3) {
    const pos = weekKeys.filter((w) => weeks[w] > 0).length;
    const vals = weekKeys.map((w) => weeks[w]);
    cats.consistency = { score: clamp((pos / weekKeys.length) * 100), why: `매매한 ${weekKeys.length}주 중 번 주 ${pos}주` };
    M('consistency', '번 주의 비율', (pos / weekKeys.length) * 100, '%', 'high');
    M('consistency', '가장 잘 번 주', Math.max(...vals), '%', 'high');
    M('consistency', '가장 많이 잃은 주', Math.min(...vals), '%', 'high');
    const total = vals.reduce((a, b) => a + b, 0);
    if (total > 0) M('consistency', '가장 잘 번 주가 전체 수익에서 차지하는 비중', (Math.max(...vals) / total) * 100, '%', 'low');
  }

  // 🌦️ 시장 적응력 — 산 날의 시장 상황 기준(없으면 판 날)
  const byRegime = {};
  sells.forEach((s) => {
    const lab = s.entryRegime || s.regime;
    if (!lab) return;
    const trend = REGIME_TREND_KO[String(lab).split('-')[0]] || lab;
    (byRegime[trend] = byRegime[trend] || []).push(s.pnlPct || 0);
  });
  breakdowns.byRegime = Object.keys(byRegime).map((k) => ({ regime: k, n: byRegime[k].length, avgPnlPct: r2(avg(byRegime[k])), winRate: r2((byRegime[k].filter((x) => x > 0).length / byRegime[k].length) * 100) }));
  const qualified = breakdowns.byRegime.filter((r) => r.n >= 3);
  if (qualified.length >= 2) {
    const worst = qualified.reduce((w, r) => (r.avgPnlPct < w.avgPnlPct ? r : w));
    cats.regime = { score: clamp(50 + worst.avgPnlPct * 15), why: qualified.map((r) => `${r.regime} 평균 ${pctStr(r.avgPnlPct)}(${r.n}건)`).join(', ') };
    if (worst.avgPnlPct < -1) guides.push({ cat: 'regime', level: 'bad', text: `${worst.regime}에서 평균 ${pctStr(worst.avgPnlPct)}로 약해요. 이 상황에서는 전략을 쉬게 하는 규칙을 검토해 볼 만해요(코드 수정 필요 — AI 상담이 개발 요청서를 정리해 줘요).` });
  }
  breakdowns.byRegime.forEach((r) => M('regime', `${r.regime} 평균 손익 (${r.n}건, 승률 ${r.winRate}%)`, r.avgPnlPct, '%', 'high'));
  if (!breakdowns.byRegime.length) M('regime', '시장 상황 기록', null, '', null, { note: '데이터 쌓는 중 — 이번 업데이트부터 매매마다 시장 상황을 기록해요' });

  // 📈 학습·개선
  if (input.learnable) {
    const exps = input.experiments || [];
    const judged = exps.filter((e) => e.status === 'judged' && e.result && ['improved', 'worse', 'no-effect'].includes(e.result.verdict));
    const imp = judged.filter((e) => e.result.verdict === 'improved').length;
    const wor = judged.filter((e) => e.result.verdict === 'worse').length;
    if (judged.length) cats.learning = { score: clamp(50 + ((imp - wor) / judged.length) * 50), why: `채점된 실험 ${judged.length}개 중 좋아짐 ${imp}, 나빠짐 ${wor}` };
    M('learning', '채점된 실험', judged.length, '개', null);
    M('learning', '좋아짐', imp, '개', 'high');
    M('learning', '나빠짐', wor, '개', 'low');
    M('learning', '되돌림', exps.filter((e) => e.result && e.result.rolledBackTo).length, '번', null);
    M('learning', '지금 실험 중', exps.filter((e) => e.status === 'running').length, '개', null);
  }

  // 나눠 보기: 종목별(확정 손익 합), 시간대별(산 시각, KST)
  const bySym = {};
  sells.forEach((s) => {
    const k = s.symbol;
    bySym[k] = bySym[k] || { symbol: k, name: s.name || k, n: 0, pnlPct: 0, pnlAmount: 0, market: s.market || 'KR' };
    bySym[k].n++; bySym[k].pnlPct += pctOfCash(s); bySym[k].pnlAmount += s.pnlAmount || 0;
  });
  const symList = Object.values(bySym).map((x) => Object.assign(x, { pnlPct: r2(x.pnlPct), pnlAmount: Math.round(x.pnlAmount) }));
  breakdowns.topSymbols = symList.slice().sort((a, b) => b.pnlPct - a.pnlPct).filter((x) => x.pnlPct > 0).slice(0, 5);
  breakdowns.bottomSymbols = symList.slice().sort((a, b) => a.pnlPct - b.pnlPct).filter((x) => x.pnlPct < 0).slice(0, 5);
  const byHour = {};
  sells.forEach((s) => {
    const b = buys.filter((x) => x.symbol === s.symbol && x.ts < s.ts).sort((a, c) => c.ts - a.ts)[0];
    if (!b) return;
    const h = new Date(b.ts + 9 * 3600000).getUTCHours();
    (byHour[h] = byHour[h] || []).push(s.pnlPct || 0);
  });
  breakdowns.byBuyHour = Object.keys(byHour).sort((a, b) => a - b).map((h) => ({ hour: Number(h), n: byHour[h].length, avgPnlPct: r2(avg(byHour[h])) }));

  return { cats, metrics, guides, breakdowns, sells: sells.length, buys: buys.length, realizedPct: r2(realized), confidence: sells.length < 10 ? '낮음' : sells.length < 30 ? '보통' : '높음' };
}

// 수익성 점수는 기준선과 비교해야 해서, 기준선 분석 결과(확정 손익)를 받은 뒤에 매겨요.
export function scoreProfit(analysis, baselineRealizedPct, isBaseline) {
  if (isBaseline) return { score: 50, why: `기준선 자신이라 비교 기준점(50점)이에요. 확정 손익 ${pctStr(analysis.realizedPct)}.` };
  if (typeof baselineRealizedPct !== 'number' || analysis.sells < 1) return null;
  const diff = analysis.realizedPct - baselineRealizedPct;
  return { score: clamp(50 + diff * 5), why: `확정 손익 ${pctStr(analysis.realizedPct)} vs 기준선 ${pctStr(baselineRealizedPct)} → ${diff >= 0 ? '+' : ''}${r2(diff)}%p` };
}

// 예전 이름 그대로 쓰는 곳(채점표 목록)을 위한 간단 버전
export function scoreStrategy(input) {
  const a = analyzeStrategy(input);
  return { cats: a.cats, sells: a.sells, buys: a.buys, confidence: a.confidence, realizedPct: a.realizedPct, analysis: a };
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
