function parseSsePayload(rawText) {
  const blocks = String(rawText || '').split('\n\n');
  const deltas = [];
  const reasoningDeltas = [];
  const reasoningSummaryDeltas = [];
  const reasoningEvents = [];
  let completedPayload = null;
  let errorMessage = '';

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const dataLines = trimmed
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    const payloadText = dataLines.join('\n');
    if (!payloadText || payloadText === '[DONE]') continue;

    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch (error) {
      continue;
    }

    if (payload?.error?.message) {
      errorMessage = payload.error.message;
    }
    const payloadType = String(payload?.type || '').toLowerCase();
    if (payload?.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      deltas.push(payload.delta);
    }
    if (typeof payload?.delta === 'string' && /reasoning.*summary.*delta/i.test(payloadType)) {
      reasoningSummaryDeltas.push(payload.delta);
    }
    if (typeof payload?.delta === 'string' && /reasoning(?!.*summary).*delta/i.test(payloadType)) {
      reasoningDeltas.push(payload.delta);
    }
    if (payloadType.includes('reasoning') || String(payload?.item?.type || '').toLowerCase().includes('reasoning')) {
      reasoningEvents.push(payload.item || payload);
    }
    if (payload?.type === 'response.completed') {
      completedPayload = payload.response || payload;
    }
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

async function parseJsonResponse(response) {
  const text = await response.text();
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/event-stream')) {
    return parseSsePayload(text);
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

  async function postResponsesRequest(aiConfig, body, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestUrl = `${normalizeBaseUrl(aiConfig.provider.baseUrl)}/responses`;

    try {
      const response = await fetchWithAppSession(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(aiConfig.provider.requiresOpenAIAuth ? { Authorization: `Bearer ${aiConfig.openAIApiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await parseJsonResponse(response);
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
