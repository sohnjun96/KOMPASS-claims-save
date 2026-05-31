import assert from "node:assert/strict";

if (!globalThis.chrome) {
  globalThis.chrome = {};
}
if (!globalThis.chrome.runtime) {
  globalThis.chrome.runtime = {};
}
if (!globalThis.chrome.runtime.onMessage) {
  globalThis.chrome.runtime.onMessage = { addListener() {} };
}
if (!globalThis.chrome.action) {
  globalThis.chrome.action = { onClicked: { addListener() {} } };
}
if (!globalThis.chrome.scripting) {
  globalThis.chrome.scripting = { executeScript: async () => [] };
}
if (!globalThis.chrome.tabs) {
  globalThis.chrome.tabs = {
    query(_, cb) { cb([]); },
    get: async () => ({ title: "test-tab" })
  };
}

await import("../background.js");

const api = globalThis.__K_LARC_XML_TEST_API__;
if (!api) {
  throw new Error("K-LARC XML test api is not available");
}

function check(condition, message) {
  assert.ok(condition, message);
  process.stdout.write(`PASS  ${message}\n`);
}

function testEvalConvScriptHelpers() {
  const basicScript = `
    <script>
      document.write(eval_convHalfCharToFullChar('청구항 1. 본 발명은 장치에 관한 것이다.'));
    </script>
  `;
  const basicClean = api.stripMarkupText(basicScript);
  check(
    basicClean === "청구항 1. 본 발명은 장치에 관한 것이다.",
    "eval_conv script is decoded from script tag"
  );

  const escapedScript = "&lt;script&gt;document.write(eval_convHalfCharToFullChar('본 발명은 배터리에 관한 것이다.'));&lt;/script&gt;";
  const escapedClean = api.stripMarkupText(escapedScript);
  check(
    escapedClean === "본 발명은 배터리에 관한 것이다.",
    "entity-escaped script tag is decoded"
  );

  const joined = api.decodeEvalConvHalfCharScript(
    "document.write(eval_convHalfCharToFullChar('본 발명은 ' + '양극재에 관한 것이다.'));"
  );
  check(
    joined === "본 발명은 양극재에 관한 것이다.",
    "eval_conv string concatenation is decoded"
  );

  check(
    api.decodeJsStringExpression("'abc' + \"def\"") === "abcdef",
    "JS string expression decoder joins literals without eval"
  );
}

function testParagraphEntityVariants() {
  const xml = `
    <table>
      <tr>
        <td><small>&lt;0001&gt;</small></td>
        <td style="word-break: break-all">본 발명은 표시 장치에 관한 것이다.</td>
      </tr>
    </table>
  `;
  const parsed = api.extractPatentData(xml);
  check(
    parsed?.paragraphs?.["[0001]"] === "본 발명은 표시 장치에 관한 것이다.",
    "structured paragraph extraction accepts entity paragraph markers"
  );
}

function testScriptArtifactsRemovedFromFinalUploadText() {
  const script = `
    &lt;script&gt;document.write(eval_convHalfCharToFullChar('본 발명은 센서 장치에 관한 것이다.'));&lt;/script&gt;
  `;
  const clean = api.stripMarkupText(script);
  check(!/document\.write/i.test(clean), "final cleaned text does not include document.write");
  check(!/eval_convHalfCharToFullChar/i.test(clean), "final cleaned text does not include eval_convHalfCharToFullChar");
  check(!/<\/?script/i.test(clean), "final cleaned text does not include script tags");
  check(clean.includes("본 발명은 센서 장치에 관한 것이다."), "final cleaned text keeps restored body text");
}

async function runExtractionCase({
  frames,
  tabTitle = "테스트 탭"
}) {
  globalThis.chrome.scripting.executeScript = async () => frames.map((result) => ({ result }));
  globalThis.chrome.tabs.get = async () => ({ title: tabTitle });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ id: "file_test_1" }),
    text: async () => ""
  });

  return await new Promise((resolve) => {
    api.handleExtractAndUpload(
      999,
      "https://example.test",
      "api-key",
      (response) => resolve(response),
      { chunkSize: 220, chunkOverflow: 40 }
    );
  });
}

testEvalConvScriptHelpers();
testParagraphEntityVariants();
testScriptArtifactsRemovedFromFinalUploadText();

async function testKnownScriptWrapperRemovedFromPlainText() {
  const raw = `<root><script>document.write(eval_convHalfCharToFullChar('스크립트본문'));</script><p>정상 본문</p></root>`;
  const clean = api.stripMarkupText(raw);
  check(!/document\.write\(/i.test(clean), "script wrapper literal is removed from plain text");
  check(clean.includes("정상 본문"), "normal text survives script cleaning");
}

async function testExtractPatentDataDropsScriptArtifactRows() {
  const xml = `
    <table>
      <tr>
        <td><small>&lt;0031&gt;</small></td>
        <td style="word-break:break-all">
          <script>document.write(eval_convHalfCharToFullChar('오염문자열'));</script>
        </td>
      </tr>
    </table>
  `;
  const parsed = api.extractPatentData(xml);
  const paragraphValues = Object.values(parsed.paragraphs || {}).join(" ");
  check(!/document\.write\(/i.test(paragraphValues), "structured parse does not keep script wrapper code");
  check(!/eval_convHalfCharToFullChar/i.test(paragraphValues), "structured parse does not keep eval_conv wrapper code");
}

async function testStructuredScriptHeavyFallsBackToRendered() {
  const rawXml = `<root><div><script>document.write(eval_convHalfCharToFullChar('스크립트코드'));</script></div></root>`;
  const response = await runExtractionCase({
    frames: [{
      url: "https://example.test/doc.xml",
      isXml: true,
      rawXml,
      text: rawXml,
      renderedText: "렌더드 본문 텍스트가 충분히 길어서 fallback 후보가 됩니다. ".repeat(3),
      cleanedRenderedText: "렌더드 본문 텍스트가 충분히 길어서 fallback 후보가 됩니다. ".repeat(3),
      length: rawXml.length,
      rawXmlLength: rawXml.length,
      renderedTextLength: 120
    }]
  });

  check(response.ok === true, "xml extraction response is ok");
  check(response.extractionMode === "xml_rendered_text", "script-heavy structured parse falls back to rendered text");
}

async function testRenderedPreferredOverRawFallback() {
  const rawXml = `<root><p>짧음</p><script>document.write(eval_convHalfCharToFullChar('오염'));</script></root>`;
  const response = await runExtractionCase({
    frames: [{
      url: "https://example.test/patent.xml",
      isXml: true,
      rawXml,
      text: rawXml,
      renderedText: "이 렌더드 텍스트는 raw fallback보다 우선되어야 하는 정상 본문입니다. ".repeat(2),
      cleanedRenderedText: "이 렌더드 텍스트는 raw fallback보다 우선되어야 하는 정상 본문입니다. ".repeat(2),
      length: rawXml.length,
      rawXmlLength: rawXml.length,
      renderedTextLength: 120
    }]
  });

  check(response.extractionMode === "xml_rendered_text", "rendered text fallback is preferred before raw xml fallback");
}

async function testRawFallbackAlsoUsesScriptAwareCleaning() {
  const rawXml = `<root><div>문단 텍스트</div><script>document.write(eval_convHalfCharToFullChar('악성스크립트'));</script></root>`;
  const response = await runExtractionCase({
    frames: [{
      url: "https://example.test/raw.xml",
      isXml: true,
      rawXml,
      text: rawXml,
      renderedText: "",
      cleanedRenderedText: "",
      length: rawXml.length,
      rawXmlLength: rawXml.length,
      renderedTextLength: 0
    }]
  });

  check(response.extractionMode === "xml_raw_fallback", "raw xml fallback path is selected when rendered text is unavailable");
  check(!/document\.write\(/i.test(String(response.text || "")), "raw fallback text does not keep script wrapper source");
}

async function testNonXmlHtmlPathStillWorks() {
  const htmlText = "일반 HTML 탭 본문 텍스트입니다. ".repeat(4);
  const response = await runExtractionCase({
    frames: [{
      url: "https://example.test/page",
      isXml: false,
      rawXml: null,
      text: htmlText,
      renderedText: htmlText,
      cleanedRenderedText: htmlText,
      length: htmlText.length,
      rawXmlLength: 0,
      renderedTextLength: htmlText.length
    }]
  });

  check(response.ok === true, "non-xml extraction response is ok");
  check(response.extractionMode === "html_plain_text", "non-xml path keeps html plain text mode");
}

async function testResponseIncludesExtractionMeta() {
  const rawXml = `<root><div>본문 텍스트</div></root>`;
  const response = await runExtractionCase({
    frames: [{
      url: "https://example.test/meta.xml",
      isXml: true,
      rawXml,
      text: rawXml,
      renderedText: "본문 텍스트",
      cleanedRenderedText: "본문 텍스트",
      length: rawXml.length,
      rawXmlLength: rawXml.length,
      renderedTextLength: 8
    }]
  });

  check(typeof response.extractionMode === "string", "response includes extractionMode");
  check(typeof response.scriptArtifactsDetected === "boolean", "response includes scriptArtifactsDetected");
  check(typeof response.scriptArtifactsRemoved === "boolean", "response includes scriptArtifactsRemoved");
}

await testKnownScriptWrapperRemovedFromPlainText();
await testExtractPatentDataDropsScriptArtifactRows();
await testStructuredScriptHeavyFallsBackToRendered();
await testRenderedPreferredOverRawFallback();
await testRawFallbackAlsoUsesScriptAwareCleaning();
await testNonXmlHtmlPathStillWorks();
await testResponseIncludesExtractionMeta();

process.stdout.write("K-LARC XML extraction tests completed.\n");
