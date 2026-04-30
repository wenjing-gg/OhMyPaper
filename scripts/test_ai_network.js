const assert = require('assert/strict');
const http = require('http');

const { createAiNetworkHelpers } = require('../electron/ai_network');

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function formatAiConnectivityError(_baseUrl, error) {
  return String(error?.message || error || 'AI 请求失败').trim() || 'AI 请求失败';
}

function createPdfFixture() {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');
}

async function startMockServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/json/responses') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'resp-json',
        output_text: 'OK',
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/sse/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.end([
        'data: {"type":"response.output_text.delta","delta":"Hello "}',
        '',
        'data: {"type":"response.output_text.delta","delta":"Windows"}',
        '',
        'data: {"type":"response.reasoning.delta","delta":"thinking"}',
        '',
        'data: {"type":"response.completed","response":{"output":[{"type":"output_text","text":"Hello Windows"}]}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/paper.pdf') {
      const pdf = createPdfFixture();
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.length),
      });
      res.end(pdf);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
}

async function run() {
  const { server, baseUrl } = await startMockServer();
  let sessionFetchCalls = 0;
  let fallbackFetchCalls = 0;

  const { fetchWithAppSession, postResponsesRequest } = createAiNetworkHelpers({
    getSession: () => ({
      fetch: async (url, options) => {
        sessionFetchCalls += 1;
        return fetch(url, options);
      },
    }),
    fallbackFetch: async (url, options) => {
      fallbackFetchCalls += 1;
      return fetch(url, options);
    },
    normalizeBaseUrl,
    formatAiConnectivityError,
  });

  try {
    const aiConfigJson = {
      openAIApiKey: 'test-key',
      provider: {
        baseUrl: `${baseUrl}/json`,
        requiresOpenAIAuth: true,
      },
    };
    const jsonResult = await postResponsesRequest(aiConfigJson, {
      model: 'gpt-5.4',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    }, 5000);
    assert.equal(jsonResult.response.ok, true);
    assert.equal(jsonResult.data.output_text, 'OK');

    const aiConfigSse = {
      openAIApiKey: 'test-key',
      provider: {
        baseUrl: `${baseUrl}/sse`,
        requiresOpenAIAuth: true,
      },
    };
    const streamEvents = [];
    const sseResult = await postResponsesRequest(aiConfigSse, {
      model: 'gpt-5.4',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    }, 5000, {
      onEvent: (event) => streamEvents.push(event),
    });
    assert.equal(sseResult.response.ok, true);
    assert.equal(sseResult.data.output_text, 'Hello Windows');
    assert.equal(sseResult.data.reasoning_text, 'thinking');
    assert.deepEqual(
      streamEvents.filter((event) => event.type === 'answer_delta').map((event) => event.delta),
      ['Hello ', 'Windows'],
    );
    assert.deepEqual(
      streamEvents.filter((event) => event.type === 'reasoning_delta').map((event) => event.delta),
      ['thinking'],
    );

    const pdfResponse = await fetchWithAppSession(`${baseUrl}/paper.pdf`, {
      method: 'GET',
      headers: { Accept: 'application/pdf' },
    });
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
    assert.equal(pdfResponse.ok, true);
    assert.equal(pdfBuffer.subarray(0, 4).toString('latin1'), '%PDF');

    assert.ok(sessionFetchCalls >= 3, 'expected session.fetch to handle AI and PDF requests');
    assert.equal(fallbackFetchCalls, 0, 'expected no fallback to global fetch when session.fetch is available');

    console.log('AI_NETWORK_OK');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
