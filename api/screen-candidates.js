// /api/screen-candidates.js
// "AI 추천 종목" — 자동매매 후보를 관심종목 밖에서도 찾기 위한 1차 스크리닝입니다.
// 1) KIS 랭킹 API(오른 순위·떨어진 순위·거래량 순위)에서 후보를 모으고,
// 2) _picks.js 규칙으로 걸러내고(우선주·ETF·동전주 등), 전략별 묶음(오르는 중/조금 오른/떨어진)으로 점수를 매긴 뒤,
// 3) AI는 그중 "피해야 할 종목"만 걸러요. 고른 것·걸러진 것은 기록해 두고 3거래일 뒤 채점해서 성적표·교훈을 만들어요.
// 실시간 주문과는 무관한 읽기 전용 조회라 실전 KIS 키로도 안전하게 쓸 수 있습니다.
//
// 바뀐 점(2026-10):
// - 예전엔 자동매매가 몇 분마다 실행될 때마다 AI를 새로 불러서 후보가 계속 바뀌고 비용도 계속 나갔어요.
//   이제 하루를 오전/오후 두 구간으로 나눠, 구간마다 한 번만 고르고 KV에 저장해 다시 씁니다(?refresh=1이면 새로 고름).
// - 예전엔 AI가 실패하면 "상승률 상위 3개"를 이유 없이 그대로 넘겨서, 사실상 오늘 제일 많이 오른 주식을 사고 있었어요.
//   이제 AI가 실패하면 후보를 비워서 AI 추천 매수를 멈추고, 실패 이유를 함께 돌려줍니다.

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';
import { kvGetJson, kvSetJson } from './_kv.js';
import { askClaude, extractJson } from './_ai.js';
import { fetchSymbolHistory } from './_backtest-core.js';
import { PICK_JOURNAL_KEY, PICK_REPORT_KEY, POOL_LABEL, buildPools, gradeJournal, buildReport, appendJournal } from './_picks.js';

const SCREEN_CACHE_KEY = 'screen:cache';
const RETRY_AFTER_FAIL_MS = 15 * 60 * 1000; // AI가 실패했으면 15분 뒤에 다시 시도

// 오늘(KST) + 오전/오후 구간 — 이 값이 바뀔 때만 새로 고릅니다.
function screenSlot() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10) + (d.getUTCHours() < 12 ? '-am' : '-pm');
}

export const config = { maxDuration: 30 };

async function fetchFluctuation(token, sortCls) {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20170', fid_input_iscd: '0000',
    fid_rank_sort_cls_code: sortCls, fid_input_cnt_1: '0', fid_prc_cls_code: '0',
    fid_input_price_1: '', fid_input_price_2: '', fid_vol_cnt: '', fid_trgt_cls_code: '0',
    fid_trgt_exls_cls_code: '0', fid_div_cls_code: '0', fid_rsfl_rate1: '', fid_rsfl_rate2: ''
  });
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/ranking/fluctuation?${params.toString()}`;
  const r = await fetch(url, { headers: kisHeaders(token, 'FHPST01700000') });
  if (!r.ok) return [];
  const data = await r.json();
  if (data.rt_cd !== '0' || !Array.isArray(data.output)) return [];
  return data.output.slice(0, 30).map((row) => ({
    symbol: row.stck_shrn_iscd, name: row.hts_kor_isnm,
    price: num(row.stck_prpr), changePct: num(row.prdy_ctrt), volume: num(row.acml_vol)
  }));
}

async function fetchVolumeRank(token) {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20171', fid_input_iscd: '0000',
    fid_div_cls_code: '0', fid_blng_cls_code: '0', fid_trgt_cls_code: '111111111',
    fid_trgt_exls_cls_code: '0000000000', fid_input_price_1: '', fid_input_price_2: '',
    fid_vol_cnt: '', fid_input_date_1: ''
  });
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/volume-rank?${params.toString()}`;
  const r = await fetch(url, { headers: kisHeaders(token, 'FHPST01710000') });
  if (!r.ok) return [];
  const data = await r.json();
  if (data.rt_cd !== '0' || !Array.isArray(data.output)) return [];
  return data.output.slice(0, 20).map((row) => ({
    symbol: row.mksc_shrn_iscd, name: row.hts_kor_isnm,
    price: num(row.stck_prpr), changePct: num(row.prdy_ctrt), volume: num(row.acml_vol)
  }));
}

// AI의 역할: 점수 규칙으로 뽑은 후보 중 "피해야 할 종목"만 이유와 함께 걸러요(고르는 건 규칙, 거르는 건 AI).
// 지난 고르기 성적(어떤 구간의 종목이 3거래일 뒤 어땠는지)을 같이 줘서, 기록에서 배운 대로 거르게 해요.
// 반환: { ok, avoid: { 종목: 이유 }, notes: { 종목: 한 줄 이유 }, reason?, message? }
async function askAi(candidates, lessons) {
  if (candidates.length === 0) return { ok: true, avoid: {}, notes: {} };
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.name}(${c.symbol}) [${POOL_LABEL[c.pool]}] 등락률 ${c.changePct}% 거래량상위:${c.inVolumeTop ? 'Y' : 'N'} 규칙점수 ${c.score}`)
    .join('\n');
  const prompt =
`아래는 규칙으로 1차로 뽑은 국내 주식 후보야. 자동매매(가짜 돈 시뮬레이션) 후보로 쓰기 전에 "피해야 할 종목"만 걸러줘.
묶음 뜻: [오르는 중]=추세를 따라 사는 전략용, [조금 오른 활발한 종목]=완만한 상승 초입, [떨어진 탄탄한 종목]=반등을 노리는 전략용.

${list}

지난 고르기 성적(고른 뒤 3거래일 결과): ${lessons && lessons.length ? '\n' + lessons.map((l) => '- ' + l).join('\n') : '아직 기록 없음'}

피해야 할 경우 예: 이미 너무 올라 조정 위험이 큰 경우, 근거 없이 거래량만 튄 경우, 지난 성적에서 계속 나빴던 구간에 해당하는 경우.
모르면 거르지 마. 아래 JSON으로만 답해(다른 설명 없이):
{"avoid":[{"symbol":"코드","reason":"30자 이내"}],"notes":[{"symbol":"코드","reason":"남긴 종목의 한 줄 이유, 30자 이내"}]}`;

  const ai = await askClaude({ feature: 'screen', prompt, maxTokens: 4000 });
  if (!ai.ok) return { ok: false, avoid: {}, notes: {}, reason: ai.reason, message: ai.message };
  const obj = extractJson(ai.text, 'object');
  if (!obj) return { ok: false, avoid: {}, notes: {}, reason: 'empty', message: 'AI 답을 읽지 못했어요.' };
  const avoid = {}, notes = {};
  (obj.avoid || []).forEach((x) => { if (x && x.symbol) avoid[x.symbol] = x.reason || ''; });
  (obj.notes || []).forEach((x) => { if (x && x.symbol) notes[x.symbol] = x.reason || ''; });
  return { ok: true, avoid, notes };
}

export default async function handler(req, res) {
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }
  try {
    // 이번 구간(오전/오후)에 이미 골라둔 게 있으면 그대로 돌려줘요. 실패했던 결과는 15분 뒤에 다시 시도해요.
    const slot = screenSlot();
    const cached = await kvGetJson(SCREEN_CACHE_KEY, null);
    const fresh = cached && cached.slot === slot && (cached.aiOk || Date.now() - cached.generatedAt < RETRY_AFTER_FAIL_MS);
    if (fresh && req.query.refresh !== '1') {
      res.status(200).json(Object.assign({}, cached, { cached: true }));
      return;
    }

    const token = await getKisToken();

    // 고르기 전에, 3거래일이 지난 예전 고르기 기록을 채점해서 성적표·교훈을 갱신해요(한 번에 최대 8종목씩).
    let journal = await kvGetJson(PICK_JOURNAL_KEY, []);
    try {
      journal = await gradeJournal(journal, (s) => fetchSymbolHistory(token, s, 20), 8);
    } catch (e) {
      console.error('screen-candidates.js(grade) error:', e);
    }
    const report = buildReport(journal);

    // 오른 순위('0'), 떨어진 순위('1'), 거래량 순위를 가져와 묶음별 후보를 점수 순으로 만들어요.
    const [riseRows, fallRows, volRows] = await Promise.all([fetchFluctuation(token, '0'), fetchFluctuation(token, '1'), fetchVolumeRank(token)]);
    const { pools, excluded } = buildPools(riseRows, fallRows, volRows);
    const candidates = pools.rise.concat(pools.calm, pools.fall);
    const ai = await askAi(candidates, report.lessons);

    const kept = candidates.filter((c) => !ai.avoid[c.symbol]);
    const picked = kept.map((c) => ({
      symbol: c.symbol, name: c.name, price: c.price, changePct: c.changePct, pool: c.pool,
      reason: `[${POOL_LABEL[c.pool]}] ${ai.notes[c.symbol] || '규칙 점수 ' + c.score}`
    }));

    // AI가 실패하면 후보를 비워요 → AI 추천 매수가 멈춰요. 성공했으면 고른 것·걸러진 것을 기록해 나중에 채점해요.
    const result = {
      slot, generatedAt: Date.now(),
      aiOk: ai.ok, aiReason: ai.ok ? null : ai.reason, aiMessage: ai.ok ? null : ai.message,
      candidates: ai.ok ? picked : [],
      avoided: ai.ok ? candidates.filter((c) => ai.avoid[c.symbol]).map((c) => ({ symbol: c.symbol, name: c.name, why: ai.avoid[c.symbol] })) : [],
      excluded: excluded.slice(0, 20)
    };
    if (ai.ok) {
      const slim = (c, extra) => Object.assign({ symbol: c.symbol, name: c.name, price: c.price, changePct: c.changePct, pool: c.pool }, extra || {});
      journal = appendJournal(journal, {
        slot, date: slot.slice(0, 10), at: Date.now(),
        picks: kept.map((c) => slim(c)),
        rejected: candidates.filter((c) => ai.avoid[c.symbol]).map((c) => slim(c, { why: ai.avoid[c.symbol] }))
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
