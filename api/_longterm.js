// /api/_longterm.js
// "장기 분산" 전략의 규칙입니다. 시가총액 상위 10개에 나눠 담고 한 달에 한 번만 비중을 맞춰요.
// 손절·익절을 쓰지 않아요(몇 달 이상 들고 가는 전략이라 며칠의 흔들림으로 팔지 않아요).
// 성적은 같은 기간의 코스피200과 비교해요. 시장 전체보다 나은지가 장기 전략의 기준이니까요.
// _로 시작해서 Vercel 함수 개수에 안 잡혀요.

import { kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';
import { safetyReason } from './_picks.js';

export const LONGTERM_STATE_KEY = 'autotrade:longterm:state';
// { lastMonth, lastTryAt, startDate, startIndex, lastIndex, indexDate, rebalances }

const TARGET_COUNT = 10;
const MIN_TARGETS = 5; // 이보다 적게 받았으면 조회 문제일 수 있어서 이번 달 조정을 미뤄요
const LOOK_AT = 15; // 안전 기준에 걸리는 종목이 있을 수 있어서 조금 더 많이 봐요
const DRIFT = 0.2; // 목표 금액에서 20% 넘게 벗어난 종목만 맞춰요(작은 차이로 사고팔면 비용만 나가요)
const CASH_BUFFER = 0.02; // 수수료를 낼 현금으로 2%를 남겨요
const RETRY_MS = 60 * 60 * 1000; // 실패하면 1시간 뒤에 다시 시도해요(1분마다 시세를 부르지 않게)
const REBALANCE_MIN = 10 * 60; // 장 시작 직후는 가격이 크게 흔들려서 10시 뒤에 해요
const INDEX_UPDATE_MIN = 15 * 60; // 코스피200은 장 끝나기 전에 하루 한 번만 적어요

export function rebalanceDue(state, today, minutes, nowMs) {
  const s = state || {};
  return minutes >= REBALANCE_MIN && s.lastMonth !== today.slice(0, 7) && nowMs - (s.lastTryAt || 0) >= RETRY_MS;
}

export function indexUpdateDue(state, today, minutes) {
  return !!state && !!state.lastMonth && state.indexDate !== today && minutes >= INDEX_UPDATE_MIN;
}

// 무엇을 얼마나 사고팔지 계산만 해요. 들고 있는 종목의 가격을 모르면 null(잘못 계산하느니 미뤄요).
// positions: 지금 보유, prices: {종목: 가격}, targets: [{symbol, name, price}]
export function planRebalance(positions, cash, targets, prices) {
  const symbols = Object.keys(positions);
  if (symbols.some((s) => !prices[s])) return null;
  const value = cash + symbols.reduce((sum, s) => sum + positions[s].qty * prices[s], 0);
  const perTarget = (value * (1 - CASH_BUFFER)) / targets.length;
  const targetSet = new Set(targets.map((t) => t.symbol));
  const sells = [], buys = [];
  for (const s of symbols) {
    const held = positions[s].qty * prices[s];
    if (!targetSet.has(s)) sells.push({ symbol: s, qty: positions[s].qty });
    else if (held > perTarget * (1 + DRIFT)) {
      const qty = Math.floor((held - perTarget) / prices[s]);
      if (qty > 0) sells.push({ symbol: s, qty });
    }
  }
  for (const t of targets) {
    const held = positions[t.symbol] ? positions[t.symbol].qty * t.price : 0;
    if (held < perTarget * (1 - DRIFT)) buys.push({ symbol: t.symbol, name: t.name, price: t.price, budget: perTarget - held });
  }
  return { sells, buys, value, perTarget };
}

// 시가총액 순위(보통주)에서 안전 기준을 통과한 상위 10개를 골라요.
export async function fetchLongTermTargets(token) {
  const params = new URLSearchParams({
    fid_input_price_2: '', fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20174', fid_div_cls_code: '1',
    fid_input_iscd: '0000', fid_trgt_cls_code: '0', fid_trgt_exls_cls_code: '0', fid_input_price_1: '', fid_vol_cnt: ''
  });
  const data = await fetchKisJson(`${KIS_BASE}/uapi/domestic-stock/v1/ranking/market-cap?${params.toString()}`, kisHeaders(token, 'FHPST01740000'));
  if (!data || !Array.isArray(data.output)) return [];
  const rows = data.output
    .map((r) => ({ symbol: r.mksc_shrn_iscd, name: r.hts_kor_isnm }))
    .filter((r) => /^\d{5}0$/.test(String(r.symbol)))
    .slice(0, LOOK_AT);
  const targets = [];
  const rule = { minCapEok: 0, maxAbsChangePct: 30, dayMaxAbsChangePct: 30 };
  for (let i = 0; i < rows.length && targets.length < TARGET_COUNT; i += 5) {
    const batch = rows.slice(i, i + 5);
    const quotes = await Promise.all(batch.map((r) => fetchKisJson(
      `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${r.symbol}`,
      kisHeaders(token, 'FHKST01010100')
    ).catch(() => null)));
    batch.forEach((r, k) => {
      const q = quotes[k] && quotes[k].output;
      const price = q ? num(q.stck_prpr) : null;
      if (!price || targets.length >= TARGET_COUNT) return;
      if (!safetyReason(Object.assign({}, r, { changePct: num(q.prdy_ctrt) }), q, rule)) targets.push(Object.assign({}, r, { price }));
    });
  }
  return targets;
}

// 코스피200 지금 값. 실패하면 null(비교만 비고 매매에는 영향 없어요).
export async function fetchKospi200(token) {
  try {
    const data = await fetchKisJson(
      `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=2001`,
      kisHeaders(token, 'FHPUP02100000')
    );
    return data && data.output ? num(data.output.bstp_nmix_prpr) : null;
  } catch (e) {
    return null;
  }
}

export { MIN_TARGETS };
