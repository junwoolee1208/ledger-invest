// /api/_picks.js
// "종목 고르기" 규칙과 성적표입니다. screen-candidates.js(고르기)와 auto-trade-status.js(채점표 화면)가 같이 써요.
// _로 시작해서 Vercel 함수 개수에 안 잡혀요.
//
// 예전 문제(2026-10 실제 기록): AI가 실패하면 "오늘 제일 많이 오른 3종목(+17~22%)"을 그대로 사서, 41번 판 결과가
// 승률 20%·평균 -2.23%였어요. 후보도 "많이 오른 주식"뿐이라 눌림목·역추세 전략은 거의 매매를 못 했어요.
// 이제는:
//   1) 기본 걸러내기 — 우선주·스팩·ETF/ETN·동전주·거래가 적은 종목, 오늘 이미 +15% 넘게 오른 종목은 빼요.
//   2) 전략별 후보 묶음 — 오르는 중(모멘텀·돌파), 조금만 오른 활발한 종목(눌림목), 떨어진 탄탄한 종목(역추세).
//   3) 점수 규칙으로 먼저 순위를 매기고(공짜, 늘 같은 결과), AI는 "피해야 할 종목"만 걸러요.
//   4) 고른 종목과 걸러진 종목을 기록해 두고, 3거래일 뒤 실제로 어떻게 됐는지 채점해 성적표와 교훈을 만들어요.

export const PICK_REPORT_KEY = 'picks:report';
export const PICK_JOURNAL_KEY = 'picks:journal';
const MAX_JOURNAL = 90;

const EXCLUDE_NAME = /스팩|SPAC|ETN|ETF|KODEX|TIGER|KBSTAR|ARIRANG|HANARO|KOSEF|TIMEFOLIO|RISE |PLUS |SOL |ACE |레버리지|인버스|선물|채권/i;
export const POOL_LABEL = { rise: '오르는 중', calm: '조금 오른 활발한 종목', fall: '떨어진 탄탄한 종목' };

// 기본 걸러내기. 걸러지면 이유 문자열, 통과하면 null
export function excludeReason(row) {
  if (!row || !/^\d{6}$/.test(String(row.symbol))) return '코드 이상';
  if (!/0$/.test(row.symbol)) return '우선주 등(보통주 아님)';
  if (EXCLUDE_NAME.test(row.name || '')) return 'ETF·ETN·스팩 등';
  if (row.price !== null && row.price < 1000) return '1,000원 미만 동전주';
  if (row.volume && row.price && row.price * row.volume < 3e9) return '거래대금 30억 미만';
  return null;
}

// 후보 묶음 만들기 + 점수 순위(묶음마다 최대 5개). rise/fall은 등락률 순위, vol은 거래량 순위 목록.
export function buildPools(riseRows, fallRows, volRows) {
  const volSet = new Set(volRows.map((r) => r.symbol));
  const tv = (r) => (r.price && r.volume ? r.price * r.volume : 0);
  const logTv = (r) => (tv(r) > 0 ? Math.log10(tv(r)) : 8);
  const pools = { rise: [], calm: [], fall: [] };
  const excluded = [];
  const seen = new Set();
  const add = (pool, r, score) => {
    if (seen.has(r.symbol)) return;
    const why = excludeReason(r);
    if (why) { excluded.push({ symbol: r.symbol, name: r.name, why }); return; }
    seen.add(r.symbol);
    pools[pool].push(Object.assign({}, r, { pool, inVolumeTop: volSet.has(r.symbol), score: Math.round(score * 10) / 10 }));
  };
  riseRows.forEach((r) => {
    if (r.changePct === null) return;
    if (r.changePct > 15) { excluded.push({ symbol: r.symbol, name: r.name, why: '오늘 이미 +15% 넘게 오름(고점 매수 위험)' }); return; }
    if (r.changePct < 2) return;
    // 거래량 상위에도 든 종목 우대, 상승률은 10%까지만 점수에 반영(더 오른 건 가산점 없음), 거래대금이 클수록 우대
    add('rise', r, (volSet.has(r.symbol) ? 20 : 0) + Math.min(r.changePct, 10) + logTv(r));
  });
  volRows.forEach((r) => {
    if (r.changePct === null || r.changePct < 0 || r.changePct > 2 || (r.price !== null && r.price < 3000)) return;
    add('calm', r, logTv(r) + (2 - Math.abs(r.changePct - 1)));
  });
  fallRows.forEach((r) => {
    if (r.changePct === null || r.changePct > -2 || r.changePct < -6) return;
    if (r.price !== null && r.price < 5000) return;
    if (r.volume && tv(r) < 5e9) return; // 떨어진 종목은 더 엄격하게(거래대금 50억 이상)
    add('fall', r, logTv(r) + (volSet.has(r.symbol) ? 10 : 0));
  });
  Object.keys(pools).forEach((k) => { pools[k] = pools[k].sort((a, b) => b.score - a.score).slice(0, 5); });
  return { pools, excluded };
}

// 지난 기록에서 배운 것: 고를 때의 상승률 구간·묶음별 3거래일 뒤 평균 — AI 프롬프트와 성적표에 써요
function bucketOf(p) {
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

// 채점: 고른 지 3거래일이 지난 기록의 고른 종목·걸러진 종목 수익률을 계산해 기록에 붙여요.
// fetchHistory(symbol) → 일봉 배열. 한 번에 최대 maxSymbols 종목만(시간 제한 때문에), 나머지는 다음에.
export async function gradeJournal(journal, fetchHistory, maxSymbols) {
  const cache = {};
  let fetched = 0;
  for (const entry of journal) {
    if (entry.graded) continue;
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
      (rejected.length ? ` / AI·규칙이 걸러낸 종목 ${rejected.length}개는 평균 ${rejAvg >= 0 ? '+' : ''}${rejAvg}% → 거르기가 ${pickAvg > rejAvg ? '도움이 됐어요' : '아직 도움이 안 됐어요'}` : '');
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
