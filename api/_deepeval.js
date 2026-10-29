// /api/_deepeval.js
// "주간 AI 심층 평가서" — 채점표·실험 기록·교훈·종목 고르기 성적을 전부 모아서, 가장 똑똑한 모델(기본 Opus 5.5)이
// 부문별로 "왜 이 점수인지"를 근거와 함께 설명하고 다음에 해볼 실험을 우선순위대로 제안합니다.
// 결과는 KV에 저장돼서 채점표 탭·AI 상담에서 다시 보고, 다음 자동조정 실험 때 AI에게도 참고자료로 전달돼요.
// _로 시작해서 Vercel 함수 개수에 안 잡혀요.

import { askClaude, extractJson } from './_ai.js';
import { kvGetJson, kvSetJson } from './_kv.js';
import { CATEGORIES } from './_scorecard.js';

export const DEEPEVAL_LATEST_KEY = 'deepeval:latest';
export const DEEPEVAL_HISTORY_KEY = 'deepeval:history';

function scorecardText(sc) {
  return (sc.strategies || []).map((s) => {
    const cats = CATEGORIES.map((c) => {
      const v = s.cats[c.id];
      return v ? `  - ${c.label}: ${v.score}점 (${v.why})` : `  - ${c.label}: 근거 부족`;
    }).join('\n');
    return `### ${s.name} (${s.id}) — 종합 ${s.total ?? '—'}점 ${s.grade || ''}, 신뢰도 ${s.confidence}, 매도 ${s.sells}건, 추세 ${s.trend === null || s.trend === undefined ? '—' : (s.trend >= 0 ? '+' : '') + s.trend}\n` +
      `현재 설정: ${s.risk ? `손절 ${s.risk.stopLossPct}% 익절 ${s.risk.takeProfitPct}% 비중 ${s.risk.positionPct}% 하루 ${s.risk.maxTradesPerDay}번` : '전략연구실 결과를 따름'}${s.enabled === false ? ' (꺼짐)' : ''}\n` +
      (s.flag ? `경고: ${s.flag}\n` : '') + cats +
      (s.lessons && s.lessons.length ? `\n  실험 교훈:\n${s.lessons.map((l) => '   · ' + l).join('\n')}` : '');
  }).join('\n\n');
}

export async function runDeepEval({ scorecard, pickReport, regimeLabel, today }) {
  const prompt =
`너는 자동매매 시뮬레이션 시스템을 매주 점검하는 수석 분석가야. 아래 채점표와 기록을 깊게 읽고 평가서를 써줘.
이 시스템은 가짜 돈으로 여러 전략을 경쟁시키고, 숫자 설정은 "지켜보기→실험→채점→교훈" 순환으로 스스로 고쳐.
읽는 사람은 투자 초보라서, 쉬운 한국어로 쓰고 숫자 근거를 꼭 붙여줘. 실제 투자 조언(사라/팔아라)은 하지 마.

오늘: ${today} / 오늘 시장 상황: ${regimeLabel || '알 수 없음'}

## 채점표(0~100점, 계산식으로 매긴 점수)
${scorecardText(scorecard)}

## 시스템 전체
- 종목 고르기: ${pickReport ? pickReport.summary : '아직 채점된 기록 없음'}
- 자동조정: 채점된 실험 ${scorecard.system ? scorecard.system.judged : 0}개, 좋아짐 ${scorecard.system ? scorecard.system.improved : 0}, 나빠짐 ${scorecard.system ? scorecard.system.worse : 0}, 되돌림 ${scorecard.system ? scorecard.system.rolledBack : 0}

## 써야 할 것
- 전략마다: 한 줄 평, 잘한 점·못한 점(부문 점수와 근거 숫자를 인용), 원인 추정, 다음에 해볼 실험(우선순위 순, 최대 2개),
  권고(keep=유지 / tune=숫자 실험 계속 / pause=잠시 끄기 / investigate=사는 조건부터 점검).
- 신뢰도가 "낮음"이면 성급하게 결론 내지 말고 그렇다고 써.
- 시스템 전체: 종목 고르기, 자동조정 학습이 잘 되고 있는지, 가장 시급한 개선 1~3개.

아래 JSON 형식으로만 답해(다른 설명 없이):
{"summary":"전체 요약 3~4문장","priorities":["가장 시급한 개선 1","…"],
 "strategies":[{"id":"전략 id","headline":"한 줄 평","good":["잘한 점"],"bad":["못한 점"],"why":"원인 추정 2~3문장",
   "nextExperiments":[{"what":"무엇을 바꿔볼지","why":"왜","expected":"기대 효과"}],"recommendation":"keep|tune|pause|investigate"}],
 "system":{"picking":"종목 고르기 평가 2문장","learning":"자동조정 학습 평가 2문장"}}`;

  const ai = await askClaude({ feature: 'deep-eval', prompt, maxTokens: 16000, timeoutMs: 55_000 });
  if (!ai.ok) return { ok: false, reason: ai.reason, message: ai.message };
  const parsed = extractJson(ai.text, 'object');
  const report = {
    at: Date.now(), date: today, model: ai.model, costUsd: ai.costUsd,
    report: parsed, rawText: parsed ? null : ai.text.slice(0, 8000),
    scores: (scorecard.strategies || []).map((s) => ({ id: s.id, total: s.total, grade: s.grade }))
  };
  const history = await kvGetJson(DEEPEVAL_HISTORY_KEY, []);
  history.unshift({ at: report.at, date: report.date, model: report.model, costUsd: report.costUsd, summary: parsed ? parsed.summary : null });
  if (history.length > 12) history.length = 12;
  await Promise.all([kvSetJson(DEEPEVAL_LATEST_KEY, report), kvSetJson(DEEPEVAL_HISTORY_KEY, history)]);
  return { ok: true, report };
}
