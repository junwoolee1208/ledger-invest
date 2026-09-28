// /api/_kv.js
// Vercel KV(Upstash Redis) REST API 공용 헬퍼. 자동매매 관련 함수들이 공통으로 사용합니다.
// (기존 sync.js / _kis.js 는 각자 파일 안에 동일한 로직을 갖고 있어 그대로 두고,
//  새로 추가하는 자동매매 파일들만 이 헬퍼를 공유합니다.)

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function kvReady() {
  return !!(REST_URL && REST_TOKEN);
}

export async function kvCommand(cmdArray) {
  if (!kvReady()) return null;
  try {
    const r = await fetch(REST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmdArray)
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.result;
  } catch (e) {
    return null;
  }
}

export async function kvGetJson(key, fallback) {
  const result = await kvCommand(['GET', key]);
  if (!result) return fallback;
  try {
    return JSON.parse(result);
  } catch (e) {
    return fallback;
  }
}

export async function kvSetJson(key, value) {
  return kvCommand(['SET', key, JSON.stringify(value)]);
}
