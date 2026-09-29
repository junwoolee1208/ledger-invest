// /api/backtest.js
// 여러 매매 전략(팩터 가중치 + 청산 방식 + 사이징 + 시장상황필터 조합)을 과거 일봉 데이터 위에서
// 한 번에 오프라인으로 시뮬레이션해서 비교하고, AI가 왜 잘됐는지/안됐는지 피드백을 줍니다.
//
// 왜 이렇게 만들었나:
// - 전략을 여러 개 만들어서 비교하려면 실시간(포워드) 시뮬레이션은 결과가 쌓이는 데 몇 주~몇 달이 걸리고,
//   전략마다 API를 따로 부르면 호출 수가 감당이 안 됩니다.
// - 대신 종목당 과거 일봉 데이터를 "딱 1번"만 가져온 뒤, 그 데이터 위에서 여러 전략(가중치 조합)을
//   오프라인으로 동시에 돌립니다. 전략이 몇 개든 추가 API 호출은 0입니다.
//
// 한계 (사용자에게 꼭 안내해야 함):
// - 가격/거래량 계열 팩터(모멘텀/거래량/추세/RSI)만 백테스트 가능합니다. 외국인수급/호가잔량/AI투자의견은
//   KIS가 "현재 스냅샷"만 제공하고 과거 이력을 안 주기 때문에 백테스트에 포함할 수 없습니다.
// - 지금은 국내(KR) 종목만 지원합니다(거래일 캘린더를 하나로 맞추기 위해). 해외 종목은 제외됩니다.
// - 체결가는 종가 기준으로 단순화했고, 매매 비용은 왕복 약 0.25%(수수료+세금 근사치)만 반영했습니다.
//   슬리피지, 호가 스프레드 등은 반영되지 않아 실제 결과와는 차이가 있을 수 있습니다.
//
// 계속 더 나은 전략을 찾고 싶다면 /api/backtest-evolve를 쓰세요 — 여기 있는 고정 9개 프리셋과 달리
// 가중치/청산/사이징을 조금씩 바꿔가며(돌연변이) 매 호출마다 한 세대씩 더 나은 조합을 탐색하고,
// 지금까지 찾은 최고 기록을 KV에 계속 이어갑니다.

import { getKisToken } from './_kis.js';
import { fetchSymbolHistory, annotateWithFactors, runBacktest, STARTING_CASH, FEE_PCT } from './_backtest-core.js';

export const config = { maxDuration: 30 };

const PRESETS = [
  { id: 'momentum_fixed', name: '모멘텀 중심 + 고정 손절/익절', weights: { momentum: 0.6, volume: 0.2, trend: 0.2, rsi: 0 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'trend_trailing', name: '추세추종 + 트레일링스탑', weights: { momentum: 0.2, volume: 0.1, trend: 0.7, rsi: 0 }, buyThreshold: 0.3, exit: { type: 'trailing', trailingPct: 8 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'reversal_fixed', name: '역추세(RSI 과매도) + 타이트 손절', weights: { momentum: -0.3, volume: 0.1, trend: -0.2, rsi: 0.6 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 3, takeProfitPct: 6 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'volume_fixed', name: '거래량 중심 + 고정 손절/익절', weights: { momentum: 0.2, volume: 0.6, trend: 0.2, rsi: 0 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'balanced', name: '복합 균형형', weights: { momentum: 0.25, volume: 0.25, trend: 0.25, rsi: 0.25 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'concentrated', name: '모멘텀 + 집중투자(상위 2종목)', weights: { momentum: 0.6, volume: 0.2, trend: 0.2, rsi: 0 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'concentrated', positionPct: 35, maxPositions: 2 } },
  { id: 'balanced_trailing', name: '복합 균형형 + 트레일링스탑', weights: { momentum: 0.25, volume: 0.25, trend: 0.25, rsi: 0.25 }, buyThreshold: 0.3, exit: { type: 'trailing', trailingPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } },
  { id: 'balanced_regime', name: '복합 균형형 + 시장상황 필터', weights: { momentum: 0.25, volume: 0.25, trend: 0.25, rsi: 0.25 }, buyThreshold: 0.3, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 }, regimeFilter: true },
  { id: 'baseline', name: '기준선(대조군, 조건 없음)', weights: { momentum: 0, volume: 0, trend: 0, rsi: 0 }, buyThreshold: -999, exit: { type: 'fixed', stopLossPct: 5, takeProfitPct: 10 }, sizing: { type: 'equal', positionPct: 10, maxPositions: 5 } }
];

// 결과 표를 Claude에게 보여주고 "왜 잘됐는지/안됐는지, 다음엔 뭘 시도해볼지"를 한국어로 짧게 피드백받습니다.
async function askAiFeedback(results, apiKey) {
  if (!apiKey) return null;
  const lines = results.map((r, i) =>
    `${i + 1}. ${r.name} — 총수익 ${r.totalReturnPct}%, MDD ${r.maxDrawdownPct}%, 거래 ${r.trades}회, 승률 ${r.winRate ?? '—'}%, ` +
    `평균익절 ${r.avgWinPct ?? '—'}%, 평균손절 ${r.avgLossPct ?? '—'}%, 손익비 ${r.profitFactor ?? '—'}, 시장노출 ${r.timeInMarketPct}%`
  ).join('\n');

  const prompt =
`아래는 서로 다른 매매 전략 9개를 같은 과거 데이터로 백테스트한 결과야 (수익률 높은 순으로 정렬됨).

${lines}

이 결과를 보고:
1. 1위 전략이 왜 잘됐는지 (예: 승률이 높아서인지, 손익비가 좋아서인지, 거래를 적게 해서인지 등 숫자 근거로) 설명해줘.
2. 최하위 전략이 왜 부진했는지 숫자 근거로 설명해줘.
3. 다음에 시도해볼 만한 개선 방향을 2가지 정도 구체적으로 제안해줘 (예: "익절 폭을 넓혀보면 어떨까" 같은 식).

한국어로 5~7문장 이내, 너무 원론적인 말 말고 위 숫자들을 직접 인용하면서 설명해줘.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) return null;
  const data = await response.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return text || null;
}

export default async function handler(req, res) {
  const rawSymbols = (req.query.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  const krSymbols = rawSymbols.filter((s) => /^\d{6}$/.test(s)).slice(0, 15);
  const skippedNonKr = rawSymbols.length - krSymbols.length;

  if (krSymbols.length === 0) {
    res.status(400).json({ error: '백테스트할 국내 종목 코드가 없습니다. (해외 종목은 이번 백테스트에서 지원되지 않아요)' });
    return;
  }
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    return;
  }

  const lookbackDays = Math.min(1825, Math.max(180, Number(req.query.days) || 730));

  try {
    const token = await getKisToken();
    const symbolMaps = {};
    const dateSet = new Set();

    for (const symbol of krSymbols) {
      const history = await fetchSymbolHistory(token, symbol, lookbackDays);
      if (history.length < 25) continue;
      const annotated = annotateWithFactors(history);
      const map = new Map();
      annotated.forEach((row) => { map.set(row.date, row); dateSet.add(row.date); });
      symbolMaps[symbol] = map;
    }

    const usedSymbols = Object.keys(symbolMaps);
    if (usedSymbols.length === 0) {
      res.status(404).json({ error: '유효한 과거 데이터를 가져오지 못했습니다.' });
      return;
    }
    const dates = Array.from(dateSet).sort();

    const results = PRESETS.map((preset) => Object.assign({ id: preset.id, name: preset.name }, runBacktest(preset, symbolMaps, dates)))
      .sort((a, b) => b.totalReturnPct - a.totalReturnPct);

    const feedback = await askAiFeedback(results, process.env.ANTHROPIC_API_KEY);

    res.status(200).json({
      symbols: usedSymbols,
      skippedNonKr,
      periodFrom: dates[0], periodTo: dates[dates.length - 1],
      startingCash: STARTING_CASH,
      feePct: FEE_PCT,
      results,
      feedback,
      note: '가격/거래량 기반 팩터만 백테스트 가능해요(수급·호가·AI의견은 과거 이력이 없어 제외). 체결가는 종가 기준 단순화, 슬리피지는 반영 안 됐어요.'
    });
  } catch (e) {
    console.error('backtest.js error:', e);
    if (e.message === 'NO_KEYS') {
      res.status(500).json({ error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다.' });
    } else {
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  }
}
