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

function kvUrl(path) {
  return `${process.env.KV_REST_API_URL}${path}`;
}
function kvHeaders() {
  return { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` };
}

export default async function handler(req, res) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    res.status(500).json({
      error: 'KV_REST_API_URL / KV_REST_API_TOKEN이 설정되지 않았습니다. Vercel에서 KV 데이터베이스를 연결해주세요.'
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
        res.status(404).json({ watchlist: [], portfolio: [] });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(data.result);
      } catch (e) {
        parsed = { watchlist: [], portfolio: [] };
      }
      res.status(200).json({
        watchlist: parsed.watchlist || [],
        portfolio: parsed.portfolio || []
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
        portfolio: body.portfolio || []
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
