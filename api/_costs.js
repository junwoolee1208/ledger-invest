// /api/_costs.js
// 매매 비용(수수료·거래세·환전비용) 모델과 해외주식 양도세 설정을 한 곳에서 관리합니다.
// 자동매매(auto-trade-check.js), 현황 조회(auto-trade-status.js), 백테스트(backtest.js → _backtest-core.js)가
// 모두 같은 기준으로 비용을 빼도록 공유합니다. 증권사마다 수수료가 달라서, 값은 KV에 저장하고
// 화면(자동매매 탭 > 매매 비용 설정)에서 언제든 바꿀 수 있습니다. _로 시작해서 Vercel 함수 개수에 안 잡혀요.
//
// 기본값은 토스증권 기준(2026년 9월 확인):
//   국내 매매수수료 0.015%(매수·매도 각각), 증권거래세 0.20%(코스피 0.05%+농특세 0.15% / 코스닥 0.20%, 매도 시)
//   해외(미국) 매매수수료 0.1%(매수·매도 각각), SEC Fee 0.00206%(매도 시, 2026.4.2~),
//   환전 비용 0.05%(평일 낮 95% 환율우대 기준 — 그 외 시간엔 약 0.5%라 직접 바꾸세요)
//   해외주식 양도세 22%(지방세 포함), 연 250만원 기본공제

import { kvGetJson } from './_kv.js';

export const COST_CONFIG_KEY = 'autotrade:cost-config';
export const REALIZED_KEY_PREFIX = 'autotrade:realized:'; // + 연도(YYYY) → { [strategyId]: 연간 실현손익 누적 }

export const DEFAULT_COSTS = {
  broker: '토스증권',
  kr: { buyFeePct: 0.015, sellFeePct: 0.015, sellTaxPct: 0.20 },
  us: { buyFeePct: 0.1, sellFeePct: 0.1, sellRegFeePct: 0.00206, fxSpreadPct: 0.05 },
  overseasTax: { ratePct: 22, deductionKrw: 2_500_000 },
  updatedAt: null
};

function clipNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// 사용자가 보낸 값(또는 KV에 저장된 옛 값)을 기본값 위에 덮어쓰되, 말이 안 되는 숫자는 잘라냅니다.
export function normalizeCosts(raw) {
  const r = raw || {};
  const d = DEFAULT_COSTS;
  const kr = r.kr || {}, us = r.us || {}, tx = r.overseasTax || {};
  return {
    broker: typeof r.broker === 'string' && r.broker.trim() ? r.broker.trim().slice(0, 30) : d.broker,
    kr: {
      buyFeePct: clipNum(kr.buyFeePct, 0, 2, d.kr.buyFeePct),
      sellFeePct: clipNum(kr.sellFeePct, 0, 2, d.kr.sellFeePct),
      sellTaxPct: clipNum(kr.sellTaxPct, 0, 2, d.kr.sellTaxPct)
    },
    us: {
      buyFeePct: clipNum(us.buyFeePct, 0, 2, d.us.buyFeePct),
      sellFeePct: clipNum(us.sellFeePct, 0, 2, d.us.sellFeePct),
      sellRegFeePct: clipNum(us.sellRegFeePct, 0, 1, d.us.sellRegFeePct),
      fxSpreadPct: clipNum(us.fxSpreadPct, 0, 3, d.us.fxSpreadPct)
    },
    overseasTax: {
      ratePct: clipNum(tx.ratePct, 0, 60, d.overseasTax.ratePct),
      deductionKrw: clipNum(tx.deductionKrw, 0, 100_000_000, d.overseasTax.deductionKrw)
    },
    updatedAt: r.updatedAt || null
  };
}

export async function loadCosts() {
  return normalizeCosts(await kvGetJson(COST_CONFIG_KEY, null));
}

export function marketOfSymbol(symbol) {
  return /^\d{6}$/.test(String(symbol)) ? 'KR' : 'US';
}

// 살 때 드는 비용 비율(%) — 해외는 원화→달러 환전 비용 포함
export function buyCostPct(costs, market) {
  const c = costs || DEFAULT_COSTS;
  return market === 'KR' ? c.kr.buyFeePct : c.us.buyFeePct + c.us.fxSpreadPct;
}

// 팔 때 드는 비용 비율(%) — 국내는 수수료+거래세, 해외는 수수료+SEC Fee+달러→원화 환전 비용
export function sellCostPct(costs, market) {
  const c = costs || DEFAULT_COSTS;
  return market === 'KR'
    ? c.kr.sellFeePct + c.kr.sellTaxPct
    : c.us.sellFeePct + c.us.sellRegFeePct + c.us.fxSpreadPct;
}

// 예산(budget) 안에서 비용까지 내고 살 수 있는 최대 수량과, 실제로 빠져나가는 총액
export function planBuy(costs, market, budget, price) {
  const pct = buyCostPct(costs, market) / 100;
  const qty = Math.floor(budget / (price * (1 + pct)));
  const gross = qty * price;
  const fee = gross * pct;
  return { qty, gross, fee, total: gross + fee };
}

// 팔았을 때 비용을 빼고 실제로 손에 들어오는 금액
export function planSell(costs, market, qty, price) {
  const gross = qty * price;
  const fee = gross * (sellCostPct(costs, market) / 100);
  return { gross, fee, proceeds: gross - fee };
}

// 보유 종목의 "실제로 들어간 돈"(매수금액+매수비용). 비용 반영 이전에 산 옛 포지션은 costBasis가 없어서,
// 지금 설정의 매수비용을 적용한 값으로 근사합니다(수익률이 실제보다 좋게 보이지 않도록).
export function positionCostBasis(costs, market, pos) {
  if (pos && typeof pos.costBasis === 'number' && pos.costBasis > 0) return pos.costBasis;
  return pos.qty * pos.avgPrice * (1 + buyCostPct(costs, market) / 100);
}

// 해외주식 양도세 추정: 연간 실현손익(원화, 이익·손실 합산)에서 기본공제를 빼고 세율을 곱합니다.
export function estimateOverseasTax(costs, annualPnlKrw) {
  const c = costs || DEFAULT_COSTS;
  const taxable = Math.max(0, (annualPnlKrw || 0) - c.overseasTax.deductionKrw);
  const tax = taxable * (c.overseasTax.ratePct / 100);
  return { taxable: Math.round(taxable), tax: Math.round(tax), afterTax: Math.round((annualPnlKrw || 0) - tax) };
}

// 원/달러 환율 (키 없는 공개 API). 실패하면 null — 호출하는 쪽에서 대체값을 정합니다.
export async function fetchUsdKrw() {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.rates && d.rates.KRW ? d.rates.KRW : null;
  } catch (e) {
    return null;
  }
}
