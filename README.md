# LEDGER — 개인 투자 분석 사이트

한국투자증권(KIS) Open API + Finnhub + Claude AI를 이용한 개인용 주식 관심종목·포트폴리오·분석 대시보드입니다.
별도 빌드 과정 없이 `index.html` + `/api/*.js` 서버리스 함수로 동작합니다.
모든 API 키는 **서버(Vercel 환경변수)에만 저장**되며, 사용자는 브라우저에서 아무 키도 입력할 필요가 없습니다.

## 1. API 키 발급

세 종류의 키가 필요합니다 (모두 무료 플랜으로 시작 가능).

1. **한국투자증권 Open API** (시세·차트·재무지표, 국내+해외 공용)
   - 한국투자증권 계좌 개설 후 https://apiportal.koreainvestment.com 에서 Open API 신청
   - App Key / App Secret 발급 (App Secret은 매우 긴 문자열이므로 복사할 때 잘리지 않도록 주의하세요)
2. **Finnhub** (뉴스·실적)
   - https://finnhub.io/register 에서 무료 계정 생성 → API 키 발급
3. **Anthropic (Claude API)** (AI 시그널 / AI 어닝콜 / 뉴스 영향도 분석, 선택 사항이지만 강력 추천)
   - https://console.anthropic.com 에서 계정 생성 → API 키 발급

## 2. GitHub에 업로드

1. GitHub에서 새 저장소(Repository)를 만듭니다. (예: `ledger-invest`)
2. 이 폴더의 `index.html`, `package.json`, `api/` 폴더 전체, `README.md`를 저장소에 업로드합니다.
   - GitHub 웹사이트에서 "Add file → Upload files"로 드래그앤드롭 하면 됩니다.
   - 또는 터미널에서:
     ```bash
     git init
     git add .
     git commit -m "Initial commit"
     git branch -M main
     git remote add origin https://github.com/사용자명/ledger-invest.git
     git push -u origin main
     ```

## 3. Vercel로 배포 + 환경변수 등록

1. https://vercel.com 접속 → GitHub 계정으로 로그인
2. "Add New… → Project" 클릭 → 방금 만든 GitHub 저장소를 선택 → Import
3. Framework Preset은 **Other**로 두면 됩니다. (별도 빌드 명령 필요 없음)
4. 배포 전(또는 배포 후) **Settings → Environment Variables**에서 아래 키를 등록하세요:

   | 이름 | 값 |
   |---|---|
   | `KIS_APP_KEY` | 한국투자증권 Open API App Key |
   | `KIS_APP_SECRET` | 한국투자증권 Open API App Secret |
   | `FINNHUB_API_KEY` | Finnhub API 키 |
   | `ANTHROPIC_API_KEY` | Anthropic API 키 (AI 기능용, 선택) |

5. "Deploy" 클릭 → 1분 내로 `https://ledger-invest.vercel.app` 같은 주소가 발급됩니다.
6. 환경변수를 나중에 추가/수정했다면 **Redeploy**를 한 번 눌러줘야 반영됩니다.
7. 이후 GitHub 저장소에 변경사항을 push할 때마다 Vercel이 자동으로 재배포합니다.

## 4. 사용 방법

1. 배포된 사이트 접속 → 로그인/회원가입 (이메일+비밀번호, Firebase 인증)
2. **대시보드**에서 관심종목 티커 추가 — 국내는 6자리 코드(예: `005930`), 해외는 티커(예: `AAPL`)
3. **종목분석**에서 개별 종목의 시세·차트·재무지표·뉴스·AI 시그널 확인
4. **랭킹**에서 국내 등락률/거래량 상위 종목 확인
5. **이슈**에서 시장 전체 뉴스를 AI가 매긴 영향도 순으로 확인
6. **포트폴리오**에서 보유종목(티커/수량/매입가)을 등록하면 실시간 손익 계산
7. 로그인한 계정 기준으로 관심종목·보유종목이 모든 기기에 자동 동기화됩니다.

## 참고 / 제약사항

- 해외 종목 시세는 KIS가 거래소(나스닥/뉴욕/아멕스)를 자동으로 순서대로 조회하므로, 첫 조회 시 약간 느릴 수 있습니다.
- 실적(어닝) 데이터는 Finnhub 특성상 미국 종목 위주로 지원되며, 국내 종목은 데이터가 없을 수 있습니다.
- 뉴스의 "긍정/부정" 판단은 Claude AI가 헤드라인을 보고 추정한 것으로, 참고용입니다.
- 이 앱은 투자 조언을 제공하지 않으며, 표시되는 모든 데이터는 참고용입니다.
