// /api/_chat.js
// "AI 전략 상담"의 대화 엔진입니다. Claude가 도구(데이터 조회·그래프·표·변경 제안)를 골라 쓰면서 답하게 해요.
//   - 도구를 실제로 실행하는 함수(execTool)는 auto-trade-status.js가 넘겨줘요(데이터를 읽는 코드가 거기 있어서).
//   - 변경은 절대 바로 적용하지 않고 "제안 카드"로만 돌려줘요. 사용자가 화면에서 [적용]을 눌러야 저장돼요.
//   - 60초 실행 제한 안에서 끝나도록 도구를 쓰는 횟수와 시간을 제한해요.
// AI 호출은 _ai.js의 공용 도구(예산 확인·사용량 기록·실패 기록)를 그대로 써요. _로 시작해서 함수 개수에 안 잡혀요.

import { aiPrepare, aiCreate, aiRecordUsage, aiMarkOk, aiFailure } from './_ai.js';

const MAX_ROUNDS = 6; // 도구를 쓰고 다시 생각하는 횟수 상한
const TIME_BUDGET_MS = 45_000; // 이 시간이 지나면 더 도구를 쓰지 않고 마무리

// history: [{ role: 'user'|'assistant', content: '문자열' }] — 화면에 보이는 대화(글자만). 생각 블록은 다시 보내지 않아요.
// 반환: { ok, text, rounds, costUsd } 또는 { ok:false, reason, message }
export async function runChat({ system, history, tools, execTool }) {
  const prep = await aiPrepare('chat');
  if (!prep.ok) return prep;
  const started = Date.now();
  const messages = history.map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) }));
  let costUsd = 0;
  let finalText = '';

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const timeLeft = TIME_BUDGET_MS - (Date.now() - started);
    const lastRound = round === MAX_ROUNDS || timeLeft < 12_000;
    let response;
    try {
      response = await aiCreate({
        model: prep.model,
        max_tokens: 8000,
        output_config: { effort: prep.effort },
        system,
        tools,
        // 마지막 차례에는 도구를 못 쓰게 해서, 지금까지 모은 자료로 답을 마무리하게 해요.
        // (대화에 이미 도구 기록이 있으면 도구 목록은 계속 보내야 해서, 목록은 두고 "쓰지 마"만 걸어요)
        tool_choice: lastRound ? { type: 'none' } : { type: 'auto' },
        messages
      }, Math.max(10_000, Math.min(timeLeft + 10_000, 40_000)));
    } catch (e) {
      return aiFailure('chat', e);
    }
    costUsd += await aiRecordUsage('chat', prep.model, response.usage);
    if (response.stop_reason === 'refusal') return aiFailure('chat', { reason: 'refusal', message: 'refusal' });

    const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) finalText = text;
    const toolUses = (response.content || []).filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !toolUses.length) {
      await aiMarkOk('chat');
      return { ok: true, text: finalText || '답을 만들지 못했어요. 다시 물어봐 주세요.', rounds: round, costUsd };
    }

    // 생각 블록까지 포함한 응답 전체를 그대로 이어 붙여야 다음 요청이 올바르게 이어져요.
    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const t of toolUses) {
      let out;
      try {
        out = await execTool(t.name, t.input || {});
      } catch (e) {
        out = { error: '도구 실행 중 오류: ' + (e && e.message) };
      }
      const str = JSON.stringify(out);
      results.push({ type: 'tool_result', tool_use_id: t.id, content: str.length > 14000 ? str.slice(0, 14000) + '…(잘림)' : str, is_error: !!(out && out.error) });
    }
    messages.push({ role: 'user', content: results });
  }
  await aiMarkOk('chat');
  return { ok: true, text: finalText || '시간 안에 답을 마무리하지 못했어요. 질문을 조금 좁혀서 다시 물어봐 주세요.', rounds: MAX_ROUNDS, costUsd };
}
