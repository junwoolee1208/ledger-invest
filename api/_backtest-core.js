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

function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
export function annotateWithFactors(rows) {
  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);
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

    const factors = { momentum: null, volume: null, trend: null, rsi: null };
    if (changePct !== null) factors.momentum = clip(changePct / 10, -1, 1);
    if (avgVol20 && row.volume !== null) factors.volume = clip((row.volume / avgVol20) - 1, -1, 1);
    if (sma20) factors.trend = clip(((row.close - sma20) / sma20) * 5, -1, 1);
    if (rsi14 !== null) factors.rsi = clip((50 - rsi14) / 50, -1, 1);

    return Object.assign({}, row, { changePct, sma20, avgVol20, rsi14, factors });
  });
}

export function scoreForStrategy(factors, weights) {
  const parts = ['momentum', 'volume', 'trend', 'rsi'];
  let sum = 0;
  for (const k of parts) {
    if (factors[k] === null || !weights[k]) continue;
    sum += factors[k] * weights[k];
  }
  return sum;
}

// 한 전략(가중치+청산+사이징+시장필터 조합)을 과거 데이터 위에서 시뮬레이션합니다.
// symbolMaps: { symbol: Map(date -> annotatedRow) }, dates: 정렬된 전체 거래일 배열
export function runBacktest(strategy, symbolMaps, dates) {
  let cash = STARTING_CASH;
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
        trades.push({ symbol, pnlPct: Math.round(pnlPct * 100) / 100, entryFactors: pos.entryFactors });
        delete positions[symbol];
      }
    }

    // 2) 시장상황 필터
    let allowBuy = true;
    if (strategy.regimeFilter) {
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

  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : STARTING_CASH;
  const totalReturnPct = ((finalEquity - STARTING_CASH) / STARTING_CASH) * 100;
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

  return {
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
}
