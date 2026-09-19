// /api/kis-quote.js
// Vercel Serverless Function — 한국투자증권(KIS) Open API로 국내 주식 현재가/재무지표를 조회합니다.
// App Key/Secret은 서버에서만 사용되므로 브라우저에 노출되지 않습니다.
// Vercel 환경변수에 KIS_APP_KEY, KIS_APP_SECRET을 등록해야 동작합니다.

const KIS_BASE = 'https://openapi.koreainvestment.com:9443';

// 액세스 토큰은 발급 후 약 24시간 유효합니다. 서버리스 함수의 "웜" 상태 동안
// 재사용해서 불필요한 재발급(과호출로 인한 일시 차단)을 피합니다.
let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error('NO_KEYS');
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('KIS token error:', res.status, text);
    throw new Error('TOKEN_ERROR');
  }

  const data = await res.json();
  const expiresInSec = data.expires_in || 86400;
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + expiresInSec * 1000
  };
  return cachedToken.token;
}

export default async function handler(req, res) {
  const symbol = (req.query.symbol || '').trim();
  if (!/^\d{6}$/.test(symbol)) {
    res.status(400).json({ error: '국내 종목코드(6자리 숫자)가 필요합니다.' });
    return;
  }

  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.' });
    return;
  }

  try {
    const token = await getAccessToken();

    const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
    const quoteRes = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHKST01010100',
        custtype: 'P'
      }
    });

    if (!quoteRes.ok) {
      const text = await quoteRes.text();
      console.error('KIS quote error:', quoteRes.status, text);
      res.status(502).json({ error: '한국투자증권 API 조회 중 오류가 발생했습니다.' });
      return;
    }

    const data = await quoteRes.json();
    if (data.rt_cd !== '0' || !data.output) {
      console.error('KIS quote logic error:', data.msg_cd, data.msg1);
      res.status(404).json({ error: data.msg1 || '종목 정보를 찾을 수 없습니다.' });
      return;
    }

    const o = data.output;
    const num = (v) => (v === undefined || v === null || v === '' || v === '0' && false ? null : parseFloat(v));

    res.status(200).json({
      symbol,
      name: o.hts_kor_isnm || null,
      price: num(o.stck_prpr),
      change: num(o.prdy_vrss),
      changePct: num(o.prdy_ctrt),
      prevClose: o.stck_prpr && o.prdy_vrss !== undefined ? num(o.stck_prpr) - num(o.prdy_vrss) : null,
      per: o.per && o.per !== '0.00' ? num(o.per) : null,
      pbr: o.pbr && o.pbr !== '0.00' ? num(o.pbr) : null,
      eps: o.eps && o.eps !== '0' ? num(o.eps) : null,
      high52: num(o.w52_hgpr),
      low52: num(o.w52_lwpr),
      marketCapEok: num(o.hts_avls) // 시가총액, 억원 단위 (KIS API 원본 단위 그대로)
    });
  } catch (e) {
    console.error('kis-quote.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
