// /api/screen-candidates.js
// "AI 추천 종목" — 자동매매 후보를 관심종목 밖에서도 찾기 위한 1차 스크리닝입니다.
// 1) KIS 랭킹 API(상승률/거래량)로 활발히 움직이는 종목을 먼저 추려 API 호출 수를 줄이고,
// 2) 그중 상위 몇 개만 Claude(Haiku)에게 넘겨 "지금 관심 가질 만한 종목인지"를 짧게 판단시킵니다.
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
  return data.output.slice(0, 20).map((row) => ({
    symbol: row.stck_shrn_iscd, name: row.hts_kor_isnm,
    price: num(row.stck_prpr), changePct: num(row.prdy_ctrt), volume: null
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

// 상승률 + 거래량 순위 둘 다에 들면서 등락률이 너무 과열(예: +25% 이상 상한가권)은 아닌 종목만
// 1차로 추려서, 뒤에서 AI가 볼 후보 수를 8개 이하로 줄입니다.
function shortlist(riseRows, volRows) {
  const volSymbols = new Set(volRows.map((r) => r.symbol));
  const merged = new Map();
  riseRows.forEach((r) => {
    if (r.changePct === null || r.changePct > 25) return; // 상한가권 제외 (급변 위험)
    const inVolume = volSymbols.has(r.symbol);
    merged.set(r.symbol, Object.assign({}, r, { inVolumeTop: inVolume }));
  });
  return Array.from(merged.values())
    .sort((a, b) => (b.inVolumeTop === a.inVolumeTop ? b.changePct - a.changePct : (b.inVolumeTop ? 1 : -1)))
    .slice(0, 8);
}

// 반환: { ok, reasons: { 종목코드: 이유 }, reason?, message? } — ok=false면 AI를 못 쓴 것(후보를 비워야 함)
async function askAi(candidates) {
  if (candidates.length === 0) return { ok: true, reasons: {} };
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.name}(${c.symbol}) 등락률 ${c.changePct}% 거래량상위:${c.inVolumeTop ? 'Y' : 'N'}`)
    .join('\n');
  const prompt =
`아래는 오늘 국내 주식시장에서 상승률과 거래량이 함께 활발한 종목 후보 목록이야.

${list}

이 중에서 "단기 스윙(며칠 내 매매) 자동매매 후보"로 관심 가질 만한 종목을 최대 5개 골라줘.
급등 이후 조정 가능성이 큰 종목, 근거 없이 거래량만 튄 종목은 피해줘.
반드시 아래 JSON 배열 형식으로만 답해줘. 다른 설명은 붙이지 마.
[{"symbol":"005930","reason":"짧은 한국어 이유(30자 이내)"}]`;

  const ai = await askClaude({ feature: 'screen', prompt, maxTokens: 4000 });
  if (!ai.ok) return { ok: false, reasons: {}, reason: ai.reason, message: ai.message };
  const arr = extractJson(ai.text, 'array');
  if (!Array.isArray(arr)) return { ok: false, reasons: {}, reason: 'empty', message: 'AI 답을 읽지 못했어요.' };
  const reasons = {};
  arr.forEach((item) => { if (item && item.symbol) reasons[item.symbol] = item.reason || ''; });
  return { ok: true, reasons };
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
    const [riseRows, volRows] = await Promise.all([fetchFluctuation(token, '0'), fetchVolumeRank(token)]);
    const candidates = shortlist(riseRows, volRows);
    const ai = await askAi(candidates);

    const picked = candidates
      .filter((c) => ai.reasons[c.symbol])
      .map((c) => ({ symbol: c.symbol, name: c.name, price: c.price, changePct: c.changePct, reason: ai.reasons[c.symbol] }));

    // AI가 실패하면 후보를 비워요 → AI 추천 매수가 멈춰요. (AI가 "고를 게 없다"고 한 경우도 그대로 빈 목록)
    const result = {
      slot, generatedAt: Date.now(),
      aiOk: ai.ok, aiReason: ai.ok ? null : ai.reason, aiMessage: ai.ok ? null : ai.message,
      candidates: ai.ok ? picked : []
    };
    await kvSetJson(SCREEN_CACHE_KEY, result);
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
