// /api/_kis.js
// 한국투자증권(KIS) Open API 공용 헬퍼 — 토큰 발급/캐싱을 모든 KIS 관련 함수에서 공유합니다.
// Vercel 서버리스 함수는 각각 독립 실행되므로 모듈 스코프 캐시는 "웜" 상태 동안만 유지되지만,
// 그래도 같은 함수가 짧은 시간 내 여러 번 불릴 때 재발급을 크게 줄여줍니다.

export const KIS_BASE = 'https://openapi.koreainvestment.com:9443';

let cachedToken = null; // { token, expiresAt }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestNewToken(appKey, appSecret) {
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
    const err = new Error('TOKEN_ERROR');
    err.status = res.status;
    err.body = text;
    throw err;
  }

  return res.json();
}

// Vercel 서버리스 함수는 파일별로 독립 실행되어 토큰 캐시를 서로 공유하지 못합니다.
// 그래서 종목분석 화면처럼 여러 API(시세/차트/뉴스)가 동시에 호출되면, 각자 콜드 스타트 상태에서
// "새 토큰 발급"을 거의 동시에 요청하게 되고, 한국투자증권 서버가 그중 일부를 거절할 수 있습니다.
// 이를 완화하기 위해 토큰 발급이 실패하면 짧게 대기 후 재시도합니다.
export async function getKisToken() {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error('NO_KEYS');
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const delays = [0, 900, 1800]; // 즉시 시도 후 실패 시 0.9초, 1.8초 대기하며 재시도 (최대 3회)
  let lastErr = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);
    try {
      const data = await requestNewToken(appKey, appSecret);
      const expiresInSec = data.expires_in || 86400;
      cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + expiresInSec * 1000
      };
      return cachedToken.token;
    } catch (e) {
      lastErr = e;
      console.error('KIS token error (attempt ' + (i + 1) + '):', e.status, e.body);
    }
  }
  throw lastErr || new Error('TOKEN_ERROR');
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
