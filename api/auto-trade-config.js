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
    positionPct: 5, // 1회 매매당 총자산 대비 비중(%) — "모멘텀" 전략에 적용됨
    stopLossPct: 5, // 손절 기준(%)
    takeProfitPct: 10, // 익절 기준(%)
    maxTradesPerDay: 3 // 하루 최대 매매 횟수
  },
  // 여러 매매 전략을 동시에 가상계좌로 경쟁시켜서, 수익률이 더 좋은 쪽을 나중에 채택합니다.
  // (momentum을 제외한 나머지 전략의 리스크 규칙은 서버 코드에 고정되어 있어요 — 비교가 목적이라
  //  자주 바뀌면 비교 기준이 흔들리기 때문이에요. momentum만 위 risk 값으로 사용자가 조절 가능합니다.)
  strategies: {
    momentum: true,  // 모멘텀(추세 추종)
    pullback: true,  // 눌림목(과열 회피, 완만한 상승만)
    breakout: true,  // 강한 돌파(더 큰 변동만, 손익폭도 큼)
    reversal: true,  // 역추세(저가 반등, 하락한 종목 매수)
    scalp: true,     // 초단타(문턱 낮춰 자주 매매)
    selective: true, // 신중한 선별(엄격한 조건, 큰 비중)
    wideswing: true, // 광폭 스윙(손절/익절 폭 넓게, 길게 보유)
    baseline: true   // 기준선(대조군, 조건 없이 매수 — 다른 전략의 유효성 비교용)
  },
  updatedAt: null
};

const STRATEGY_IDS = ['momentum', 'pullback', 'breakout', 'reversal', 'scalp', 'selective', 'wideswing', 'baseline'];

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
    const strategiesIn = body.strategies || {};
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
      strategies: STRATEGY_IDS.reduce((acc, id) => {
        acc[id] = strategiesIn[id] !== false;
        return acc;
      }, {}),
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
