// /api/screen-candidates.js
// 자동매매 후보를 관심종목 밖에서 찾는 "종목 고르기"입니다. 거래대금 상위 종목 중 안전 기준을 통과한 종목만 돌려줘요(규칙은 _picks.js).
// AI를 쓰지 않아서 크레딧이 없어도 돌아가요.
// - 오전/오후 구간마다 한 번만 고르고 KV에 저장해 다시 씁니다(?refresh=1이면 새로 고름).
// - 09:30 전에는 고르지 않아요. 장 시작 직후엔 거래대금이 아직 얼마 안 쌓여서 순위를 믿기 어려워요.
// - 순위나 시세를 못 받으면 후보를 비워요(안전한지 모르는 종목을 사지 않게). 실패했으면 15분 뒤에 다시 시도해요.
// 실시간 주문과는 무관한 읽기 전용 조회라 실전 KIS 키로도 안전하게 쓸 수 있습니다.

import { getKisToken, kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';
import { kvGetJson, kvSetJson } from './_kv.js';
import { fetchSymbolHistory } from './_backtest-core.js';
import {
  PICK_JOURNAL_KEY, PICK_REPORT_KEY, SCREEN_CACHE_KEY, normalizeScreen, selectByValue, gradeJournal, buildReport, appendJournal,
  screenSlot, beforeFirstPick, screenIsFresh
} from './_picks.js';

export const config = { maxDuration: 30 };

const CONFIG_KEY = 'autotrade:config';

// 거래대금 순위. KIS 문서 기준으로 소속 구분 3 = 거래금액순이고, 제외 코드는 순서대로
// 투자위험/경고/주의, 관리, 정리매매, 불성실공시, 우선주, 거래정지, ETF, ETN, 신용주문불가, SPAC 이에요(1이면 제외).
async function fetchValueRank(token, topN) {
  const params = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20171', FID_INPUT_ISCD: '0000',
    FID_DIV_CLS_CODE: '1', FID_BLNG_CLS_CODE: '3', FID_TRGT_CLS_CODE: '111111111',
    FID_TRGT_EXLS_CLS_CODE: '1111111111', FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '',
    FID_VOL_CNT: '', FID_INPUT_DATE_1: ''
  });
  const data = await fetchKisJson(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/volume-rank?${params.toString()}`, kisHeaders(token, 'FHPST01710000'));
  if (!data || !Array.isArray(data.output)) return [];
  return data.output.slice(0, topN).map((row) => ({
    symbol: row.mksc_shrn_iscd, name: row.hts_kor_isnm,
    price: num(row.stck_prpr), changePct: num(row.prdy_ctrt), tradeValue: num(row.acml_tr_pbmn)
  })).filter((r) => r.symbol);
}

// 시가총액·위험 표시는 종목별 시세에서 확인해요(5개씩 동시에). 실패한 종목은 비워 둬서 후보에서 빠지게 해요.
async function fetchQuotes(token, symbols) {
  const quotes = {};
  for (let i = 0; i < symbols.length; i += 5) {
    await Promise.all(symbols.slice(i, i + 5).map(async (s) => {
      const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${s}`;
      const data = await fetchKisJson(url, kisHeaders(token, 'FHKST01010100'));
      if (data && data.output) quotes[s] = data.output;
    }));
  }
  return quotes;
}

function eok(won) {
  const v = Number(won) / 1e8;
  return v >= 10000 ? (v / 10000).toFixed(1) + '조' : Math.round(v).toLocaleString() + '억';
}

export default async function handler(req, res) {
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }
  try {
    if (beforeFirstPick(Date.now())) {
      res.status(200).json({ waiting: true, candidates: [], note: '09:30부터 종목을 골라요.' });
      return;
    }

    const slot = screenSlot(Date.now());
    const cached = await kvGetJson(SCREEN_CACHE_KEY, null);
    if (screenIsFresh(cached, Date.now()) && req.query.refresh !== '1') {
      res.status(200).json(Object.assign({}, cached, { cached: true }));
      return;
    }

    const token = await getKisToken();
    const cfgRaw = await kvGetJson(CONFIG_KEY, null);
    const screen = normalizeScreen(cfgRaw && cfgRaw.screen);

    // 고르기 전에, 예전 고르기 기록을 채점해서 성적표를 갱신해요(한 번에 최대 8종목씩).
    let journal = await kvGetJson(PICK_JOURNAL_KEY, []);
    try {
      journal = await gradeJournal(journal, (s) => fetchSymbolHistory(token, s, 20), 8);
    } catch (e) {
      console.error('screen-candidates.js(grade) error:', e);
    }
    const report = buildReport(journal);

    const rows = await fetchValueRank(token, screen.topN);
    const quotes = await fetchQuotes(token, rows.map((r) => r.symbol));
    const { picks, rejected } = selectByValue(rows, quotes, screen);
    const ok = rows.length > 0 && Object.keys(quotes).length > 0;

    const result = {
      slot, generatedAt: Date.now(), ok,
      failReason: ok ? null : (rows.length ? '종목 시세를 받지 못했어요.' : '거래대금 순위를 받지 못했어요.'),
      screen, ranked: rows.length,
      candidates: ok ? picks.map((c) => ({
        symbol: c.symbol, name: c.name, price: c.price, changePct: c.changePct, pool: c.pool, capEok: c.capEok, tradeValue: c.tradeValue, dayOnly: !!c.dayOnly,
        reason: `거래대금 ${c.rank}위(${eok(c.tradeValue)}), 시가총액 ${eok(c.capEok * 1e8)}`
      })) : [],
      excluded: rejected.map((r) => ({ symbol: r.symbol, name: r.name, why: r.why }))
    };
    if (ok) {
      const slim = (c, extra) => Object.assign({ symbol: c.symbol, name: c.name, price: c.price, changePct: c.changePct, pool: c.pool }, extra || {});
      journal = appendJournal(journal, {
        slot, date: slot.slice(0, 10), at: Date.now(),
        picks: picks.map((c) => slim(c)),
        rejected: rejected.map((c) => slim(c, { why: c.why }))
      });
    }
    await Promise.all([kvSetJson(SCREEN_CACHE_KEY, result), kvSetJson(PICK_JOURNAL_KEY, journal), kvSetJson(PICK_REPORT_KEY, report)]);
    res.status(200).json(result);
  } catch (e) {
    console.error('screen-candidates.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
