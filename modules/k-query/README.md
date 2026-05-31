# K-Query

검색어 생성 AI 툴입니다.

K-Query는 크롬 MV3 사이드패널 확장으로, 특허 청구항을 **논리 → 구문** 파이프라인을 통해 구조화된 불리언 검색식으로 변환합니다. LLM의 분석/번역 능력과 규칙 기반 조립을 분리하여 안정성과 재현성을 확보합니다.

## 핵심 특징
- **3단계 파이프라인**: 분석 → 확장 → 조립/검증
- **멀티 모델 앙상블**: 유의어 확장에서 여러 모델 경쟁 + 심판 모델 평가
- **프롬프트 분리**: `prompts/`의 텍스트 파일만 수정해 튜닝 가능
- **규칙 기반 조립**: LLM 출력 불안정성을 보완하는 안정적 빌더
- **개발 로그**: 각 레이어 요청/응답을 UI에서 확인

## 시스템 아키텍처

### Layer 1: 분석 (Analyst)
1. **키워드 추출**
   - 청구항에서 핵심 기술 용어를 JSON 요소로 추출
2. **관계 매핑**
   - 요소 간 문법적 관계와 NEAR 거리 판단

### Layer 2: 확장 (Translator + Ensemble)
1. **유의어 확장 (멀티 모델)**
   - 모델별 유의어/약어/영문 표현 생성
2. **평가 (Judge)**
   - 결과 취합, 정제, 점수화, 피드백 생성
3. **피드백 루프**
   - 저성능 모델에 교정 지시를 저장해 다음 턴에 반영

### Layer 3: 조립 & 검증 (Assembler)
1. **규칙 기반 빌더**가 드래프트 검색식 생성
2. **LLM 조립기**가 `final_query` JSON으로 최종식 작성
3. **문법 검증**으로 금지 연산자 및 `<near/n>` 규칙 체크

## 디렉터리 구조
```
/project-root
├── manifest.json
├── prompts/
│   ├── layer_1/
│   │   ├── extraction/
│   │   │   ├── system.txt
│   │   │   ├── user.txt
│   │   │   └── schema.json
│   │   └── relations/
│   │       ├── system.txt
│   │       ├── user.txt
│   │       └── schema.json
│   ├── layer_2/
│   │   ├── expansion/
│   │   │   ├── system.txt
│   │   │   ├── user.txt
│   │   │   └── schema.json
│   │   ├── evaluation/
│   │   │   ├── system.txt
│   │   │   ├── user.txt
│   │   │   └── schema.json
│   │   └── context_filter/
│   │       ├── system.txt
│   │       ├── user.txt
│   │       └── schema.json
│   └── layer_3/
│       └── validation/
│           ├── system.txt
│           ├── user.txt
│           └── schema.json
└── src/
    ├── core/
    │   ├── api_clients.js
    │   ├── background.js
    │   ├── feedback_manager.js
    │   ├── json_utils.js
    │   ├── model_config.js
    │   ├── orchestrator.js
    │   ├── prompt_loader.js
    │   ├── query_builder.js
    │   └── query_validator.js
    └── sidebar/
        ├── sidepanel.html
        ├── sidepanel.css
        └── sidepanel.js
```

## 프롬프트 플레이스홀더
각 단계는 `system.txt + user.txt + schema.json` 번들로 로딩됩니다.
`schema.json`은 `required`, `optional`, `types(text|json|list)`를 정의하며, 누락된 필수 변수는 즉시 에러 처리됩니다.

- `prompts/layer_1/extraction/user.txt`
  - `{{claim}}`
- `prompts/layer_1/relations/user.txt`
  - `{{claim}}`, `{{elements_json}}`
- `prompts/layer_2/expansion/user.txt`
  - `{{keyword}}`, `{{feedback_instruction}}`, `{{claim}}`, `{{elements_json}}`, `{{mode}}`
- `prompts/layer_2/evaluation/user.txt`
  - `{{keyword}}`, `{{claim}}`, `{{elements_json}}`, `{{mode}}`, `{{model_payload}}`
- `prompts/layer_2/context_filter/user.txt`
  - `{{claim}}`, `{{elements_json}}`, `{{mode}}`, `{{keyword}}`, `{{synonyms_json}}`
- `prompts/layer_3/validation/user.txt`
  - `{{claim}}`, `{{mode}}`, `{{synonyms_json}}`, `{{relations_json}}`

> 참고: 레거시 단일 파일(`*.txt`)도 fallback 경로로 유지되지만, 신규 편집은 번들 디렉터리(`system/user/schema`) 기준을 권장합니다.

## 설정

### 모델 ID
`src/core/model_config.js`에서 설정합니다.
- `ANALYST_MODEL`
- `JUDGE_MODEL`
- `ENSEMBLE_MODELS`
- `TEMPERATURES`

### API 엔드포인트
`src/core/api_clients.js`에서 OpenWebUI 주소를 설정합니다. 로컬 테스트:
```
http://127.0.0.1:5000/api/chat/completions
```

### API 키 저장
API 키는 K-SUITE 팝업에서 공통으로 저장되며, `chrome.storage.local`의 `ksuiteSharedApiKey`를 사용합니다.

## K-SUITE 통합 메모
- K-Query는 K-SUITE 통합 런처에서 사이드패널로 실행됩니다.
- 공통 설정(`Base URL`, `Shared API Key`)은 루트 팝업에서 관리합니다.
- K-SCAN 최신 변경사항(큐 처리, 결과창 UI 개선 등)은 루트 [README](../../README.md)를 참고합니다.

## 실행 방법 (Chrome MV3)
1. Chrome → `chrome://extensions` 접속
2. **개발자 모드** 활성화
3. **압축 해제된 확장 프로그램 로드** 클릭 후 프로젝트 폴더 선택
4. K-SUITE 팝업에서 공통 API 키 저장
5. 청구항 입력 후 **Generate Query** 실행

## 로그
- **Progress Log**: 사용자용 진행 상황
- **Developer Log**: 레이어별 요청/응답 상세 내용

## 문제 해결
- **Manifest 로드 오류**: `src/core/background.js`, `src/sidebar/sidepanel.html` 존재 여부 확인
- **Syntax 오류**: 프롬프트 출력이 반드시 JSON만 반환하는지 확인
- **CORS/네트워크 문제**: 필요 시 `manifest.json`에 `host_permissions` 추가

## 참고
- 쿼리 조립은 가능한 한 **규칙 기반**으로 안정성을 유지하도록 설계됨
- `prompts/layer_2/expansion/*`와 `prompts/layer_2/evaluation/*`는 역할이 달라야 품질이 향상됨
- DB가 그룹 간 `<near/n>`을 지원하지 않으면 전개(expand) 모듈 추가가 필요
