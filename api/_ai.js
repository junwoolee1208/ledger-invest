// /api/_ai.js
// 사이트의 모든 Claude(AI) 호출이 거쳐 가는 공용 창구입니다. 여기서 한꺼번에 처리하는 일:
//   1) 기능별로 어떤 모델을 쓸지 정하기(설정 탭에서 바꿀 수 있음, 기본은 싸고 빠른 Haiku 5.5)
//   2) 실제로 쓴 토큰 수 × 가격으로 "이번 달 AI 사용액"을 기록하기
//   3) 월 예산을 넘으면 큰 작업(심층 평가·상담)을 멈추기
//   4) 실패하면 이유(크레딧 부족·키 오류 등)를 기록해서 화면에 경고로 보여주기
// 예전엔 파일마다 직접 fetch로 Claude를 불러서, 실패해도 이유가 숨겨지고 사용량도 알 수 없었어요.
// 공식 SDK(@anthropic-ai/sdk)를 쓰고, 오류를 던지지 않고 { ok:false, reason } 으로 돌려줘서
// 부르는 쪽이 "AI 없이 어떻게 할지"를 직접 정하게 합니다. _로 시작해서 Vercel 함수 개수에 안 잡혀요.

import Anthropic, {
  AuthenticationError, PermissionDeniedError, RateLimitError, BadRequestError, APIConnectionError, APIError
} from '@anthropic-ai/sdk';
import { kvGetJson, kvSetJson, kvCommand } from './_kv.js';

export const AI_CONFIG_KEY = 'ai:config';
export const AI_USAGE_PREFIX = 'ai:usage:'; // + YYYY-MM (Redis 해시: "기능:usd" 같은 칸에 누적)
export const AI_LAST_OK_KEY = 'ai:last-ok';
export const AI_LAST_ERROR_KEY = 'ai:last-error';

// 고를 수 있는 모델과 가격(달러, 100만 토큰당). Haiku 5.5는 프롬프트가 10만 토큰을 넘으면 비싼 요금표가 적용돼요.
export const AI_MODELS = {
  'claude-haiku-5-5': { label: 'Haiku 5.5 (빠르고 저렴)', inUsd: 0.10, outUsd: 0.50, inUsdLong: 0.50, outUsdLong: 2.50 },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5 (균형)', inUsd: 2, outUsd: 10 },
  'claude-opus-5-5': { label: 'Opus 5.5 (가장 똑똑함)', inUsd: 4, outUsd: 20 }
};

// AI를 쓰는 기능 목록. heavy=true인 기능은 월 예산을 다 쓰면 멈춰요(자동매매에 꼭 필요한 작은 일은 계속).
// effort: 모델이 얼마나 깊게 생각할지(low < medium < high). 짧고 자주 하는 일은 low로 아껴요.
export const AI_FEATURES = {
  screen: { label: 'AI 추천 종목 거르기', defaultModel: 'claude-haiku-5-5', effort: 'low', heavy: false },
  sentiment: { label: '뉴스 호재·악재 점수', defaultModel: 'claude-haiku-5-5', effort: 'low', heavy: false },
  'stoploss-reason': { label: '손절 이유 설명', defaultModel: 'claude-haiku-5-5', effort: 'low', heavy: false },
  // 자동조정은 지난 실험 기록을 읽고 다음 실험을 설계하는 "판단" 일이라 Sonnet이 기본(하루 몇 번뿐이라 비용 부담 작음)
  adjust: { label: '전략 자동조정(실험 설계)', defaultModel: 'claude-sonnet-5-5', effort: 'medium', heavy: false },
  explain: { label: '주가 움직임·실적 요약', defaultModel: 'claude-haiku-5-5', effort: 'low', heavy: false },
  opinion: { label: 'AI 투자의견', defaultModel: 'claude-haiku-5-5', effort: 'medium', heavy: false },
  'backtest-feedback': { label: '전략연구실 AI 피드백', defaultModel: 'claude-haiku-5-5', effort: 'low', heavy: false }
};

export const DEFAULT_AI_CONFIG = { monthlyBudgetUsd: 20, models: {} };
// 예산의 이 배수를 넘으면 작은 일까지 전부 멈춰요(무언가 잘못돼서 AI를 끝없이 부르는 사고를 막는 안전장치).
const HARD_STOP_MULTIPLIER = 2;

export function normalizeAiConfig(raw) {
  const r = raw || {};
  const budget = Number(r.monthlyBudgetUsd);
  const models = {};
  Object.keys(AI_FEATURES).forEach((f) => {
    const m = r.models && r.models[f];
    if (m && AI_MODELS[m]) models[f] = m;
  });
  return {
    monthlyBudgetUsd: Number.isFinite(budget) && budget >= 0 ? Math.min(budget, 1000) : DEFAULT_AI_CONFIG.monthlyBudgetUsd,
    models,
    updatedAt: r.updatedAt || null
  };
}

export function modelFor(cfg, feature) {
  return (cfg.models && cfg.models[feature]) || (AI_FEATURES[feature] && AI_FEATURES[feature].defaultModel) || 'claude-haiku-5-5';
}

function monthKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

// 이번 달 사용량: { totalUsd, totalCalls, byFeature: { [기능]: { usd, calls, inTok, outTok, fails } } }
export async function loadAiUsage(month) {
  const raw = await kvCommand(['HGETALL', AI_USAGE_PREFIX + (month || monthKST())]);
  const usage = { totalUsd: 0, totalCalls: 0, byFeature: {} };
  if (!Array.isArray(raw)) return usage;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [feature, field] = String(raw[i]).split(':');
    const v = Number(raw[i + 1]) || 0;
    if (feature === 'total') {
      if (field === 'usd') usage.totalUsd = v;
      if (field === 'calls') usage.totalCalls = v;
      continue;
    }
    const row = usage.byFeature[feature] = usage.byFeature[feature] || { usd: 0, calls: 0, inTok: 0, outTok: 0, fails: 0 };
    if (field in row) row[field] = v;
  }
  return usage;
}

// 응답의 usage(토큰 수)로 실제 비용을 계산합니다. 캐시 쓰기는 입력가의 1.25배, 캐시 읽기는 0.1배예요.
function costOf(modelId, usage) {
  const p = AI_MODELS[modelId] || AI_MODELS['claude-opus-5-5']; // 모르는 모델이면 비싼 쪽으로 계산(적게 잡히지 않게)
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const long = p.inUsdLong && inTok > 100_000;
  const inRate = long ? p.inUsdLong : p.inUsd;
  const outRate = long ? p.outUsdLong : p.outUsd;
  const inputUsd = ((usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1) * inRate / 1e6;
  return { usd: inputUsd + (usage.output_tokens || 0) * outRate / 1e6, inTok, outTok: usage.output_tokens || 0 };
}

async function recordUsage(feature, modelId, usage) {
  const key = AI_USAGE_PREFIX + monthKST();
  const c = costOf(modelId, usage || {});
  await Promise.all([
    kvCommand(['HINCRBYFLOAT', key, 'total:usd', String(c.usd)]),
    kvCommand(['HINCRBY', key, 'total:calls', '1']),
    kvCommand(['HINCRBYFLOAT', key, feature + ':usd', String(c.usd)]),
    kvCommand(['HINCRBY', key, feature + ':calls', '1']),
    kvCommand(['HINCRBY', key, feature + ':inTok', String(c.inTok)]),
    kvCommand(['HINCRBY', key, feature + ':outTok', String(c.outTok)])
  ]);
  return c.usd;
}

async function recordFailure(feature, reason, message) {
  await Promise.all([
    kvCommand(['HINCRBY', AI_USAGE_PREFIX + monthKST(), feature + ':fails', '1']),
    kvSetJson(AI_LAST_ERROR_KEY, { at: Date.now(), feature, reason, message: String(message || '').slice(0, 300) })
  ]);
}

// 화면에 보여줄 쉬운 실패 이유
export const AI_REASON_TEXT = {
  'no-key': 'Vercel 환경변수에 ANTHROPIC_API_KEY가 없어요.',
  credit: 'Anthropic 크레딧(충전금)이 부족해요. 콘솔에서 충전해 주세요.',
  auth: 'API 키가 맞지 않거나 사용이 막혔어요. 콘솔에서 키를 확인해 주세요.',
  rate: '짧은 시간에 너무 많이 불러서 잠시 막혔어요. 조금 뒤 다시 돼요.',
  budget: '이번 달 AI 예산을 다 써서 큰 작업을 멈췄어요. 설정 탭에서 예산을 바꿀 수 있어요.',
  'hard-stop': '이번 달 AI 사용액이 예산의 2배를 넘어서 모든 AI를 멈췄어요. 설정 탭에서 확인해 주세요.',
  refusal: 'AI가 이 요청에는 답하지 않았어요.',
  empty: 'AI가 답을 끝까지 쓰지 못했어요.',
  network: 'Anthropic 서버에 연결하지 못했어요.',
  error: 'AI 호출 중 알 수 없는 오류가 났어요.'
};

function classifyError(e) {
  if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) return 'auth';
  if (e instanceof RateLimitError) return 'rate';
  // 크레딧 부족은 전용 오류 종류가 없고 400 오류의 안내 문구로만 알 수 있어서, 문구를 확인합니다.
  if (e instanceof BadRequestError && /credit balance/i.test(String(e.message))) return 'credit';
  if (e instanceof APIConnectionError) return 'network';
  if (e instanceof APIError) return 'error';
  return 'error';
}

let client = null;
let cfgCache = null; // { at, cfg } — 설정은 1분 동안 재사용(호출마다 KV를 읽지 않게)

async function loadAiConfigCached() {
  if (cfgCache && Date.now() - cfgCache.at < 60_000) return cfgCache.cfg;
  const cfg = normalizeAiConfig(await kvGetJson(AI_CONFIG_KEY, null));
  cfgCache = { at: Date.now(), cfg };
  return cfg;
}

// Claude에게 한 번 물어봅니다.
// opts: { feature, prompt, system?, maxTokens?, timeoutMs? }
// 반환: { ok:true, text, model, costUsd } 또는 { ok:false, reason, message } — 오류를 던지지 않아요.
export async function askClaude(opts) {
  const feature = opts.feature;
  const def = AI_FEATURES[feature] || { effort: 'medium', heavy: false };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, reason: 'no-key', message: AI_REASON_TEXT['no-key'] };

  const cfg = await loadAiConfigCached();
  const used = (await loadAiUsage()).totalUsd;
  if (cfg.monthlyBudgetUsd > 0 && used >= cfg.monthlyBudgetUsd * HARD_STOP_MULTIPLIER) {
    await recordFailure(feature, 'hard-stop', AI_REASON_TEXT['hard-stop']);
    return { ok: false, reason: 'hard-stop', message: AI_REASON_TEXT['hard-stop'] };
  }
  if (def.heavy && cfg.monthlyBudgetUsd > 0 && used >= cfg.monthlyBudgetUsd) {
    return { ok: false, reason: 'budget', message: AI_REASON_TEXT.budget };
  }

  const model = modelFor(cfg, feature);
  if (!client) client = new Anthropic({ maxRetries: 1 });
  const params = {
    model,
    // 새 모델들은 답하기 전에 먼저 "생각"을 하고, 그 생각도 max_tokens에 포함돼요. 그래서 예전보다 넉넉히 잡아요.
    max_tokens: opts.maxTokens || 4000,
    output_config: { effort: def.effort },
    messages: [{ role: 'user', content: opts.prompt }]
  };
  if (opts.system) params.system = opts.system;

  try {
    const requestOpts = { timeout: opts.timeoutMs || 25_000 };
    // Sonnet·Opus는 안전 필터가 요청을 거절하면 다른 모델이 대신 답하도록(fallback) 켜 둡니다. Haiku 5.5는 이 기능이 없어요.
    const response = model === 'claude-haiku-5-5'
      ? await client.messages.create(params, requestOpts)
      : await client.beta.messages.create(Object.assign({}, params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }), requestOpts);

    const costUsd = await recordUsage(feature, model, response.usage);
    if (response.stop_reason === 'refusal') {
      await recordFailure(feature, 'refusal', AI_REASON_TEXT.refusal);
      return { ok: false, reason: 'refusal', message: AI_REASON_TEXT.refusal };
    }
    // 답 앞에 "생각" 블록이 올 수 있어서, 순서가 아니라 종류(text)로 골라 읽어요.
    const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) {
      await recordFailure(feature, 'empty', AI_REASON_TEXT.empty);
      return { ok: false, reason: 'empty', message: AI_REASON_TEXT.empty };
    }
    await kvSetJson(AI_LAST_OK_KEY, { at: Date.now(), feature });
    return { ok: true, text, model: response.model || model, costUsd };
  } catch (e) {
    const reason = classifyError(e);
    console.error(`_ai.js(${feature}) ${reason}:`, e && e.message);
    await recordFailure(feature, reason, e && e.message);
    return { ok: false, reason, message: AI_REASON_TEXT[reason] };
  }
}

// 답에서 JSON(객체 {…} 또는 배열 […])만 뽑아냅니다. 실패하면 null.
export function extractJson(text, kind) {
  const open = kind === 'array' ? '[' : '{';
  const close = kind === 'array' ? ']' : '}';
  const s = text.indexOf(open), e = text.lastIndexOf(close);
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (err) { return null; }
}
