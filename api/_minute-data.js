// /api/_minute-data.js
// 토스증권 Open API에서 받은 과거 분봉(1분 단위 가격)을 백테스트용으로 줄여 저장·복원하는 공용 코드예요.
// _로 시작해서 Vercel 함수 개수에 안 잡혀요. 이 PC에서 도는 tools/toss-sync.mjs와 서버(backtest.js)가 같이 써요.
//
// 왜 5분 묶음으로 저장하나: 1분봉을 50종목 × 1년치 그대로 두면 저장소 무료 용량과 읽는 시간이 너무 커요.
// 5분 안의 시가·고가·저가·종가를 남기면 하루 가격 4개로 흉내 내던 것보다 훨씬 실제에 가깝고, 크기는 1/5이에요.
//
// 왜 토스에서 받나: 토스 API는 허용 IP(이 PC)에서만 부를 수 있어서, 사이트 서버(Vercel)는 직접 못 불러요.
// 그래서 이 PC가 받아서 사이트의 backtest.js(mode=toss-upload)로 올리고, 백테스트는 저장소에서 읽기만 해요.

export const MIN5_PREFIX = 'bt:min5:v1:'; // + 종목 + ':' + YYYY-MM → { v:1, sym, month, days: { YYYYMMDD: '압축 문자열' } }
export const MIN5_INDEX_KEY = 'bt:min5:v1:index'; // { updatedAt, months: { 종목: ['2026-10', ...] } }
export const TOSS_META_KEY = 'toss:meta:v1'; // { updatedAt, ranking1mo, warnings, sectorOf }
export const KR_HOLIDAYS_KEY = 'market:kr-holidays'; // { updatedAt, from, to, dates: ['2026-12-25', ...] } — 자동매매가 휴장일에 쉬게
export const INDEX_MIN_SYMBOL = 'KOSPI'; // 시장 필터용 지수(토스는 코스피200 대신 코스피를 줘요)

export const BAR_MIN = 5; // 묶음 크기(분)
export const DAY_START_MIN = 9 * 60; // 09:00
export const DAY_END_MIN = 15 * 60 + 30; // 15:30 (장전·장후 시간외는 빼요 — 자동매매는 정규장에서만 해요)

const b36 = (n) => Math.round(n).toString(36);
const p36 = (s) => parseInt(s, 36);

// 1분봉 [{ t: 시작 시각(자정부터 분), o, h, l, c, v }] → 5분 묶음 같은 모양. 정규장 밖은 버려요.
export function aggregateTo5(bars1) {
  const out = new Map();
  for (const b of bars1) {
    if (!(b.t >= DAY_START_MIN && b.t < DAY_END_MIN) || !(b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0)) continue;
    const t = DAY_START_MIN + Math.floor((b.t - DAY_START_MIN) / BAR_MIN) * BAR_MIN;
    const x = out.get(t);
    if (!x) out.set(t, { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, _first: b.t, _last: b.t });
    else {
      if (b.t < x._first) { x.o = b.o; x._first = b.t; }
      if (b.t >= x._last) { x.c = b.c; x._last = b.t; }
      x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.v += b.v || 0;
    }
  }
  return Array.from(out.values()).sort((a, b) => a.t - b.t).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
}

// 하루치 5분 묶음 → 짧은 문자열. "기준가|칸,시가,고가,저가,종가,거래량;..." (가격은 기준가와의 차이, 36진수)
// 지수(소수점 둘째 자리)도 담을 수 있게 scale(가격×scale을 정수로)을 앞에 붙여요.
export function packDay(bars, scale) {
  if (!bars.length) return '';
  const sc = scale || 1;
  const base = Math.round(bars[0].o * sc);
  const rel = (p) => b36(Math.round(p * sc) - base);
  const body = bars.map((b) => [b36((b.t - DAY_START_MIN) / BAR_MIN), rel(b.o), rel(b.h), rel(b.l), rel(b.c), b36(b.v || 0)].join(',')).join(';');
  return `${sc === 1 ? '' : b36(sc)}~${b36(base)}|${body}`;
}

export function unpackDay(s) {
  if (!s || typeof s !== 'string') return [];
  const bar = s.indexOf('|');
  if (bar < 0) return [];
  const head = s.slice(0, bar).split('~');
  const sc = head[0] ? p36(head[0]) : 1;
  const base = p36(head[1]);
  return s.slice(bar + 1).split(';').filter(Boolean).map((x) => {
    const [t, o, h, l, c, v] = x.split(',').map(p36);
    return { t: DAY_START_MIN + t * BAR_MIN, o: (base + o) / sc, h: (base + h) / sc, l: (base + l) / sc, c: (base + c) / sc, v: v || 0 };
  });
}

// 업로드 받은 값이 우리가 만든 모양인지 확인해요(저장소에 이상한 값이 들어가지 않게).
const PACK_RE = /^[0-9a-z]*~-?[0-9a-z]+\|[0-9a-z,;\-]*$/;
export function validPacked(s) {
  return typeof s === 'string' && s.length < 20000 && PACK_RE.test(s);
}
export function validMonth(m) {
  return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}
export function validYmd(d) {
  return typeof d === 'string' && /^\d{8}$/.test(d);
}

// 기간(YYYYMMDD~YYYYMMDD)에 걸치는 달 목록 ['2026-09', ...]
export function monthsBetween(startYmd, endYmd) {
  const out = [];
  let y = Number(startYmd.slice(0, 4)), m = Number(startYmd.slice(4, 6));
  const ey = Number(endYmd.slice(0, 4)), em = Number(endYmd.slice(4, 6));
  for (let guard = 0; guard < 60 && (y < ey || (y === ey && m <= em)); guard++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// 저장소에서 읽은 달 단위 값들 → 백테스트가 쓰는 조회기. 압축은 필요할 때만 풀어요(쓰지 않는 날은 풀지 않게).
// docs: [{ sym, days: { YYYYMMDD: '압축 문자열' } }]
export function minuteAccessor(docs) {
  const raw = new Map(), memo = new Map();
  for (const d of docs || []) {
    if (!d || !d.sym || !d.days) continue;
    for (const ymd of Object.keys(d.days)) raw.set(d.sym + '|' + ymd, d.days[ymd]);
  }
  return {
    size: raw.size,
    has: (sym, ymd) => raw.has(sym + '|' + ymd),
    get(sym, ymd) {
      const k = sym + '|' + ymd;
      if (memo.has(k)) return memo.get(k);
      const s = raw.get(k);
      const v = s ? unpackDay(s) : null;
      memo.set(k, v);
      return v;
    }
  };
}

// 데이터 점검용 하루 요약: + 종목 → { YYYYMMDD: [시가, 고가, 저가, 종가, 5분 묶음 수] } (올릴 때 서버가 계산해 둬요)
export const MIN5_SUM_PREFIX = 'bt:min5:v1:sum:';
export function daySummary(packed) {
  const bars = unpackDay(packed);
  if (!bars.length) return null;
  let h = -Infinity, l = Infinity;
  bars.forEach((b) => { if (b.h > h) h = b.h; if (b.l < l) l = b.l; });
  return [bars[0].o, h, l, bars[bars.length - 1].c, bars.length];
}
