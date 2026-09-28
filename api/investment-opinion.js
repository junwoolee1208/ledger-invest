// /api/investment-opinion.js
// "AI 투자의견" — 뉴스 + 호가(매수/매도 잔량) + 외국인/기관 수급 + 애널리스트 투자의견/목표주가를
// 한 번에 모아서 Claude에게 매수/매도/보유, 목표주가, 예상 보유기간을 종합 판단시킵니다.
// 국내: KIS의 호가/투자자/종목투자의견 API. 해외: Finnhub의 추천의견/목표주가 API.
// 일부 데이터(특히 국내 종목투자의견)는 API 스펙이 확실치 않아 실패해도 나머지 데이터로 계속 진행합니다.

import { getKisToken, kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';

export const config = { maxDuration: 30 };

/* ---------------- 국내: 호가 ---------------- */
async function fetchAskingPrice(token, symbol) {
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  const data = await fetchKisJson(url, kisHeaders(token, 'FHKST01010200'));
  if (!data || !data.output1) return null;
  const o = data.output1;
  return {
    askPrice1: num(o.askp1), askVol1: num(o.askp_rsqn1),
    bidPrice1: num(o.bidp1), bidVol1: num(o.bidp_rsqn1),
    totalAskVol: num(o.total_askp_rsqn), totalBidVol: num(o.total_bidp_rsqn)
  };
}

/* ---------------- 국내: 외국인/기관 매매동향 ---------------- */
async function fetchInvestorTrend(token, symbol) {
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  const data = await fetchKisJson(url, kisHeaders(token, 'FHKST01010900'));
  if (!data || !Array.isArray(data.output) || !data.output[0]) return null;
  const o = data.output[0]; // 최근일
  return {
    date: o.stck_bsop_date || null,
    foreignNet: num(o.frgn_ntby_qty), // 외국인 순매수 수량
    institutionNet: num(o.orgn_ntby_qty), // 기관 순매수 수량
    individualNet: num(o.prsn_ntby_qty) // 개인 순매수 수량
  };
}

/* ---------------- 국내: 종목투자의견 (best-effort — 실패해도 무시) ---------------- */
async function fetchInvestOpinion(token, symbol) {
  try {
    const today = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - 3);
    const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const url =
      `${KIS_BASE}/uapi/domestic-stock/v1/quotations/invest-opinion?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=16633` +
      `&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${ymd(from)}&FID_INPUT_DATE_2=${ymd(today)}`;
    const data = await fetchKisJson(url, kisHeaders(token, 'FHKST663300C0'));
    if (!data || !Array.isArray(data.output) || data.output.length === 0) return null;
    const latest = data.output[0];
    return {
      opinion: latest.invt_opnn || null, // 투자의견 (매수/중립 등)
      targetPrice: num(latest.hts_goal_prc), // 목표주가
      securityFirm: latest.mbcr_name || null,
      date: latest.stck_bsop_date || null
    };
  } catch (e) {
    return null; // API 스펙이 다를 수 있어 실패는 조용히 무시하고 나머지 데이터로 진행
  }
}

/* ---------------- 해외: Finnhub 추천의견/목표주가 ---------------- */
async function fetchFinnhubOpinion(symbol, apiKey) {
  if (!apiKey) return null;
  try {
    const [recRes, targetRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`),
      fetch(`https://finnhub.io/api/v1/stock/price-target?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`)
    ]);
    const rec = recRes.ok ? await recRes.json() : [];
    const target = targetRes.ok ? await targetRes.json() : null;
    const latestRec = Array.isArray(rec) && rec.length ? rec[0] : null;
    return {
      recommendation: latestRec ? {
        strongBuy: latestRec.strongBuy, buy: latestRec.buy, hold: latestRec.hold,
        sell: latestRec.sell, strongSell: latestRec.strongSell, period: latestRec.period
      } : null,
      targetPrice: target && target.targetMean ? {
        mean: target.targetMean, high: target.targetHigh, low: target.targetLow
      } : null
    };
  } catch (e) {
    return null;
  }
}

/* ---------------- 뉴스 ---------------- */
async function fetchNews(symbol, market, apiKey) {
  if (!apiKey) return [];
  try {
    const fhSymbol = market === 'KR' ? `${symbol}.KS` : symbol.toUpperCase();
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 10);
    const fmtDate = (d) => d.toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(fhSymbol)}&from=${fmtDate(from)}&to=${fmtDate(to)}&token=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    return data.slice(0, 6).map((a) => a.headline).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/* ---------------- Claude에게 종합 판단 요청 ---------------- */
async function askAi(payload, apiKey) {
  if (!apiKey) return null;
  const lines = [];
  lines.push(`종목: ${payload.name} (${payload.symbol})`);
  lines.push(`현재가: ${payload.price} (등락률 ${payload.changePct}%)`);
  if (payload.per !== null) lines.push(`PER: ${payload.per}, PBR: ${payload.pbr}`);
  if (payload.asking) {
    lines.push(`호가: 매도1호가 ${payload.asking.askPrice1}(잔량 ${payload.asking.askVol1}), 매수1호가 ${payload.asking.bidPrice1}(잔량 ${payload.asking.bidVol1}), 총매도잔량 ${payload.asking.totalAskVol}, 총매수잔량 ${payload.asking.totalBidVol}`);
  }
  if (payload.investorTrend) {
    lines.push(`최근 수급(${payload.investorTrend.date}): 외국인 순매수 ${payload.investorTrend.foreignNet}주, 기관 순매수 ${payload.investorTrend.institutionNet}주, 개인 순매수 ${payload.investorTrend.individualNet}주`);
  }
  if (payload.krOpinion) {
    lines.push(`증권사 투자의견(${payload.krOpinion.securityFirm}): ${payload.krOpinion.opinion}, 목표주가 ${payload.krOpinion.targetPrice}`);
  }
  if (payload.usOpinion) {
    if (payload.usOpinion.recommendation) {
      const r = payload.usOpinion.recommendation;
      lines.push(`애널리스트 의견 분포: 적극매수 ${r.strongBuy}, 매수 ${r.buy}, 중립 ${r.hold}, 매도 ${r.sell}, 적극매도 ${r.strongSell}`);
    }
    if (payload.usOpinion.targetPrice) {
      const t = payload.usOpinion.targetPrice;
      lines.push(`애널리스트 목표주가: 평균 ${t.mean}, 최고 ${t.high}, 최저 ${t.low}`);
    }
  }
  if (payload.news && payload.news.length) {
    lines.push('최근 뉴스:');
    payload.news.forEach((h, i) => lines.push(`${i + 1}. ${h}`));
  }

  const prompt =
`너는 투자 데이터를 종합해서 참고 의견을 주는 애널리스트야. 아래 데이터를 보고 판단해줘.

${lines.join('\n')}

아래 형식의 JSON으로만 답해줘 (다른 설명 붙이지 마):
{"opinion":"매수|매도|중립 중 하나","targetPrice":숫자 또는 null,"holdingPeriod":"짧은 한국어 표현(예: 2~4주)","confidence":"낮음|보통|높음 중 하나","summary":"3~4문장 이내 한국어 근거 요약"}

- 데이터가 부족하면 confidence를 "낮음"으로, targetPrice는 null로 해줘.
- 절대 확정적으로 말하지 말고, 어디까지나 참고 의견이라는 톤을 유지해줘.
- summary 안에 반드시 "투자 손실에 대한 책임은 본인에게 있습니다" 같은 취지를 넣어줘.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) return null;
  const data = await response.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  try {
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return null;
    return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  const rawSymbol = (req.query.symbol || '').trim();
  const isKR = /^\d{6}$/.test(rawSymbol);
  const symbol = isKR ? rawSymbol : rawSymbol.toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: '종목 코드가 필요합니다.' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  try {
    const token = await getKisToken();
    const newsPromise = fetchNews(symbol, isKR ? 'KR' : 'US', process.env.FINNHUB_API_KEY);

    let quote = null, asking = null, investorTrend = null, krOpinion = null, usOpinion = null;

    if (isKR) {
      const priceUrl = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
      const [priceData, a, inv, opinion] = await Promise.all([
        fetchKisJson(priceUrl, kisHeaders(token, 'FHKST01010100')),
        fetchAskingPrice(token, symbol),
        fetchInvestorTrend(token, symbol),
        fetchInvestOpinion(token, symbol)
      ]);
      asking = a; investorTrend = inv; krOpinion = opinion;
      if (priceData && priceData.output) {
        const o = priceData.output;
        quote = {
          name: o.hts_kor_isnm || symbol, price: num(o.stck_prpr), changePct: num(o.prdy_ctrt),
          per: o.per && o.per !== '0.00' ? num(o.per) : null, pbr: o.pbr && o.pbr !== '0.00' ? num(o.pbr) : null
        };
      }
    } else {
      usOpinion = await fetchFinnhubOpinion(symbol, process.env.FINNHUB_API_KEY);
      // 미국 종목 현재가는 기존 analysis.js 로직과 동일한 방식으로 조회
      const EXCHANGES = ['NAS', 'NYS', 'AMS'];
      for (const excd of EXCHANGES) {
        const url = `${KIS_BASE}/uapi/overseas-price/v1/quotations/price-detail?AUTH=&EXCD=${excd}&SYMB=${symbol}`;
        const data = await fetchKisJson(url, kisHeaders(token, 'HHDFS76200200'));
        if (data && data.output) {
          const o = data.output;
          quote = { name: o.name || o.e_name || symbol, price: num(o.last), changePct: num(o.rate), per: o.per ? num(o.per) : null, pbr: o.pbr ? num(o.pbr) : null };
          break;
        }
      }
    }

    if (!quote) {
      res.status(404).json({ error: '해당 종목의 데이터를 찾을 수 없습니다.' });
      return;
    }

    const news = await newsPromise;
    const payload = { symbol, name: quote.name, price: quote.price, changePct: quote.changePct, per: quote.per, pbr: quote.pbr, asking, investorTrend, krOpinion, usOpinion, news };
    const ai = await askAi(payload, process.env.ANTHROPIC_API_KEY);

    res.status(200).json({
      symbol, market: isKR ? 'KR' : 'US', quote,
      asking, investorTrend, krOpinion, usOpinion,
      ai: ai || null
    });
  } catch (e) {
    console.error('investment-opinion.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
