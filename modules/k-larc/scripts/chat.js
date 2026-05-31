async function sendUserChat() {
  const inputEl = document.getElementById('chat-input');
  const responseArea = document.getElementById('chat-response-area');
  const contentEl = document.getElementById('chat-content');
  const userText = String(inputEl?.value || '').trim();

  if (!userText) {
    alert('질문 내용을 입력해 주세요.');
    return;
  }

  const completedCitations = citations
    .filter(citation => citation.status === 'completed' && citation.fileId);
  const validFiles = completedCitations
    .map(citation => citation.fileId)
    .filter(Boolean);
  const mapInfo = completedCitations
    .map(citation => String(citation?.name || '').trim())
    .filter(Boolean)
    .join('\n');

  if (validFiles.length === 0) {
    alert('분석 가능한 인용발명 파일이 없습니다.');
    return;
  }

  if (!settings.mockMode && !settings.key) {
    alert('API Key가 필요합니다.');
    return;
  }

  if (responseArea) responseArea.classList.remove('hidden');
  if (contentEl) contentEl.textContent = '답변 생성 중...';

  if (settings.mockMode) {
    const claimCount = claims.filter(claim => String(claim?.text || '').trim()).length;
    const citationCount = citations.filter(citation => citation.status === 'completed').length;
    if (contentEl) {
      contentEl.textContent = [
        '[Mock 답변]',
        '현재는 실모델 연결 없이 테스트 중입니다.',
        '',
        `질문: ${userText}`,
        `입력된 청구항: ${claimCount}개`,
        `완료된 인용발명: ${citationCount}개`,
        '',
        '실모델 연결 후에는 RAG 기반 응답이 표시됩니다.'
      ].join('\n');
    }
    return;
  }

  const promptPair = await renderLarcPromptPair('chat', {
    mapInfo,
    user_text: userText
  });

  const payload = applyStepApiOptions({
    model: resolveLarcModelName(),
    messages: promptPair.messages,
    files: validFiles.map(fileId => ({ type: 'file', id: fileId }))
  }, 'chat');

  try {
    const response = await sendLLMRequest(payload);
    if (response?.ok && response?.data?.choices?.length) {
      const answer = String(response.data.choices[0]?.message?.content || '').trim();
      if (contentEl) {
        contentEl.textContent = answer || '응답 내용이 비어 있습니다.';
      }
      return;
    }

    if (contentEl) {
      contentEl.textContent = `오류 발생: ${response?.error || '응답이 없습니다.'}`;
    }
  } catch (error) {
    console.error(error);
    if (contentEl) {
      contentEl.textContent = `통신 오류 발생: ${error?.message || error}`;
    }
  }
}
