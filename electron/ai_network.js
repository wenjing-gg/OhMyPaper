function collectReasoningSummaryFragments(node, context = {}) {
  const fragments = [];
  const visit = (value, nextContext = {}) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, nextContext));
      return;
    }
    if (typeof value === 'string') {
      if (nextContext.summary) {
        const normalized = value.trim();
        if (normalized) fragments.push(normalized);
      }
      return;
    }
    if (typeof value !== 'object') {
      return;
    }

    const valueType = String(value.type || '').toLowerCase();
    const inReasoning = nextContext.reasoning || valueType.includes('reasoning');
    const inSummary = nextContext.summary || valueType.includes('summary');

    if (inSummary && typeof value.text === 'string') {
      const normalized = value.text.trim();
      if (normalized) fragments.push(normalized);
    }
    if (typeof value.summary_text === 'string') {
      const normalized = value.summary_text.trim();
      if (normalized) fragments.push(normalized);
    }
    if (typeof value.reasoning_summary_text === 'string') {
      const normalized = value.reasoning_summary_text.trim();
      if (normalized) fragments.push(normalized);
    }

    visit(value.summary, { reasoning: true, summary: true });
    visit(value.summaries, { reasoning: true, summary: true });
    visit(value.reasoning_summary, { reasoning: true, summary: true });
    visit(value.content, { reasoning: inReasoning, summary: inSummary });
    visit(value.output, { reasoning: inReasoning, summary: inSummary });
    visit(value.item, { reasoning: inReasoning, summary: inSummary });
  };

  visit(node, context);
  return fragments;
}

function createSseCollector(onEvent) {
  const deltas = [];
  const reasoningDeltas = [];
  const reasoningSummaryDeltas = [];
  const reasoningEvents = [];
  const seenReasoningSummaries = new Set();
  let completedPayload = null;
  let errorMessage = '';
  let pendingText = '';

  function emit(event) {
    if (typeof onEvent === 'function') {
      onEvent(event);
    }
  }

  function consumeBlock(block) {
    const trimmed = block.trim();
    if (!trimmed) return;
    const dataLines = trimmed
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    const payloadText = dataLines.join('\n');
    if (!payloadText) return;
    if (payloadText === '[DONE]') {
      emit({ type: 'done' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch (error) {
      return;
    }

    if (payload?.error?.message) {
      errorMessage = payload.error.message;
      emit({ type: 'error', message: errorMessage });
    }
    const payloadType = String(payload?.type || '').toLowerCase();
    if (payload?.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      deltas.push(payload.delta);
      emit({ type: 'answer_delta', delta: payload.delta });
    }
    if (typeof payload?.delta === 'string' && /reasoning.*summary.*delta/i.test(payloadType)) {
      reasoningSummaryDeltas.push(payload.delta);
      emit({ type: 'reasoning_delta', delta: payload.delta, kind: 'summary' });
    }
    if (typeof payload?.delta === 'string' && /reasoning(?!.*summary).*delta/i.test(payloadType)) {
      reasoningDeltas.push(payload.delta);
      emit({ type: 'reasoning_delta', delta: payload.delta, kind: 'reasoning' });
    }
    if (payloadType.includes('reasoning') || String(payload?.item?.type || '').toLowerCase().includes('reasoning')) {
      reasoningEvents.push(payload.item || payload);
    }
    const summaryFragments = [
      ...collectReasoningSummaryFragments(payload.item, { reasoning: String(payload?.item?.type || '').toLowerCase().includes('reasoning') }),
      ...collectReasoningSummaryFragments(payload.response?.output, {}),
    ];
    for (const fragment of summaryFragments) {
      const key = fragment.toLowerCase();
      if (seenReasoningSummaries.has(key)) continue;
      seenReasoningSummaries.add(key);
      reasoningSummaryDeltas.push(fragment);
      emit({ type: 'reasoning_delta', delta: fragment, kind: 'summary' });
    }
    if (payload?.type === 'response.completed') {
      completedPayload = payload.response || payload;
      emit({ type: 'completed' });
    }
  }

  function feed(text) {
    pendingText += String(text || '').replace(/\r\n/g, '\n');
    let delimiterIndex = pendingText.indexOf('\n\n');
    while (delimiterIndex >= 0) {
      const block = pendingText.slice(0, delimiterIndex);
      pendingText = pendingText.slice(delimiterIndex + 2);
      consumeBlock(block);
      delimiterIndex = pendingText.indexOf('\n\n');
    }
  }

  function finish() {
    if (pendingText.trim()) {
      consumeBlock(pendingText);
      pendingText = '';
    }

    if (errorMessage) {
      throw new Error(errorMessage);
    }

    const text = deltas.join('').trim();
    const reasoningText = reasoningDeltas.join('').trim();
    const reasoningSummaryText = reasoningSummaryDeltas.join('').trim();
    if (text) {
      return {
        output_text: text,
        output: completedPayload?.output || [],
        reasoning_text: reasoningText,
        reasoning_summary_text: reasoningSummaryText,
        reasoning_events: reasoningEvents,
      };
    }

    if (completedPayload) {
      return {
        ...completedPayload,
        ...(reasoningText ? { reasoning_text: reasoningText } : {}),
        ...(reasoningSummaryText ? { reasoning_summary_text: reasoningSummaryText } : {}),
        ...(reasoningEvents.length ? { reasoning_events: reasoningEvents } : {}),
      };
    }

    throw new Error('AI 返回了空的流式响应');
  }

  return { feed, finish };
}

function parseSsePayload(rawText, onEvent) {
  const collector = createSseCollector(onEvent);
  collector.feed(rawText);
  return collector.finish();
}

async function parseSseResponse(response, onEvent) {
  const reader = response.body?.getReader ? response.body.getReader() : null;
  if (!reader) {
    return parseSsePayload(await response.text(), onEvent);
  }

  const decoder = new TextDecoder();
  const collector = createSseCollector(onEvent);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    collector.feed(decoder.decode(value, { stream: true }));
  }
  collector.feed(decoder.decode());
  return collector.finish();
}

async function parseJsonResponse(response, onEvent) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/event-stream')) {
    return parseSseResponse(response, onEvent);
  }
  const text = await response.text();
  if (typeof onEvent === 'function' && text) {
    onEvent({ type: 'response_text', text });
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return { rawText: text };
  }
}

function createAiNetworkHelpers({
  getSession,
  fallbackFetch,
  normalizeBaseUrl,
  formatAiConnectivityError,
}) {
  if (typeof normalizeBaseUrl !== 'function') {
    throw new Error('normalizeBaseUrl is required');
  }
  if (typeof formatAiConnectivityError !== 'function') {
    throw new Error('formatAiConnectivityError is required');
  }
  if (typeof fallbackFetch !== 'function') {
    throw new Error('fallbackFetch is required');
  }

  async function fetchWithAppSession(url, options = {}) {
    const ses = typeof getSession === 'function' ? getSession() : null;
    if (ses && typeof ses.fetch === 'function') {
      return ses.fetch(url, options);
    }
    return fallbackFetch(url, options);
  }

  async function postResponsesRequest(aiConfig, body, timeoutMs = 20000, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestUrl = `${normalizeBaseUrl(aiConfig.provider.baseUrl)}/responses`;
    const requestBody = {
      stream: true,
      ...(body || {}),
    };

    try {
      const response = await fetchWithAppSession(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(aiConfig.provider.requiresOpenAIAuth ? { Authorization: `Bearer ${aiConfig.openAIApiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const data = await parseJsonResponse(response, options.onEvent);
      return { response, data };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }
      const wrapped = new Error(formatAiConnectivityError(aiConfig.provider.baseUrl, error));
      wrapped.cause = error;
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    fetchWithAppSession,
    postResponsesRequest,
  };
}

module.exports = {
  createAiNetworkHelpers,
  parseJsonResponse,
  parseSsePayload,
};
