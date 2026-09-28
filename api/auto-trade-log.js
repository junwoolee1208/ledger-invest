// /api/auto-trade-log.js
// 자동매매(현재는 내부 시뮬레이션) 현황 조회 — 프론트엔드 "자동매매" 탭에서 사용합니다.
// 인증 없이 조회만 가능(개인용 앱이라 단순화). 매매 실행/설정 변경은 별도 파일에서 보호합니다.

import { kvGetJson, kvReady } from './_kv.js';

const POSITIONS_KEY = 'autotrade:positions';
const CASH_KEY = 'autotrade:cash';
const LOG_KEY = 'autotrade:log';
const STARTING_CASH = 10_000_000;

export default async function handler(req, res) {
  if (!kvReady()) {
    res.status(500).json({ error: 'KV(Upstash Redis)가 설정되지 않았습니다.' });
    return;
  }
  try {
    const [positions, cash, log] = await Promise.all([
      kvGetJson(POSITIONS_KEY, {}),
      kvGetJson(CASH_KEY, STARTING_CASH),
      kvGetJson(LOG_KEY, [])
    ]);
    res.status(200).json({ positions, cash, log: log.slice(0, 50), startingCash: STARTING_CASH });
  } catch (e) {
    console.error('auto-trade-log.js error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}
