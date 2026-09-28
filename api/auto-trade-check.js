// /api/auto-trade-check.js
// 외부 무료 스케줄러(cron-job.org 등)가 주기적으로 호출하는 자동매매 실행 엔드포인트입니다.
//
// 지금은 아직 한국투자증권 "모의투자" API 키가 없는 상태라, 실제 모의투자 주문을 넣는 대신
// Vercel KV 안에서 가상의 현금(기본 1천만원)과 보유종목을 직접 추적하는 "내부 시뮬레이션"으로
// 매매 신호/리스크 규칙 로직을 미리 검증합니다. 모의투자 키가 발급되면 이 파일의 executeBuy/
// executeSell만 실제 KIS 모의투자 주문 API 호출로 교체하면 됩니다 (신호 로직은 그대로 재사용).
//
// 보안: 아무나 이 URL을 호출해서 매매를 조작하지 못하도록, 쿼리 파라미터 key가
// 환경변수 AUTO_TRADE_SECRET과 일치할 때만 동작합니다.

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';
import { kvGetJson, kvSetJson, kvReady } from './_kv.js';

export const config = { maxDuration: 30 };

const CONFIG_KEY = 'autotrade:config';
const POSITIONS_KEY = 'autotrade:positions';
const CASH_KEY = 'autotrade:cash';
const LOG_KEY = 'autotrade:log';
const STARTING_CASH = 10_000_000; // 시뮬레이션 초기 가상 자금(원)
const MAX_LOG = 300;

function todayKST() {
  // 서버 시간이 UTC라 KST(+9)로 보정해서 "날짜"를 계산합니다.
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function fetchDomesticQuote(token, symbol) {
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  const r = await fetch(url, { headers: kisHeaders(token, 'FHKST01010100') });
  if (!r.ok) return null;
  const data = await r.json();
  if (data.rt_cd !== '0' || !data.output) return null;
  const o = data.output;
  return {
    symbol, name: o.hts_kor_isnm || symbol,
    price: num(o.stck_prpr), changePct: num(o.prdy_ctrt)
  };
}

async function loadCandidateSymbols(cfg, req) {
  const symbols = new Map();
  (cfg.symbols || []).forEach((s) => symbols.set(s, { symbol: s, name: null, reason: '관심종목' }));

  if (cfg.useAiCandidates) {
    try {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host;
      const r = await fetch(`${proto}://${host}/api/screen-candidates`);
      if (r.ok) {
        const data = await r.json();
        (data.candidates || []).forEach((c) => {
          // 스크리닝 단계에서 이미 한글 종목명을 받아왔으니(name), 그대로 들고 가서
          // 나중에 시세 재조회 시 이름이 비어 나오는 경우를 대비한 폴백으로 씁니다.
          if (!symbols.has(c.symbol)) symbols.set(c.symbol, { symbol: c.symbol, name: c.name || null, reason: 'AI 추천: ' + c.reason });
        });
      }
    } catch (e) {
      console.error('auto-trade-check: AI 후보 조회 실패', e);
    }
  }
  return Array.from(symbols.values()).slice(0, 20); // 과호출 방지로 상한
}

async function appendLog(entry) {
  const log = await kvGetJson(LOG_KEY, []);
  log.unshift(entry);
  if (log.length > MAX_LOG) log.length = MAX_LOG;
  await kvSetJson(LOG_KEY, log);
}

export default async function handler(req, res) {
  if (!kvReady()) {
    res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
    return;
  }
  const secret = process.env.AUTO_TRADE_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'AUTO_TRADE_SECRET 환경변수가 설정되지 않았습니다.' });
    return;
  }
  if ((req.query.key || '') !== secret) {
    res.status(401).json({ error: '인증 키가 올바르지 않습니다.' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  const cfg = await kvGetJson(CONFIG_KEY, null);
  if (!cfg || !cfg.enabled) {
    res.status(200).json({ skipped: true, reason: 'disabled' });
    return;
  }

  try {
    const token = await getKisToken();
    const positions = await kvGetJson(POSITIONS_KEY, {});
    let cash = await kvGetJson(CASH_KEY, STARTING_CASH);
    if (typeof cash !== 'number') cash = STARTING_CASH;

    const today = todayKST();
    const log = await kvGetJson(LOG_KEY, []);
    const tradesToday = log.filter((e) => e.date === today && e.side !== 'STOP_LOSS').length;
    const risk = cfg.risk || {};
    const positionPct = risk.positionPct || 5;
    const stopLossPct = risk.stopLossPct || 5;
    const takeProfitPct = risk.takeProfitPct || 10;
    const maxTradesPerDay = risk.maxTradesPerDay || 3;

    const actions = [];

    // 1) 보유 종목 먼저 점검 — 손절/익절 (손절은 일일 매매 한도와 무관하게 항상 실행: 손실 방어가 우선)
    for (const symbol of Object.keys(positions)) {
      const pos = positions[symbol];
      const q = await fetchDomesticQuote(token, symbol);
      if (!q || q.price === null) continue;
      const pnlPct = ((q.price - pos.avgPrice) / pos.avgPrice) * 100;

      let side = null;
      if (pnlPct <= -stopLossPct) side = 'STOP_LOSS';
      else if (pnlPct >= takeProfitPct && tradesToday < maxTradesPerDay) side = 'TAKE_PROFIT';

      if (side) {
        const proceeds = pos.qty * q.price;
        cash += proceeds;
        delete positions[symbol];
        // 매수 시점에 저장해둔 이름(pos.name)을 우선 쓰고, 없을 때만 방금 조회한 이름을 씁니다 —
        // 시세 조회 응답에서 가끔 종목명이 비어 오는 경우가 있어서 코드가 그대로 노출되는 걸 막아줍니다.
        const entry = {
          ts: Date.now(), date: today, symbol, name: pos.name || q.name || symbol, side,
          qty: pos.qty, price: q.price, pnlPct: Math.round(pnlPct * 100) / 100, mode: 'dryrun'
        };
        await appendLog(entry);
        actions.push(entry);
      }
    }

    // 2) 신규 매수 후보 평가 (일일 매매 한도 내에서만)
    const currentTradesToday = tradesToday + actions.filter((a) => a.side === 'TAKE_PROFIT').length;
    if (currentTradesToday < maxTradesPerDay) {
      const candidates = await loadCandidateSymbols(cfg, req);
      for (const cand of candidates) {
        if (positions[cand.symbol]) continue; // 이미 보유 중이면 스킵
        const remainingSlots = maxTradesPerDay - (tradesToday + actions.filter((a) => a.side === 'BUY').length);
        if (remainingSlots <= 0) break;

        const q = await fetchDomesticQuote(token, cand.symbol);
        if (!q || q.price === null || q.changePct === null) continue;

        // 아주 단순한 모멘텀 규칙: 관심종목은 +3% 이상, AI 추천 종목은 AI가 이미 골랐으므로 +1% 이상만 넘으면 매수
        const isAi = cand.reason.indexOf('AI 추천') === 0;
        const threshold = isAi ? 1 : 3;
        if (q.changePct < threshold) continue;

        const budget = cash * (positionPct / 100);
        const qty = Math.floor(budget / q.price);
        if (qty < 1) continue;

        const cost = qty * q.price;
        cash -= cost;
        // 스크리닝 단계 이름(cand.name)을 우선 쓰고, 없으면 방금 조회한 이름을 씁니다.
        const displayName = cand.name || q.name || cand.symbol;
        positions[cand.symbol] = { qty, avgPrice: q.price, entryDate: today, name: displayName };
        const entry = {
          ts: Date.now(), date: today, symbol: cand.symbol, name: displayName, side: 'BUY',
          qty, price: q.price, reason: cand.reason, mode: 'dryrun'
        };
        await appendLog(entry);
        actions.push(entry);
      }
    }

    await kvSetJson(POSITIONS_KEY, positions);
    await kvSetJson(CASH_KEY, cash);

    res.status(200).json({ ok: true, actions, cash, positions, checkedAt: Date.now() });
  } catch (e) {
    console.error('auto-trade-check.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
