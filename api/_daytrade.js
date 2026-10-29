// /api/_daytrade.js
// "데이트레이딩(당일 청산)" 전략의 설정값(사는 조건·매수 시간·청산 시각·손실한도·매수 횟수 등)을 한 곳에서 관리합니다.
// 사용자가 자동매매 탭의 "데이트레이딩 설정"에서 바꾸면 KV의 자동매매 설정(cfg.daytrade)에 저장되고,
// 매매 엔진(auto-trade-check.js)과 설정 저장/조회(auto-trade-status.js)가 이 파일의 같은 규칙으로 값을 검사해서 씁니다.
// _로 시작해서 Vercel 함수 개수에 안 잡혀요.

export const DEFAULT_DAYTRADE = {
  // 사는 조건
  minFromOpenPct: 1, // 오늘 시가 대비 최소 상승률(%)
  maxFromOpenPct: 5, // 오늘 시가 대비 최대 상승률(%) — 이미 너무 오른 건 피함
  maxOffHighPct: 1, // 오늘 고가에서 이 이상 밀린 종목은 안 삼(힘이 빠지는 중일 수 있어서)
  maxChangePct: 15, // 전일 대비 이 이상 급등한 종목은 안 삼(상한가 근처라 변동이 너무 큼)
  // 시간
  buyStart: '09:05', // 이 시각부터 매수
  buyEnd: '15:00', // 이 시각 이후엔 새로 안 삼
  closeAt: '15:10', // 이 시각부터 들고 있는 종목을 전부 팖(국내 동시호가 15:20 전이어야 함)
  // 위험 관리
  stopLossPct: 1,
  takeProfitPct: 1.5,
  positionPct: 5, // 1회 매수 비중(가상계좌 현금 대비 %)
  dailyLossLimitPct: 3, // 오늘 실현손실이 원금의 이 비율에 닿으면 그날 매수 중단
  maxBuysPerDay: 10, // 하루 최대 매수 횟수
  cooldownMin: 30 // 판 종목을 다시 사기까지 기다리는 시간(분)
};

const KR_OPEN_MIN = 9 * 60;
// 국내는 15:20부터 동시호가라 그 전까지만 매매돼요. 스케줄러가 5분마다 부르니, 청산 시각이 최소 한 번은 걸리도록 15:15까지만 허용해요.
const KR_LAST_MIN = 15 * 60 + 15;

export function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

function minToHhmm(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

function clipNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// 사용자가 보낸 값(또는 KV에 저장된 값)을 기본값 위에 덮어쓰되, 말이 안 되는 값은 잘라냅니다.
// 시간은 국내 장중(09:00~15:20) 안으로 맞추고, "매수 시작 ≤ 매수 끝 ≤ 청산 시각" 순서가 되게 정리해요.
export function normalizeDaytrade(raw) {
  const r = raw || {};
  const d = DEFAULT_DAYTRADE;
  const clipTime = (v, fallback) => {
    const min = hhmmToMin(v);
    return min === null ? hhmmToMin(fallback) : Math.max(KR_OPEN_MIN, Math.min(KR_LAST_MIN, min));
  };
  const closeAt = clipTime(r.closeAt, d.closeAt);
  const buyEnd = Math.min(clipTime(r.buyEnd, d.buyEnd), closeAt);
  const buyStart = Math.min(clipTime(r.buyStart, d.buyStart), buyEnd);

  const minFromOpenPct = clipNum(r.minFromOpenPct, -10, 30, d.minFromOpenPct);
  return {
    minFromOpenPct,
    maxFromOpenPct: Math.max(minFromOpenPct, clipNum(r.maxFromOpenPct, -10, 30, d.maxFromOpenPct)),
    maxOffHighPct: clipNum(r.maxOffHighPct, 0, 30, d.maxOffHighPct),
    maxChangePct: clipNum(r.maxChangePct, -30, 30, d.maxChangePct),
    buyStart: minToHhmm(buyStart),
    buyEnd: minToHhmm(buyEnd),
    closeAt: minToHhmm(closeAt),
    stopLossPct: clipNum(r.stopLossPct, 0.1, 30, d.stopLossPct),
    takeProfitPct: clipNum(r.takeProfitPct, 0.1, 100, d.takeProfitPct),
    positionPct: clipNum(r.positionPct, 1, 50, d.positionPct),
    dailyLossLimitPct: clipNum(r.dailyLossLimitPct, 0.1, 50, d.dailyLossLimitPct),
    maxBuysPerDay: Math.round(clipNum(r.maxBuysPerDay, 1, 50, d.maxBuysPerDay)),
    cooldownMin: Math.round(clipNum(r.cooldownMin, 0, 390, d.cooldownMin))
  };
}

// "전략 변경 이력"에 남길 한 줄 요약
export function describeDaytrade(s) {
  return `시가 대비 +${s.minFromOpenPct}~${s.maxFromOpenPct}%, 고가에서 ${s.maxOffHighPct}% 이내, 전일 대비 ${s.maxChangePct}% 이하 · ` +
    `매수 ${s.buyStart}~${s.buyEnd}, 청산 ${s.closeAt} · 손절 ${s.stopLossPct}%/익절 ${s.takeProfitPct}%, 비중 ${s.positionPct}% · ` +
    `하루 손실한도 ${s.dailyLossLimitPct}%, 매수 최대 ${s.maxBuysPerDay}회, 재매수 대기 ${s.cooldownMin}분`;
}
