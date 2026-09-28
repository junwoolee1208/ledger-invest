// /api/_kis.js
// 한국투자증권(KIS) Open API 공용 헬퍼 — 토큰 발급/캐싱을 모든 KIS 관련 함수에서 공유합니다.
// Vercel 서버리스 함수는 각각 독립 실행되므로 모듈 스코프 캐시는 "웜" 상태 동안만 유지되지만,
// 그래도 같은 함수가 짧은 시간 내 여러 번 불릴 때 재발급을 크게 줄여줍니다.

export const KIS_BASE = 'https://openapi.koreainvestment.com:9443';

let cachedToken = null; // { token, expiresAt } — 이 서버리스 실행(웜 인스턴스)이 살아있는 동안만 유지됨

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 한국투자증권 API는 접근토큰 발급을 "1분에 1회"로 엄격히 제한합니다.
// Vercel 서버리스 함수는 파일별로 독립 실행되어 메모리 캐시를 서로 공유하지 못하므로,
// 시세/차트/뉴스를 동시에 조회하거나 화면을 여러 번 새로고침하면 여러 함수가 각자
// "새 토큰"을 요청하게 되어 바로 이 1분 제한에 걸립니다(EGW00133 오류).
// 이를 근본적으로 막기 위해, 이미 만들어둔 Vercel KV(Upstash Redis)에 토큰을 저장해두고
// 모든 서버 함수가 같은 토큰을 공유해서 씁니다. 토큰은 보통 24시간 유효합니다.
const KV_REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KV_TOKEN_KEY = 'kis_access_token';

async function kvCommand(cmdArray) {
  if (!KV_REST_URL || !KV_REST_TOKEN) return null;
  try {
    const r = await fetch(KV_REST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmdArray)
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.result;
  } catch (e) {
    return null;
  }
}

async function kvGetToken() {
  const result = await kvCommand(['GET', KV_TOKEN_KEY]);
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch (e) {
    return null;
  }
}

async function kvSetToken(tokenObj, ttlSeconds) {
  await kvCommand(['SET', KV_TOKEN_KEY, JSON.stringify(tokenObj), 'EX', String(Math.max(ttlSeconds, 60))]);
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

export async function getKisToken() {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error('NO_KEYS');
  }

  // 1) 이 실행(웜 인스턴스) 안의 메모리 캐시 — 가장 빠름
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  // 2) 다른 서버 함수 실행이 이미 받아둔 토큰이 있는지 Vercel KV에서 확인
  const kvToken = await kvGetToken();
  if (kvToken && kvToken.expiresAt > Date.now() + 60_000) {
    cachedToken = kvToken;
    return kvToken.token;
  }

  // 3) 여러 요청이 동시에 여기 도달했을 수 있으니, 잠깐 대기 후 KV를 한 번 더 확인합니다
  //    (그사이 다른 실행이 먼저 토큰을 받아 저장했을 가능성이 큽니다)
  await sleep(300 + Math.floor(Math.random() * 400));
  const kvToken2 = await kvGetToken();
  if (kvToken2 && kvToken2.expiresAt > Date.now() + 60_000) {
    cachedToken = kvToken2;
    return kvToken2.token;
  }

  // 4) 새 토큰 발급 — 한국투자증권이 1분당 1회로 제한하므로 즉시 재시도는 의미가 없습니다.
  try {
    const data = await requestNewToken(appKey, appSecret);
    const expiresInSec = data.expires_in || 86400;
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + expiresInSec * 1000
    };
    // 다른 함수들이 재사용할 수 있도록 KV에도 저장 (만료보다 5분 일찍 캐시가 만료되게 여유를 둠)
    await kvSetToken(cachedToken, expiresInSec - 300);
    return cachedToken.token;
  } catch (e) {
    console.error('KIS token error:', e.status, e.body);
    // 발급이 막 실패했더라도, 비슷한 시각에 다른 실행이 먼저 성공해 KV에 저장했을 수 있으니 한 번 더 확인
    const kvToken3 = await kvGetToken();
    if (kvToken3 && kvToken3.expiresAt > Date.now()) {
      cachedToken = kvToken3;
      return kvToken3.token;
    }
    throw e;
  }
}

// 한국투자증권 API는 짧은 시간에 요청이 몰리면(초당 호출 제한) 간헐적으로 오류를 반환합니다.
// 다만 "종목 없음/거래소 불일치"(rt_cd가 '0'이 아님)는 정상적인 "결과 없음" 응답이지
// 일시적 오류가 아니므로 재시도하지 않습니다 — 해외 종목의 거래소(NAS/NYS/AMS)를 순서대로
// 추측할 때 틀린 거래소마다 여러 번 재시도하면 응답이 크게 느려져 서버 함수 실행시간 제한에
// 걸릴 수 있기 때문입니다. 실제 네트워크 오류나 429/5xx 같은 일시적 오류일 때만 한 번 재시도합니다.
export async function fetchKisJson(url, headers) {
  const delays = [0, 400];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) {
        if (r.status === 429 || r.status >= 500) continue; // 일시적 오류 → 재시도
        return null; // 4xx 등은 재시도해도 의미 없음
      }
      const data = await r.json();
      if (data.rt_cd !== '0') return null; // 정상적인 "결과 없음" 응답 — 재시도하지 않음
      return data;
    } catch (e) {
      continue; // 네트워크 예외 → 재시도
    }
  }
  return null;
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
