// /api/_universe.js
// 자동매매가 사고파는 "고정 50종목" 목록이에요. _로 시작해서 Vercel 함수 개수에 안 잡혀요.
//
// 왜 고정하나: 그날그날 거래대금 순위로 고르면 뉴스 하나로 튄 종목이 섞이고, 목록이 매일 바뀌어서
// 어떤 전략이 왜 벌었는지 비교하기 어려웠어요(2026-11 손실 분석). 그래서 꾸준히 거래가 많은 큰 회사로 고정해요.
// 고른 기준(2026-11-08 조사): 최근 20거래일(10/12~11/6) 평균 거래대금 상위 + 시가총액 5조 원 이상.
// 한 달에 한 번 "목록 점검"(auto-trade-status.js action=universe)으로 기준에서 벗어난 종목을 알려줘요(자동으로 바꾸진 않아요).

import { kisHeaders, num, KIS_BASE, fetchKisJson } from './_kis.js';
import { fetchSymbolHistory } from './_backtest-core.js';

// 순서 = 조사 당시 20일 평균 거래대금 순위(1위부터). 후보를 볼 때도 이 순서대로 봐요.
export const FIXED_UNIVERSE = [
  ['000660', 'SK하이닉스', '반도체'], ['005930', '삼성전자', '반도체'], ['009150', '삼성전기', '전자부품'],
  ['402340', 'SK스퀘어', '지주(반도체)'], ['006400', '삼성SDI', '2차전지'], ['036930', '주성엔지니어링', '반도체장비'],
  ['028050', '삼성E&A', '건설·플랜트'], ['373220', 'LG에너지솔루션', '2차전지'], ['005380', '현대차', '자동차'],
  ['034020', '두산에너빌리티', '원전·발전'], ['105560', 'KB금융', '금융'], ['012450', '한화에어로스페이스', '방산'],
  ['009830', '한화솔루션', '화학·태양광'], ['042700', '한미반도체', '반도체장비'], ['042660', '한화오션', '조선'],
  ['034730', 'SK', '지주'], ['068270', '셀트리온', '바이오'], ['035420', 'NAVER', '인터넷'],
  ['298040', '효성중공업', '전력기기'], ['066570', 'LG전자', '전자'], ['278470', '에이피알', '화장품'],
  ['207940', '삼성바이오로직스', '바이오'], ['329180', 'HD현대중공업', '조선'], ['028260', '삼성물산', '지주·건설'],
  ['096770', 'SK이노베이션', '정유·배터리'], ['010120', 'LS ELECTRIC', '전력기기'], ['000150', '두산', '지주'],
  ['055550', '신한지주', '금융'], ['000270', '기아', '자동차'], ['267260', 'HD현대일렉트릭', '전력기기'],
  ['012330', '현대모비스', '자동차부품'], ['086790', '하나금융지주', '금융'], ['011070', 'LG이노텍', '전자부품'],
  ['003490', '대한항공', '항공'], ['079550', 'LIG넥스원', '방산'], ['032830', '삼성생명', '보험'],
  ['005490', 'POSCO홀딩스', '철강·소재'], ['196170', '알테오젠', '바이오'], ['003670', '포스코퓨처엠', '2차전지소재'],
  ['010140', '삼성중공업', '조선'], ['086520', '에코프로', '2차전지소재'], ['272210', '한화시스템', '방산'],
  ['180640', '한진칼', '지주(항공)'], ['316140', '우리금융지주', '금융'], ['051910', 'LG화학', '화학'],
  ['000810', '삼성화재', '보험'], ['017670', 'SK텔레콤', '통신'], ['010950', 'S-Oil', '정유'],
  ['009540', 'HD한국조선해양', '조선'], ['033780', 'KT&G', '담배']
].map(([symbol, name, sector], i) => ({ symbol, name, sector, rank: i + 1 }));

export const UNIVERSE_CHOSEN_AT = '2026-11-08';
export const UNIVERSE_RULE = { minCapJo: 5, tradeValueDays: 20 };

// 하락장 전략만 쓰는 예외 종목: 시장이 떨어질수록 오르는 상품(인버스 ETF). 50종목 밖이에요.
export const INVERSE_ETF = { symbol: '114800', name: 'KODEX 인버스', sector: '인버스 ETF', etf: true };

export const UNIVERSE_REVIEW_KEY = 'autotrade:universe-review'; // 마지막 점검 결과
export const UNIVERSE_REVIEW_DAYS = 30; // 이만큼 지나면 화면에서 점검하라고 알려줘요

// 매매 엔진이 쓰는 후보 모양. reason이 '거래대금'으로 시작해야 기존 전략들이 "거래대금 상위 후보" 기준(낮은 문턱)을 써요.
export function universeCandidates() {
  return FIXED_UNIVERSE.map((u) => ({ symbol: u.symbol, name: u.name, sector: u.sector, reason: `거래대금 고정 50(${u.rank}위)` }));
}

export function isUniverseSymbol(symbol) {
  return FIXED_UNIVERSE.some((u) => u.symbol === symbol);
}

// 점검 규칙(계산만): 기준 밖으로 나간 종목에 이유를 붙여요. rows: [{symbol, tv20(억), capJo}]
export function reviewRows(rows) {
  const ranked = rows.filter((r) => typeof r.tv20 === 'number').sort((a, b) => b.tv20 - a.tv20);
  const rankOf = new Map(ranked.map((r, i) => [r.symbol, i + 1]));
  return rows.map((r) => {
    const flags = [];
    if (typeof r.capJo === 'number' && r.capJo < UNIVERSE_RULE.minCapJo) flags.push(`시가총액 ${r.capJo.toFixed(1)}조(5조 미만)`);
    if (typeof r.tv20 === 'number' && r.tv20 < 300) flags.push(`20일 평균 거래대금 ${Math.round(r.tv20)}억(300억 미만)`);
    if (typeof r.tv20 !== 'number') flags.push('데이터를 받지 못했어요');
    return Object.assign({}, r, { nowRank: rankOf.get(r.symbol) || null, flags });
  });
}

// 50종목의 최근 20거래일 평균 거래대금(종가×거래량 어림)과 시가총액을 받아요. 5개씩 나눠 받아 초당 호출 제한을 피해요.
export async function fetchUniverseStats(token) {
  const out = [];
  for (let i = 0; i < FIXED_UNIVERSE.length; i += 5) {
    const batch = FIXED_UNIVERSE.slice(i, i + 5);
    const res = await Promise.all(batch.map(async (u) => {
      const row = { symbol: u.symbol, name: u.name, sector: u.sector, rank: u.rank, tv20: null, capJo: null };
      try {
        const hist = await fetchSymbolHistory(token, u.symbol, 40);
        const last = hist.slice(-UNIVERSE_RULE.tradeValueDays);
        if (last.length >= 10) row.tv20 = last.reduce((s, r) => s + (r.close || 0) * (r.volume || 0), 0) / last.length / 1e8;
      } catch (e) { /* 한 종목 실패해도 계속 */ }
      try {
        const q = await fetchKisJson(
          `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${u.symbol}`,
          kisHeaders(token, 'FHKST01010100')
        );
        const cap = q && q.output ? num(q.output.hts_avls) : null; // 억 원
        if (cap) row.capJo = cap / 10000;
      } catch (e) { /* 시가총액만 비어요 */ }
      return row;
    }));
    out.push(...res);
  }
  return reviewRows(out);
}
