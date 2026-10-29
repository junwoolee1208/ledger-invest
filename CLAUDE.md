# LEDGER — 프로젝트 안내 (Claude용)

개인 투자 분석 사이트. 빌드 과정 없이 `index.html`(프론트엔드 전체) + `api/*.js`(Vercel 서버리스 함수)로 동작한다.

## 배포

- GitHub 저장소 `main` 브랜치에 푸시하면 Vercel이 자동 배포한다 → https://ledger-invest.vercel.app
- 따라서 `main`에 푸시하는 것 = 실제 사이트에 반영하는 것. 신중하게.

## 코드 구조

- `index.html` — 화면 전체(HTML/CSS/JS 한 파일). Chart.js, Firebase Auth(로그인)를 CDN으로 불러온다.
- `api/` — 서버 함수. `_`로 시작하지 않는 파일 하나 = Vercel 함수 하나.
  - `analysis.js` 종목분석(시세+차트+뉴스 한 번에)
  - `chart-data.js` 차트 기간 전환
  - `market-data.js` 시세/순위/실적/시장뉴스 (`source=kis|finnhub`, `type=...`)
  - `investment-opinion.js` AI 투자의견
  - `explain.js` AI 요약 (`mode` 없음=뉴스, `mode=earnings`=실적)
  - `screen-candidates.js` AI 추천 종목 스크리닝
  - `sync.js` 관심종목/포트폴리오 저장 (Firebase ID 토큰 검증 → Vercel KV)
  - `auto-trade-check.js` 자동매매 실행 (외부 크론이 호출, `key`=`AUTO_TRADE_SECRET` 필요)
  - `auto-trade-status.js` 자동매매 설정/현황 (`action=config|log`)
  - `backtest.js` 전략연구실 (`mode=presets|evolve`)
- `api/_*.js` — 공용 코드 (Vercel 함수 개수에 안 잡힘)
  - `_kis.js` KIS 토큰 발급·KV 공유 캐시, `_kv.js` Vercel KV 헬퍼, `_costs.js` 수수료·세금,
    `_sentiment.js` 뉴스 긍정/부정 점수, `_backtest-core.js` / `_evolve-core.js` 백테스트·진화 탐색 로직
  - `_ai.js` 모든 AI 호출(모델 선택·사용량·예산·실패 기록), `_chat.js` AI 상담 대화 엔진(도구 사용 반복)
  - `_strategies.js` 전략 이름·기본 규칙·가상계좌 키, `_daytrade.js` 단타 설정, `_ledger.js` 날짜별 손익 장부
  - `_learning.js` 학습하는 자동조정 규칙, `_scorecard.js` 채점표 계산, `_deepeval.js` 주간 AI 심층 평가서
  - `_picks.js` 종목 고르기 규칙·기록·성적표
- 데이터 저장: Vercel KV(Upstash Redis). 로그인: Firebase Authentication.

## 반드시 지킬 규칙

### 서버 함수 개수 제한 (12개)
- Vercel 무료 플랜은 서버 함수가 **최대 12개**다. 넘으면 배포가 실패한다. (현재 10개)
- **`api/` 폴더에 새 함수 파일을 만들지 말 것.** 새 기능은 기존 파일에 `action` / `mode` 같은
  쿼리 파라미터를 추가해서 넣는다. (예: `auto-trade-status.js`의 `action`, `backtest.js`의 `mode`)
- 여러 파일이 같이 쓰는 코드는 `_`로 시작하는 파일(예: `api/_kis.js`)에 둔다.

### 외부 API와 키
- 시세·차트: 한국투자증권(KIS) Open API (토큰은 반드시 `_kis.js`를 통해 받는다 — 1분 1회 발급 제한)
- 뉴스·실적: Finnhub
- AI: Claude API (Anthropic) — **모든 AI 호출은 `api/_ai.js`의 `askClaude()`를 거친다.** 파일에서 직접 fetch로
  Claude를 부르지 말 것(사용량 기록·월 예산·실패 이유 기록이 빠짐). 공식 SDK `@anthropic-ai/sdk`(package.json)를 쓰고,
  기능별 모델은 설정 탭에서 고른다(기본 `claude-haiku-5-5`). 새 AI 기능은 `AI_FEATURES`에 등록한다.
- **API 키는 전부 Vercel 환경변수에만 둔다.** 코드나 `index.html`에 키를 직접 쓰지 말 것.
  사용하는 환경변수: `KIS_APP_KEY`, `KIS_APP_SECRET`, `FINNHUB_API_KEY`, `ANTHROPIC_API_KEY`,
  `AUTO_TRADE_SECRET`, `KV_REST_API_URL`/`KV_REST_API_TOKEN`(또는 `UPSTASH_REDIS_REST_*`)

### 자동매매
- 아직 **가상계좌 시뮬레이션(`mode: 'dryrun'`)** 이다. 실제 주문 코드로 바꾸지 말 것(사용자가 명시적으로 요청할 때만).
- 수익 계산은 `api/_costs.js`의 수수료·세금 설정(기본값: 토스증권)을 따른다.
  자동매매·현황·백테스트 모두 같은 비용 모델을 써야 한다. 수수료를 코드에 따로 하드코딩하지 말 것.
- 전략 숫자 자동조정은 "지켜보기 → 실험 → 채점 → 교훈" 순환이다(규칙: `api/_learning.js`, 실행: `auto-trade-check.js`의
  `maybeRunLearningCycle`). 기준선(baseline)은 대조군이라 절대 자동/수동으로 바꾸지 않는다.

## 작업 방식

- 사용자는 코딩 초보다. **무엇을, 왜 바꿨는지 쉬운 한국어로** 설명한다. 전문용어는 풀어서 쓴다.
- **새 기능은 사용자가 "코드 올려줘"라고 하기 전까지 계획만 설명하고 코드를 바꾸지 않는다.**
- 코드 수정 후에는 **문법 검사**를 한다.
  - JS 파일: `node --check api/파일명.js`
  - `index.html`의 스크립트는 `<script>` 내용을 따로 떼어 `node --check`로 확인한다.
  - (Node.js가 설치되어 있지 않으면 그 사실을 사용자에게 알린다.)
- **푸시 전에는 바뀐 내용을 요약해서 보여준다.**
- 코드 주석은 기존처럼 한국어로, 왜 그렇게 했는지 위주로 단다.
