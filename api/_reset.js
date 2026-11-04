// /api/_reset.js
// "모든 전략 처음부터 다시"의 실제 동작이에요. 화면 버튼(auto-trade-status.js)이 씁니다. _로 시작해서 함수 개수에 안 잡혀요.
//
// 지우는 것: 전략 숫자 변경값, 가장 좋았던 설정, 경고, (선택) 가짜 계좌의 현금·보유 종목.
// 남기는 것: 매매 기록, 손익 캘린더, 전략 변경 이력, 끝난 실험 기록.
// 지난 기록을 지우지 않는 대신 "시작 시각"을 저장해서, 학습과 채점표는 그 뒤의 거래만 보게 해요.

import { kvGetJson, kvSetJson, kvCommand } from './_kv.js';
import { STRATEGY_IDS, keysFor } from './_strategies.js';
import { EXPERIMENTS_KEY, BEST_RISK_KEY, FLAGS_KEY } from './_learning.js';
import { SCORECARD_CACHE_KEY, SCORECARD_HISTORY_KEY } from './_scorecard.js';
import { LONGTERM_STATE_KEY } from './_longterm.js';

export const RESET_INFO_KEY = 'autotrade:reset-info'; // { learnSince, scoreSince }
const OVERRIDES_KEY = 'autotrade:strategy-overrides';
const CUSTOM_KEY = 'autotrade:custom-strategies';
const ADJUST_LASTRUN_KEY = 'autotrade:strategy-adjust:lastrun';
const CHANGES_KEY = 'autotrade:strategy-changes';
const MAX_CHANGES = 200;

// 진행 중인 실험은 "중단됨"으로 닫고, 관찰 기록은 비워요(지금까지의 거래로는 공정하게 비교할 수 없으니까).
export function cancelExperimentsFor(experiments, strategyId, reason) {
  experiments.forEach((e) => {
    if (strategyId && e.strategyId !== strategyId) return;
    if (e.status === 'running') {
      e.status = 'cancelled';
      e.result = { verdict: 'cancelled', judgedAt: Date.now(), note: reason };
    }
    if (e.status === 'observing') { e.samples = []; e.startedAt = Date.now(); }
  });
}

export async function resetAllStrategies({ resetAccounts, reason, today, resetIdNames }) {
  const now = Date.now();
  const [overrides, experiments, changes, info] = await Promise.all([
    kvGetJson(OVERRIDES_KEY, {}), kvGetJson(EXPERIMENTS_KEY, []), kvGetJson(CHANGES_KEY, []), kvGetJson(RESET_INFO_KEY, {})
  ]);
  cancelExperimentsFor(experiments, null, reason);
  const resetIds = Object.keys(overrides);
  await Promise.all([
    kvSetJson(OVERRIDES_KEY, {}), kvSetJson(EXPERIMENTS_KEY, experiments),
    kvSetJson(BEST_RISK_KEY, {}), kvSetJson(FLAGS_KEY, {}),
    kvSetJson(ADJUST_LASTRUN_KEY, 0)
  ]);
  const nextInfo = Object.assign({}, info, { learnSince: now });
  if (resetAccounts) {
    const ids = STRATEGY_IDS.concat((await kvGetJson(CUSTOM_KEY, [])).map((c) => c.id));
    const keys = [];
    ids.forEach((id) => { const kr = keysFor(id, 'KR'), us = keysFor(id, 'US'); keys.push(kr.positionsKey, kr.cashKey, us.positionsKey, us.cashKey); });
    keys.push(LONGTERM_STATE_KEY); // 계좌를 비웠으니 장기 전략은 다음 실행에서 다시 담아야 해요
    await Promise.all(keys.map((k) => kvCommand(['DEL', k])));
    nextInfo.scoreSince = now;
    // 채점표는 초기화 뒤 거래로만 다시 계산해요(1주 추세도 새로 시작)
    await Promise.all([kvCommand(['DEL', SCORECARD_CACHE_KEY]), kvCommand(['DEL', SCORECARD_HISTORY_KEY])]);
  }
  await kvSetJson(RESET_INFO_KEY, nextInfo);
  changes.unshift({
    id: now + '-reset-all', ts: now, date: today,
    strategyId: 'all', strategyName: '모든 전략', source: 'manual',
    diagnosis: reason + (resetAccounts ? ' 가짜 계좌도 모두 처음 돈으로 초기화했어요.' : ''),
    statsAtChange: null,
    beforeDescription: resetIds.length ? `바뀌어 있던 전략 ${resetIds.length}개: ${resetIds.map((id) => (resetIdNames && resetIdNames[id]) || id).join(', ')}` : '바뀐 전략 없음',
    afterDescription: '모든 전략 처음 값, 실험 기록은 남기고 새 실험부터 다시'
  });
  if (changes.length > MAX_CHANGES) changes.length = MAX_CHANGES;
  await kvSetJson(CHANGES_KEY, changes);
  return { resetCount: resetIds.length };
}
