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

// 여러 키를 명령 1번으로 읽어요. 저장소 무료 한도가 "명령 횟수" 기준이라, 자주 도는 코드는 이걸 써요.
// 돌려주는 값: { 키: 값 } (없는 키는 빠져요). 읽기에 실패하면 null이에요.
// "값이 없음"과 "읽기 실패"를 구분해야, 연결이 잠깐 끊겼을 때 계좌가 빈 것으로 착각하고 덮어쓰는 일을 막을 수 있어요.
export async function kvMGetJson(keys) {
  if (!keys.length) return {};
  const result = await kvCommand(['MGET', ...keys]);
  if (!Array.isArray(result)) return null;
  const out = {};
  keys.forEach((key, i) => {
    if (!result[i]) return;
    try {
      out[key] = JSON.parse(result[i]);
    } catch (e) {
      // 깨진 값은 없는 값으로 봐요(하나 때문에 전체를 못 읽으면 안 돼요).
    }
  });
  return out;
}

// 여러 키를 명령 1번으로 함께 저장해요. 전부 저장되거나 전부 안 되므로, 현금과 보유 종목이 어긋나지 않아요.
export async function kvMSetJson(values) {
  const args = [];
  Object.keys(values).forEach((key) => args.push(key, JSON.stringify(values[key])));
  return kvCommand(['MSET', ...args]);
}
