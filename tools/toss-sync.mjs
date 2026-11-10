#!/usr/bin/env node
// tools/toss-sync.mjs — 이 PC에서 실행하는 "토스증권 데이터 받아서 사이트에 올리기" 프로그램이에요.
//
// 왜 사이트 서버가 아니라 이 PC에서 도나: 토스 Open API는 미리 등록한 인터넷 주소(허용 IP)에서만 부를 수 있어요.
// 사이트 서버(Vercel)는 실행할 때마다 주소가 바뀌어서 등록할 수 없고, 이 PC 주소는 토스 설정에 등록돼 있어요.
// 그래서 이 PC가 받아서 사이트(backtest.js?mode=toss-upload)로 올리고, 사이트는 저장소에서 읽기만 해요.
//
// 안전장치: 이 프로그램은 토스의 "조회" 주소만 불러요(아래 READ_ONLY_PATHS). 주문·정정·취소 주소는 코드에 없고,
// 혹시 잘못 부르려 해도 tossGet이 막아요. 키는 tools/toss.env 파일에만 두고, 이 파일은 GitHub에 올라가지 않아요(.gitignore).
//
// 사용법 (PowerShell이나 터미널에서 프로젝트 폴더에서):
//   node tools/toss-sync.mjs check     ← 연결 확인 + 과거 분봉을 얼마나 멀리까지 받을 수 있는지 확인(올리지 않아요)
//   node tools/toss-sync.mjs minutes   ← 50종목·인버스·코스피 분봉을 받아서 5분 묶음으로 올려요(처음엔 오래 걸려요, 다음부턴 새 날짜만)
//   node tools/toss-sync.mjs meta      ← 1개월 거래대금 순위·투자 유의 종목·업종·휴장일을 올려요
//   node tools/toss-sync.mjs all       ← minutes + meta
//   옵션: --symbols=005930,000660 (일부 종목만), --no-upload (받기만), --reupload (받아 둔 것을 전부 다시 올리기)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED_UNIVERSE, INVERSE_ETF } from '../api/_universe.js';
import { aggregateTo5, packDay, INDEX_MIN_SYMBOL } from '../api/_minute-data.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(HERE, 'toss.env');
const DATA_DIR = path.join(HERE, '.toss-data');
const TOSS_BASE = 'https://openapi.tossinvest.com';

// ---------- 설정 읽기 ----------
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`\n설정 파일이 없어요: ${ENV_FILE}\n` +
      `tools/toss.env.example 파일을 복사해서 tools/toss.env 로 이름을 바꾸고, 안의 값을 채워 주세요.\n`);
    process.exit(1);
  }
  const env = {};
  fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  const need = ['TOSS_CLIENT_ID', 'TOSS_CLIENT_SECRET'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) { console.error(`toss.env에 값이 비어 있어요: ${missing.join(', ')}`); process.exit(1); }
  env.LEDGER_URL = (env.LEDGER_URL || 'https://ledger-invest.vercel.app').replace(/\/+$/, '');
  env.FROM_DATE = /^\d{4}-\d{2}-\d{2}$/.test(env.FROM_DATE || '') ? env.FROM_DATE : '2025-09-01';
  return env;
}

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) || 'check';
const flag = (name) => args.includes('--' + name);
const opt = (name) => { const a = args.find((x) => x.startsWith('--' + name + '=')); return a ? a.split('=').slice(1).join('=') : null; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const kstToday = () => kstNow().toISOString().slice(0, 10);
function kstParts(ts) {
  const d = new Date(new Date(ts).getTime() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isWeekday = (date) => { const w = new Date(date + 'T00:00:00Z').getUTCDay(); return w >= 1 && w <= 5; };

// ---------- 토스 API (조회만) ----------
const READ_ONLY_PATHS = ['/api/v1/candles', '/api/v1/market-indicators/', '/api/v1/rankings', '/api/v1/stocks', '/api/v1/sectors', '/api/v1/market-calendar/'];
let ENV = null;
let token = null;
let lastCallAt = 0;
const MIN_GAP_MS = 130; // 초당 7번 남짓. 한도에 걸리면(429) 토스가 알려주는 시간만큼 쉬었다가 다시 해요.

async function getToken() {
  const file = path.join(DATA_DIR, 'token.json');
  if (!token && fs.existsSync(file)) {
    try { const t = JSON.parse(fs.readFileSync(file, 'utf8')); if (t.clientId === ENV.TOSS_CLIENT_ID && t.exp > Date.now() + 10 * 60000) token = t; } catch (e) { /* 새로 받아요 */ }
  }
  if (token && token.exp > Date.now() + 10 * 60000) return token.access_token;
  // 토큰은 키 하나에 하나만 유효해요(새로 받으면 이전 것이 무효). 그래서 파일에 저장해 두고 하루 동안 다시 써요.
  const r = await fetch(TOSS_BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ENV.TOSS_CLIENT_ID, client_secret: ENV.TOSS_CLIENT_SECRET })
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 403) throw ipError();
  if (!r.ok || !body.access_token) throw new Error(`토큰 발급 실패(${r.status}): ${body.error || ''} ${body.error_description || ''}`.trim());
  token = { access_token: body.access_token, exp: Date.now() + (body.expires_in || 86400) * 1000, clientId: ENV.TOSS_CLIENT_ID };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(token));
  return token.access_token;
}

function ipError() {
  const e = new Error('IP_NOT_ALLOWED');
  e.hint = '토스가 이 PC의 인터넷 주소를 허용하지 않았어요. 토스증권 웹 → 설정 → Open API → 허용 IP 관리에서 지금 주소를 추가해 주세요.\n' +
    '지금 주소 확인: 브라우저에서 "내 IP 확인" 검색';
  return e;
}

async function tossGet(pathAndQuery) {
  if (!READ_ONLY_PATHS.some((p) => pathAndQuery.startsWith(p))) throw new Error('조회용이 아닌 주소는 부르지 않아요: ' + pathAndQuery);
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const r = await fetch(TOSS_BASE + pathAndQuery, { headers: { Authorization: 'Bearer ' + (await getToken()) } });
    if (r.status === 429) { await sleep(Math.max(1, Number(r.headers.get('retry-after')) || 1) * 1000); continue; }
    if (r.status === 401) { token = null; try { fs.unlinkSync(path.join(DATA_DIR, 'token.json')); } catch (e) { /* 없음 */ } continue; }
    if (r.status === 403) {
      const b = await r.json().catch(() => ({}));
      if (JSON.stringify(b).includes('IP')) throw ipError();
      throw new Error('권한이 없어요(403): ' + JSON.stringify(b).slice(0, 200));
    }
    if (r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    const body = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(`토스 오류 ${r.status}: ${JSON.stringify(body).slice(0, 200)}`); e.status = r.status; e.body = body; throw e; }
    return body && body.result;
  }
  throw new Error('토스가 계속 응답하지 않아요(호출 한도 또는 점검). 잠시 뒤 다시 해 주세요.');
}

// ---------- 분봉 받기 ----------
function candlesPath(sym, before) {
  const b = before ? '&before=' + encodeURIComponent(before) : '';
  if (sym === INDEX_MIN_SYMBOL) return `/api/v1/market-indicators/${INDEX_MIN_SYMBOL}/candles?interval=1m&count=200${b}`;
  return `/api/v1/candles?symbol=${sym}&interval=1m&count=200&adjusted=true${b}`;
}
// 종목 분봉의 시각은 "봉이 끝난 시각", 지수 분봉은 "봉이 시작한 시각"이에요(토스 명세). 둘 다 시작 시각으로 맞춰요.
function toBar(sym, c) {
  const { date, min } = kstParts(c.timestamp);
  const t = sym === INDEX_MIN_SYMBOL ? min : min - 1;
  return { date, bar: [t, Number(c.openPrice), Number(c.highPrice), Number(c.lowPrice), Number(c.closePrice), Number(c.volume) || 0] };
}

// 종목별 받아 둔 분봉(이 PC에만 저장): tools/.toss-data/min1/종목.json
function cachePath(sym) { return path.join(DATA_DIR, 'min1', sym + '.json'); }
function loadCache(sym) {
  try { const c = JSON.parse(fs.readFileSync(cachePath(sym), 'utf8')); c.days = c.days || {}; c.complete = c.complete || []; return c; }
  catch (e) { return { days: {}, complete: [], startReached: null }; }
}
function saveCache(sym, c) {
  fs.mkdirSync(path.dirname(cachePath(sym)), { recursive: true });
  fs.writeFileSync(cachePath(sym), JSON.stringify(c));
}

// 최신부터 과거로 거슬러 가며 받아요. 이미 다 받은 날은 건너뛰고(before를 그날 0시로), FROM_DATE보다 앞이면 멈춰요.
async function syncSymbol(sym, from) {
  const cache = loadCache(sym);
  const complete = new Set(cache.complete);
  const today = kstToday();
  const nowMin = kstNow().getUTCHours() * 60 + kstNow().getUTCMinutes();
  const todayDone = nowMin >= 16 * 60; // 오늘 장이 끝난 뒤에만 오늘을 "다 받음"으로 쳐요
  const changedDates = new Set();
  // 장이 끝난 뒤면 오늘 15:31부터(장후 시간외 분봉은 건너뛰어요), 아니면 가장 최근부터 받아요.
  let before = nowMin >= 15 * 60 + 31 ? today + 'T15:31:00+09:00' : null;
  let pages = 0, oldestSeen = null, apiEnded = false;
  for (let guard = 0; guard < 5000; guard++) {
    if (before) {
      // 이미 다 받은 날과 주말은 건너뛰어요. 건너뛴 뒤에는 그 전 거래일의 정규장 끝(15:31)부터 받아요.
      let cd = kstParts(new Date(new Date(before).getTime() - 1000).toISOString()).date;
      let jumped = false;
      while ((complete.has(cd) || !isWeekday(cd)) && cd >= from) { cd = addDays(cd, -1); jumped = true; }
      if (jumped) before = cd + 'T15:31:00+09:00';
      if (cd < from) break;
      if (cache.startReached && cd < cache.startReached) break; // 토스가 이보다 옛날 분봉은 안 준다는 걸 이미 알아요
    }
    const res = await tossGet(candlesPath(sym, before));
    pages++;
    const list = (res && res.candles) || [];
    if (!list.length) { apiEnded = true; break; }
    for (const c of list) {
      const { date, bar } = toBar(sym, c);
      // 정규장(09:00~15:30)만 보관해요. 토스는 장전·장후(08:00~20:00) 분봉도 주지만 자동매매는 정규장에서만 해요.
      if (date < from || bar[0] < 9 * 60 || bar[0] >= 15 * 60 + 30) continue;
      const day = cache.days[date] || (cache.days[date] = []);
      if (!day.some((x) => x[0] === bar[0])) day.push(bar);
      changedDates.add(date);
    }
    const oldestP = kstParts(list[list.length - 1].timestamp);
    const oldest = oldestP.date;
    oldestSeen = oldest;
    // 이번에 받은 날짜 중 이 페이지의 가장 옛날 날짜보다 뒤의 날짜는 다 받은 거예요(과거로 이어서 받고 있으니까).
    changedDates.forEach((d) => { if (d > oldest && (d < today || todayDone)) complete.add(d); });
    if (oldest < from) break;
    const next = res.nextBefore;
    if (!next || next === before) { apiEnded = true; break; }
    before = next;
    // 장 시작(09:00) 전까지 내려왔으면, 그 전날 장후 시간외(15:30~20:00) 분봉은 필요 없어서 전날 15:31로 건너뛰어요(호출 수 약 40% 절약).
    if (oldestP.min < 9 * 60) before = addDays(oldest, -1) + 'T15:31:00+09:00';
    if (pages % 20 === 0) process.stdout.write(`  ${sym}: ${oldest}까지 받는 중...\r`);
  }
  if (apiEnded && oldestSeen) {
    // 토스가 더 옛날 분봉을 주지 않으면, 받은 가장 옛날 날짜가 시작이에요. 마지막 날도 받은 만큼이 전부예요.
    const firstStored = Object.keys(cache.days).sort()[0] || null;
    if (firstStored && (!cache.startReached || firstStored < cache.startReached)) cache.startReached = firstStored;
    Object.keys(cache.days).forEach((d) => { if (d < today || todayDone) complete.add(d); });
  }
  Object.keys(cache.days).forEach((d) => cache.days[d].sort((a, b) => a[0] - b[0]));
  cache.complete = Array.from(complete).sort();
  saveCache(sym, cache);
  return { sym, pages, changedMonths: Array.from(new Set(Array.from(changedDates).map((d) => d.slice(0, 7)))), days: Object.keys(cache.days).length, startReached: cache.startReached };
}

// 받아 둔 1분봉 → 5분 묶음 압축 문자열(달 단위). 다 받은 날만 올려요.
function buildMonthDoc(sym, month) {
  const cache = loadCache(sym);
  const done = new Set(cache.complete);
  const days = {};
  Object.keys(cache.days).filter((d) => d.startsWith(month) && done.has(d)).sort().forEach((d) => {
    const bars = aggregateTo5(cache.days[d].map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })));
    if (bars.length >= 10) days[d.replace(/-/g, '')] = packDay(bars, sym === INDEX_MIN_SYMBOL ? 100 : 1);
  });
  return { sym, month, days };
}

// ---------- 사이트로 올리기 ----------
async function upload(payload) {
  if (!ENV.LEDGER_UPLOAD_KEY) throw new Error('toss.env에 LEDGER_UPLOAD_KEY(자동매매 시크릿 키)가 없어서 올릴 수 없어요.');
  const r = await fetch(ENV.LEDGER_URL + '/api/backtest?mode=toss-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ledger-key': ENV.LEDGER_UPLOAD_KEY },
    body: JSON.stringify(payload)
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`사이트에 올리기 실패(${r.status}): ${body.error || ''}`);
  return body;
}

async function uploadMonths(list) {
  // 한 번에 너무 크게 보내지 않도록 약 600KB씩 묶어요(저장소 한 번 쓰기 크기 제한).
  let batch = [], size = 0, sent = 0;
  const flush = async () => {
    if (!batch.length) return;
    await upload({ kind: 'min5', items: batch });
    sent += batch.length;
    process.stdout.write(`  올림: ${sent}/${list.length}\r`);
    batch = []; size = 0;
  };
  for (const { sym, month } of list) {
    const doc = buildMonthDoc(sym, month);
    if (!Object.keys(doc.days).length) continue;
    const s = JSON.stringify(doc).length;
    if (size + s > 600_000) await flush();
    batch.push(doc); size += s;
  }
  await flush();
  console.log(`  사이트에 ${sent}개(종목×달) 올렸어요.            `);
}

function targetSymbols() {
  const only = opt('symbols');
  const all = FIXED_UNIVERSE.map((u) => u.symbol).concat([INVERSE_ETF.symbol, INDEX_MIN_SYMBOL]);
  return only ? all.filter((s) => only.split(',').includes(s)) : all;
}

async function cmdMinutes() {
  const syms = targetSymbols();
  console.log(`분봉 받기: ${syms.length}개, ${ENV.FROM_DATE}부터 (처음엔 종목당 몇 분씩 걸릴 수 있어요. 중간에 꺼도 다음에 이어서 받아요)`);
  const toUpload = [];
  for (let i = 0; i < syms.length; i++) {
    const sym = syms[i];
    const t0 = Date.now();
    const r = await syncSymbol(sym, ENV.FROM_DATE);
    console.log(`[${i + 1}/${syms.length}] ${sym}: 요청 ${r.pages}번, 보관 ${r.days}일${r.startReached ? `, 토스가 주는 가장 옛날 날짜 ${r.startReached}` : ''} (${Math.round((Date.now() - t0) / 1000)}초)`);
    const months = flag('reupload') ? Array.from(new Set(Object.keys(loadCache(sym).days).map((d) => d.slice(0, 7)))) : r.changedMonths;
    months.forEach((month) => toUpload.push({ sym, month }));
  }
  if (flag('no-upload')) { console.log('--no-upload: 사이트에는 올리지 않았어요.'); return; }
  await uploadMonths(toUpload);
}

// ---------- 확인(check): 연결 + 과거 분봉이 얼마나 멀리까지 있는지 ----------
async function cmdCheck() {
  await getToken();
  console.log('✓ 토스 연결 성공(토큰 발급). 이 PC 주소가 허용 목록에 있어요.');
  const latest = await tossGet(candlesPath('005930', null));
  const n = latest && latest.candles ? latest.candles.length : 0;
  console.log(`✓ 삼성전자 최근 1분봉 ${n}개 받음` + (n ? ` (가장 최근: ${latest.candles[0].timestamp})` : ''));
  console.log('과거 분봉을 얼마나 멀리까지 받을 수 있는지 확인해요...');
  const today = kstToday();
  let reach = null;
  for (const daysAgo of [7, 30, 90, 180, 365, 540]) {
    const target = addDays(today, -daysAgo);
    const res = await tossGet(candlesPath('005930', target + 'T15:31:00+09:00'));
    const c = res && res.candles && res.candles[0];
    const got = c ? kstParts(c.timestamp).date : null;
    const ok = got && got >= addDays(target, -7);
    console.log(`  ${daysAgo}일 전(${target}) → ${got ? got + '의 분봉' : '없음'}${ok ? ' ✓' : ' ✗'}`);
    if (ok) reach = daysAgo; else break;
  }
  console.log(reach ? `→ 최소 ${reach}일 전 분봉까지 받을 수 있어요.` : '→ 과거 분봉은 거의 못 받아요.');
  try {
    const rk = await tossGet('/api/v1/rankings?type=MARKET_TRADING_AMOUNT&marketCountry=KR&duration=1mo&count=5');
    console.log('✓ 1개월 거래대금 순위:', (rk.rankings || []).map((x) => `${x.rank}.${x.symbol}`).join(' '));
  } catch (e) { console.log('✗ 순위 조회 실패:', e.message); }
  if (ENV.LEDGER_UPLOAD_KEY) {
    const r = await fetch(ENV.LEDGER_URL + '/api/backtest?mode=toss-status');
    console.log(r.ok ? '✓ 사이트 연결 확인' : `✗ 사이트 응답 ${r.status}(새 기능이 아직 배포 전일 수 있어요)`);
  } else console.log('! toss.env에 LEDGER_UPLOAD_KEY가 없어서 사이트에 올리기는 못 해요.');
}

// ---------- 메타(순위·유의 종목·업종·휴장일) ----------
async function cmdMeta() {
  console.log('1개월 거래대금 순위...');
  const rk = await tossGet('/api/v1/rankings?type=MARKET_TRADING_AMOUNT&marketCountry=KR&duration=1mo&count=100');
  const rows = (rk && rk.rankings) || [];
  // 종목 이름·종류(ETF 여부)는 순위에 없어서 한 번에 받아요(최대 200개).
  const info = {};
  if (rows.length) {
    const st = await tossGet('/api/v1/stocks?symbols=' + rows.map((r) => r.symbol).join(','));
    (st || []).forEach((s) => { info[s.symbol] = { name: s.name, type: s.securityType, common: s.isCommonShare }; });
  }
  const ranking1mo = {
    rankedAt: rk && rk.rankedAt,
    list: rows.map((r) => ({ rank: r.rank, symbol: r.symbol, name: (info[r.symbol] || {}).name || r.symbol, type: (info[r.symbol] || {}).type || null,
      amountEok: Math.round(Number(r.tradingAmount) / 1e8), changeRate: r.price && r.price.changeRate !== null ? Number(r.price.changeRate) : null }))
  };

  console.log('투자 유의 종목(과열·경고·위험) 확인...');
  const warnings = {};
  for (const u of FIXED_UNIVERSE.concat([INVERSE_ETF])) {
    try {
      const w = await tossGet(`/api/v1/stocks/${u.symbol}/warnings`);
      const kept = (w || []).filter((x) => !String(x.warningType).startsWith('VI_')); // VI(잠깐 멈춤)는 몇 분짜리라 빼요
      if (kept.length) warnings[u.symbol] = kept.map((x) => ({ type: x.warningType, start: x.startDate, end: x.endDate }));
    } catch (e) { /* 한 종목 실패해도 계속 */ }
  }

  console.log('토스 업종 분류...');
  const sectorOf = {};
  try {
    const all = await tossGet('/api/v1/sectors');
    const mids = ((all && all.sectors) || []).filter((s) => s.depth === 1);
    const ours = new Set(FIXED_UNIVERSE.map((u) => u.symbol));
    for (const s of mids) {
      try {
        const st = await tossGet(`/api/v1/sectors/${encodeURIComponent(s.sectorId)}/stocks?marketCountry=KR`);
        ((st && st.stocks) || []).forEach((x) => { if (ours.has(x.symbol)) (sectorOf[x.symbol] = sectorOf[x.symbol] || []).push(s.name); });
      } catch (e) { /* 계속 */ }
    }
  } catch (e) { console.log('  업종 조회 실패:', e.message); }

  console.log('휴장일(앞으로 4개월)...');
  const holidays = [];
  const today = kstToday();
  const until = addDays(today, 120);
  let d = today;
  for (let guard = 0; guard < 150 && d <= until; guard++) {
    let cal;
    try { cal = await tossGet('/api/v1/market-calendar/KR?date=' + d); } catch (e) { break; }
    if (!cal || !cal.today) break;
    if (!cal.today.integrated || !cal.today.integrated.regularMarket) { if (isWeekday(d)) holidays.push(d); }
    const next = cal.nextBusinessDay && cal.nextBusinessDay.date;
    if (!next || next <= d) break;
    // 오늘과 다음 영업일 사이의 평일은 모두 휴장일이에요.
    for (let x = addDays(d, 1); x < next; x = addDays(x, 1)) if (isWeekday(x)) holidays.push(x);
    d = next;
  }
  const uniqHol = Array.from(new Set(holidays)).sort();
  console.log(`  휴장일 ${uniqHol.length}일: ${uniqHol.join(', ') || '없음'}`);

  const meta = { ranking1mo, warnings, sectorOf, updatedAt: Date.now() };
  if (flag('no-upload')) { console.log('--no-upload: 올리지 않았어요.'); return; }
  const r = await upload({ kind: 'meta', meta, holidays: { from: today, to: d, dates: uniqHol } });
  console.log('✓ 사이트에 올렸어요.', r.ok ? '' : JSON.stringify(r));
}

async function main() {
  ENV = loadEnv();
  try {
    if (cmd === 'check') await cmdCheck();
    else if (cmd === 'minutes') await cmdMinutes();
    else if (cmd === 'meta') await cmdMeta();
    else if (cmd === 'all') { await cmdMinutes(); await cmdMeta(); }
    else { console.log('명령: check | minutes | meta | all'); process.exit(1); }
  } catch (e) {
    console.error('\n✗ ' + (e.message === 'IP_NOT_ALLOWED' ? e.hint : e.message));
    process.exit(1);
  }
}
main();
