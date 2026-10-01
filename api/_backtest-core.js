// /api/_backtest-core.js
// backtest.js(고정 프리셋 비교)와 backtest-evolve.js(진화형 탐색)가 공유하는 핵심 로직입니다.
// 과거 일봉 데이터 조회 + 팩터 계산 + 한 전략(가중치/청산/사이징 조합)의 시뮬레이션을 담당합니다.

import { kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';

export const STARTING_CASH = 10_000_000;
export const FEE_PCT = 0.25; // 매도 시 대략적인 왕복 비용(수수료+세금) 반영

function todayYYYYMMDD() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function ymdMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export async function fetchSymbolHistory(token, symbol, lookbackDays) {
  const rows = [];
  let endDate = todayYYYYMMDD();
  const startBoundary = ymdMinus(lookbackDays);
  for (let page = 0; page < 12; page++) {
    const url =
      `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` +
      `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}` +
      `&FID_INPUT_DATE_1=${startBoundary}&FID_INPUT_DATE_2=${endDate}` +
      `&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
    const data = await fetchKisJson(url, kisHeaders(token, 'FHKST03010100'));
    if (!data || !Array.isArray(data.output2) || data.output2.length === 0) break;
    const page_rows = data.output2.filter((r) => r.stck_bsop_date);
    if (page_rows.length === 0) break;
    page_rows.forEach((r) => rows.push({
      date: r.stck_bsop_date,
      open: num(r.stck_oprc), high: num(r.stck_hgpr), low: num(r.stck_lwpr),
      close: num(r.stck_clpr), volume: num(r.acml_vol)
    }));
    const earliest = page_rows[page_rows.length - 1].stck_bsop_date;
    if (earliest <= startBoundary || page_rows.length < 90) break;
    endDate = String(Number(earliest) - 1);
  }
  const uniq = new Map();
  rows.forEach((r) => uniq.set(r.date, r));
  return Array.from(uniq.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// "상세분석"에서 직접 고른 시작일~종료일(YYYYMMDD)로 국내 종목 과거 일봉을 가져옵니다.
// (fetchSymbolHistory는 "오늘 기준 최근 N일"만 가능해서, 과거 특정 구간을 보고 싶을 때는 이 함수를 씁니다.)
export async function fetchSymbolHistoryRange(token, symbol, startYmd, endYmd) {
  const rows = [];
  let curEnd = endYmd;
  for (let page = 0; page < 20; page++) {
    const url =
      `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` +
      `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}` +
      `&FID_INPUT_DATE_1=${startYmd}&FID_INPUT_DATE_2=${curEnd}` +
      `&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
    const data = await fetchKisJson(url, kisHeaders(token, 'FHKST03010100'));
    if (!data || !Array.isArray(data.output2) || data.output2.length === 0) break;
    const pageRows = data.output2.filter((r) => r.stck_bsop_date);
    if (pageRows.length === 0) break;
    pageRows.forEach((r) => rows.push({
      date: r.stck_bsop_date,
      open: num(r.stck_oprc), high: num(r.stck_hgpr), low: num(r.stck_lwpr),
      close: num(r.stck_clpr), volume: num(r.acml_vol)
    }));
    const earliest = pageRows[pageRows.length - 1].stck_bsop_date;
    if (earliest <= startYmd || pageRows.length < 90) break;
    curEnd = String(Number(earliest) - 1);
  }
  const uniq = new Map();
  rows.forEach((r) => { if (r.date >= startYmd && r.date <= endYmd) uniq.set(r.date, r); });
  return Array.from(uniq.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// 해외 종목의 시작일~종료일(YYYYMMDD) 과거 일봉. BYMD를 과거로 옮겨가며 페이지네이션하는데,
// 이 방식이 KIS 공식 문서로 100% 확인된 건 아니라서(chart-data.js와 동일한 전제) best-effort입니다 —
// 요청한 기간보다 적게 나와도 에러 없이 나온 만큼만으로 백테스트를 진행합니다.
export async function fetchOverseasHistoryRange(token, excd, symbol, startYmd, endYmd) {
  const rows = [];
  let bymd = endYmd;
  for (let page = 0; page < 20; page++) {
    const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/dailyprice?AUTH=&EXCD=${excd}&SYMB=${symbol}&GUBN=0&BYMD=${bymd}&MODP=1`;
    const data = await fetchKisJson(url, kisHeaders(token, 'HHDFS76240000'));
    if (!data || !Array.isArray(data.output2) || data.output2.length === 0) break;
    const pageRows = data.output2.filter((r) => r.xymd);
    if (pageRows.length === 0) break;
    pageRows.forEach((r) => rows.push({
      date: r.xymd, open: num(r.open), high: num(r.high), low: num(r.low),
      close: num(r.clos), volume: num(r.tvol)
    }));
    const earliest = pageRows[pageRows.length - 1].xymd;
    if (earliest <= startYmd || pageRows.length < 90) break;
    bymd = earliest;
  }
  const uniq = new Map();
  rows.forEach((r) => { if (r.date >= startYmd && r.date <= endYmd) uniq.set(r.date, r); });
  return Array.from(uniq.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// 국내 종목의 외국인 순매수 수급 데이터를 "시도"해봅니다 (한계점 ②).
// KIS 문서로 과거 며칠치까지 주는지 100% 확인은 못 했어요 — 당일만 줄 수도, 최근 며칠을 줄 수도 있습니다.
// 그래서 실패하거나 짧게만 와도 에러 없이 빈 배열을 반환하고, 호출한 쪽에서 "일부 날짜만 있는 팩터"로
// 안전하게 다룹니다(없는 날짜는 그냥 그 팩터만 비워두고 나머지 팩터로 계산).
export async function fetchInvestorTrend(token, symbol) {
  try {
    const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
    const data = await fetchKisJson(url, kisHeaders(token, 'FHKST01010900'));
    if (!data || !Array.isArray(data.output)) return [];
    return data.output
      .filter((r) => r.stck_bsop_date)
      .map((r) => ({ date: r.stck_bsop_date, foreignNet: num(r.frgn_ntby_qty) }));
  } catch (e) {
    return [];
  }
}

export function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function computeRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// 각 날짜별로 "그날까지의 데이터만" 사용해서 지표/팩터를 계산합니다(미래 데이터를 미리 보는 lookahead 방지).
// supplyByDate: 선택적 Map(date -> foreignNet) — "상세분석"에서 외국인 수급 반영을 시도할 때만 넘겨줍니다.
// 수급값은 그 자체로는 스케일을 알 수 없어서, 최근 20일 치의 절대값 평균 대비 비율로 정규화합니다(미래 데이터 미리보기 없이).
export function annotateWithFactors(rows, supplyByDate) {
  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);
  const supplyVals = supplyByDate ? rows.map((r) => {
    const v = supplyByDate.get(r.date);
    return typeof v === 'number' && !Number.isNaN(v) ? v : null;
  }) : null;

  return rows.map((row, i) => {
    const changePct = i > 0 && closes[i - 1] ? ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100 : null;
    let sma20 = null, avgVol20 = null, rsi14 = null;
    if (i >= 19) {
      const windowCloses = closes.slice(i - 19, i + 1);
      sma20 = windowCloses.reduce((a, b) => a + b, 0) / 20;
      const windowVols = volumes.slice(i - 19, i + 1).filter((v) => v !== null);
      avgVol20 = windowVols.length ? windowVols.reduce((a, b) => a + b, 0) / windowVols.length : null;
    }
    if (i >= 14) rsi14 = computeRSI(closes.slice(0, i + 1), 14);

    const factors = { momentum: null, volume: null, trend: null, rsi: null, supply: null };
    if (changePct !== null) factors.momentum = clip(changePct / 10, -1, 1);
    if (avgVol20 && row.volume !== null) factors.volume = clip((row.volume / avgVol20) - 1, -1, 1);
    if (sma20) factors.trend = clip(((row.close - sma20) / sma20) * 5, -1, 1);
    if (rsi14 !== null) factors.rsi = clip((50 - rsi14) / 50, -1, 1);

    if (supplyVals && supplyVals[i] !== null) {
      const windowStart = Math.max(0, i - 19);
      const windowAbs = supplyVals.slice(windowStart, i + 1).filter((v) => v !== null).map((v) => Math.abs(v));
      const avgAbs = windowAbs.length ? windowAbs.reduce((a, b) => a + b, 0) / windowAbs.length : 0;
      if (avgAbs > 0) factors.supply = clip(supplyVals[i] / avgAbs, -1, 1);
    }

    return Object.assign({}, row, { changePct, sma20, avgVol20, rsi14, factors });
  });
}

// ---- 시장 상황(regime) 분류: 상승/하락/횡보(trend) × 평온/고변동(volatility) = 최대 6개 구간 ----
// 전종목(symbolMaps)의 "그날 등락률" 평균을 시장 전체의 대리 지표로 씁니다(코스피 지수 데이터를 따로
// 안 가져와도 되게). 과거 20일 누적수익률로 추세를, 과거 20일 등락률의 표준편차로 변동성을 판단합니다.
// 둘 다 "그날까지의 데이터만" 사용해서 미래를 미리 보지 않습니다(annotateWithFactors와 같은 원칙).
// 임계값(4%, 1.5%)은 엄밀한 통계적 기준이 아니라 합리적인 근사치입니다.
export const REGIME_LABELS = ['bull-calm', 'bull-turbulent', 'sideways-calm', 'sideways-turbulent', 'bear-calm', 'bear-turbulent'];

export function classifyRegimeByDate(symbolMaps, dates) {
  const symbols = Object.keys(symbolMaps);
  const avgReturnByDate = dates.map((date) => {
    let sum = 0, count = 0;
    symbols.forEach((s) => {
      const row = symbolMaps[s].get(date);
      if (row && row.changePct !== null && row.changePct !== undefined) { sum += row.changePct; count++; }
    });
    return count ? sum / count : null;
  });

  const regimeByDate = new Map();
  for (let i = 0; i < dates.length; i++) {
    let label = 'sideways-calm'; // 데이터가 부족한 초반 구간의 기본값(중립)
    if (i >= 19) {
      const window = avgReturnByDate.slice(i - 19, i + 1).filter((v) => v !== null);
      if (window.length >= 10) {
        const cumReturn = window.reduce((a, b) => a + b, 0); // 대략 20일 누적수익률(%)
        const mean = cumReturn / window.length;
        const variance = window.reduce((a, b) => a + (b - mean) * (b - mean), 0) / window.length;
        const stddev = Math.sqrt(variance);

        const trend = cumReturn > 4 ? 'bull' : (cumReturn < -4 ? 'bear' : 'sideways');
        const vol = stddev > 1.5 ? 'turbulent' : 'calm';
        label = `${trend}-${vol}`;
      }
    }
    regimeByDate.set(dates[i], label);
  }
  return regimeByDate;
}

export function scoreForStrategy(factors, weights) {
  const parts = ['momentum', 'volume', 'trend', 'rsi', 'supply'];
  let sum = 0;
  for (const k of parts) {
    if (factors[k] === null || factors[k] === undefined || !weights[k]) continue;
    sum += factors[k] * weights[k];
  }
  return sum;
}

// 한 전략(가중치+청산+사이징+시장필터 조합)을 과거 데이터 위에서 시뮬레이션합니다.
// symbolMaps: { symbol: Map(date -> annotatedRow) }, dates: 정렬된 전체 거래일 배열
// opts.startingCash: 시작 자본 override(해외 종목은 원화 천만원 기준이 안 맞아서 "상세분석"에서 씀)
// opts.includeDetails: true면 다운샘플 없는 전체 자산곡선 + 매매 하나하나의 진입/청산 상세를 같이 반환
export function runBacktest(strategy, symbolMaps, dates, opts = {}) {
  const startingCash = opts.startingCash || STARTING_CASH;
  let cash = startingCash;
  const positions = {};
  const trades = []; // { symbol, pnlPct, days, factorAtEntry }
  const equityCurve = [];
  let daysWithPosition = 0;

  for (const date of dates) {
    if (Object.keys(positions).length > 0) daysWithPosition++;

    // 1) 보유 종목 청산 체크
    for (const symbol of Object.keys(positions)) {
      const row = symbolMaps[symbol].get(date);
      if (!row || row.close === null) continue;
      const pos = positions[symbol];
      pos.peakPrice = Math.max(pos.peakPrice, row.close);
      let exit = false;
      const pnlPct = ((row.close - pos.entryPrice) / pos.entryPrice) * 100;
      if (strategy.exit.type === 'trailing') {
        const dropFromPeak = ((row.close - pos.peakPrice) / pos.peakPrice) * 100;
        if (dropFromPeak <= -strategy.exit.trailingPct) exit = true;
      } else {
        if (pnlPct <= -strategy.exit.stopLossPct) exit = true;
        else if (pnlPct >= strategy.exit.takeProfitPct) exit = true;
      }
      if (exit) {
        const proceeds = pos.qty * row.close * (1 - FEE_PCT / 100);
        cash += proceeds;
        trades.push({
          symbol, pnlPct: Math.round(pnlPct * 100) / 100, entryFactors: pos.entryFactors,
          entryDate: pos.entryDate, entryPrice: pos.entryPrice,
          exitDate: date, exitPrice: row.close, qty: pos.qty,
          pnlAmount: Math.round(proceeds - pos.qty * pos.entryPrice)
        });
        delete positions[symbol];
      }
    }

    // 2) 시장상황 필터
    // regimeFilter가 문자열이면(예: "bull-calm") opts.regimeByDate로 분류해둔 그날의 구간과 정확히
    // 일치할 때만 신규 매수를 허용합니다(구간별 진화 탐색이 쓰는 방식). 보유 종목 청산(위 1번)은
    // 구간과 무관하게 항상 그대로 진행되므로, 날짜를 건너뛰지 않고도(포지션 추적이 끊기지 않고도) 안전합니다.
    // regimeFilter가 true(기존 방식)면 그날 전체 종목의 등락 비율로 간단히 판단합니다.
    let allowBuy = true;
    if (typeof strategy.regimeFilter === 'string' && opts.regimeByDate) {
      allowBuy = opts.regimeByDate.get(date) === strategy.regimeFilter;
    } else if (strategy.regimeFilter === true) {
      const changes = [];
      Object.keys(symbolMaps).forEach((s) => {
        const r = symbolMaps[s].get(date);
        if (r && r.changePct !== null && r.changePct !== undefined) changes.push(r.changePct);
      });
      if (changes.length) {
        const posRatio = changes.filter((c) => c > 0).length / changes.length;
        if (posRatio < 0.4) allowBuy = false;
      }
    }

    // 3) 신규 매수
    if (allowBuy) {
      const slots = strategy.sizing.maxPositions - Object.keys(positions).length;
      if (slots > 0) {
        const candidates = [];
        Object.keys(symbolMaps).forEach((s) => {
          if (positions[s]) return;
          const row = symbolMaps[s].get(date);
          if (!row || row.close === null) return;
          const score = scoreForStrategy(row.factors, strategy.weights);
          if (score >= strategy.buyThreshold) candidates.push({ symbol: s, row, score });
        });
        candidates.sort((a, b) => b.score - a.score);
        candidates.slice(0, slots).forEach((c) => {
          const budget = cash * (strategy.sizing.positionPct / 100);
          const qty = Math.floor(budget / c.row.close);
          if (qty < 1) return;
          cash -= qty * c.row.close;
          positions[c.symbol] = { qty, entryPrice: c.row.close, entryDate: date, peakPrice: c.row.close, entryFactors: c.row.factors };
        });
      }
    }

    // 4) 자산 곡선 기록
    let posValue = 0;
    Object.keys(positions).forEach((s) => {
      const row = symbolMaps[s].get(date);
      if (row && row.close !== null) posValue += positions[s].qty * row.close;
    });
    equityCurve.push({ date, equity: cash + posValue });
  }

  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startingCash;
  const totalReturnPct = ((finalEquity - startingCash) / startingCash) * 100;
  let peak = -Infinity, maxDrawdownPct = 0;
  equityCurve.forEach((e) => {
    peak = Math.max(peak, e.equity);
    const dd = ((e.equity - peak) / peak) * 100;
    if (dd < maxDrawdownPct) maxDrawdownPct = dd;
  });

  const closedTrades = trades.length;
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const winRate = closedTrades ? (wins.length / closedTrades) * 100 : null;
  const avgWinPct = wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : null;
  const avgLossPct = losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : null;
  const grossWin = wins.reduce((a, t) => a + Math.max(t.pnlPct, 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + Math.min(t.pnlPct, 0), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : 0); // null = 손실 거래가 없어 계산 불가(무한대에 가까움)
  const timeInMarketPct = dates.length ? (daysWithPosition / dates.length) * 100 : 0;

  const step = Math.max(1, Math.ceil(equityCurve.length / 60));
  const sampledCurve = equityCurve.filter((_, i) => i % step === 0);

  const result = {
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    trades: closedTrades,
    winRate: winRate !== null ? Math.round(winRate * 10) / 10 : null,
    avgWinPct: avgWinPct !== null ? Math.round(avgWinPct * 100) / 100 : null,
    avgLossPct: avgLossPct !== null ? Math.round(avgLossPct * 100) / 100 : null,
    profitFactor: profitFactor !== null ? Math.round(profitFactor * 100) / 100 : null,
    timeInMarketPct: Math.round(timeInMarketPct * 10) / 10,
    finalEquity: Math.round(finalEquity),
    equityCurve: sampledCurve
  };

  if (opts.includeDetails) {
    result.equityCurveFull = equityCurve;
    result.tradeList = trades;
  }

  return result;
}
