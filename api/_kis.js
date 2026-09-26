// /api/_kis.js
// 한국투자증권(KIS) Open API 공용 헬퍼 — 토큰 발급/캐싱을 모든 KIS 관련 함수에서 공유합니다.
// Vercel 서버리스 함수는 각각 독립 실행되므로 모듈 스코프 캐시는 "웜" 상태 동안만 유지되지만,
// 그래도 같은 함수가 짧은 시간 내 여러 번 불릴 때 재발급을 크게 줄여줍니다.

export const KIS_BASE = 'https://openapi.koreainvestment.com:9443';

let cachedToken = null; // { token, expiresAt }

export async function getKisToken() {
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

export function kisHeaders(token, trId, extra) {
  return Object.assign(
    {
      'Content-Type': 'application/json',
      authorization: `Bearer ${token}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: trId,
      custtype: 'P'
    },
    extra || {}
  );
}

export function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

// 해외 종목의 거래소 코드를 추측합니다. 프론트에서 exchange를 함께 보내주면 그것을 우선 사용합니다.
// KIS 해외현재가 API 거래소 코드: NAS(나스닥), NYS(뉴욉거래소), AMS(아멕스)
export function guessExchange(hint) {
  const h = (hint || '').toUpperCase();
  if (h === 'NAS' || h === 'NYS' || h === 'AMS') return h;
  return 'NAS';
}
