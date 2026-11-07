// /api/_bear.js
// 시장 필터(언제 사도 되는지)와 새 전략 4개(단계별 저점 매수, 급락 반등 단타, 급락 다음날 매수, 인버스)의 판단 규칙이에요.
// 저장소를 읽지 않고 계산만 해서 시험하기 쉽게 따로 뒀어요. _로 시작해서 Vercel 함수 개수에 안 잡혀요.
//
// 왜 필요한가(2026-11 손실 분석): 코스피200이 이틀 동안 -7% 빠지는 날에도 전략들이 계속 사서 손실이 커졌어요.
// 그렇다고 떨어질 때 가만히 있으면 기회도 놓쳐요. 그래서 오르는 장 전략은 쉬게 하고, 하락장 전략이 대신 움직여요.

import { kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';

export function isBearRegime(label) {
  return String(label || '').startsWith('bear');
}

// 코스피200 지금 값·시가·등락률. 실패하면 null(필터는 "모름"으로 보고 막지 않아요 — 하루 내내 매매가 멈추지 않게).
export async function fetchIndexQuote(token) {
  try {
    const data = await fetchKisJson(
      `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=2001`,
      kisHeaders(token, 'FHPUP02100000')
    );
    const o = data && data.output;
    if (!o) return null;
    const price = num(o.bstp_nmix_prpr), open = num(o.bstp_nmix_oprc), changePct = num(o.bstp_nmix_prdy_ctrt);
    if (!price) return null;
    return { price, open: open || null, changePct: changePct === null ? null : changePct };
  } catch (e) {
    return null;
  }
}

// 전략 종류별 "새로 사도 되는지" 판단. 이미 들고 있는 종목을 파는 건 언제나 해요.
//   up    : 오르는 장 전략 — 코스피200이 오늘 -1% 아래거나 오늘 시가보다 낮으면 쉬어요
//   swing : 위 조건 + 하락장(20일 흐름)에서는 며칠씩 들고 갈 종목을 새로 사지 않아요
//   dip   : 떨어진 종목을 사는 전략 — 시장 전체가 -2% 넘게 무너지는 날만 쉬어요
//   bear  : 하락장 전략 — 하락장이거나 오늘 시장이 -1% 넘게 빠질 때만 움직여요
//   none  : 기준선(대조군) — 비교를 위해 아무 조건 없이 사요
export function marketGate(kind, idx, regime) {
  const known = idx && typeof idx.changePct === 'number';
  const belowOpen = known && idx.open ? idx.price < idx.open : false;
  if (kind === 'none') return { ok: true };
  if (kind === 'bear') {
    const ok = isBearRegime(regime) || (known && idx.changePct <= -1);
    return { ok, why: ok ? null : '하락장이 아니라 쉬어요' };
  }
  if (kind === 'dip') {
    const ok = !known || idx.changePct > -2;
    return { ok, why: ok ? null : '시장 전체가 -2% 넘게 빠져서 쉬어요' };
  }
  const upOk = !known || (idx.changePct > -1 && !belowOpen);
  if (!upOk) return { ok: false, why: '코스피200이 약해서(-1% 아래 또는 시가 아래) 쉬어요' };
  if (kind === 'swing' && isBearRegime(regime)) return { ok: false, why: '하락장이라 며칠 들고 갈 종목은 새로 사지 않아요' };
  return { ok: true };
}

const fromOpen = (q) => (q.open ? ((q.price - q.open) / q.open) * 100 : null);

// 새 단타: 단계별 저점 매수 — 시가보다 -2~-4% 내려온 종목의 첫 1/3을 사요(나머지는 매매 방식이 더 떨어지면 나눠 사요).
export const STAGED_DIP = { startMin: 9 * 60 + 15, minFromOpen: -4, maxFromOpen: -2, minChangePct: -8 };
export function stagedDipSignal(q, minutes) {
  const fo = fromOpen(q);
  if (fo === null || q.changePct === null || minutes < STAGED_DIP.startMin) return false;
  return fo <= STAGED_DIP.maxFromOpen && fo >= STAGED_DIP.minFromOpen && q.changePct >= STAGED_DIP.minChangePct;
}

// 하락장 단타: 급락 반등 — 시가보다 -3% 넘게 빠졌다가 오늘 저가에서 +1~3% 다시 올라온 종목을 사요(바닥 확인 후).
export const DIP_REBOUND = { startMin: 10 * 60, maxFromOpen: -3, bounceMin: 1.01, bounceMax: 1.03, minChangePct: -15 };
export function dipReboundSignal(q, minutes) {
  const fo = fromOpen(q);
  if (fo === null || !q.low || q.changePct === null || minutes < DIP_REBOUND.startMin) return false;
  return fo <= DIP_REBOUND.maxFromOpen && q.price >= q.low * DIP_REBOUND.bounceMin && q.price <= q.low * DIP_REBOUND.bounceMax &&
    q.changePct >= DIP_REBOUND.minChangePct;
}

// 하락장 스윙: 급락 다음날 매수 — 어제 -5% 넘게 빠진 종목이 오늘 아침 더 빠지지 않고 버티면 사요(2~5일 보유).
// daily: { d1: 어제 등락률 } — 하루 한 번 계산해 둔 값(auto-trade-check.js의 일봉 캐시)
export const DIP_NEXTDAY = { startMin: 9 * 60 + 30, maxD1: -5, minChangePct: -3, bounce: 1.01, maxHoldDays: 5 };
export function dipNextDaySignal(q, daily, minutes) {
  if (!daily || typeof daily.d1 !== 'number' || !q.open || !q.low || q.changePct === null) return false;
  if (minutes < DIP_NEXTDAY.startMin || daily.d1 > DIP_NEXTDAY.maxD1) return false;
  return q.price >= q.open && q.price >= q.low * DIP_NEXTDAY.bounce && q.changePct >= DIP_NEXTDAY.minChangePct;
}

// 하락장 스윙: 인버스 ETF — 하락장이고 오늘도 시장이 약하면(시가 아래, -0.3% 이하) 사요. 하락장이 끝나면 팔아요.
export const INVERSE_RULE = { maxIndexChangePct: -0.3, maxHoldDays: 20 };
export function inverseSignal(idx, regime) {
  if (!isBearRegime(regime) || !idx || typeof idx.changePct !== 'number') return false;
  return idx.changePct <= INVERSE_RULE.maxIndexChangePct && (!idx.open || idx.price < idx.open);
}
export function inverseShouldExit(regime) {
  return regime ? !isBearRegime(regime) : false; // 시장 상황을 모르면 팔지 않아요(손절·따라가는 손절은 그대로 작동)
}

// 같은 날 판 종목을 다시 살 때의 "다른 근거"(재진입 규칙).
//   손해 보고 판 종목(손절·따라가는 손절·위험 줄이기): 바닥에서 +1% 반등하고 평균 체결가 위로 올라왔을 때만
//   이익 보고 판 종목: 판 가격보다 1% 넘게 싸졌을 때만(비싸게 다시 사서 수익을 반납하지 않게)
export const REENTRY = { minGapMin: 10, bounce: 1.01, cheaper: 0.99 };
const LOSS_SIDES = ['STOP_LOSS', 'TRAIL_STOP', 'RISK_CUT', 'SIGNAL_EXIT', 'MAX_HOLD'];
export function reentryAllowed(lastSell, q, nowMs, minGapMin) {
  if (!lastSell) return { ok: true };
  const gap = (minGapMin === undefined ? REENTRY.minGapMin : minGapMin) * 60 * 1000;
  if (nowMs - (lastSell.ts || 0) < gap) return { ok: false, why: '방금 판 종목이라 잠시 쉬어요' };
  const lostMoney = LOSS_SIDES.includes(lastSell.side) || (typeof lastSell.pnlPct === 'number' && lastSell.pnlPct < 0);
  if (lostMoney) {
    const bounced = q.low && q.price >= q.low * REENTRY.bounce && (!q.vwap || q.price >= q.vwap);
    return bounced ? { ok: true, note: '손절 뒤 반등 확인' } : { ok: false, why: '손절한 종목은 반등이 확인돼야 다시 사요' };
  }
  const cheaper = lastSell.price && q.price <= lastSell.price * REENTRY.cheaper;
  return cheaper ? { ok: true, note: '판 가격보다 싸게 다시 매수' } : { ok: false, why: '익절한 종목은 판 가격보다 싸져야 다시 사요' };
}
