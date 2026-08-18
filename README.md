# LEDGER — 개인 투자 분석 사이트

Alpha Vantage API를 이용한 개인용 주식 관심종목·포트폴리오·분석 대시보드입니다.
별도 빌드 과정 없이 `index.html` 파일 하나로 동작하는 정적 사이트입니다.

## 1. API 키 발급

1. https://www.alphavantage.co/support/#api-key 접속
2. 이메일만 입력하면 무료 키가 즉시 발급됩니다.
3. 무료 티어는 **분당 5회 / 일 25회** 요청으로 제한되니 참고하세요.

## 2. GitHub에 업로드

1. GitHub에서 새 저장소(Repository)를 만듭니다. (예: `ledger-invest`)
2. 이 폴더의 `index.html`, `README.md` 파일을 저장소에 업로드합니다.
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

## 3. Vercel로 배포

1. https://vercel.com 접속 → GitHub 계정으로 로그인
2. "Add New… → Project" 클릭
3. 방금 만든 GitHub 저장소를 선택 → Import
4. Framework Preset은 **Other**로 두면 됩니다. (별도 빌드 명령 필요 없음, 정적 HTML이라 그대로 배포됩니다)
5. "Deploy" 클릭 → 1분 내로 `https://ledger-invest.vercel.app` 같은 주소가 발급됩니다.
6. 이후 GitHub 저장소에 변경사항을 push할 때마다 Vercel이 자동으로 재배포합니다.

## 4. 사용 방법

1. 배포된 사이트 접속 → **설정** 탭에서 API 키 입력 후 저장
   (키는 브라우저에만 저장되고 서버로 전송되지 않습니다)
2. **대시보드**에서 관심종목 티커 추가 (예: `AAPL`, `MSFT`, `005930.KS`)
3. **종목분석**에서 개별 종목의 차트·재무지표·RSI 확인
4. **포트폴리오**에서 보유종목(티커/수량/매입가)을 등록하면 실시간 손익 계산

## 참고 / 제약사항

- 미국 등 해외 주요 종목은 폭넓게 지원되지만, 국내(코스피/코스닥) 종목은 Alpha Vantage에서 지원이 제한적이거나 지연 시세일 수 있습니다.
- 무료 API 한도 때문에 관심종목·보유종목이 많으면 일부 데이터가 늦게 갱신될 수 있습니다. (앱 내부적으로 캐싱해서 요청 수를 줄이고 있어요)
- 이 앱은 투자 조언을 제공하지 않으며, 표시되는 모든 데이터는 참고용입니다.
