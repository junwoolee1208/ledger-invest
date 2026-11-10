// /api/_strategy-sim.js
// 기간 백테스트: "이 전략을 그 기간에 썼다면 얼마나 벌었을까?"를 과거 일봉으로 계산해요. _로 시작해서 Vercel 함수 개수에 안 잡혀요.
// backtest.js의 mode=strategy(기간 백테스트)와 mode=method-search(방법 찾기)가 써요. 계산만 하고 저장소·시세 조회는 하지 않아요.
//
// 분봉이 있으면(토스증권에서 받아 올린 5분 묶음, _minute-data.js) 단타 전략은 실제 장중 흐름대로 계산해요:
//  - 5분마다 실제 매매(auto-trade-check.js)와 같은 "살까?" 함수(_intraday.js intradayBuySignal)·시간 규칙(dayRulesFor)·
//    시장 필터(코스피 분봉으로 marketGate)·재매수 규칙(reentryAllowed)·금액 규칙(sizeByVolatility)을 그대로 써요.
//  - 5분 안의 가격 4개 순서만 모르는 거라, 두 계산(보수적·낙관적)의 차이가 아주 작아져요.
//  - 분봉이 없는 날(토스가 주지 않는 옛날 등)은 아래의 하루 가격 4개 방식으로 계산하고, 결과에 분봉 비율을 표시해요.
//
// 분봉이 없을 때의 한계(화면에도 "추정치"로 표시해요):
//  - 하루 가격 4개(시가·고가·저가·종가)로 장중 흐름을 흉내 내요.
//    하루 안에서 무엇이 먼저였는지 알 수 없어서 두 가지로 계산해 범위로 보여줘요(pathMode).
//    - 보수적(conservative, 기본): 산 날은 산 뒤에 그날 저가를 한 번 더 찍었다고 봐요 → 같은 날 손절·익절이 둘 다 가능하면 손절 먼저.
//      다른 날은 시가→저가→고가→종가. 반등을 확인하고 사는 전략은 바닥을 미리 알 수 없으니 내려오는 길에 산 것으로 계산해요.
//    - 낙관적(optimistic): 양봉은 시가→저가→고가→종가, 음봉은 시가→고가→저가→종가(흔히 쓰는 근사), 산 뒤 저가를 다시 찍지 않아요.
//    두 계산 중 나쁜 쪽을 대표 숫자로 쓰고 범위를 함께 보여줘요. 방법 찾기의 순위도 나쁜 쪽으로 매겨요(좋게 착각하지 않게).
//  - 그 경로 위에서 손절선·익절선·나눠 사기 가격에 닿는지를 실제 매매와 같은 계산(_methods.js levelsOf)으로 판단해요.
//  - 다음 날 시가가 손절선 아래에서 시작하면 손절선이 아니라 시가에 판 것으로 계산해요(밤사이 급락을 그대로 반영).
//  - 시장 필터는 장중 코스피200 대신 "오늘 시가가 어제 종가보다 얼마나 낮게 시작했는지"와 어제까지의 시장 상황으로 판단해요.
//  - 비용은 자동매매와 같은 _costs.js 설정(기본: 토스증권)을 써요.

import { annotateWithFactors, classifyRegimeByDate, scoreForStrategy } from './_backtest-core.js';
import { DEFAULT_COSTS, planBuy, planSell } from './_costs.js';
import { BASE_RISK, COMMON_RULES, SWING_MAX_HOLD_DAYS, STRATEGY_NAMES } from './_strategies.js';
import { normalizeDaytrade } from './_daytrade.js';
import { methodOf, levelsOf, firstBuyShare, newPositionFields, applyAdd, describeMethod, methodGrid } from './_methods.js';
import { FIXED_UNIVERSE, INVERSE_ETF } from './_universe.js';
import { isBearRegime, DIP_NEXTDAY, INVERSE_RULE, marketGate, reentryAllowed, REENTRY } from './_bear.js';
import { dayRulesFor, intradayBuySignal, sizeByVolatility, updateIntradayState } from './_intraday.js';
import { hhmmToMin } from './_daytrade.js';
import { DAY_START_MIN, DAY_END_MIN, BAR_MIN, INDEX_MIN_SYMBOL } from './_minute-data.js';

export const SIM_STRATEGY_IDS = ['daytrade', 'scalp', 'vwap-pullback', 'opening-breakout', 'staged-dip', 'momentum', 'evolved',
  'dip-rebound', 'dip-nextday', 'inverse', 'baseline', 'pullback', 'breakout', 'reversal', 'selective', 'wideswing'];

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- 데이터 준비: 종목별 날짜 → 계산에 필요한 값(어제 종가, 어제 등락률, 20일 평균 변동폭, 어제까지의 팩터) ----
export function prepareData(bars, indexRows) {
  const maps = {};
  const dateSet = new Set();
  for (const sym of Object.keys(bars)) {
    const rows = (bars[sym] || []).filter((r) => r && r.open && r.high && r.low && r.close);
    if (rows.length < 2) continue;
    const ann = annotateWithFactors(rows);
    const m = new Map();
    for (let i = 0; i < ann.length; i++) {
      const row = ann[i];
      const prev = ann[i - 1];
      let avgRange = null;
      if (i >= 5) {
        const win = ann.slice(Math.max(0, i - 20), i);
        avgRange = win.reduce((s, x) => s + ((x.high - x.low) / x.close) * 100, 0) / win.length;
      }
      m.set(row.date, {
        date: row.date, open: row.open, high: row.high, low: row.low, close: row.close, changePct: row.changePct,
        prevClose: prev ? prev.close : null, d1: prev ? prev.changePct : null, avgRange,
        factorsPrev: prev ? prev.factors : null
      });
      dateSet.add(row.date);
    }
    maps[sym] = m;
  }
  // 시장 상황(상승·하락·횡보)은 거래대금 상위 10종목의 흐름으로 분류하고, 판단에는 "어제까지"의 결과만 써요(미래를 보지 않게).
  const allDates = Array.from(dateSet).sort();
  const top = FIXED_UNIVERSE.slice(0, 10).map((u) => u.symbol).filter((s) => maps[s]);
  const regimeMaps = {};
  top.forEach((s) => { regimeMaps[s] = maps[s]; });
  const regimeByDate = classifyRegimeByDate(regimeMaps, allDates);
  // 코스피200(없으면 50종목 평균으로 대신)
  const index = new Map();
  const idxRows = (indexRows || []).filter((r) => r && r.open && r.close);
  if (idxRows.length >= 2) {
    for (let i = 1; i < idxRows.length; i++) {
      const r = idxRows[i], p = idxRows[i - 1];
      index.set(r.date, { open: r.open, close: r.close, prevClose: p.close, chg: (r.close / p.close - 1) * 100, gap: (r.open / p.close - 1) * 100 });
    }
  } else {
    const uni = FIXED_UNIVERSE.map((u) => u.symbol).filter((s) => maps[s]);
    for (const d of allDates) {
      let sc = 0, sg = 0, n = 0;
      uni.forEach((s) => { const r = maps[s].get(d); if (r && r.prevClose) { sc += (r.close / r.prevClose - 1) * 100; sg += (r.open / r.prevClose - 1) * 100; n++; } });
      if (n) index.set(d, { chg: sc / n, gap: sg / n, proxy: true });
    }
  }
  return { maps, allDates, regimeByDate, index, indexIsProxy: !(idxRows.length >= 2) };
}

// ---- 전략별 "언제 살지"(하루 가격으로 흉내 낸 버전) ----
// 반환: null(안 삼) | { atOpen } | { level, dir:'up'|'down', allowOpen, after:'high'|'low'|null }
function entrySpec(id, b, ctx) {
  if (!b.prevClose) return null;
  const pc = b.prevClose;
  const chgAt = (p) => (p / pc - 1) * 100;
  switch (id) {
    case 'daytrade': {
      const dt = ctx.daytrade;
      const level = b.open * (1 + dt.minFromOpenPct / 100);
      return chgAt(level) <= dt.maxChangePct ? { level, dir: 'up' } : null;
    }
    case 'scalp': return { level: pc * 1.005, dir: 'up', allowOpen: true };
    case 'opening-breakout': {
      const lift = Math.max(1, 0.3 * (b.avgRange || 3));
      const level = b.open * (1 + lift / 100);
      return chgAt(level) <= 20 ? { level, dir: 'up' } : null;
    }
    case 'vwap-pullback': {
      // 강했던 종목(어제보다 +4~15%까지 오른 날)이 평균 가격까지 내려왔다가 다시 올라설 때. 평균 체결가는 4개 가격의 평균으로 어림해요.
      if (chgAt(b.high) < 4 || chgAt(b.high) > 15) return null;
      const vwapEst = (b.open + b.high + b.low + b.close) / 4;
      if (b.low > vwapEst) return null;
      return { level: vwapEst * 1.003, dir: 'up' };
    }
    case 'staged-dip': {
      const level = b.open * 0.98;
      return chgAt(level) >= -8 ? { level, dir: 'down' } : null;
    }
    case 'dip-rebound': {
      // 시가보다 -3% 넘게 빠진 날. 보수적 계산은 바닥을 미리 알 수 없으니 -3% 지점에서 +1% 위(내려오는 길)에 산 것으로,
      // 낙관적 계산은 실제 저가에서 +1% 반등할 때 산 것으로 봐요.
      if (b.low > b.open * 0.97) return null;
      if (ctx.pathMode === 'optimistic') { const lv = b.low * 1.01; return chgAt(lv) >= -15 ? { level: lv, dir: 'up', after: 'low' } : null; }
      const level = b.open * 0.97 * 1.01;
      return chgAt(level) >= -15 ? { level, dir: 'down' } : null;
    }
    case 'dip-nextday': {
      // 어제 -5% 넘게 빠지고, 오늘 시가 위·저가보다 1% 위에서 끝난 날 종가에 사요(장중 정보를 미리 쓰지 않게 종가로 계산).
      if (typeof b.d1 !== 'number' || b.d1 > DIP_NEXTDAY.maxD1) return null;
      return b.close >= b.open && b.close >= b.low * DIP_NEXTDAY.bounce && chgAt(b.close) >= DIP_NEXTDAY.minChangePct ? { atClose: true } : null;
    }
    case 'momentum': return { level: pc * 1.01, dir: 'up', allowOpen: true };
    case 'pullback': return chgAt(b.open) <= 2 ? { level: pc * 1.001, dir: 'up', allowOpen: true, maxPrice: pc * 1.02 } : null;
    case 'breakout': return { level: pc * 1.04, dir: 'up', allowOpen: true };
    case 'reversal': return { level: pc * 0.98, dir: 'down', allowOpen: true, minPrice: pc * 0.94 };
    case 'selective': return { level: pc * 1.025, dir: 'up', allowOpen: true };
    case 'wideswing': return { level: pc * 1.015, dir: 'up', allowOpen: true };
    case 'baseline': return { atOpen: true };
    case 'evolved': {
      const s = ctx.evolved;
      if (!s || !b.factorsPrev) return null;
      return scoreForStrategy(b.factorsPrev, s.weights) >= s.buyThreshold ? { atOpen: true } : null;
    }
    case 'inverse': {
      const idxPrev = ctx.indexPrev;
      return isBearRegime(ctx.regimePrev) && idxPrev && idxPrev.chg <= INVERSE_RULE.maxIndexChangePct ? { atOpen: true } : null;
    }
    default: return null;
  }
}

// 전략별 규칙 묶음(실제 매매 정의와 같은 값)
function strategyProfile(id, opts) {
  const dt = normalizeDaytrade(opts.daytrade);
  const p = { id, intraday: false, gate: 'up', maxPositions: null, maxHold: null, sizeVol: false, etf: false, noRiskCut: false, candidates: null };
  const day = ['daytrade', 'scalp', 'vwap-pullback', 'opening-breakout', 'staged-dip', 'dip-rebound'];
  if (day.includes(id)) p.intraday = true;
  if (['momentum', 'pullback', 'breakout', 'selective', 'wideswing', 'evolved', 'dip-nextday', 'inverse'].includes(id)) p.maxHold = SWING_MAX_HOLD_DAYS;
  p.gate = { momentum: 'swing', pullback: 'swing', breakout: 'swing', selective: 'swing', wideswing: 'swing', evolved: 'swing',
    reversal: 'dip', 'staged-dip': 'dip', 'dip-nextday': 'dip', 'dip-rebound': 'bear', inverse: 'none', baseline: 'none' }[id] || 'up';
  if (id === 'opening-breakout' || id === 'vwap-pullback') { p.sizeVol = true; p.maxPositions = 4; }
  if (id === 'dip-rebound') { p.sizeVol = true; p.maxPositions = 3; }
  if (id === 'staged-dip') p.maxPositions = 4;
  if (id === 'dip-nextday') { p.maxPositions = 5; p.maxHold = DIP_NEXTDAY.maxHoldDays; }
  if (id === 'inverse') { p.maxPositions = 1; p.maxHold = INVERSE_RULE.maxHoldDays; p.etf = true; p.noRiskCut = true; p.candidates = [INVERSE_ETF.symbol]; }
  // 위험 규칙
  let risk;
  if (id === 'daytrade') risk = { positionPct: dt.positionPct, stopLossPct: dt.stopLossPct, takeProfitPct: dt.takeProfitPct, maxTradesPerDay: dt.maxBuysPerDay };
  else if (id === 'opening-breakout' || id === 'vwap-pullback') risk = { positionPct: 10, stopLossPct: 2, takeProfitPct: 4, maxTradesPerDay: 6 };
  else if (id === 'dip-rebound') risk = { positionPct: 10, stopLossPct: 2, takeProfitPct: 3, maxTradesPerDay: 4 };
  else if (id === 'evolved' && opts.evolved) {
    const s = opts.evolved, ex = s.exit || {}, sz = s.sizing || {};
    const stop = ex.type === 'trailing' ? (ex.trailingPct || 8) : (ex.stopLossPct || 5);
    const take = ex.type === 'trailing' ? stop * 2.5 : (ex.takeProfitPct || 10);
    risk = { positionPct: clamp(sz.positionPct || 5, 1, 30), stopLossPct: clamp(stop, 1, 30), takeProfitPct: clamp(take, 1, 60), maxTradesPerDay: clamp(sz.maxPositions || 3, 1, 10) };
  } else risk = Object.assign({}, BASE_RISK[id] || BASE_RISK.baseline);
  if (opts.riskOverrides && opts.riskOverrides[id]) Object.assign(risk, opts.riskOverrides[id]);
  p.risk = risk;
  p.dtCooldown = dt.cooldownMin;
  return p;
}

function gateOk(kind, idx, regimePrev) {
  if (kind === 'none') return true;
  const gap = idx && typeof idx.gap === 'number' ? idx.gap : 0;
  if (kind === 'bear') return isBearRegime(regimePrev) || gap <= -1;
  if (kind === 'dip') return gap > -2;
  if (gap <= -1) return false;
  if (kind === 'swing' && isBearRegime(regimePrev)) return false;
  return true;
}

// 하루 가격 경로(4점). 보수적: 항상 시가→저가→고가→종가 / 낙관적: 양봉은 시가→저가→고가→종가, 음봉은 시가→고가→저가→종가
function pathOf(b, mode) {
  if (mode === 'optimistic' && b.close < b.open) return { pts: [b.open, b.high, b.low, b.close], hiIdx: 1, loIdx: 2 };
  return { pts: [b.open, b.low, b.high, b.close], hiIdx: 2, loIdx: 1 };
}

// 경로에서 처음 사는 지점을 찾아요. 반환 { price, rest:[이후 점들] } 또는 null
function findEntry(spec, b, mode) {
  const { pts, hiIdx, loIdx } = pathOf(b, mode);
  if (spec.atOpen) return { price: b.open, rest: pts.slice(1) };
  if (spec.atClose) return { price: b.close, rest: [] };
  const okPrice = (p) => (spec.maxPrice ? p <= spec.maxPrice : true) && (spec.minPrice ? p >= spec.minPrice : true);
  if (spec.allowOpen && !spec.after) {
    const hit = spec.dir === 'up' ? b.open >= spec.level : b.open <= spec.level;
    if (hit) return okPrice(b.open) ? { price: b.open, rest: pts.slice(1) } : null;
  }
  const startSeg = spec.after === 'high' ? hiIdx : spec.after === 'low' ? loIdx : 0;
  for (let i = startSeg; i < pts.length - 1; i++) {
    const a = pts[i], c = pts[i + 1];
    const crosses = spec.dir === 'up' ? (a < spec.level && c >= spec.level) : (a > spec.level && c <= spec.level);
    if (!crosses) continue;
    if (!okPrice(spec.level)) return null;
    // 보수적 계산: 저가를 지난 뒤 올라가며 샀다면, 산 뒤에 그 저가를 한 번 더 찍었다고 봐요(같은 날 손절이 먼저).
    const rest = mode !== 'optimistic' && spec.dir === 'up' && i >= loIdx ? [b.low].concat(pts.slice(i + 1)) : pts.slice(i + 1);
    return { price: spec.level, rest };
  }
  return null;
}

// 한 구간(from→to)을 움직이며 손절·익절·나눠 팔기·따라가는 손절·더 사기를 순서대로 처리해요.
// gap=true면 가격이 건너뛴 것(밤사이)이라 선에 닿은 모든 일이 "to" 가격에서 일어나요.
function walk(st, from, to, gap) {
  let cur = from;
  if (st.pos && from > (st.pos.peak || 0)) st.pos.peak = from;
  for (let guard = 0; guard < 12 && st.pos; guard++) {
    const L = levelsOf(st.pos, st.m, st.stop, st.take);
    const ev = [];
    if (to < cur) {
      if (L.add !== null && L.addDir === 'down' && L.add < cur && L.add >= to) ev.push({ lv: L.add, k: 'add' });
      if (L.stop !== null && L.stop < cur && L.stop >= to) ev.push({ lv: L.stop, k: 'stop' });
      if (L.trail !== null && L.trail < cur && L.trail >= to) ev.push({ lv: L.trail, k: 'trail' });
      if (gap) { // 이미 선 아래에서 시작
        if (L.stop !== null && to <= L.stop && !ev.some((e) => e.k === 'stop')) ev.push({ lv: L.stop, k: 'stop' });
        if (L.trail !== null && to <= L.trail && !ev.some((e) => e.k === 'trail')) ev.push({ lv: L.trail, k: 'trail' });
      }
      ev.sort((x, y) => y.lv - x.lv);
    } else if (to > cur) {
      if (L.add !== null && L.addDir === 'up' && L.add > cur && L.add <= to) ev.push({ lv: L.add, k: 'add' });
      if (L.partial !== null && L.partial > cur && L.partial <= to) ev.push({ lv: L.partial, k: 'partial' });
      if (L.take !== null && L.take > cur && L.take <= to) ev.push({ lv: L.take, k: 'take' });
      if (gap) {
        if (L.partial !== null && to >= L.partial && !ev.some((e) => e.k === 'partial')) ev.push({ lv: L.partial, k: 'partial' });
        if (L.take !== null && to >= L.take && !ev.some((e) => e.k === 'take')) ev.push({ lv: L.take, k: 'take' });
      }
      ev.sort((x, y) => x.lv - y.lv);
    }
    if (!ev.length) break;
    const e = ev[0];
    const px = gap ? to : e.lv;
    if (e.k === 'add') st.onAdd(px);
    else if (e.k === 'partial') st.onSell('PARTIAL_TAKE', px, st.m.sell.firstFrac);
    else if (e.k === 'take') st.onSell('TAKE_PROFIT', px, 1);
    else if (e.k === 'stop') st.onSell('STOP_LOSS', px, 1);
    else st.onSell('TRAIL_STOP', px, 1);
    if (!gap) cur = e.lv;
    if (e.k === 'add' && st.pos && gap) break; // 건너뛴 가격에선 한 번만 더 사요
  }
  if (st.pos && to > (st.pos.peak || 0)) st.pos.peak = to;
}

// ---- 분봉(5분 묶음)으로 단타 하루 계산 ----
const PT_MIN = [0, 1, 3, 4]; // 5분 묶음 안의 가격 4개(시가→…→종가)가 묶음 시작에서 몇 분째에 나왔다고 볼지
// 5분 묶음의 가격 순서(pathOf와 같은 규칙: 보수적은 시가→저가→고가→종가, 낙관적 음봉은 시가→고가→저가→종가)
function barPts(bar, mode) {
  return mode === 'optimistic' && bar.c < bar.o ? [bar.o, bar.h, bar.l, bar.c] : [bar.o, bar.l, bar.h, bar.c];
}
const INTRADAY_IDS = ['daytrade', 'scalp', 'vwap-pullback', 'opening-breakout', 'staged-dip', 'dip-rebound'];

// 그날 후보의 80% 이상에 분봉이 있어야 분봉으로 계산해요(일부만 있으면 그 종목들만 사는 쏠림이 생겨서).
function minuteDayOk(data, date, candidates) {
  if (!data.minute) return false;
  let n = 0;
  for (const s of candidates) if (data.minute.has(s, date)) n++;
  return n >= Math.max(1, candidates.length * 0.8);
}

// 코스피 분봉 → 그 시각의 지수 {price, open, changePct}. 전날 분봉이 없으면 null(일봉 기준 필터로 대신해요).
function indexQuoteAt(data, date, prevDate) {
  const bars = data.minute.get(INDEX_MIN_SYMBOL, date);
  const prev = prevDate ? data.minute.get(INDEX_MIN_SYMBOL, prevDate) : null;
  if (!bars || !bars.length || !prev || !prev.length) return null;
  const prevClose = prev[prev.length - 1].c, open = bars[0].o;
  const byT = new Map(bars.map((b) => [b.t, b]));
  let last = bars[0];
  return (t) => {
    const b = byT.get(t);
    if (b) last = b;
    return { price: last.o, open, changePct: (last.o / prevClose - 1) * 100 };
  };
}

// 하루 동안 "살 만한 순간" 목록. 계좌 상태와 상관없는 부분(가격·신호·시간·시장 필터)이라 한 번 계산해 두고
// 방법 찾기처럼 같은 전략을 여러 번 돌릴 때 다시 써요. 같은 종목은 5분에 한 번만 남겨요(계산량 줄이기).
function daySignals(id, data, date, c) {
  const key = id + '|' + c.pathMode + '|' + JSON.stringify(c.daytrade || null);
  if (!data._sig) data._sig = new Map();
  let cache = data._sig.get(key);
  if (!cache) { cache = new Map(); data._sig.set(key, cache); }
  if (cache.has(date)) return cache.get(date);
  const rules = dayRulesFor(id, c.daytrade);
  const startMin = hhmmToMin(rules.buyStart), endMin = hhmmToMin(rules.buyEnd);
  const idxAt = indexQuoteAt(data, date, c.prevDate);
  const gateMemo = new Map();
  const gateAt = (t) => {
    if (!gateMemo.has(t)) gateMemo.set(t, idxAt ? marketGate(c.gateKind, idxAt(t), c.regimePrev).ok : gateOk(c.gateKind, c.idxDaily, c.regimePrev));
    return gateMemo.get(t);
  };
  const iState = { date, ranges: {}, touches: {} };
  const events = [], syms = {};
  c.candidates.forEach((sym, ci) => {
    const bars = data.minute.get(sym, date);
    const b = data.maps[sym] && data.maps[sym].get(date);
    if (!bars || !bars.length || !b || !b.prevClose) return;
    if (Math.abs(bars[0].o / b.open - 1) > 0.03) return; // 분봉과 일봉 시가가 크게 다르면(수정주가 차이 등) 그 종목은 빼요
    syms[sym] = { byT: new Map(bars.map((x) => [x.t, x])), lastClose: bars[bars.length - 1].c };
    const open = bars[0].o, pc = b.prevClose;
    let hi = -Infinity, lo = Infinity, pv = 0, vol = 0, lastEvT = -1;
    for (const bar of bars) {
      const pts = barPts(bar, c.pathMode);
      const typ = (bar.o + bar.h + bar.l + bar.c) / 4;
      for (let k = 0; k < 4; k++) {
        const price = pts[k], minute = bar.t + PT_MIN[k];
        if (price > hi) hi = price;
        if (price < lo) lo = price;
        const fv = bar.v * (k + 1) / 4; // 평균 체결가는 이 5분의 거래량도 지나온 만큼만 넣어요
        const vwap = vol + fv > 0 ? (pv + typ * fv) / (vol + fv) : price;
        const q = { symbol: sym, price, open, high: hi, low: lo, vwap, changePct: (price / pc - 1) * 100 };
        if (id === 'opening-breakout' || id === 'vwap-pullback') updateIntradayState(iState, [q], minute, date, minute * 60000);
        if (minute < startMin || minute >= endMin || bar.t === lastEvT) continue;
        if (!intradayBuySignal(id, q, minute, iState, minute * 60000, c.daytrade)) continue;
        if (!gateAt(bar.t)) continue;
        events.push({ t: bar.t, k, ci, sym, minute, price, q });
        lastEvT = bar.t;
      }
      pv += typ * bar.v; vol += bar.v;
    }
  });
  events.sort((a, b) => a.t - b.t || a.ci - b.ci || a.k - b.k);
  const out = { events, syms };
  cache.set(date, out);
  return out;
}

// ---- 한 전략을 기간 동안 돌려요 ----
// data: prepareData 결과, dates: 시뮬레이션할 날짜(오름차순), opts: { costs, startingCash, method, daytrade, evolved, riskOverrides, keepTrades }
export function simulateStrategy(id, data, dates, opts) {
  const costs = opts.costs || DEFAULT_COSTS;
  const startCash = opts.startingCash || 10_000_000;
  const prof = strategyProfile(id, opts);
  const m = opts.method || methodOf(id, opts.methods);
  const risk = prof.risk;
  const pathMode = opts.pathMode === 'optimistic' ? 'optimistic' : 'conservative';
  const ctxBase = { daytrade: normalizeDaytrade(opts.daytrade), evolved: opts.evolved || null, pathMode };
  const candidates = prof.candidates || FIXED_UNIVERSE.map((u) => u.symbol);
  const sellOpts = prof.etf ? { etf: true } : undefined;
  let cash = startCash;
  const positions = {};
  const trades = [];
  const equity = [];
  let fees = 0, buysCount = 0, minuteDays = 0;
  const allIdx = new Map(data.allDates.map((d, i) => [d, i]));

  if (id === 'evolved' && !opts.evolved) return { id, skipped: '진화형 탐색 결과가 아직 없어서 계산할 수 없어요.' };

  for (const date of dates) {
    const di = allIdx.get(date);
    const prevDate = di > 0 ? data.allDates[di - 1] : null;
    const regimePrev = prevDate ? data.regimeByDate.get(prevDate) : null;
    const idx = data.index.get(date) || null;
    const ctx = Object.assign({}, ctxBase, { regimePrev, indexPrev: prevDate ? data.index.get(prevDate) : null });
    let realized = 0;

    const sellPos = (sym, pos, side, price, frac) => {
      const qty = frac >= 1 ? pos.qty : Math.max(1, Math.floor(pos.qty * frac));
      const sell = planSell(costs, 'KR', qty, price, sellOpts);
      const basis = pos.costBasis * (qty / pos.qty);
      const pnl = sell.proceeds - basis;
      cash += sell.proceeds; fees += sell.fee; realized += pnl;
      trades.push({ symbol: sym, side, entryDate: pos.entryDate, exitDate: date, entryPrice: r2(pos.firstPrice), exitPrice: r2(price), qty,
        pnlAmount: Math.round(pnl), pnlPct: r2((pnl / basis) * 100) });
      if (qty >= pos.qty) { delete positions[sym]; return null; }
      const rest = Object.assign(pos, { qty: pos.qty - qty, costBasis: pos.costBasis - basis });
      if (side === 'PARTIAL_TAKE') { rest.partialDone = true; rest.breakeven = true; }
      return rest;
    };
    const makeState = (sym, pos) => {
      const st = { pos, m, stop: pos.stopPct || risk.stopLossPct, take: pos.takePct || risk.takeProfitPct };
      st.onSell = (side, price, frac) => { st.pos = sellPos(sym, st.pos, side, price, frac); };
      st.onAdd = (price) => {
        if (!st.pos.trancheBudget) return;
        const buy = planBuy(costs, 'KR', Math.min(st.pos.trancheBudget, cash), price);
        if (buy.qty < 1) return;
        cash -= buy.total; fees += buy.fee;
        const kind = m.buy.type === 'ladder' ? 'ladder' : 'pyramid';
        const next = applyAdd(st.pos, kind, buy.qty, price, buy.total);
        Object.assign(st.pos, next);
      };
      return st;
    };

    // A) 어제부터 들고 있는 종목(스윙·기준선)
    for (const sym of Object.keys(positions)) {
      const pos = positions[sym];
      const b = data.maps[sym] && data.maps[sym].get(date);
      if (!b) continue;
      pos.heldDays = (pos.heldDays || 0) + 1;
      if (id === 'inverse' && regimePrev && !isBearRegime(regimePrev)) { sellPos(sym, pos, 'SIGNAL_EXIT', b.open, 1); continue; }
      if (prof.maxHold && pos.heldDays >= prof.maxHold) { sellPos(sym, pos, 'MAX_HOLD', b.open, 1); continue; }
      const st = makeState(sym, pos);
      walk(st, b.prevClose || b.open, b.open, true);
      const { pts } = pathOf(b, pathMode);
      for (let i = 0; i < pts.length - 1 && st.pos; i++) walk(st, pts[i], pts[i + 1], false);
      if (st.pos && !prof.intraday && !prof.noRiskCut && prof.maxHold && idx && idx.chg <= COMMON_RULES.riskCutIndexPct && st.pos.cutDate !== date) {
        const rest = sellPos(sym, st.pos, 'RISK_CUT', b.close, 0.5);
        if (rest) rest.cutDate = date;
      }
    }

    // B') 단타 + 분봉이 있는 날: 5분마다 실제 매매와 같은 순서(보유 종목 점검 → 새로 사기)로 계산해요.
    const useMinutes = prof.intraday && minuteDayOk(data, date, candidates);
    if (useMinutes) {
      minuteDays++;
      const sig = daySignals(id, data, date, { pathMode, daytrade: opts.daytrade, candidates, prevDate, regimePrev, idxDaily: idx, gateKind: prof.gate });
      const rules = dayRulesFor(id, opts.daytrade);
      const closeMin = hhmmToMin(rules.closeAt);
      const ownLimit = typeof rules.dailyLossLimitPct === 'number' ? rules.dailyLossLimitPct : COMMON_RULES.dailyLossLimitPct;
      const lossLimitM = startCash * (Math.min(ownLimit, COMMON_RULES.dailyLossLimitPct) / 100);
      const gapMin = rules.cooldownMin || REENTRY.minGapMin;
      const lastSell = {}, lastPx = {};
      let buysM = 0, ei = 0;
      const ev = sig.events;
      // 보유 종목을 5분 묶음의 가격 4개를 따라 움직여요. 청산 시각(15:10)이 되면 그 가격에 정리해요.
      const stepHeld = (sym, bar, fromK) => {
        const pts = barPts(bar, pathMode);
        for (let k = fromK; k < 4 && positions[sym]; k++) {
          const price = pts[k], minute = bar.t + PT_MIN[k];
          const before = trades.length;
          if (minute >= closeMin) sellPos(sym, positions[sym], 'DAY_CLOSE', price, 1);
          else walk(makeState(sym, positions[sym]), lastPx[sym], price, false);
          lastPx[sym] = price;
          if (!positions[sym] && trades.length > before) {
            const tr = trades[trades.length - 1];
            lastSell[sym] = { ts: minute * 60000, side: tr.side, price: tr.exitPrice, pnlPct: tr.pnlPct };
          }
        }
      };
      for (let t = DAY_START_MIN; t < DAY_END_MIN; t += BAR_MIN) {
        for (const sym of Object.keys(positions)) {
          const s = sig.syms[sym], bar = s && s.byT.get(t);
          if (bar) stepHeld(sym, bar, 0);
        }
        while (ei < ev.length && ev[ei].t === t) {
          const e = ev[ei++];
          if (positions[e.sym] || realized <= -lossLimitM || buysM >= risk.maxTradesPerDay) continue;
          if (prof.maxPositions && Object.keys(positions).length >= prof.maxPositions) continue;
          // 오늘 판 종목을 다시 살 때는 "다른 근거"가 있어야 해요(실제 매매와 같은 규칙).
          if (!reentryAllowed(lastSell[e.sym] || null, e.q, e.minute * 60000, gapMin).ok) continue;
          const exposure = Object.values(positions).reduce((s, p) => s + p.costBasis, 0);
          let budget, stopPct = null, takePct = null;
          if (prof.sizeVol) {
            const sz = sizeByVolatility(e.q, cash + exposure, cash);
            if (!sz) continue;
            budget = sz.budget; stopPct = sz.stopPct; takePct = sz.takePct;
          } else budget = cash * (risk.positionPct / 100);
          budget = Math.min(budget, cash);
          const buy = planBuy(costs, 'KR', budget * firstBuyShare(m), e.price);
          if (buy.qty < 1) continue;
          cash -= buy.total; fees += buy.fee; buysM++; buysCount++;
          positions[e.sym] = Object.assign({ qty: buy.qty, avgPrice: e.price, costBasis: buy.total, entryDate: date, heldDays: 0 },
            newPositionFields(m, e.price, budget), stopPct ? { stopPct, takePct } : {});
          lastPx[e.sym] = e.price;
          stepHeld(e.sym, sig.syms[e.sym].byT.get(t), e.k + 1);
        }
      }
      // 분봉이 일찍 끝난 종목 등 남은 건 마지막 가격으로 정리해요.
      Object.keys(positions).forEach((sym) => {
        const px = lastPx[sym] || (sig.syms[sym] && sig.syms[sym].lastClose) || positions[sym].avgPrice;
        sellPos(sym, positions[sym], 'DAY_CLOSE', px, 1);
      });
    }

    // B) 새로 사기
    const lossLimit = startCash * (COMMON_RULES.dailyLossLimitPct / 100);
    let buysToday = 0;
    if (!useMinutes && gateOk(prof.gate, idx, regimePrev)) {
      for (const sym of candidates) {
        if (realized <= -lossLimit) break;
        if (positions[sym]) continue;
        if (prof.maxPositions && Object.keys(positions).length >= prof.maxPositions) break;
        if (buysToday >= risk.maxTradesPerDay) break;
        const b = data.maps[sym] && data.maps[sym].get(date);
        if (!b) continue;
        const spec = entrySpec(id, b, ctx);
        if (!spec) continue;
        const hit = findEntry(spec, b, pathMode);
        if (!hit) continue;
        const exposure = Object.values(positions).reduce((s, p) => s + p.costBasis, 0);
        const accountValue = cash + exposure;
        let stopPct = null, takePct = null, budget;
        if (prof.sizeVol) {
          stopPct = Math.round(clamp((b.avgRange || 3) / 2, 1, 4) * 10) / 10;
          takePct = Math.round(stopPct * 2 * 10) / 10;
          budget = Math.min(cash, accountValue * (Math.min(25, (0.5 / stopPct) * 100) / 100));
        } else budget = cash * (risk.positionPct / 100);
        if (prof.maxHold) budget = Math.max(0, Math.min(budget, accountValue * (COMMON_RULES.swingMaxExposurePct / 100) - exposure));
        budget = Math.min(budget, cash);
        const buy = planBuy(costs, 'KR', budget * firstBuyShare(m), hit.price);
        if (buy.qty < 1) continue;
        cash -= buy.total; fees += buy.fee; buysToday++; buysCount++;
        const pos = Object.assign({ qty: buy.qty, avgPrice: hit.price, costBasis: buy.total, entryDate: date, heldDays: 0 },
          newPositionFields(m, hit.price, budget), stopPct ? { stopPct, takePct } : {});
        positions[sym] = pos;
        const st = makeState(sym, pos);
        let cur = hit.price;
        for (const p of hit.rest) { if (!st.pos) break; walk(st, cur, p, false); cur = p; }
        if (st.pos && prof.intraday) sellPos(sym, st.pos, 'DAY_CLOSE', b.close, 1);
      }
    }
    // 단타가 혹시 남았으면(데이터 빠짐 등) 정리
    if (prof.intraday) Object.keys(positions).forEach((sym) => {
      const b = data.maps[sym] && data.maps[sym].get(date);
      if (b) sellPos(sym, positions[sym], 'DAY_CLOSE', b.close, 1);
    });

    // C) 자산 기록 — 들고 있는 종목은 "지금 팔면 손에 남는 금액"으로 평가
    let value = cash;
    Object.keys(positions).forEach((sym) => {
      const b = data.maps[sym] && data.maps[sym].get(date);
      const px = b ? b.close : positions[sym].avgPrice;
      value += planSell(costs, 'KR', positions[sym].qty, px, sellOpts).proceeds;
    });
    equity.push({ date, equity: Math.round(value) });
  }
  const out = summarizeRun(id, m, startCash, equity, trades, fees, buysCount, opts.keepTrades);
  // 신뢰도: 단타는 분봉으로 계산한 날의 비율로 정해요(80% 이상 'minute', 일부 'mixed', 없으면 'low').
  if (prof.intraday) {
    const share = dates.length ? minuteDays / dates.length : 0;
    out.minuteDays = minuteDays;
    out.minuteShare = r2(share * 100);
    out.reliability = share >= 0.8 ? 'minute' : share > 0 ? 'mixed' : 'low';
  }
  return out;
}

function summarizeRun(id, m, startCash, equity, trades, fees, buys, keepTrades) {
  const final = equity.length ? equity[equity.length - 1].equity : startCash;
  let peak = -Infinity, mdd = 0;
  equity.forEach((e) => { peak = Math.max(peak, e.equity); mdd = Math.min(mdd, (e.equity - peak) / peak * 100); });
  const wins = trades.filter((t) => t.pnlAmount > 0), losses = trades.filter((t) => t.pnlAmount <= 0);
  const avg = (arr) => (arr.length ? r2(arr.reduce((s, t) => s + t.pnlPct, 0) / arr.length) : null);
  const step = Math.max(1, Math.ceil(equity.length / 120));
  const bySide = {};
  trades.forEach((t) => { bySide[t.side] = (bySide[t.side] || 0) + 1; });
  return {
    id, name: STRATEGY_NAMES[id] || id, method: m, methodText: describeMethod(m),
    totalReturnPct: r2((final / startCash - 1) * 100), profit: Math.round(final - startCash), finalEquity: final,
    maxDrawdownPct: r2(mdd), sells: trades.length, buys, winRate: trades.length ? r2((wins.length / trades.length) * 100) : null,
    avgWinPct: avg(wins), avgLossPct: avg(losses), fees: Math.round(fees), bySide,
    equity: equity.filter((_, i) => i % step === 0 || i === equity.length - 1),
    reliability: INTRADAY_IDS.includes(id) ? 'low' : 'mid',
    ...(keepTrades ? { trades: trades.slice(-300).reverse() } : {})
  };
}

// 같은 기간의 비교 기준: 코스피200(또는 50종목 평균)과 50종목을 똑같이 나눠 사서 들고 있었을 때
export function benchmarks(data, dates) {
  if (!dates.length) return null;
  const first = dates[0], last = dates[dates.length - 1];
  let idxPct = null;
  if (!data.indexIsProxy) {
    const a = data.index.get(first), b = data.index.get(last);
    if (a && b) idxPct = r2((b.close / a.prevClose - 1) * 100);
  } else {
    let v = 1;
    dates.forEach((d) => { const x = data.index.get(d); if (x) v *= 1 + x.chg / 100; });
    idxPct = r2((v - 1) * 100);
  }
  const rets = [];
  FIXED_UNIVERSE.forEach((u) => {
    const mp = data.maps[u.symbol];
    if (!mp) return;
    const a = mp.get(first), b = mp.get(last);
    if (a && b && a.open) rets.push(b.close / a.open - 1);
  });
  return { kospi200Pct: idxPct, kospiIsProxy: data.indexIsProxy, equalWeightPct: rets.length ? r2((rets.reduce((s, x) => s + x, 0) / rets.length) * 100) : null };
}

// ---- 방법 찾기: 한 전략에 여러 사는/파는 방법을 붙여 보고, 앞 기간(2/3)에서 고른 방법이 뒤 기간(1/3)에서도 버는지 확인해요 ----
// 과거에 우연히 딱 맞은 조합을 고르는 실수(과최적화)를 막으려고 기간을 나눠요.
export function searchMethods(id, data, dates, opts) {
  const cut = Math.floor(dates.length * 2 / 3);
  const train = dates.slice(0, cut), test = dates.slice(cut);
  if (train.length < 20 || test.length < 10) return { error: '기간이 너무 짧아요. 최소 3개월 이상 골라 주세요.' };
  const current = methodOf(id, opts.methods);
  const grid = methodGrid();
  const key = (mm) => JSON.stringify(mm);
  if (!grid.some((g) => key(g) === key(current))) grid.unshift(current);
  // 두 가지 순서로 계산해서 나쁜 쪽을 써요.
  const worst = (period, mm) => {
    const x = simulateStrategy(id, data, period, Object.assign({}, opts, { method: mm, keepTrades: false }));
    if (x.skipped) return x;
    const y = simulateStrategy(id, data, period, Object.assign({}, opts, { method: mm, keepTrades: false, pathMode: 'optimistic' }));
    return y.totalReturnPct < x.totalReturnPct ? y : x;
  };
  const rows = grid.map((mm) => {
    const a = worst(train, mm);
    const b = worst(test, mm);
    if (a.skipped) return { skipped: a.skipped };
    return {
      method: mm, methodText: describeMethod(mm), isCurrent: key(mm) === key(current),
      train: { returnPct: a.totalReturnPct, mdd: a.maxDrawdownPct, sells: a.sells, winRate: a.winRate },
      test: { returnPct: b.totalReturnPct, mdd: b.maxDrawdownPct, sells: b.sells, winRate: b.winRate }
    };
  });
  if (rows[0] && rows[0].skipped) return { error: rows[0].skipped };
  rows.sort((x, y) => y.train.returnPct - x.train.returnPct);
  // 추천: 앞 기간 순위가 높은 것부터, 뒤 기간에서도 이익이고 거래가 5건 이상인 첫 조합
  const pick = rows.find((r) => r.train.returnPct > 0 && r.test.returnPct > 0 && r.train.sells >= 5) || null;
  const cur = rows.find((r) => r.isCurrent) || null;
  return {
    id, name: STRATEGY_NAMES[id] || id,
    trainPeriod: [train[0], train[train.length - 1]], testPeriod: [test[0], test[test.length - 1]],
    rows, recommended: pick ? pick.method : null, recommendedText: pick ? pick.methodText : null,
    beatsCurrent: !!(pick && cur && !pick.isCurrent && pick.test.returnPct > cur.test.returnPct)
  };
}

export const SIM_NOTES = [
  '단타는 토스증권에서 받아 둔 분봉(5분 묶음)이 있는 날엔 실제 장중 흐름대로, 실제 매매와 같은 판단 규칙으로 계산해요(신뢰도 "분봉").',
  '분봉이 없는 날·스윙은 하루 가격 4개(시가·고가·저가·종가)로 장중 흐름을 흉내 낸 추정치예요.',
  '하루 안에서 무엇이 먼저였는지 알 수 없어서 두 가지 순서로 계산해요. 큰 숫자는 둘 중 나쁜 쪽이고, 옆에 범위를 함께 보여줘요. 실제는 대개 그 범위 안이에요.',
  '단타는 하루 가격만으로 흉내 내기 어려워 범위가 아주 넓을 수 있어요(신뢰도 낮음). 스윙은 비교적 믿을 만해요.',
  '보수적 계산에서 반등을 확인하고 사는 전략은 그날 바닥을 미리 알 수 없어서, 바닥 전 내려오는 길에 산 것으로 계산해요.',
  '다음 날 시가가 손절선 아래에서 시작하면 시가에 판 것으로 계산해요(밤사이 급락 반영).',
  '비용(수수료·세금·체결 오차)은 자동매매와 같은 설정으로 빼요.'
];
