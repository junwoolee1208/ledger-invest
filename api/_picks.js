// /api/_picks.js
// "종목 고르기" 규칙과 성적표입니다. screen-candidates.js(고르기)와 auto-trade-status.js(설정·화면)가 같이 써요.
// _로 시작해서 Vercel 함수 개수에 안 잡혀요.
//
// 고르는 방법(2026-11, 사용자 결정): 거래대금이 많은 종목 중 안전 기준을 통과한 종목만 씁니다. AI는 쓰지 않아요.
//   1) 거래대금 상위 N개를 받아요(거래가 많아야 원하는 가격에 사고팔기 쉬워요).
//   2) 시가총액, 위험 표시(관리·경고·단기과열 등), 오늘 등락폭으로 걸러요.
//   3) 남은 종목을 거래대금 순으로 최대 M개까지 후보로 써요.
//   4) 고른 종목과 뺀 종목을 기록해 두고, 3거래일 뒤 실제로 어떻게 됐는지 채점해 성적표를 만들어요.
// 거래대금 상위에는 급등 테마주도 많이 올라오므로, 거래대금만으로는 안전하지 않아서 2)가 꼭 필요해요.
// 시가총액·위험 표시를 확인하지 못한 종목은 안전한지 알 수 없으니 뺍니다.

export const PICK_REPORT_KEY = 'picks:report';
export const PICK_JOURNAL_KEY = 'picks:journal';
export const SCREEN_CACHE_KEY = 'screen:cache:v2';
const MAX_JOURNAL = 90;
const RETRY_AFTER_FAIL_MS = 15 * 60 * 1000; // 고르기에 실패했으면 15분 뒤에 다시 시도해요
const FIRST_PICK_MIN = 9 * 60 + 30; // 하루 첫 고르기 시각(09:30). 장 시작 직후엔 거래대금이 아직 얼마 안 쌓여서 순위를 믿기 어려워요.

function kstOf(nowMs) {
  return new Date(nowMs + 9 * 60 * 60 * 1000);
}

// 오늘(KST) + 오전/오후 구간 — 이 값이 바뀔 때만 새로 골라요.
export function screenSlot(nowMs) {
  const d = kstOf(nowMs);
  return d.toISOString().slice(0, 10) + (d.getUTCHours() < 12 ? '-am' : '-pm');
}

export function beforeFirstPick(nowMs) {
  const d = kstOf(nowMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes() < FIRST_PICK_MIN;
}

// 저장해 둔 고르기 결과를 그대로 써도 되는지. 자동매매 실행과 고르기 함수가 같은 기준을 봐야 해서 여기에 뒀어요.
export function screenIsFresh(cached, nowMs) {
  return !!cached && cached.slot === screenSlot(nowMs) && (!!cached.ok || nowMs - cached.generatedAt < RETRY_AFTER_FAIL_MS);
}

export const POOL_LABEL = { value: '거래대금 상위', rise: '오르는 중', calm: '조금 오른 활발한 종목', fall: '떨어진 탄탄한 종목' };

// 화면에서 바꿀 수 있는 기준 (자동매매 설정 cfg.screen에 저장)
export const DEFAULT_SCREEN = { topN: 30, minCapEok: 10000, maxAbsChangePct: 10, maxPicks: 15 };

function clipNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function normalizeScreen(raw) {
  const r = raw || {}, d = DEFAULT_SCREEN;
  return {
    topN: Math.round(clipNum(r.topN, 5, 30, d.topN)), // KIS 순위 API가 한 번에 최대 30개를 줘요
    minCapEok: Math.round(clipNum(r.minCapEok, 0, 1000000, d.minCapEok)), // 억 원 단위 (10000 = 1조)
    maxAbsChangePct: clipNum(r.maxAbsChangePct, 1, 30, d.maxAbsChangePct),
    maxPicks: Math.round(clipNum(r.maxPicks, 1, 30, d.maxPicks))
  };
}

// 안전 기준 검사. 통과하면 null, 걸리면 쉬운 이유. row: 순위 행, q: 종목 시세(주식현재가 응답의 output)
export function safetyReason(row, q, cfg) {
  if (!/^\d{5}0$/.test(String(row.symbol))) return '보통주가 아님(우선주 등)';
  if (!q) return '시세를 확인하지 못함';
  const cap = Number(q.hts_avls);
  if (!Number.isFinite(cap) || cap <= 0) return '시가총액을 확인하지 못함';
  if (cap < cfg.minCapEok) return `시가총액 부족(${Math.round(cap).toLocaleString()}억)`;
  if (q.mang_issu_cls_code === 'Y') return '관리종목';
  if (q.sltr_yn === 'Y') return '정리매매';
  if (q.temp_stop_yn === 'Y') return '거래 임시정지';
  if (q.invt_caful_yn === 'Y') return '투자유의';
  if (q.short_over_yn === 'Y') return '단기과열';
  // 시장경고코드: 00 없음, 01 투자주의, 02 투자경고, 03 투자위험
  if (q.mrkt_warn_cls_code && q.mrkt_warn_cls_code !== '00') return '시장경고(투자주의·경고·위험)';
  if (row.changePct === null || row.changePct === undefined) return '등락률을 확인하지 못함';
  if (Math.abs(row.changePct) > cfg.maxAbsChangePct) return `오늘 등락폭이 큼(${row.changePct}%)`;
  return null;
}

// rows: 거래대금 순위 행, quotes: { 종목: 시세 output }. 거래대금 큰 순서로 최대 maxPicks개를 고르고, 뺀 종목은 이유와 함께 돌려줘요.
export function selectByValue(rows, quotes, cfg) {
  const sorted = rows.slice().sort((a, b) => (b.tradeValue || 0) - (a.tradeValue || 0));
  const picks = [], rejected = [];
  sorted.forEach((row, i) => {
    const q = quotes[row.symbol];
    const why = safetyReason(row, q, cfg);
    const item = Object.assign({}, row, { rank: i + 1, pool: 'value', capEok: q && Number.isFinite(Number(q.hts_avls)) ? Number(q.hts_avls) : null });
    if (why) rejected.push(Object.assign(item, { why }));
    else if (picks.length < cfg.maxPicks) picks.push(item);
    else rejected.push(Object.assign(item, { why: '개수 제한(거래대금 순으로 ' + cfg.maxPicks + '개까지)' }));
  });
  return { picks, rejected };
}

// 고를 때 상태별 3거래일 뒤 평균 — 성적표에 써요. 거래대금 방식은 고를 때의 등락률 구간으로 나눠 봐요.
function bucketOf(p) {
  if (p.pool === 'value') return p.changePct >= 5 ? '고를 때 +5% 이상' : p.changePct >= 0 ? '고를 때 0~+5%' : p.changePct > -5 ? '고를 때 -5~0%' : '고를 때 -5% 이하';
  if (p.pool !== 'rise') return POOL_LABEL[p.pool] || p.pool;
  return p.changePct >= 10 ? '오르는 중(+10% 이상)' : p.changePct >= 5 ? '오르는 중(+5~10%)' : '오르는 중(+2~5%)';
}

// 일봉에서 날짜(YYYY-MM-DD) 다음 n번째 거래일 종가
function closeAfter(history, isoDate, n) {
  if (!history || !history.length) return null;
  const ymd = isoDate.replace(/-/g, '');
  const idx = history.findIndex((h) => h.date > ymd);
  if (idx === -1) return null;
  const row = history[idx + n - 1];
  return row && row.close ? row.close : null;
}

// 채점: 고른 지 3거래일이 지난 기록의 고른 종목·뺀 종목 수익률을 계산해 기록에 붙여요.
// fetchHistory(symbol) → 일봉 배열. 한 번에 최대 maxSymbols 종목만(시간 제한 때문에), 나머지는 다음에.
// 아직 3거래일이 안 된 최근 기록이 조회 횟수를 다 쓰지 않도록, 5일 이상 지난 기록만 오래된 순서로 봐요.
export async function gradeJournal(journal, fetchHistory, maxSymbols, nowMs) {
  const cache = {};
  let fetched = 0;
  const oldEnough = (e) => (nowMs || Date.now()) - Date.parse(e.date) >= 5 * 86400000;
  for (const entry of journal.slice().reverse()) {
    if (entry.graded || !oldEnough(entry)) continue;
    const all = (entry.picks || []).concat(entry.rejected || []);
    let complete = true;
    for (const p of all) {
      if (p.ret3 !== undefined) continue;
      if (!cache[p.symbol]) {
        if (fetched >= maxSymbols) { complete = false; continue; }
        try { cache[p.symbol] = await fetchHistory(p.symbol); } catch (e) { cache[p.symbol] = []; }
        fetched++;
      }
      const c1 = closeAfter(cache[p.symbol], entry.date, 1), c3 = closeAfter(cache[p.symbol], entry.date, 3);
      if (!c3 || !p.price) { complete = false; continue; }
      p.ret1 = Math.round((c1 / p.price - 1) * 10000) / 100;
      p.ret3 = Math.round((c3 / p.price - 1) * 10000) / 100;
    }
    if (complete) entry.graded = true;
  }
  return journal;
}

const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

export function buildReport(journal) {
  const picks = [], rejected = [];
  journal.forEach((e) => {
    (e.picks || []).forEach((p) => { if (typeof p.ret3 === 'number') picks.push(p); });
    (e.rejected || []).forEach((p) => { if (typeof p.ret3 === 'number') rejected.push(p); });
  });
  const buckets = {};
  picks.concat(rejected).forEach((p) => {
    const b = bucketOf(p);
    (buckets[b] = buckets[b] || []).push(p.ret3);
  });
  const bucketStats = Object.keys(buckets).map((b) => ({ bucket: b, n: buckets[b].length, avgRet3: avg(buckets[b]), upRate: Math.round(buckets[b].filter((x) => x > 0).length / buckets[b].length * 100) }))
    .sort((a, b) => b.n - a.n);
  const pickAvg = avg(picks.map((p) => p.ret3));
  const rejAvg = avg(rejected.map((p) => p.ret3));
  const hit = picks.length ? Math.round(picks.filter((p) => p.ret3 > 0).length / picks.length * 100) : null;
  let summary = '아직 채점된 기록이 없어요(고른 지 3거래일이 지나야 채점돼요).';
  if (picks.length) {
    summary = `고른 종목 ${picks.length}개의 3거래일 뒤 평균 ${pickAvg >= 0 ? '+' : ''}${pickAvg}%, 오른 비율 ${hit}%` +
      (rejected.length ? ` / 기준에 걸려 뺀 종목 ${rejected.length}개는 평균 ${rejAvg >= 0 ? '+' : ''}${rejAvg}% → 거르기가 ${pickAvg > rejAvg ? '도움이 됐어요' : '아직 도움이 안 됐어요'}` : '');
  }
  return {
    updatedAt: Date.now(), picks: picks.length, rejected: rejected.length,
    pickAvgRet3: pickAvg, rejectedAvgRet3: rejAvg, hitRate: hit, buckets: bucketStats, summary,
    lessons: bucketStats.filter((b) => b.n >= 5).map((b) => `${b.bucket}: ${b.n}개, 3거래일 뒤 평균 ${b.avgRet3 >= 0 ? '+' : ''}${b.avgRet3}%, 오른 비율 ${b.upRate}%`)
  };
}

export function appendJournal(journal, entry) {
  const next = [entry].concat(journal.filter((e) => e.slot !== entry.slot));
  if (next.length > MAX_JOURNAL) next.length = MAX_JOURNAL;
  return next;
}
