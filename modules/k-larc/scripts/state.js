/**
 * Patent RAG Analyzer - Dashboard Logic
 * UI 제어, 데이터 관리, Background 통신, 결과 렌더링 담당
 */

// 개발자 전용 실행 플래그 (코드에서만 변경)
const DEV_FLAGS = {
  ENABLE_MOCK_MODE: false,
  SHOW_DEBUG_PANEL: true
};
const DEFAULT_LARC_MODEL = String(globalThis.KSUITE_DEFAULT_LLM_MODEL || "gemma-26b-moe").trim() || "gemma-26b-moe";
const K_LARC_OPENWEBUI_API_STORAGE_KEY = 'kLarcOpenWebUiApiSettings';
const K_LARC_B2_SKILL_TOGGLE_STORAGE_KEY = 'kLarcUseB2SkillMd';
const K_LARC_B2_SKILL_FILE_PATH = '../../skills/k-larc-rag-ops/SKILL.md';
const K_LARC_OPENWEBUI_API_FIELDS = Object.freeze([
  Object.freeze({
    key: 'temperature',
    label: 'Temperature',
    placeholder: '예: 0.2',
    min: '0',
    max: '2',
    step: '0.1'
  }),
  Object.freeze({
    key: 'top_p',
    label: 'Top P',
    placeholder: '예: 0.9',
    min: '0',
    max: '1',
    step: '0.05'
  }),
  Object.freeze({
    key: 'max_tokens',
    label: 'Max Tokens',
    placeholder: '예: 4096',
    min: '1',
    step: '1'
  }),
  Object.freeze({
    key: 'frequency_penalty',
    label: 'Frequency Penalty',
    placeholder: '예: 0',
    min: '-2',
    max: '2',
    step: '0.1'
  }),
  Object.freeze({
    key: 'presence_penalty',
    label: 'Presence Penalty',
    placeholder: '예: 0',
    min: '-2',
    max: '2',
    step: '0.1'
  }),
  Object.freeze({
    key: 'reasoning_effort',
    label: 'Reasoning Effort',
    type: 'select',
    options: Object.freeze([
      Object.freeze({ value: 'low', label: 'Low' }),
      Object.freeze({ value: 'medium', label: 'Medium' }),
      Object.freeze({ value: 'high', label: 'High' })
    ])
  })
]);
const K_LARC_OPENWEBUI_STEP_ORDER = Object.freeze([
  'stepAFeatures',
  'stepQuickAnalysis',
  'stepBQuery',
  'stepBRag',
  'stepBRagRepair',
  'stepBMerge',
  'stepCMultiJudge',
  'stepDRepair',
  'verification',
  'opinionNoticeReview',
  'chat',
  'translation'
]);
const K_LARC_OPENWEBUI_STEP_LABELS = Object.freeze({
  stepAFeatures: 'A 단계: 구성요소 추출',
  stepQuickAnalysis: 'Quick 분석',
  stepBQuery: 'B-1: Query 생성',
  stepBRag: 'B-2: RAG 검색',
  stepBRagRepair: 'B-2: Repair',
  stepBMerge: 'B-3: 결과 병합',
  stepCMultiJudge: 'C 단계: 다중판단',
  stepDRepair: 'D 단계: 보강',
  verification: '검증 단계',
  opinionNoticeReview: 'Opinion Notice Review',
  chat: 'Q&A 채팅',
  translation: '원문 번역'
});

function createEmptyOpenWebUiApiFieldSet() {
  const next = {};
  K_LARC_OPENWEBUI_API_FIELDS.forEach((field) => {
    next[field.key] = null;
  });
  return next;
}

function createDefaultOpenWebUiApiSettings() {
  const perStep = {};
  K_LARC_OPENWEBUI_STEP_ORDER.forEach((stepKey) => {
    perStep[stepKey] = {
      enabled: false,
      ...createEmptyOpenWebUiApiFieldSet()
    };
  });

  return {
    global: createEmptyOpenWebUiApiFieldSet(),
    perStep
  };
}

// --- 전역 상태 변수 ---
let claims = [];     // 청구항 목록
let citations = [];  // 인용발명 목록 (이제 storage에 영구 저장됨)
let settings = {
  url: 'https://llm.moip.go.kr',
  key: '',
  model: DEFAULT_LARC_MODEL,
  mockMode: DEV_FLAGS.ENABLE_MOCK_MODE,
  openwebuiApiSettings: createDefaultOpenWebUiApiSettings(),
  useB2SkillMd: false
};
//let settings = { url: 'http://127.0.0.1:5000', key: '', model: DEFAULT_LARC_MODEL, mockMode: DEV_FLAGS.ENABLE_MOCK_MODE };
let analysisResults = {}; // { claimId: { ClaimFeatures: [...], Relevant: {...} } }
let currentSortOrder = 'doc_then_feature'; // 'doc_then_feature' or 'feature_then_doc'
let debugState = { claimId: null, tab: 'stepA' };
let isAnalysisRunning = false;
let analysisStartedAt = null;
let analysisElapsedTimerId = null;
let selectedClaimPreviewId = null;
const ANALYSIS_STEPS = ['A', 'B', 'C', 'D', 'E'];
let claimProgressById = {};
let selectedResultClaimId = null;
let analysisExecutionMode = 'deep'; // 'deep' | 'quick'
let positionModalState = {
  docName: '',
  paragraphKey: '',
  summaryText: '',
  sourceText: '',
  canTranslate: false,
  cacheKey: '',
  requestSeq: 0,
  cache: {},
  context: null
};

// Sentinel chunk policy for citation text segmentation.
const CITATION_SENTINEL_CHUNK_SIZE = 400;
const CITATION_SENTINEL_CHUNK_OVERFLOW = Math.round(CITATION_SENTINEL_CHUNK_SIZE * 0.2);
const CITATION_SENTINEL_DIGITS = 4;
