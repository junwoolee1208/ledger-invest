// /api/screen-candidates.js
// "AI 추천 종목" — 자동매매 후보를 관심종목 밖에서도 찾기 위한 1차 스크리닝입니다.
// 1) KIS 랭킹 API(상승률/거래량)로 활발히 움직이는 종목을 먼저 추려 API 호출 수를 줄이고,
// 2) 그중 상위 몇 개만 Claude(Haiku)에게 넘겨 "지금 관심 가질 만한 종목인지"를 짧게 판단시킵니다.
// 실시간 주문과는 무관한 읽기 전용 조회라 실전 KIS 키로도 안전하게 쓸 수 있습니다.

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';

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

async function askAi(candidates, apiKey) {
  if (!apiKey || candidates.length === 0) return {};
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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) return {};
  const data = await response.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  try {
    const jsonStart = text.indexOf('[');
    const jsonEnd = text.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) return {};
    const arr = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    const map = {};
    arr.forEach((item) => { if (item && item.symbol) map[item.symbol] = item.reason || ''; });
    return map;
  } catch (e) {
    return {};
  }
}

export default async function handler(req, res) {
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }
  try {
    const token = await getKisToken();
    const [riseRows, volRows] = await Promise.all([fetchFluctuation(token, '0'), fetchVolumeRank(token)]);
    const candidates = shortlist(riseRows, volRows);
    const reasons = await askAi(candidates, process.env.ANTHROPIC_API_KEY);

    const picked = candidates
      .filter((c) => reasons[c.symbol])
      .map((c) => ({ symbol: c.symbol, name: c.name, price: c.price, changePct: c.changePct, reason: reasons[c.symbol] }));

    // AI 호출이 실패했거나 아무것도 안 골랐으면, 최소한 1차 스크리닝 상위 3개는 이유 없이 반환
    const fallback = picked.length > 0 ? picked : candidates.slice(0, 3).map((c) => ({
      symbol: c.symbol, name: c.name, price: c.price, changePct: c.changePct, reason: '거래량/등락률 상위 (AI 분석 불가)'
    }));

    res.status(200).json({ candidates: fallback, generatedAt: Date.now() });
  } catch (e) {
    console.error('screen-candidates.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
