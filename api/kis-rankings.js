// /api/kis-rankings.js
// 한국투자증권(KIS) Open API로 국내 주식 등락률/거래량 순위를 조회합니다.
// 쿼리: type=rise|fall|volume

import { getKisToken, kisHeaders, num, KIS_BASE } from './_kis.js';

async function fetchFluctuation(token, sortCls) {
  // sortCls: '0' 상승률순, '1' 하락률순
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J',
    fid_cond_scr_div_code: '20170',
    fid_input_iscd: '0000',
    fid_rank_sort_cls_code: sortCls,
    fid_input_cnt_1: '0',
    fid_prc_cls_code: '0',
    fid_input_price_1: '',
    fid_input_price_2: '',
    fid_vol_cnt: '',
    fid_trgt_cls_code: '0',
    fid_trgt_exls_cls_code: '0',
    fid_div_cls_code: '0',
    fid_rsfl_rate1: '',
    fid_rsfl_rate2: ''
  });
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/ranking/fluctuation?${params.toString()}`;
  const r = await fetch(url, { headers: kisHeaders(token, 'FHPST01700000') });
  if (!r.ok) return null;
  const data = await r.json();
  if (data.rt_cd !== '0' || !Array.isArray(data.output)) return null;
  return data.output.slice(0, 15).map((row) => ({
    symbol: row.stck_shrn_iscd,
    name: row.hts_kor_isnm,
    price: num(row.stck_prpr),
    changePct: num(row.prdy_ctrt)
  }));
}

async function fetchVolumeRank(token) {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J',
    fid_cond_scr_div_code: '20171',
    fid_input_iscd: '0000',
    fid_div_cls_code: '0',
    fid_blng_cls_code: '0',
    fid_trgt_cls_code: '111111111',
    fid_trgt_exls_cls_code: '0000000000',
    fid_input_price_1: '',
    fid_input_price_2: '',
    fid_vol_cnt: '',
    fid_input_date_1: ''
  });
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/volume-rank?${params.toString()}`;
  const r = await fetch(url, { headers: kisHeaders(token, 'FHPST01710000') });
  if (!r.ok) return null;
  const data = await r.json();
  if (data.rt_cd !== '0' || !Array.isArray(data.output)) return null;
  return data.output.slice(0, 15).map((row) => ({
    symbol: row.mksc_shrn_iscd,
    name: row.hts_kor_isnm,
    price: num(row.stck_prpr),
    changePct: num(row.prdy_ctrt),
    volume: num(row.acml_vol)
  }));
}

export default async function handler(req, res) {
  const type = (req.query.type || 'rise').trim();

  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  try {
    const token = await getKisToken();
    let rows = null;

    if (type === 'rise') rows = await fetchFluctuation(token, '0');
    else if (type === 'fall') rows = await fetchFluctuation(token, '1');
    else if (type === 'volume') rows = await fetchVolumeRank(token);
    else {
      res.status(400).json({ error: 'type은 rise, fall, volume 중 하나여야 합니다.' });
      return;
    }

    if (!rows) {
      res.status(502).json({ error: '순위 데이터를 불러오지 못했습니다.' });
      return;
    }

    res.status(200).json({ type, rows });
  } catch (e) {
    console.error('kis-rankings.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
