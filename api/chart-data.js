// /api/chart-data.js
// 차트 기간(10분/일/주/월/년) 전환 전용의 "가벼운" 엔드포인트입니다.
// analysis.js는 시세+차트(일봉)+뉴스를 한 번에 가져오는 무거운 엔드포인트라, 사용자가 차트 기간이나
// 스타일(선/캔들)만 바꿀 때마다 그걸 전부 다시 부르면 낭비가 커서 별도로 분리했습니다.
//
// interval 값: '10'(국내 전용, 10분봉) | 'D'(일) | 'W'(주) | 'M'(월) | 'Y'(년, 국내 전용)
//
// 국내(KR): 일/주/월/년은 KIS 기간별시세(FHKST03010100)의 FID_PERIOD_DIV_CODE로 지원됩니다(공식 확인).
//   10분봉은 KIS 분봉 API(FHKST03010200)를 페이지네이션해서 1분봉을 모은 뒤 10분 단위로 직접 집계합니다.
//   단, 이 API는 "오늘(현재 거래일)" 데이터만 제공하고 1회 호출당 최대 30건이라, 10분봉은 오늘 하루치만 보여요.
//
// 해외(US): 일봉은 기존에 쓰던 dailyprice(HHDFS76240000, GUBN=0)를 그대로 씁니다.
//   주/월봉은 같은 API의 GUBN=1/2 파라미터로 시도하는 best-effort 방식이라(공식 문서로 100% 확인은 못했어요),
//   응답이 비어있으면 unsupported로 표시하고 프론트에서 해당 탭을 숨깁니다. 10분봉/년봉은 해외 미지원입니다.

import { getKisToken, kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';

export const config = { maxDuration: 30 };

function todayYYYYMMDD() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function ymdMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------------- 국내: 일/주/월/년 ---------------- */
async function fetchDomesticPeriodChart(token, symbol, periodCode) {
  const lookbackDays = { D: 180, W: 730, M: 1825, Y: 3650 }[periodCode] || 180;
  const url =
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` +
    `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}` +
    `&FID_INPUT_DATE_1=${ymdMinus(lookbackDays)}&FID_INPUT_DATE_2=${todayYYYYMMDD()}` +
    `&FID_PERIOD_DIV_CODE=${periodCode}&FID_ORG_ADJ_PRC=0`;
  const data = await fetchKisJson(url, kisHeaders(token, 'FHKST03010100'));
  if (!data || !Array.isArray(data.output2)) return [];
  return data.output2
    .filter((row) => row.stck_bsop_date)
    .map((row) => ({
      date: row.stck_bsop_date,
      open: num(row.stck_oprc), high: num(row.stck_hgpr), low: num(row.stck_lwpr),
      close: num(row.stck_clpr), volume: num(row.acml_vol)
    }))
    .reverse();
}

/* ---------------- 국내: 10분봉 (1분봉을 모아서 직접 집계) ---------------- */
async function fetchDomesticMinuteBars(token, symbol, maxPages) {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST
  let hourParam = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + '00';
  const seen = new Set();
  const rows = [];

  for (let i = 0; i < maxPages; i++) {
    const url =
      `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice` +
      `?FID_ETC_CLS_CODE=&FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}` +
      `&FID_INPUT_HOUR_1=${hourParam}&FID_PW_DATA_INCU_YN=Y`;
    const data = await fetchKisJson(url, kisHeaders(token, 'FHKST03010200'));
    if (!data || !Array.isArray(data.output2) || data.output2.length === 0) break;

    let earliest = null;
    for (const row of data.output2) {
      const t = row.stck_cntg_hour;
      if (!t || seen.has(t)) continue;
      seen.add(t);
      rows.push({
        time: t, date: row.stck_bsop_date,
        open: num(row.stck_oprc), high: num(row.stck_hgpr), low: num(row.stck_lwpr),
        close: num(row.stck_prpr), volume: num(row.cntg_vol)
      });
      if (earliest === null || t < earliest) earliest = t;
    }
    if (!earliest || earliest === hourParam) break; // 진행이 없으면 무한루프 방지로 중단
    hourParam = earliest;
    if (data.output2.length < 30) break; // 이 API의 페이지당 최대 건수보다 적게 왔으면 마지막 페이지
  }

  rows.sort((a, b) => a.time.localeCompare(b.time));
  return rows;
}

function aggregateMinuteBars(rows, bucketMinutes) {
  const buckets = new Map();
  rows.forEach((r) => {
    if (r.open === null || r.high === null || r.low === null || r.close === null) return;
    const hh = parseInt(r.time.slice(0, 2), 10);
    const mm = parseInt(r.time.slice(2, 4), 10);
    const totalMin = hh * 60 + mm;
    const bucketStart = Math.floor(totalMin / bucketMinutes) * bucketMinutes;
    const key = String(Math.floor(bucketStart / 60)).padStart(2, '0') + String(bucketStart % 60).padStart(2, '0');
    if (!buckets.has(key)) {
      buckets.set(key, { time: key, date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: 0 });
    }
    const b = buckets.get(key);
    b.high = Math.max(b.high, r.high);
    b.low = Math.min(b.low, r.low);
    b.close = r.close; // rows는 시간순 정렬돼 있어 마지막에 처리된 값이 그 버킷의 종가
    b.volume += r.volume || 0;
  });
  return Array.from(buckets.values()).sort((a, b) => a.time.localeCompare(b.time));
}

/* ---------------- 해외: 일/주/월 (주/월은 best-effort) ---------------- */
async function fetchOverseasChart(token, excd, symbol, gubn) {
  const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/dailyprice?AUTH=&EXCD=${excd}&SYMB=${symbol}&GUBN=${gubn}&BYMD=&MODP=1`;
  const data = await fetchKisJson(url, kisHeaders(token, 'HHDFS76240000'));
  if (!data || !Array.isArray(data.output2)) return [];
  return data.output2
    .filter((row) => row.xymd)
    .map((row) => ({
      date: row.xymd, open: num(row.open), high: num(row.high), low: num(row.low),
      close: num(row.clos), volume: num(row.tvol)
    }))
    .reverse();
}

async function findOverseasExchange(token, symbol, hint) {
  const ALL = ['NAS', 'NYS', 'AMS'];
  const order = hint && ALL.includes(hint) ? [hint, ...ALL.filter((e) => e !== hint)] : ALL;
  for (const excd of order) {
    const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/price-detail?AUTH=&EXCD=${excd}&SYMB=${symbol}`;
    const data = await fetchKisJson(url, kisHeaders(token, 'HHDFS76200200'));
    if (data && data.output && data.output.last) return excd;
  }
  return null;
}

export default async function handler(req, res) {
  const rawSymbol = (req.query.symbol || '').trim();
  const isKR = /^\d{6}$/.test(rawSymbol);
  const symbol = isKR ? rawSymbol : rawSymbol.toUpperCase();
  const interval = (req.query.interval || 'D').toUpperCase();
  const exchangeHint = (req.query.exchange || '').toUpperCase();

  if (!symbol) {
    res.status(400).json({ error: '종목 코드가 필요합니다.' });
    return;
  }
  if (!['10', 'D', 'W', 'M', 'Y'].includes(interval)) {
    res.status(400).json({ error: '지원하지 않는 interval입니다.' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  try {
    const token = await getKisToken();

    if (isKR) {
      if (interval === '10') {
        const minuteBars = await fetchDomesticMinuteBars(token, symbol, 10); // 최대 10페이지(약 300분치)
        const rows = aggregateMinuteBars(minuteBars, 10);
        res.status(200).json({
          symbol, market: 'KR', interval, rows, unsupported: false,
          note: '10분봉은 오늘(현재 거래일) 데이터만 제공돼요.'
        });
        return;
      }
      const rows = await fetchDomesticPeriodChart(token, symbol, interval);
      res.status(200).json({ symbol, market: 'KR', interval, rows, unsupported: false });
      return;
    }

    // 해외
    if (interval === '10' || interval === 'Y') {
      res.status(200).json({
        symbol, market: 'US', interval, rows: [], unsupported: true,
        note: interval === '10' ? '해외 종목은 분봉을 지원하지 않아요.' : '해외 종목은 연봉을 지원하지 않아요.'
      });
      return;
    }

    const excd = ['NAS', 'NYS', 'AMS'].includes(exchangeHint) ? exchangeHint : await findOverseasExchange(token, symbol, exchangeHint);
    if (!excd) {
      res.status(404).json({ error: '해당 종목의 거래소를 찾을 수 없습니다.' });
      return;
    }

    const gubn = interval === 'D' ? '0' : (interval === 'W' ? '1' : '2');
    const rows = await fetchOverseasChart(token, excd, symbol, gubn);
    res.status(200).json({
      symbol, market: 'US', interval, exchange: excd, rows,
      unsupported: rows.length === 0 && interval !== 'D',
      note: interval !== 'D' ? '해외 주/월봉은 KIS 문서로 100% 확인되지 않은 best-effort 데이터예요.' : undefined
    });
  } catch (e) {
    console.error('chart-data.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
