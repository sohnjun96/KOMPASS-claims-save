# K-LARC 인용발명 전처리 프로세스 상세 정리

## 1) 목적과 범위
- 이 문서는 K-LARC에서 인용발명 문서를 분석 전에 어떻게 정규화/분할/센티넬화해서 업로드하는지 설명한다.
- 대상 경로:
1. 브라우저 탭 추출(`EXTRACT_AND_UPLOAD`)
2. PDF 파일 추가
3. 직접 텍스트 입력
- 기준 코드:
`modules/k-larc/background.js`,
`modules/k-larc/scripts/data.js`,
`modules/k-larc/scripts/pdf_extractor.js`,
`modules/k-larc/scripts/utils.js`,
`modules/k-larc/scripts/ui.js`

## 2) 왜 전처리가 필요한가
- K-LARC 후속 단계(B/C/D/E)는 근거 위치를 `Position`으로 다루며, 이 위치는 업로드 원문의 **센티넬 식별자(4자리)**를 기준으로 추적된다.
- 프롬프트에서도 센티넬 형식을 강제한다.
`modules/k-larc/prompts/step_b_rag/system.txt:30`,
`modules/k-larc/prompts/step_d_repair/system.txt:38`,
`modules/k-larc/prompts/step_quick_analysis/system.txt:46`,
`modules/k-larc/prompts/verification/system.txt:19`

즉, 전처리의 핵심은:
1. 텍스트를 검색 가능한 단위로 안정적으로 분할
2. 각 단위에 `⟪0001⟫ ... ⟪/0001⟫` 형식의 추적 토큰 부여
3. 센티넬 메타정보(`sentinelMap`)를 함께 저장해 사후 검증/원문 확인 가능하게 만드는 것이다.

## 3) 공통 데이터 모델

## Canonical Payload
전처리 결과는 아래 형태를 기준으로 다룬다.

```json
{
  "paragraphs": {
    "[0001]": "⟪0001⟫ ... ⟪/0001⟫"
  },
  "claims": {
    "청구항 1": "⟪0010⟫ ... ⟪/0010⟫"
  },
  "sentinelMap": {
    "0001": {
      "id": "0001",
      "order": 1,
      "source": "xml|tab_text|pdf|direct_input",
      "targetType": "paragraph|claim",
      "sourceKey": "[0001]",
      "displayKey": "[0001] or ⟪0001⟫",
      "pageNumber": 1,
      "sectionId": "S001"
    }
  },
  "meta": {
    "source": "...",
    "pageCount": 0,
    "sectionCount": 0,
    "paragraphCount": 0,
    "claimCount": 0,
    "sentinelCount": 0,
    "chunkSize": 400
  }
}
```

참고:
`modules/k-larc/background.js:204`,
`modules/k-larc/background.js:296`,
`modules/k-larc/scripts/pdf_extractor.js:641`,
`modules/k-larc/scripts/data.js:821`

## Upload Text 생성 규칙
- 실제 서버 업로드는 payload JSON 전체가 아니라, `sentinelMap.order` 순으로 펼친 텍스트(여러 줄)다.
- `targetType`이 `paragraph`면 `paragraphs[sourceKey]`, `claim`이면 `claims[sourceKey]`를 가져와 join한다.
- 구현:
`modules/k-larc/background.js:367`,
`modules/k-larc/scripts/utils.js:1341`

## 4) 핵심 전처리 유틸(공통 로직)

## 4.1 센티넬 포맷
- 자리수 고정: 4자리 (`CITATION_SENTINEL_DIGITS = 4`)
- 예: `1 -> 0001`
- 토큰: `⟪0001⟫`, `⟪/0001⟫`
- 구현:
`modules/k-larc/scripts/state.js:38`,
`modules/k-larc/scripts/utils.js:863`

## 4.2 청킹 정책
- 기본 chunk size: `400`
- overflow: `80`(20%)
- 문장 단위 병합 후 최대 길이 초과 시 분할
- 초장문은 구두점/공백 기준으로 재절단
- 구현:
`modules/k-larc/scripts/state.js:36`,
`modules/k-larc/background.js:153`,
`modules/k-larc/scripts/utils.js:1290`

## 4.3 위치 문자열 정규화
- 후속 단계에서 들어오는 Position을 센티넬/숫자 범위로 파싱하고 중복 제거/병합한다.
- 예: `⟪0010⟫-⟪0012⟫`, `[0010]-[0012]`, 단일 값, 콤마/세미콜론 분리 입력
- 구현:
`modules/k-larc/scripts/utils.js:887`,
`modules/k-larc/scripts/utils.js:976`,
`modules/k-larc/scripts/utils.js:1047`,
`modules/k-larc/scripts/utils.js:1130`

## 5) 경로 A: 브라우저 탭 기반 전처리

## 5.1 진입
- UI에서 탭 선택 후 추가하면 `EXTRACT_AND_UPLOAD` 메시지를 보낸다.
- 호출:
`modules/k-larc/scripts/data.js:721`
- background 수신:
`modules/k-larc/background.js:14`

## 5.2 페이지 본문 수집
- `chrome.scripting.executeScript`를 `allFrames: true`로 실행한다.
- 프레임별로:
1. `isXml` 판단 (URL 확장자/`document.contentType`)
2. XML이면 문서 직렬화(`rawXml`)
3. 일반 페이지면 `script/style/nav/header/footer/iframe` 제거 후 `innerText` 추출
- 구현:
`modules/k-larc/background.js:453`

## 5.3 대상 프레임 선택
- 우선순위:
1. XML 프레임 중 길이(`MIN_CONTENT_LENGTH=50`) 충분한 것
2. 없으면 길이가 가장 긴 프레임
- 유효 프레임 없으면 실패 처리
- 구현:
`modules/k-larc/background.js:489`

## 5.4 XML 전용 구조 추출
- `extractPatentData`가 XML/HTML에서 `paragraphs`, `claims`를 추출한다.
- 핵심:
1. 문단 번호 패턴을 키(`[0001]`)로 수집
2. `청구항` 라벨과 본문을 claim으로 수집
3. 전각 숫자는 반각으로 정규화
- 구현:
`modules/k-larc/background.js:394`

## 5.5 센티넬 payload 생성
- XML 경로:
`buildSentinelPayloadFromStructured`
  - 문단/청구항 키를 숫자 순 정렬 후 센티넬 부여
  - `paragraph -> claim` 순으로 연속 ID 배정
- 일반 텍스트 경로:
`buildSentinelPayloadFromPlainText`
  - 문장 청킹 후 문단 배열화
  - 각 청크에 센티넬 부여
- 구현:
`modules/k-larc/background.js:204`,
`modules/k-larc/background.js:296`,
`modules/k-larc/background.js:505`

## 5.6 XML fallback
- XML 파싱 결과가 비어 업로드 텍스트가 생성되지 않으면,
`rawXml`에서 태그 제거한 평문으로 다시 청킹해 payload를 만든다.
- 구현:
`modules/k-larc/background.js:521`

## 5.7 서버 업로드 + 로컬 저장
- 업로드 API:
`POST /api/v1/files/?process=true&process_in_background=true`
- 응답 `fileId` 확보 후 citation 객체에 저장:
`text`(업로드 텍스트), `payloadText`(JSON 문자열), `status=processing`
- 구현:
`modules/k-larc/background.js:540`,
`modules/k-larc/scripts/data.js:732`

## 5.8 처리 상태 폴링
- UI는 `CHECK_STATUS`를 3초 간격으로 호출한다.
- 상태 전이:
`uploading -> processing -> completed|failed`
- 구현:
`modules/k-larc/scripts/data.js:953`,
`modules/k-larc/background.js:574`

## 6) 경로 B: PDF 파일 전처리

## 6.1 진입
- 파일 선택 후 `handlePdfFileSelected` 실행
- PDF MIME/확장자 검증
- 구현:
`modules/k-larc/scripts/data.js:858`

## 6.2 PDF 파서 로드
- `modules/k-larc/lib/pdf.mjs` 동적 import
- worker: `modules/k-larc/lib/pdf.worker.mjs`
- 구현:
`modules/k-larc/scripts/pdf_extractor.js:210`

## 6.3 텍스트 라인 복원
- 페이지별 `getTextContent` 결과를 token으로 변환:
좌표(x,y), width, size, bold/italic
- y축 근접도 기반 라인 그룹핑 후 line text 복원
- 페이지 번호/인덱스 부여
- 구현:
`modules/k-larc/scripts/pdf_extractor.js:272`,
`modules/k-larc/scripts/pdf_extractor.js:698`

## 6.4 노이즈 제거/문단 경계 판단
- 페이지 번호, 기호열, copyright 등 라인 제거
- 수직 gap 기반 `breakBefore` 계산
- 구현:
`modules/k-larc/scripts/pdf_extractor.js:262`,
`modules/k-larc/scripts/pdf_extractor.js:365`

## 6.5 섹션(heading) 추정
- heading 키워드/패턴(ABSTRACT, INTRODUCTION, RESULTS...) + 서체 특성(bold/uppercase/한글 heading)으로 섹션 분류
- 중복 heading은 근접 인덱스 조건으로 통합
- 구현:
`modules/k-larc/scripts/pdf_extractor.js:483`

## 6.6 문단 생성과 재청킹
- 같은 페이지/섹션 내 라인을 이어 문단화(`stitchParagraphLines`)
- 문단을 다시 chunk size 정책으로 분할
- chunk별로 source paragraph index와 chunk index를 메타로 유지
- 구현:
`modules/k-larc/scripts/pdf_extractor.js:559`,
`modules/k-larc/scripts/pdf_extractor.js:616`

## 6.7 PDF payload 생성
- 각 청크를 `paragraphs["[0001]"]`에 저장하고 센티넬 부여
- `sentinelMap`에 `pageNumber`, `sectionId`, `sectionTitle` 포함
- `meta`에 `pageCount`, `sectionCount`, `sections(startParagraph)` 기록
- 구현:
`modules/k-larc/scripts/pdf_extractor.js:641`

## 6.8 업로드
- 생성된 payload -> `buildUploadTextFromCitationPayload` -> `DIRECT_UPLOAD`
- 구현:
`modules/k-larc/scripts/data.js:892`,
`modules/k-larc/scripts/data.js:922`,
`modules/k-larc/background.js:662`

## 7) 경로 C: 직접 텍스트 입력 전처리
- 사용자가 입력한 텍스트를 즉시 평문 청킹 -> 센티넬 payload 생성
- `source: direct_input`
- 이후 upload text를 `DIRECT_UPLOAD`로 전송
- 구현:
`modules/k-larc/scripts/data.js:1148`,
`modules/k-larc/scripts/data.js:1158`

## 8) 전처리 결과의 활용(추적성)

## 8.1 citation 객체에 원본 보존
- 각 citation에:
1. `text`: 서버에 업로드한 센티넬 텍스트
2. `payloadText`: 구조화 JSON 문자열
을 저장한다.
- 구현:
`modules/k-larc/scripts/data.js:735`,
`modules/k-larc/scripts/data.js:904`,
`modules/k-larc/scripts/data.js:1176`

## 8.2 Position 클릭 시 원문 역추적
- 결과 테이블 Position 토큰 클릭 -> `openPositionModal`
- `payloadText`를 다시 파싱해서:
1. 센티넬 범위(`⟪0010⟫-⟪0012⟫`)는 sentinelMap 기준으로 원문 복원
2. 숫자 문단(`[0010]`)은 paragraphs에서 직접 조회
- 구현:
`modules/k-larc/scripts/main.js:130`,
`modules/k-larc/scripts/ui.js:1904`

## 8.3 Display 변환
- 내부 Position 센티넬은 문서/페이지 메타를 붙여 UI 표시 가능
- 구현:
`modules/k-larc/scripts/utils.js:1220`

## 9) 실패 처리와 복구 포인트
- 내용 추출 실패: `유효한 텍스트 없음` 에러
- 업로드 실패: HTTP status + body 포함 에러
- 서버 fileId 누락: 실패 처리
- 앱 재시작 시 이전 `processing/uploading` citation은 `loadSettings`에서 polling 재개
- 구현:
`modules/k-larc/background.js:497`,
`modules/k-larc/background.js:549`,
`modules/k-larc/background.js:556`,
`modules/k-larc/scripts/data.js:277`

## 10) 요약
- K-LARC 인용발명 전처리는 단순 텍스트 업로드가 아니라, 문서를 **센티넬 기반 추적 가능한 문단 단위**로 재구성하는 파이프라인이다.
- 이 전처리 덕분에 후속 LLM 판정(B/C/D/E)과 검증(E), 그리고 UI 원문 확인(Position modal)이 같은 좌표계를 공유한다.
- 특히 PDF 경로는 layout 분석(라인/섹션/문단)을 통해 일반 텍스트보다 더 풍부한 메타(`page`, `section`)를 제공한다.
