// /api/_ledger.js
// 손익 캘린더용 "날짜별 장부"입니다.
//
// 예전엔 캘린더가 전체 매매 기록(최근 400건만 보관, 화면엔 그중 80건만 전달)에서 날짜별 손익을 계산해서,
// 매매가 많아지면 며칠만 지나도 예전 날짜가 빈칸이 됐어요. 이제 매매가 생길 때마다 아래 두 가지에 따로 쌓아서
// 기록이 아무리 많아져도 지워지지 않게 합니다.
//   1) 월별 요약  autotrade:daily:YYYY-MM      → { 'YYYY-MM-DD': { 그날 합계 + byStrategy: { 전략별 합계 } } }
//   2) 하루 상세  autotrade:trades:YYYY-MM-DD  → 그날의 매매 하나하나(최신순) — 달력의 "자세히 보기"용
// 장부가 처음 만들어질 때는 아직 남아 있는 매매 기록으로 한 번 채웁니다(이미 지워진 기록은 되살릴 수 없어요).
// _로 시작해서 Vercel 함수 개수에 안 잡혀요.

import { kvGetJson, kvSetJson } from './_kv.js';

export const DAILY_KEY_PREFIX = 'autotrade:daily:';
export const TRADES_KEY_PREFIX = 'autotrade:trades:';
const BACKFILL_FLAG_KEY = 'autotrade:daily:backfilled';
const MAX_TRADES_PER_DAY = 1500; // 하루 상세 기록 상한(값 하나가 너무 커지지 않게)

// 매도 종류: 손절 / 익절 / 장마감 청산(단타 전략)
export function isSellSide(side) {
  return side === 'STOP_LOSS' || side === 'TAKE_PROFIT' || side === 'DAY_CLOSE';
}

// 손익 금액이 없는 옛 기록(필드 추가 전 데이터)은 남아 있는 값으로 근사치를 계산합니다(화면 매매 기록과 같은 방식).
function pnlAmountOf(e) {
  if (typeof e.pnlAmount === 'number') return e.pnlAmount;
  if (typeof e.pnlPct === 'number' && e.price && e.qty) {
    const buyPrice = e.price / (1 + e.pnlPct / 100);
    return e.qty * (e.price - buyPrice);
  }
  return 0;
}

function emptyRow() {
  return { krPnl: 0, usPnl: 0, buys: 0, sells: 0, wins: 0, krFee: 0, usFee: 0 };
}

// 하루 요약(day)과 그 안의 전략별 요약에 매매 하나를 더합니다. krPnl/krFee는 원, usPnl/usFee는 달러.
function addEntry(day, e) {
  const id = e.strategy || 'momentum';
  day.byStrategy = day.byStrategy || {};
  day.byStrategy[id] = day.byStrategy[id] || emptyRow();
  const us = e.market === 'US';
  for (const row of [day, day.byStrategy[id]]) {
    if (e.side === 'BUY') row.buys += 1;
    else if (isSellSide(e.side)) {
      row.sells += 1;
      if ((e.pnlPct || 0) > 0) row.wins += 1;
      if (us) row.usPnl += pnlAmountOf(e); else row.krPnl += pnlAmountOf(e);
    }
    if (us) row.usFee += e.fee || 0; else row.krFee += e.fee || 0;
  }
}

function groupBy(entries, keyFn) {
  const map = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return map;
}

// 새 매매들을 장부에 더합니다. entries는 최신순이어도 되고 아니어도 돼요(하루 상세는 시간순으로 다시 정렬).
export async function recordEntries(entries, { fresh = false } = {}) {
  const valid = entries.filter((e) => typeof e.date === 'string' && e.date.length === 10);
  for (const [month, list] of groupBy(valid, (e) => e.date.slice(0, 7))) {
    const key = DAILY_KEY_PREFIX + month;
    const summary = fresh ? {} : await kvGetJson(key, {});
    for (const e of list) {
      summary[e.date] = summary[e.date] || emptyRow();
      addEntry(summary[e.date], e);
    }
    await kvSetJson(key, summary);
  }
  for (const [date, list] of groupBy(valid, (e) => e.date)) {
    const key = TRADES_KEY_PREFIX + date;
    const prev = fresh ? [] : await kvGetJson(key, []);
    const merged = list.concat(prev).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (merged.length > MAX_TRADES_PER_DAY) merged.length = MAX_TRADES_PER_DAY;
    await kvSetJson(key, merged);
  }
}

// 장부가 아직 없으면, 남아 있는 전체 매매 기록으로 한 번 채웁니다. 채웠으면 true.
// (log에 방금 생긴 매매가 이미 들어 있다면, true일 때는 따로 recordEntries를 부르지 않아야 두 번 더해지지 않아요.)
export async function ensureBackfilled(log) {
  const done = await kvGetJson(BACKFILL_FLAG_KEY, null);
  if (done) return false;
  await recordEntries(log || [], { fresh: true });
  await kvSetJson(BACKFILL_FLAG_KEY, { at: Date.now(), entries: (log || []).length });
  return true;
}
