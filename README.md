# K-SUITE

K-SUITE는 특허 심사 지원을 위한 Chrome MV3 확장 제품군입니다. 저장소 루트의 `manifest.json`을 기준으로 하나의 런처 확장을 로드하면, 공통 설정과 서비스 워커를 통해 `K-LARC`, `K-Query`, `K-SCAN`, `K-Research`를 같은 워크플로우 안에서 사용할 수 있습니다.

현재 루트 확장 버전은 `v1.4.0`입니다.

## 구성

- `K-LARC`
  - 청구항과 인용문헌을 비교 분석하는 메인 대시보드
  - 탭 화면으로 열립니다.
- `K-Query`
  - 청구항에서 검색식 후보를 생성하고 보정하는 사이드패널
  - Layer 1/2/3 기반 구조화 파이프라인을 사용합니다.
- `K-SCAN`
  - KOMPASS 탐색 결과를 캡처하고 문헌 유사도 평가를 수행하는 사이드패널
  - 평가 이력과 재평가 UI는 별도 결과 창으로 열립니다.
- `K-Research`
  - 검색식 생성 -> 수집 -> 평가 -> 보정을 반복하는 자동 탐색 사이드패널
  - 기본 UI는 `실행 / 결과 / 고급` 3개 작업면입니다.

## 실행 환경

- Chrome 기반 브라우저의 Manifest V3 확장 환경
- `sidePanel`을 지원하는 브라우저 버전
- OpenWebUI 호환 `chat/completions` 엔드포인트
- 공통 인증값으로 사용할 `Shared API Key / Token`
- `K-SCAN`, `K-Research`를 사용할 때는 KOMPASS 웹 탭 문맥

루트 팝업에서 저장하는 공통 설정은 다음 두 가지입니다.

- `OpenWebUI Base URL`
- `Shared API Key / Token`

공통 API 키는 `chrome.storage.local`에 저장되며, 예전 키 이름(`webuiApiKey`, `user_token`, `apiKey`)이 있으면 자동 마이그레이션됩니다.

## 시작하기

1. `chrome://extensions`로 이동합니다.
2. `개발자 모드`를 켭니다.
3. 이 저장소 루트를 `압축해제된 확장 프로그램 로드`로 등록합니다.
4. K-SUITE 팝업을 열고 공통 설정을 저장합니다.
5. 사용할 모듈을 실행합니다.

모듈별 실행 방식은 다음과 같습니다.

- `K-LARC`: 새 탭 또는 기존 탭 포커스
- `K-Query`: 현재 탭 기준 사이드패널
- `K-SCAN`: KOMPASS 탭 기준 사이드패널
- `K-Research`: KOMPASS 탭 기준 사이드패널

주의할 점:

- `K-Query`는 `chrome://extensions`, `edge://extensions` 같은 설정 탭에서 열 수 없습니다.
- `K-SCAN`, `K-Research`는 `K-LARC` 대시보드 탭이 아니라 실제 웹 탭, 보통 KOMPASS 탭에서 여는 흐름을 전제로 합니다.

## 권장 사용 흐름

1. `K-Query`에서 청구항을 넣고 초기 검색식을 생성합니다.
2. KOMPASS 탭에서 `K-SCAN`을 열어 결과를 캡처하고 문헌 점수를 확인합니다.
3. 반복 탐색이 필요하면 `K-Research`에서 자동 루프를 실행합니다.
4. 확보한 문헌과 청구항을 바탕으로 `K-LARC`에서 인용 분석과 의견제출통지서 작성을 진행합니다.

## 저장소 구조

```text
.
|-- suite/                 # 루트 팝업, 공통 상수, 버전 배지, 네비게이션, 공통 테마
|-- modules/
|   |-- k-larc/            # 청구항/문헌 분석 대시보드
|   |-- k-query/           # 검색식 생성 사이드패널
|   |-- k-research/        # 자동 탐색 사이드패널
|   `-- k-scan/            # 캡처/유사도 평가 사이드패널 및 결과창
|-- docs/                  # 시스템/모듈 가이드
|-- tests/                 # 스모크 및 K-Research 회귀 테스트
|-- updates/               # 날짜별 변경 메모
|-- KOMPASS Control/       # 별도 실험용 보조 확장
`-- skills/                # K-LARC 관련 보조 스킬 자산
```

## 문서

- 전체 구조: [ARCHITECTURE.md](ARCHITECTURE.md)
- 변경 이력: [UPDATE.md](UPDATE.md)
- 시스템 가이드: [docs/k-suite-system-guide.md](docs/k-suite-system-guide.md)
- 모듈 가이드: [docs/k-suite-modules-guide.md](docs/k-suite-modules-guide.md)
- K-Research 상세: [modules/k-research/README.md](modules/k-research/README.md)
- K-Query 상세: [modules/k-query/README.md](modules/k-query/README.md)
- K-LARC 상세: [modules/k-larc/docs/k-larc-5-layer-judgment-system.md](modules/k-larc/docs/k-larc-5-layer-judgment-system.md)

## 테스트

루트에는 별도 빌드 단계나 패키지 매니저 설정이 없고, 주요 검증은 Node 기반 스크립트로 수행합니다.

```powershell
node tests/smoke/run-smoke.mjs
node tests/kresearch/run-kresearch-tests.mjs
node modules/k-larc/tests/xml-extraction-tests.mjs
```

K-Research 모듈 단위 테스트를 개별 실행하려면 다음 스크립트를 사용할 수 있습니다.

```powershell
node modules/k-research/tests/auto-loop-tests.mjs
node modules/k-research/tests/capture-parity-tests.mjs
node modules/k-research/tests/count-aware-control-tests.mjs
node modules/k-research/tests/refactor-policy-tests.mjs
```

## 개발 메모

- 루트 `manifest.json`의 버전은 `suite/shared-version.js`를 통해 각 UI에 공통 주입됩니다.
- 루트 서비스 워커는 `modules/k-larc/background.js`, `modules/k-scan/background.js`, `modules/k-research/background-capture.js`를 함께 불러와 모듈 실행과 캡처 제어를 오케스트레이션합니다.
- `KOMPASS Control/`은 루트 K-SUITE 런처와 별개인 보조 확장입니다. 필요한 경우 별도로 로드해서 사용할 수 있습니다.
