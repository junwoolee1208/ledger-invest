// /api/auto-trade-config.js
// 자동매매 설정(켬/끔, 리스크 규칙, 감시 종목)을 조회/저장합니다.
// 이 앱은 개인용이라 사용자별 분리 없이 하나의 설정만 둡니다.
// 조회(GET)는 자동매매 실행 함수(auto-trade-check)도 같이 쓰므로 인증 없이 열어두고,
// 저장(POST)만 로그인한 본인만 바꿀 수 있도록 Firebase ID 토큰으로 검증합니다.

import { kvGetJson, kvSetJson, kvReady } from './_kv.js';

const FIREBASE_API_KEY = 'AIzaSyCI9mlo-KCsDagXdP4h07sPufTIns2FfZc';
const CONFIG_KEY = 'autotrade:config';

const DEFAULT_CONFIG = {
  enabled: false,
  mode: 'dryrun', // 'dryrun' | 'live' — 모의투자 키 연결 전까지는 dryrun 고정
  symbols: [], // 관심종목 외 추가로 감시할 종목 (보통은 프론트에서 관심종목을 합쳐서 채움)
  useAiCandidates: true, // AI 추천 종목도 감시 대상에 포함할지
  risk: {
    positionPct: 5, // 1회 매매당 총자산 대비 비중(%)
    stopLossPct: 5, // 손절 기준(%)
    takeProfitPct: 10, // 익절 기준(%)
    maxTradesPerDay: 3 // 하루 최대 매매 횟수
  },
  updatedAt: null
};

async function verifyIdToken(idToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!r.ok) return null;
  const data = await r.json();
  const user = data.users && data.users[0];
  return user ? user.localId : null;
}

export default async function handler(req, res) {
  if (!kvReady()) {
    res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
    return;
  }

  if (req.method === 'GET') {
    const cfg = await kvGetJson(CONFIG_KEY, DEFAULT_CONFIG);
    res.status(200).json(cfg);
    return;
  }

  if (req.method === 'POST') {
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
      res.status(500).json({ error: '인증 확인 중 오류가 발생했습니다.' });
      return;
    }
    if (!uid) {
      res.status(401).json({ error: '유효하지 않은 인증 토큰입니다.' });
      return;
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const risk = Object.assign({}, DEFAULT_CONFIG.risk, body.risk || {});
    const next = {
      enabled: !!body.enabled,
      mode: 'dryrun', // 실거래 전환은 모의투자 검증 후 서버 코드에서 명시적으로만 바꿉니다.
      symbols: Array.isArray(body.symbols) ? body.symbols.slice(0, 50) : [],
      useAiCandidates: body.useAiCandidates !== false,
      risk: {
        positionPct: Math.max(1, Math.min(50, Number(risk.positionPct) || DEFAULT_CONFIG.risk.positionPct)),
        stopLossPct: Math.max(1, Math.min(50, Number(risk.stopLossPct) || DEFAULT_CONFIG.risk.stopLossPct)),
        takeProfitPct: Math.max(1, Math.min(200, Number(risk.takeProfitPct) || DEFAULT_CONFIG.risk.takeProfitPct)),
        maxTradesPerDay: Math.max(1, Math.min(50, Number(risk.maxTradesPerDay) || DEFAULT_CONFIG.risk.maxTradesPerDay))
      },
      updatedAt: Date.now()
    };

    const ok = await kvSetJson(CONFIG_KEY, next);
    if (!ok) {
      res.status(500).json({ error: '설정 저장에 실패했습니다.' });
      return;
    }
    res.status(200).json(next);
    return;
  }

  res.status(405).json({ error: '허용되지 않은 메서드입니다.' });
}
