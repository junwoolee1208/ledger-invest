// /api/_rules.js
// "코드 없이 만드는 전략"(조건 블록을 골라 조립한 전략)의 모양 검사·판단·설명이에요. _로 시작해서 Vercel 함수 개수에 안 잡혀요.
// 실제 자동매매(auto-trade-check.js)와 분봉 백테스트(_strategy-sim.js)가 이 파일의 같은 ruleSignal을 써서,
// 백테스트에서 본 "살 때"와 실제 매매의 "살 때"가 어긋나지 않게 해요.
//
// 저장 위치: 커스텀 전략 목록(autotrade:custom-strategies)에 type:'rule'로 함께 저장해요.
// 그래서 켜기/끄기·삭제·카드 표시·채점표는 기존 커스텀 전략과 같은 길을 써요.

import { normalizeMethod, describeMethod } from './_methods.js';
import { hhmmToMin } from './_daytrade.js';

// 조건 블록 종류. 모두 "%" 범위(최소~최대)로 고르고, 둘 중 하나만 정해도 돼요.
export const RULE_CONDITIONS = {
  change: { label: '어제 종가 대비 등락률', need: 'quote' },
  fromOpen: { label: '오늘 시가 대비', need: 'quote' },
  offHigh: { label: '오늘 고가에서 밀린 폭', need: 'quote' }, // 0 이상(고가 = 0%)
  fromLow: { label: '오늘 저가에서 오른 폭', need: 'quote' }, // 0 이상(저가 = 0%)
  vsVwap: { label: '평균 체결가 대비', need: 'quote' },
  gap: { label: '시가 갭(어제 종가 대비 오늘 시가)', need: 'quote' },
  d1: { label: '어제 하루 등락률', need: 'daily' },
  index: { label: '코스피 등락률', need: 'index' },
  indexVsOpen: { label: '코스피 오늘 시가 대비', need: 'index' }
};
export const RULE_GATES = { up: '오르는 장에서만', dip: '시장 급락일(-2%)만 피하기', bear: '하락장에서만', none: '시장 상관없이' };

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const clip = (v, lo, hi, fb) => { const n = num(v); return n === null ? fb : Math.max(lo, Math.min(hi, n)); };
const r1 = (v) => Math.round(v * 10) / 10;
function hhmm(v, fb, lo, hi) {
  const m = hhmmToMin(v);
  const x = m === null ? hhmmToMin(fb) : Math.max(lo, Math.min(hi, m));
  return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
}

// 화면에서 보낸 전략을 안전한 모양으로 맞춰요. 문제가 있으면 { error }.
export function normalizeRule(raw) {
  const r = raw || {};
  const name = String(r.name || '').trim().slice(0, 40);
  if (!name) return { error: '전략 이름을 입력해 주세요.' };
  const horizon = r.horizon === 'swing' ? 'swing' : 'day';
  const gate = Object.prototype.hasOwnProperty.call(RULE_GATES, r.gate) ? r.gate : 'up';
  const conds = (Array.isArray(r.conditions) ? r.conditions : []).slice(0, 8).map((c) => {
    if (!c || !RULE_CONDITIONS[c.k]) return null;
    const min = num(c.min) === null ? null : clip(c.min, -30, 30, null);
    const max = num(c.max) === null ? null : clip(c.max, -30, 30, null);
    if (min === null && max === null) return null;
    return { k: c.k, min: min === null ? null : r1(min), max: max === null ? null : r1(max) };
  }).filter(Boolean);
  if (!conds.length) return { error: '사는 조건을 하나 이상 정해 주세요(최소나 최대 숫자).' };
  if (conds.some((c) => c.min !== null && c.max !== null && c.min > c.max)) return { error: '조건의 최소가 최대보다 커요.' };
  const w = r.window || {};
  const start = hhmm(w.start, '09:30', 9 * 60, 15 * 60);
  const end = hhmm(w.end, horizon === 'day' ? '14:30' : '15:15', hhmmToMin(start) + 5, 15 * 60 + 15);
  const closeAt = horizon === 'day' ? hhmm(r.closeAt, '15:10', hhmmToMin(end), 15 * 60 + 15) : null;
  const k = r.risk || {};
  const risk = {
    positionPct: clip(k.positionPct, 1, 30, 10),
    stopLossPct: clip(k.stopLossPct, 0.3, 20, horizon === 'day' ? 2 : 5),
    takeProfitPct: clip(k.takeProfitPct, 0.3, 50, horizon === 'day' ? 3 : 10),
    maxTradesPerDay: Math.round(clip(k.maxTradesPerDay, 1, 20, 5)),
    maxPositions: Math.round(clip(k.maxPositions, 1, 10, 4))
  };
  const rule = {
    type: 'rule', name, horizon, gate, conditions: conds, window: { start, end }, risk,
    method: normalizeMethod(r.method),
    ...(horizon === 'day' ? { closeAt } : { maxHoldDays: Math.round(clip(r.maxHoldDays, 1, 20, 10)) })
  };
  return { rule };
}

// 단타 규칙 모양(processStrategyMarket·분봉 백테스트가 쓰는 { buyStart, buyEnd, closeAt, ... })
export function ruleDayRules(rule) {
  return { buyStart: rule.window.start, buyEnd: rule.window.end, closeAt: rule.closeAt || '15:10', dailyLossLimitPct: 1.5, cooldownMin: 10 };
}

// 조건 값 계산. q: { price, open, high, low, vwap, changePct }, ctx: { d1, index: { price, open, changePct } }
function valueOf(k, q, ctx) {
  const pc = q.changePct === null || q.changePct === undefined ? null : q.price / (1 + q.changePct / 100);
  switch (k) {
    case 'change': return q.changePct ?? null;
    case 'fromOpen': return q.open ? (q.price / q.open - 1) * 100 : null;
    case 'offHigh': return q.high ? (1 - q.price / q.high) * 100 : null;
    case 'fromLow': return q.low ? (q.price / q.low - 1) * 100 : null;
    case 'vsVwap': return q.vwap ? (q.price / q.vwap - 1) * 100 : null;
    case 'gap': return q.open && pc ? (q.open / pc - 1) * 100 : null;
    case 'd1': return ctx && typeof ctx.d1 === 'number' ? ctx.d1 : null;
    case 'index': return ctx && ctx.index && typeof ctx.index.changePct === 'number' ? ctx.index.changePct : null;
    case 'indexVsOpen': return ctx && ctx.index && ctx.index.open ? (ctx.index.price / ctx.index.open - 1) * 100 : null;
    default: return null;
  }
}

// "살까?" — 매수 시간 안이고, 모든 조건을 만족하면 true. 값을 모르는 조건이 있으면 사지 않아요(모르는 채로 사지 않게).
export function ruleSignal(rule, q, minutes, ctx) {
  if (!q || !q.price) return false;
  const s = hhmmToMin(rule.window.start), e = hhmmToMin(rule.window.end);
  if (typeof minutes === 'number' && (minutes < s || minutes >= e)) return false;
  for (const c of rule.conditions) {
    const v = valueOf(c.k, q, ctx);
    if (v === null || !Number.isFinite(v)) return false;
    if (c.min !== null && v < c.min) return false;
    if (c.max !== null && v > c.max) return false;
  }
  return true;
}

export function ruleNeedsDaily(rule) {
  return rule.conditions.some((c) => RULE_CONDITIONS[c.k].need === 'daily');
}

export function describeRule(rule) {
  const conds = rule.conditions.map((c) => {
    const L = RULE_CONDITIONS[c.k].label;
    if (c.min !== null && c.max !== null) return `${L} ${c.min}~${c.max}%`;
    return c.min !== null ? `${L} ${c.min}% 이상` : `${L} ${c.max}% 이하`;
  }).join(', ');
  const k = rule.risk;
  return `${rule.horizon === 'day' ? '단타' : `스윙(최대 ${rule.maxHoldDays}거래일)`} · ${RULE_GATES[rule.gate]} · ${rule.window.start}~${rule.window.end} 매수` +
    (rule.horizon === 'day' ? `, ${rule.closeAt} 정리` : '') + ` · 조건: ${conds} · 손절 ${k.stopLossPct}%/익절 ${k.takeProfitPct}%, 비중 ${k.positionPct}%, ` +
    `하루 ${k.maxTradesPerDay}번·동시 ${k.maxPositions}종목 · ${describeMethod(rule.method)}`;
}
