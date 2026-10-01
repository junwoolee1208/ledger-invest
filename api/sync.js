// /api/sync.js
// 관심종목/포트폴리오 클라우드 동기화 — Firestore 대신 Vercel KV(Upstash Redis)를 사용합니다.
// 로그인은 그대로 Firebase Authentication을 사용하고, 이 함수는 클라이언트가 보낸
// Firebase ID 토큰을 서버에서 직접 검증(identitytoolkit REST API)해서 uid를 확인한 뒤,
// 그 uid를 키로 Vercel KV에 데이터를 저장/조회/삭제합니다.
// (firebase-admin SDK나 서비스 계정 키가 필요 없습니다.)

const FIREBASE_API_KEY = 'AIzaSyCI9mlo-KCsDagXdP4h07sPufTIns2FfZc';

async function verifyIdToken(idToken) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!r.ok) return null;
  const data = await r.json();
  const user = data.users && data.users[0];
  return user ? user.localId : null;
}

// Vercel의 "Storage → KV"는 이제 Upstash 마켓플레이스 연동으로 제공됩니다.
// 연동 방식에 따라 환경변수 이름이 KV_REST_API_URL/TOKEN 또는
// UPSTASH_REDIS_REST_URL/TOKEN 으로 생성될 수 있어 둘 다 지원합니다.
const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function kvUrl(path) {
  return `${REST_URL}${path}`;
}
function kvHeaders() {
  return { Authorization: `Bearer ${REST_TOKEN}` };
}

export default async function handler(req, res) {
  if (!REST_URL || !REST_TOKEN) {
    res.status(500).json({
      error: 'KV(Upstash Redis) 환경변수가 설정되지 않았습니다. Vercel Storage에서 데이터베이스를 프로젝트에 연결해주세요.'
    });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: '인증 토큰이 없습니다.' });
    return;
  }

  let uid;
  try {
    uid = await verifyIdToken(idToken);
  } catch (e) {
    console.error('sync.js token verify error:', e);
    res.status(500).json({ error: '인증 확인 중 오류가 발생했습니다.' });
    return;
  }
  if (!uid) {
    res.status(401).json({ error: '유효하지 않은 인증 토큰입니다.' });
    return;
  }

  const key = `ledger_user:${uid}`;

  try {
    if (req.method === 'GET') {
      const r = await fetch(kvUrl(`/get/${encodeURIComponent(key)}`), { headers: kvHeaders() });
      if (!r.ok) throw new Error('KV_GET_FAILED');
      const data = await r.json();
      if (!data.result) {
        res.status(404).json({ watchlist: [], portfolio: [], memos: {} });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(data.result);
      } catch (e) {
        parsed = { watchlist: [], portfolio: [], memos: {} };
      }
      res.status(200).json({
        watchlist: parsed.watchlist || [],
        portfolio: parsed.portfolio || [],
        memos: parsed.memos || {} // 종목 메모 (관심종목 심볼 -> 메모 텍스트)
      });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      body = body || {};
      const value = JSON.stringify({
        watchlist: body.watchlist || [],
        portfolio: body.portfolio || [],
        memos: (body.memos && typeof body.memos === 'object') ? body.memos : {}
      });
      const r = await fetch(kvUrl(`/set/${encodeURIComponent(key)}`), {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'text/plain' }, kvHeaders()),
        body: value
      });
      if (!r.ok) throw new Error('KV_SET_FAILED');
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      const r = await fetch(kvUrl(`/del/${encodeURIComponent(key)}`), {
        method: 'POST',
        headers: kvHeaders()
      });
      if (!r.ok) throw new Error('KV_DEL_FAILED');
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: '허용되지 않은 메서드입니다.' });
  } catch (e) {
    console.error('sync.js error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}
