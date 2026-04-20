const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const DEFAULT_AI_CONFIG = {
  modelProvider: 'fox',
  model: 'gpt-5.4',
  modelReasoningEffort: 'high',
  disableResponseStorage: true,
  openAIApiKey: '',
  provider: {
    name: 'fox',
    baseUrl: 'https://code.newcli.com/codex/v1',
    wireApi: 'responses',
    requiresOpenAIAuth: true,
  },
};

const AI_REASONING_LEVELS = new Set(['high', 'medium', 'low', 'minimal']);
let mainWindow = null;
const pdfViewerWindows = new Set();
const pdfPrefetchTasks = new Map();
const pdfPrefetchStatuses = new Map();
const PDF_CACHE_NAMESPACE = 'v1';

function defaultAiConfigStatus(aiConfig = normalizeAiConfig()) {
  if (aiConfig.provider.requiresOpenAIAuth && !aiConfig.openAIApiKey) {
    return {
      ok: false,
      code: 'missing_api_key',
      message: '请先填写 OPENAI_API_KEY',
      checkedAt: '',
    };
  }
  return {
    ok: false,
    code: 'unverified',
    message: '尚未验证 AI 连接',
    checkedAt: '',
  };
}

function appRoot() {
  if (process.env.DEEPXIV_PROJECT_ROOT) {
    return process.env.DEEPXIV_PROJECT_ROOT;
  }
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.join(__dirname, '..');
}

function pythonCandidates() {
  const root = appRoot();
  return [
    process.env.DEEPXIV_PYTHON,
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'Scripts', 'python3.exe'),
    path.join(root, '.venv', 'bin', 'python3'),
    path.join(root, '.venv', 'bin', 'python'),
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
    'python'
  ].filter(Boolean);
}

function bundledBridgeCandidates() {
  const bridgeDir = path.join(appRoot(), 'bridge');
  return process.platform === 'win32'
    ? [path.join(bridgeDir, 'deepxiv-bridge.exe')]
    : [path.join(bridgeDir, 'deepxiv-bridge')];
}

function bridgePath() {
  return path.join(appRoot(), 'python', 'bridge.py');
}

function bridgeEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

async function findBundledBridge() {
  for (const candidate of bundledBridgeCandidates()) {
    try {
      if (process.platform === 'win32') {
        await fsp.access(candidate, fs.constants.F_OK);
      } else {
        await fsp.access(candidate, fs.constants.X_OK);
      }
      return candidate;
    } catch (error) {
    }
  }
  return null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultFavoriteGroupsMap() {
  return {
    default: {
      id: 'default',
      name: '默认分组',
      createdAt: new Date(0).toISOString(),
    },
  };
}

function normalizeFavoriteGroupEntry(group = {}, fallbackId = '') {
  const id = String(group.id || fallbackId || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(group.name || '').trim() || '未命名分组',
    createdAt: String(group.createdAt || '').trim() || new Date().toISOString(),
  };
}

function normalizeFavoriteGroupsMap(rawGroups = {}) {
  const base = defaultFavoriteGroupsMap();
  for (const [rawId, rawValue] of Object.entries(rawGroups || {})) {
    const group = normalizeFavoriteGroupEntry(rawValue || {}, rawId);
    if (group) {
      base[group.id] = group;
    }
  }
  return base;
}

function listFavoriteGroupsFromState(state) {
  return Object.values(state.favoriteGroups || {}).sort((left, right) => {
    if (left.id === 'default') return -1;
    if (right.id === 'default') return 1;
    return String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.name || '').localeCompare(String(right.name || ''));
  });
}

function normalizeFavoriteGroupId(groupId, favoriteGroups) {
  const id = String(groupId || '').trim();
  if (id && favoriteGroups?.[id]) {
    return id;
  }
  return 'default';
}

function createFavoriteGroupId() {
  return `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeProviderConfig(raw = {}) {
  const fallback = DEFAULT_AI_CONFIG.provider;
  return {
    name: String(raw.name || fallback.name).trim() || fallback.name,
    baseUrl: String(raw.baseUrl || fallback.baseUrl).trim() || fallback.baseUrl,
    wireApi: String(raw.wireApi || fallback.wireApi).trim() || fallback.wireApi,
    requiresOpenAIAuth: raw.requiresOpenAIAuth !== false,
  };
}

function normalizeAiConfig(raw = {}) {
  const reasoning = String(raw.modelReasoningEffort || DEFAULT_AI_CONFIG.modelReasoningEffort).trim().toLowerCase();
  return {
    modelProvider: String(raw.modelProvider || DEFAULT_AI_CONFIG.modelProvider).trim() || DEFAULT_AI_CONFIG.modelProvider,
    model: String(raw.model || DEFAULT_AI_CONFIG.model).trim() || DEFAULT_AI_CONFIG.model,
    modelReasoningEffort: AI_REASONING_LEVELS.has(reasoning) ? reasoning : DEFAULT_AI_CONFIG.modelReasoningEffort,
    disableResponseStorage: raw.disableResponseStorage !== false,
    openAIApiKey: String(raw.openAIApiKey || '').trim(),
    provider: normalizeProviderConfig(raw.provider || raw.modelProviders?.fox || {}),
  };
}

function normalizeAiConfigStatus(raw = {}, aiConfig = normalizeAiConfig()) {
  const fallback = defaultAiConfigStatus(aiConfig);
  return {
    ok: raw.ok === true,
    code: String(raw.code || fallback.code).trim() || fallback.code,
    message: String(raw.message || (raw.ok === true ? `${aiConfig.provider.name} · ${aiConfig.model} 已通过连通性测试` : fallback.message)).trim() || fallback.message,
    checkedAt: String(raw.checkedAt || '').trim(),
  };
}

function defaultState() {
  const aiConfig = normalizeAiConfig();
  return {
    favorites: {},
    favoriteGroups: defaultFavoriteGroupsMap(),
    history: [],
    aiConfig,
    aiConfigStatus: defaultAiConfigStatus(aiConfig),
  };
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function looksLikePdfUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  return value.includes('.pdf') || value.includes('/pdf/') || value.includes('arxiv.org/pdf/');
}

function isRemoteHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function favoriteKeyFromPaper(paper = {}) {
  const explicitKey = String(paper.favorite_key || '').trim();
  if (explicitKey) {
    return explicitKey;
  }

  const arxivId = String(paper.arxiv_id || '').trim();
  if (arxivId) {
    return arxivId;
  }

  const openalexId = String(paper.openalex_id || '').trim();
  if (openalexId) {
    return `openalex:${openalexId}`;
  }

  const europepmcId = String(paper.europepmc_id || '').trim();
  if (europepmcId) {
    const europepmcSource = String(paper.europepmc_source || paper.source_kind || 'europepmc').trim().toLowerCase();
    return `${europepmcSource}:${europepmcId}`;
  }

  const localPdfPath = String(paper.local_pdf_path || '').trim();
  if (localPdfPath) {
    return `local-pdf:${localPdfPath}`;
  }

  const paperKey = String(paper.paper_key || '').trim();
  if (paperKey) {
    return paperKey;
  }

  const externalUrl = String(paper.external_url || paper.src_url || '').trim();
  if (externalUrl) {
    const sourceKind = String(paper.source_kind || 'paper').trim().toLowerCase() || 'paper';
    return `${sourceKind}:${externalUrl}`;
  }

  const title = String(paper.title || '').trim();
  if (title) {
    const sourceKind = String(paper.source_kind || 'paper').trim().toLowerCase() || 'paper';
    return `${sourceKind}:${title}`;
  }

  return '';
}

function pdfCacheDir() {
  return path.join(app.getPath('userData'), 'pdf-cache', PDF_CACHE_NAMESPACE);
}

function normalizePdfPayload(payload = {}) {
  const target = String(payload.target || payload.local_pdf_path || payload.pdf_url || '').trim();
  const targetKind = String(payload.target_kind || (isRemoteHttpUrl(target) ? 'url' : 'path')).trim().toLowerCase() || 'path';
  const paperKey = String(
    payload.favorite_key
    || favoriteKeyFromPaper(payload)
    || payload.paper_key
    || (target ? `pdf:${sha1(target)}` : '')
  ).trim();
  const sourceUrl = isRemoteHttpUrl(target)
    ? target
    : (isRemoteHttpUrl(payload.pdf_url) ? String(payload.pdf_url).trim() : '');
  const localPath = !isRemoteHttpUrl(target) ? target : String(payload.local_pdf_path || '').trim();
  const cachePath = sourceUrl ? path.join(pdfCacheDir(), `${sha1(`${paperKey}|${sourceUrl}`)}.pdf`) : '';
  return {
    ...payload,
    paperKey,
    title: String(payload.title || '论文 PDF').trim() || '论文 PDF',
    sourceKind: String(payload.source_kind || '').trim().toLowerCase(),
    target,
    targetKind,
    sourceUrl,
    localPath,
    cachePath,
  };
}

function clonePdfStatus(status) {
  return status ? JSON.parse(JSON.stringify(status)) : null;
}

function emitPdfPrefetchStatus(status) {
  const normalized = clonePdfStatus(status);
  if (!normalized?.paperKey) {
    return normalized;
  }
  pdfPrefetchStatuses.set(normalized.paperKey, normalized);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pdf:prefetch-status', normalized);
  }
  return normalized;
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
}

async function getCachedPdfStatus(normalized) {
  if (!normalized?.paperKey) {
    return null;
  }
  if (normalized.localPath) {
    if (!(await fileExists(normalized.localPath))) {
      return emitPdfPrefetchStatus({
        paperKey: normalized.paperKey,
        title: normalized.title,
        state: 'error',
        progress: 0,
        target: normalized.target,
        sourceUrl: '',
        cachedPath: '',
        openTarget: '',
        message: '本地 PDF 文件不存在',
      });
    }
    return emitPdfPrefetchStatus({
      paperKey: normalized.paperKey,
      title: normalized.title,
      state: 'ready',
      progress: 1,
      target: normalized.localPath,
      sourceUrl: '',
      cachedPath: normalized.localPath,
      openTarget: normalized.localPath,
      message: '本地 PDF 已就绪',
      isLocal: true,
      isCached: true,
    });
  }
  if (normalized.cachePath && await fileExists(normalized.cachePath)) {
    return emitPdfPrefetchStatus({
      paperKey: normalized.paperKey,
      title: normalized.title,
      state: 'ready',
      progress: 1,
      target: normalized.target,
      sourceUrl: normalized.sourceUrl,
      cachedPath: normalized.cachePath,
      openTarget: normalized.cachePath,
      message: 'PDF 已缓存',
      isCached: true,
    });
  }
  return clonePdfStatus(pdfPrefetchStatuses.get(normalized.paperKey) || null);
}

function validatePdfSignature(firstChunk, response, normalized) {
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('pdf')) {
    return true;
  }
  const buffer = Buffer.isBuffer(firstChunk) ? firstChunk : Buffer.from(firstChunk || []);
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF') {
    return true;
  }
  if (looksLikePdfUrl(response?.url || normalized?.sourceUrl || '')) {
    return true;
  }
  return false;
}

async function startPdfPrefetch(normalized) {
  const existing = pdfPrefetchTasks.get(normalized.paperKey);
  if (existing) {
    return clonePdfStatus(pdfPrefetchStatuses.get(normalized.paperKey) || null);
  }

  const initialStatus = emitPdfPrefetchStatus({
    paperKey: normalized.paperKey,
    title: normalized.title,
    state: 'downloading',
    progress: 0,
    target: normalized.target,
    sourceUrl: normalized.sourceUrl,
    cachedPath: '',
    openTarget: normalized.sourceUrl || normalized.target,
    message: '正在缓存 PDF…',
    isCached: false,
  });

  const task = (async () => {
    const tempPath = `${normalized.cachePath}.download`;
    let fileHandle = null;
    try {
      await fsp.mkdir(path.dirname(normalized.cachePath), { recursive: true });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180000);
      const response = await fetch(normalized.sourceUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': `DeepXiv Client/${app.getVersion()}`,
          'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
        },
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`下载 PDF 失败（${response.status}）`);
      }

      const totalBytes = Number(response.headers.get('content-length') || 0);
      const reader = response.body?.getReader ? response.body.getReader() : null;
      let receivedBytes = 0;
      let firstChunk = Buffer.alloc(0);
      fileHandle = await fsp.open(tempPath, 'w');

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          if (!firstChunk.length) {
            firstChunk = chunk;
          }
          receivedBytes += chunk.length;
          await fileHandle.write(chunk);
          emitPdfPrefetchStatus({
            ...initialStatus,
            state: 'downloading',
            progress: totalBytes > 0 ? Math.min(0.99, receivedBytes / totalBytes) : 0,
            message: totalBytes > 0 ? `正在缓存 PDF… ${Math.round((receivedBytes / totalBytes) * 100)}%` : '正在缓存 PDF…',
          });
        }
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        firstChunk = buffer.subarray(0, Math.min(buffer.length, 8));
        receivedBytes = buffer.length;
        await fileHandle.write(buffer);
      }

      await fileHandle.close();
      fileHandle = null;

      if (!validatePdfSignature(firstChunk, response, normalized)) {
        throw new Error('返回内容不是有效 PDF');
      }

      await fsp.rename(tempPath, normalized.cachePath);

      emitPdfPrefetchStatus({
        ...initialStatus,
        state: 'ready',
        progress: 1,
        sourceUrl: response.url || normalized.sourceUrl,
        cachedPath: normalized.cachePath,
        openTarget: normalized.cachePath,
        message: 'PDF 已缓存，下次打开更快',
        isCached: true,
        totalBytes: totalBytes || receivedBytes,
        receivedBytes,
      });
    } catch (error) {
      if (fileHandle) {
        try {
          await fileHandle.close();
        } catch (closeError) {
        }
      }
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      emitPdfPrefetchStatus({
        ...initialStatus,
        state: 'error',
        progress: 0,
        openTarget: normalized.sourceUrl || normalized.target,
        message: String(error?.name || '') === 'AbortError' ? 'PDF 缓存超时，已回退直连打开' : 'PDF 缓存失败，已回退直连打开',
        error: String(error?.message || error || 'PDF 缓存失败').trim(),
        isCached: false,
      });
    } finally {
      pdfPrefetchTasks.delete(normalized.paperKey);
    }
  })();

  pdfPrefetchTasks.set(normalized.paperKey, task);
  return initialStatus;
}

async function prefetchPdf(payload = {}) {
  const normalized = normalizePdfPayload(payload);
  if (!normalized.paperKey || !normalized.target) {
    return {
      paperKey: normalized.paperKey || '',
      title: normalized.title,
      state: 'missing',
      progress: 0,
      target: normalized.target,
      sourceUrl: normalized.sourceUrl,
      cachedPath: '',
      openTarget: '',
      message: '未找到可用 PDF',
      isCached: false,
    };
  }

  const cachedStatus = await getCachedPdfStatus(normalized);
  if (cachedStatus?.state === 'ready') {
    return cachedStatus;
  }

  if (normalized.sourceUrl && looksLikePdfUrl(normalized.sourceUrl)) {
    return startPdfPrefetch(normalized);
  }

  return emitPdfPrefetchStatus({
    paperKey: normalized.paperKey,
    title: normalized.title,
    state: 'missing',
    progress: 0,
    target: normalized.target,
    sourceUrl: normalized.sourceUrl,
    cachedPath: '',
    openTarget: normalized.localPath || normalized.target,
    message: '当前论文没有可缓存的 PDF 直链',
    isCached: false,
  });
}

async function resolvePdfForOpen(payload = {}) {
  const normalized = normalizePdfPayload(payload);
  const status = await prefetchPdf(payload);
  const cachedStatus = await getCachedPdfStatus(normalized);
  const effective = cachedStatus?.state === 'ready' ? cachedStatus : status;
  return {
    ...(effective || {}),
    paperKey: normalized.paperKey,
    openTarget: effective?.cachedPath || effective?.openTarget || normalized.localPath || normalized.sourceUrl || normalized.target,
  };
}

function normalizeFavoriteEntry(paper = {}, fallbackKey = '') {
  const sourceKind = String(paper.source_kind || (paper.local_pdf_path ? 'local-pdf' : paper.openalex_id ? 'openalex' : paper.europepmc_id ? 'europepmc' : paper.arxiv_id ? 'arxiv' : 'paper')).trim().toLowerCase() || 'paper';
  const sourceLabel = String(paper.source_label || (sourceKind === 'local-pdf' ? '本地 PDF' : '')).trim();
  const favoriteKey = favoriteKeyFromPaper({ ...paper, favorite_key: paper.favorite_key || fallbackKey });
  const paperKey = String(paper.paper_key || favoriteKey).trim() || favoriteKey;

  return {
    ...paper,
    paper_key: paperKey,
    favorite_key: favoriteKey,
    source_kind: sourceKind,
    source_label: sourceLabel,
    title: String(paper.title || 'Untitled').trim() || 'Untitled',
    publish_at: String(paper.publish_at || '').trim(),
    author_line: String(paper.author_line || '').trim(),
    abstract: String(paper.abstract || '').trim(),
    external_url: String(paper.external_url || paper.src_url || '').trim(),
    src_url: String(paper.src_url || paper.external_url || '').trim(),
    pdf_url: String(paper.pdf_url || '').trim(),
    local_pdf_path: String(paper.local_pdf_path || '').trim(),
    group_id: String(paper.group_id || '').trim() || 'default',
    savedAt: String(paper.savedAt || '').trim() || new Date().toISOString(),
    supports_favorite: true,
  };
}

function normalizeFavoritesMap(rawFavorites = {}, favoriteGroups = defaultFavoriteGroupsMap()) {
  const nextFavorites = {};
  for (const [rawKey, rawValue] of Object.entries(rawFavorites || {})) {
    const entry = normalizeFavoriteEntry(rawValue || {}, rawKey);
    const favoriteKey = entry.favorite_key || rawKey;
    if (favoriteKey) {
      nextFavorites[favoriteKey] = {
        ...entry,
        group_id: normalizeFavoriteGroupId(entry.group_id, favoriteGroups),
      };
    }
  }
  return nextFavorites;
}

function buildPaperContextText(paperContext = {}) {
  const lines = [
    '以下是当前论文的上下文，请优先依据该论文内容回答。',
    `标题：${paperContext.title || 'Untitled'}`,
    `来源：${paperContext.sourceLabel || paperContext.sourceKind || 'Unknown'}`,
  ];
  if (paperContext.paperId) {
    lines.push(`论文标识：${paperContext.paperId}`);
  }
  if (paperContext.publishAt) {
    lines.push(`发布时间：${paperContext.publishAt}`);
  }
  if (paperContext.sourceUrl) {
    lines.push(`来源链接：${paperContext.sourceUrl}`);
  }
  if (paperContext.abstract) {
    lines.push(`摘要：${paperContext.abstract}`);
  }
  if (paperContext.contextText) {
    lines.push(`论文正文摘录：${paperContext.contextText}`);
  }
  lines.push('如果提供了 PDF，请将其视为最高优先级上下文；如果上下文不足，请明确说明。');
  return lines.join('\n');
}

function toResponseInputMessage(message) {
  const role = message?.role === 'assistant' ? 'assistant' : 'user';
  const text = String(message?.content || '').trim();
  if (!text) return null;
  return {
    role,
    content: [{ type: 'input_text', text }],
  };
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const fragments = [];
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'string') {
      const value = node.trim();
      if (value) fragments.push(value);
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    if (node.type === 'output_text' && typeof node.text === 'string') {
      const value = node.text.trim();
      if (value) fragments.push(value);
    }
    if (typeof node.text === 'string' && node.type === 'text') {
      const value = node.text.trim();
      if (value) fragments.push(value);
    }
    if (typeof node.output_text === 'string') {
      const value = node.output_text.trim();
      if (value) fragments.push(value);
    }
    visit(node.content);
    visit(node.output);
  };

  visit(payload?.output);
  const merged = fragments.join('\n\n').trim();
  if (merged) {
    return merged;
  }
  throw new Error('AI 未返回可读文本');
}

function extractReasoningSummary(payload) {
  return extractReasoningArtifacts(payload).summaryText;
}

function extractReasoningArtifacts(payload) {
  const summaryFragments = [];
  const reasoningSteps = [];
  const seenSummary = new Set();
  const seenSteps = new Set();

  const pushSummary = (value) => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seenSummary.has(key)) return;
    seenSummary.add(key);
    summaryFragments.push(normalized);
  };

  const pushStep = (value) => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seenSteps.has(key)) return;
    seenSteps.add(key);
    reasoningSteps.push({
      id: `reasoning-${reasoningSteps.length + 1}`,
      text: normalized,
    });
  };

  const visit = (node, context = {}) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, context));
      return;
    }
    if (typeof node === 'string') {
      if (context.summary) {
        pushSummary(node);
        return;
      }
      if (context.reasoning) {
        pushStep(node);
      }
      return;
    }
    if (typeof node !== 'object') {
      return;
    }

    const nodeType = String(node.type || '').toLowerCase();
    const inReasoning = context.reasoning || nodeType.includes('reasoning');
    const inSummary = context.summary || nodeType.includes('summary');

    if (typeof node.text === 'string') {
      if (inSummary) {
        pushSummary(node.text);
      } else if (inReasoning) {
        pushStep(node.text);
      }
    }
    if (inReasoning && typeof node.output_text === 'string') {
      pushStep(node.output_text);
    }
    if (typeof node.reasoning_text === 'string') {
      pushStep(node.reasoning_text);
    }
    if (typeof node.summary_text === 'string') {
      pushSummary(node.summary_text);
    }
    if (typeof node.reasoning_summary_text === 'string') {
      pushSummary(node.reasoning_summary_text);
    }
    if (typeof node.summary === 'string') {
      pushSummary(node.summary);
    }
    if (typeof node.reasoning_summary === 'string') {
      pushSummary(node.reasoning_summary);
    }
    if (typeof node.delta === 'string') {
      if (inSummary) {
        pushSummary(node.delta);
      } else if (inReasoning) {
        pushStep(node.delta);
      }
    }

    visit(node.summary, { reasoning: true, summary: true });
    visit(node.reasoning_summary, { reasoning: true, summary: true });
    visit(node.summaries, { reasoning: true, summary: true });
    visit(node.content, { reasoning: inReasoning, summary: inSummary });
    visit(node.output, { reasoning: inReasoning, summary: inSummary });
    visit(node.item, { reasoning: inReasoning, summary: inSummary });
  };

  if (typeof payload?.reasoning_text === 'string') {
    pushStep(payload.reasoning_text);
  }
  if (typeof payload?.reasoning_summary_text === 'string') {
    pushSummary(payload.reasoning_summary_text);
  }
  visit(payload?.reasoning_events, { reasoning: true });
  visit(payload?.output, {});

  return {
    summaryText: summaryFragments.join('\n'),
    steps: reasoningSteps,
  };
}

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

function formatAiConnectivityError(baseUrl, error) {
  const rawMessage = String(error?.message || '').trim();
  const cause = error?.cause;
  const causeCode = String(cause?.code || '').trim().toUpperCase();
  let host = normalizeBaseUrl(baseUrl);
  try {
    host = new URL(baseUrl).host || host;
  } catch (parseError) {
  }

  if (causeCode === 'ENOTFOUND') {
    return `无法解析 AI 服务地址 ${host}`;
  }
  if (causeCode === 'ECONNRESET') {
    return `AI 服务连接被重置，请检查 ${host} 是否可访问`;
  }
  if (causeCode === 'ECONNREFUSED') {
    return `AI 服务拒绝连接：${host}`;
  }
  if (causeCode === 'ETIMEDOUT') {
    return `连接 AI 服务超时：${host}`;
  }
  if (rawMessage === 'fetch failed' && host) {
    return `无法连接到 AI 服务：${host}`;
  }
  return rawMessage || 'AI 请求失败';
}

async function findPython() {
  for (const candidate of pythonCandidates()) {
    try {
      if (candidate.includes(path.sep)) {
        await fsp.access(candidate, fs.constants.X_OK);
        return candidate;
      }

      await new Promise((resolve, reject) => {
        execFile(candidate, ['--version'], { timeout: 5000 }, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      return candidate;
    } catch (error) {
    }
  }
  throw new Error('未找到可用的 Python 解释器');
}

async function callBridge(command, payload = {}) {
  const bundledBridge = await findBundledBridge();
  const useBundledBridge = app.isPackaged || Boolean(bundledBridge);
  if (useBundledBridge && !bundledBridge) {
    throw new Error('内置服务组件缺失，请重新安装最新版客户端');
  }

  const executable = useBundledBridge ? bundledBridge : await findPython();
  const args = useBundledBridge
    ? [command, JSON.stringify(payload)]
    : [bridgePath(), command, JSON.stringify(payload)];

  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd: appRoot(), env: bridgeEnv(), timeout: 120000 }, (error, stdout, stderr) => {
      const trimmed = String(stdout || '').trim();
      const lines = trimmed ? trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
      const candidate = lines.length ? lines[lines.length - 1] : trimmed;
      let parsed = null;
      if (candidate) {
        try {
          parsed = JSON.parse(candidate);
        } catch (parseError) {
          parsed = null;
        }
      }
      if (error) {
        const rawError = parsed?.error || stderr.trim() || trimmed || error.message;
        if (!useBundledBridge && /ENOENT|not found|spawn .*python/i.test(String(error.message || rawError))) {
          reject(new Error('未找到可用的 Python 运行环境；请安装 Python 3.10+，或使用正式安装包版本'));
          return;
        }
        reject(new Error(rawError));
        return;
      }
      try {
        const response = parsed || JSON.parse(candidate || '{}');
        if (!response.ok) {
          reject(new Error(response.error || '请求失败'));
          return;
        }
        resolve(response.data);
      } catch (parseError) {
        reject(new Error('服务返回格式异常'));
      }
    });
  });
}

function statePath() {
  return path.join(app.getPath('userData'), 'state.json');
}

async function readState() {
  try {
    const content = await fsp.readFile(statePath(), 'utf-8');
    const payload = JSON.parse(content);
    const favoriteGroups = normalizeFavoriteGroupsMap(payload.favoriteGroups || {});
    const aiConfig = normalizeAiConfig(payload.aiConfig || {});
    return {
      favorites: normalizeFavoritesMap(payload.favorites || {}, favoriteGroups),
      favoriteGroups,
      history: payload.history || [],
      aiConfig,
      aiConfigStatus: normalizeAiConfigStatus(payload.aiConfigStatus || {}, aiConfig),
    };
  } catch (error) {
    return defaultState();
  }
}

async function writeState(state) {
  await fsp.mkdir(path.dirname(statePath()), { recursive: true });
  await fsp.writeFile(statePath(), JSON.stringify(state, null, 2), 'utf-8');
}

async function listFavorites() {
  const state = await readState();
  return Object.values(state.favorites).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

async function listFavoriteGroups() {
  return listFavoriteGroupsFromState(await readState());
}

async function toggleFavorite(paper) {
  const state = await readState();
  const paperId = favoriteKeyFromPaper(paper || {});
  if (!paperId) {
    throw new Error('缺少论文 ID');
  }
  if (state.favorites[paperId]) {
    delete state.favorites[paperId];
    await writeState(state);
    return { isFavorite: false, favorites: await listFavorites(), favoriteGroups: await listFavoriteGroups() };
  }
  state.favorites[paperId] = normalizeFavoriteEntry({
    ...paper,
    favorite_key: paperId,
    group_id: normalizeFavoriteGroupId(paper.group_id, state.favoriteGroups),
    savedAt: new Date().toISOString(),
  }, paperId);
  await writeState(state);
  return { isFavorite: true, favorites: await listFavorites(), favoriteGroups: await listFavoriteGroups() };
}

async function removeFavorite(paperId) {
  const state = await readState();
  delete state.favorites[paperId];
  await writeState(state);
  return { favorites: await listFavorites(), favoriteGroups: await listFavoriteGroups() };
}

async function createFavoriteGroup(name) {
  const state = await readState();
  const normalizedName = String(name || '').trim();
  if (!normalizedName) {
    throw new Error('请输入分组名称');
  }
  const duplicate = Object.values(state.favoriteGroups || {}).find((group) => String(group.name || '').trim() === normalizedName);
  if (duplicate) {
    return { group: duplicate, favoriteGroups: listFavoriteGroupsFromState(state) };
  }
  const id = createFavoriteGroupId();
  state.favoriteGroups[id] = normalizeFavoriteGroupEntry({ id, name: normalizedName, createdAt: new Date().toISOString() }, id);
  await writeState(state);
  return { group: state.favoriteGroups[id], favoriteGroups: await listFavoriteGroups() };
}

async function renameFavoriteGroup(groupId, name) {
  const state = await readState();
  const id = String(groupId || '').trim();
  const nextName = String(name || '').trim();
  if (!nextName) {
    throw new Error('请输入新的分组名称');
  }
  if (!state.favoriteGroups[id]) {
    throw new Error('未找到分组');
  }
  state.favoriteGroups[id] = {
    ...state.favoriteGroups[id],
    name: nextName,
  };
  await writeState(state);
  return { favoriteGroups: await listFavoriteGroups() };
}

async function setFavoriteGroup(favoriteKey, groupId) {
  const state = await readState();
  const normalizedFavoriteKey = String(favoriteKey || '').trim();
  if (!normalizedFavoriteKey || !state.favorites[normalizedFavoriteKey]) {
    throw new Error('未找到收藏论文');
  }
  const nextGroupId = normalizeFavoriteGroupId(groupId, state.favoriteGroups);
  state.favorites[normalizedFavoriteKey] = {
    ...state.favorites[normalizedFavoriteKey],
    group_id: nextGroupId,
  };
  await writeState(state);
  return { favorites: await listFavorites(), favoriteGroups: await listFavoriteGroups() };
}

async function addHistory(kind, payload) {
  const state = await readState();
  state.history = [{ kind, payload, at: new Date().toISOString() }, ...state.history].slice(0, 50);
  await writeState(state);
  return state.history;
}

async function saveAiConfig(rawConfig) {
  const state = await readState();
  state.aiConfig = normalizeAiConfig(rawConfig || {});
  state.aiConfigStatus = await probeAiConfig(state.aiConfig);
  await writeState(state);
  return {
    config: state.aiConfig,
    status: state.aiConfigStatus,
  };
}

async function getAiConfig() {
  const state = await readState();
  return state.aiConfig;
}

async function probeAiConfig(rawConfig = {}) {
  const aiConfig = normalizeAiConfig(rawConfig || {});
  const checkedAt = new Date().toISOString();

  if (aiConfig.provider.wireApi !== 'responses') {
    return normalizeAiConfigStatus({
      ok: false,
      code: 'unsupported_wire_api',
      message: '当前仅支持 Responses 协议',
      checkedAt,
    }, aiConfig);
  }

  if (aiConfig.provider.requiresOpenAIAuth && !aiConfig.openAIApiKey) {
    return normalizeAiConfigStatus({
      ok: false,
      code: 'missing_api_key',
      message: '请先填写 OPENAI_API_KEY',
      checkedAt,
    }, aiConfig);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${normalizeBaseUrl(aiConfig.provider.baseUrl)}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(aiConfig.provider.requiresOpenAIAuth ? { Authorization: `Bearer ${aiConfig.openAIApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: aiConfig.model,
        store: false,
        reasoning: { effort: 'minimal' },
        instructions: 'Reply with OK only.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
      }),
      signal: controller.signal,
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      const message = data?.error?.message || data?.message || data?.rawText || `AI 请求失败（HTTP ${response.status}）`;
      return normalizeAiConfigStatus({
        ok: false,
        code: `http_${response.status}`,
        message,
        checkedAt,
      }, aiConfig);
    }
    return normalizeAiConfigStatus({
      ok: true,
      code: 'ok',
      message: `${aiConfig.provider.name} · ${aiConfig.model} 已通过连通性测试`,
      checkedAt,
    }, aiConfig);
  } catch (error) {
    if (error?.name === 'AbortError') {
      return normalizeAiConfigStatus({
        ok: false,
        code: 'timeout',
        message: 'AI 连通性测试超时，请稍后重试',
        checkedAt,
      }, aiConfig);
    }
    return normalizeAiConfigStatus({
      ok: false,
      code: String(error?.cause?.code || 'network_error').trim().toLowerCase() || 'network_error',
      message: formatAiConnectivityError(aiConfig.provider.baseUrl, error),
      checkedAt,
    }, aiConfig);
  } finally {
    clearTimeout(timer);
  }
}

async function refreshStatus() {
  const state = await readState();
  const token = await callBridge('token-status');
  state.aiConfigStatus = await probeAiConfig(state.aiConfig);
  await writeState(state);
  return {
    token,
    aiConfig: state.aiConfig,
    aiConfigStatus: state.aiConfigStatus,
  };
}

async function callAi(payload = {}) {
  const state = await readState();
  const aiConfig = normalizeAiConfig(payload.aiConfig || state.aiConfig || {});
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) {
    throw new Error('请输入问题');
  }
  if (aiConfig.provider.wireApi !== 'responses') {
    throw new Error('当前仅支持 Responses 协议');
  }
  if (aiConfig.provider.requiresOpenAIAuth && !aiConfig.openAIApiKey) {
    throw new Error('请先在设置中配置 OPENAI_API_KEY');
  }

  const paperContext = payload.paperContext || {};
  const history = Array.isArray(payload.messages) ? payload.messages : [];
  const input = [];
  const hasRemotePdfContext = isRemoteHttpUrl(paperContext.pdfUrl) && looksLikePdfUrl(paperContext.pdfUrl);
  const hasTextContext = Boolean(String(paperContext.contextText || '').trim());
  const contextContent = [{ type: 'input_text', text: buildPaperContextText(paperContext) }];
  if (hasRemotePdfContext) {
    contextContent.push({ type: 'input_file', file_url: paperContext.pdfUrl });
  }
  input.push({ role: 'user', content: contextContent });

  for (const message of history) {
    const normalized = toResponseInputMessage(message);
    if (normalized) {
      input.push(normalized);
    }
  }
  input.push({ role: 'user', content: [{ type: 'input_text', text: prompt }] });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let response;
  try {
    response = await fetch(`${normalizeBaseUrl(aiConfig.provider.baseUrl)}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(aiConfig.provider.requiresOpenAIAuth ? { Authorization: `Bearer ${aiConfig.openAIApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: aiConfig.model,
        store: !aiConfig.disableResponseStorage,
        reasoning: { effort: aiConfig.modelReasoningEffort },
        instructions: 'You are DeepXiv 的论文阅读助手。默认使用中文回答，优先依据随附 PDF 内容，其次参考论文元信息。回答应准确、简洁，并在不确定时明确说明。',
        input,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('AI 请求超时，请稍后重试');
    }
    throw new Error(formatAiConnectivityError(aiConfig.provider.baseUrl, error));
  } finally {
    clearTimeout(timer);
  }

  const data = await parseJsonResponse(response);
  if (!response.ok) {
    const message = data?.error?.message || data?.message || data?.rawText || `AI 请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }

  const reasoning = extractReasoningArtifacts(data);

  return {
    answer: extractResponseText(data),
    reasoningSummary: reasoning.summaryText,
    reasoningSteps: reasoning.steps,
    usedPdfContext: Boolean(hasRemotePdfContext || hasTextContext),
    contextMode: hasRemotePdfContext ? 'pdf' : hasTextContext ? 'text' : 'metadata',
    providerName: aiConfig.provider.name || aiConfig.modelProvider,
    model: aiConfig.model,
  };
}

async function importLocalPdf(options = {}) {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: '导入本地 PDF',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (picked.canceled || !picked.filePaths?.length) {
    return { canceled: true, favorites: await listFavorites(), favoriteGroups: await listFavoriteGroups() };
  }

  const state = await readState();
  const groupId = normalizeFavoriteGroupId(options.groupId, state.favoriteGroups);
  const importedItems = [];
  const failedItems = [];

  for (const filePath of picked.filePaths) {
    try {
      const imported = normalizeFavoriteEntry(await callBridge('import-local-pdf', { path: filePath }));
      state.favorites[imported.favorite_key] = {
        ...imported,
        group_id: groupId,
      };
      importedItems.push(state.favorites[imported.favorite_key]);
    } catch (error) {
      failedItems.push({
        path: filePath,
        message: String(error?.message || '导入失败').trim() || '导入失败',
      });
    }
  }

  if (!importedItems.length && failedItems.length) {
    throw new Error(failedItems[0].message || '导入本地 PDF 失败');
  }

  await writeState(state);

  return {
    canceled: false,
    imported: importedItems[0] || null,
    importedItems,
    importedCount: importedItems.length,
    failedItems,
    failedCount: failedItems.length,
    favorites: await listFavorites(),
    favoriteGroups: await listFavoriteGroups(),
  };
}

async function openLocalPath(targetPath) {
  const filePath = String(targetPath || '').trim();
  if (!filePath) {
    throw new Error('缺少本地文件路径');
  }
  const errorMessage = await shell.openPath(filePath);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
  return true;
}

function resolvePdfViewerSource(target) {
  const value = String(target || '').trim();
  if (!value) {
    throw new Error('缺少 PDF 地址');
  }
  if (isRemoteHttpUrl(value)) {
    return value;
  }
  return pathToFileURL(value).toString();
}

async function openPdfViewer(payload = {}) {
  const rawTarget = String(payload.target || '').trim();
  if (!rawTarget) {
    throw new Error('缺少 PDF 地址');
  }

  const viewerWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 680,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    title: String(payload.title || 'PDF 阅读').trim() || 'PDF 阅读',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  pdfViewerWindows.add(viewerWindow);
  viewerWindow.on('closed', () => {
    pdfViewerWindows.delete(viewerWindow);
  });

  viewerWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  viewerWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'mouseWheel') {
      return;
    }
    if (!(input.meta || input.control)) {
      return;
    }
    const delta = Number(input.deltaY ?? input.wheelDeltaY ?? 0);
    if (!Number.isFinite(delta) || delta === 0) {
      return;
    }
    event.preventDefault();
    const currentZoom = viewerWindow.webContents.getZoomFactor();
    const nextZoom = delta < 0 ? currentZoom + 0.12 : currentZoom - 0.12;
    const boundedZoom = Math.min(4, Math.max(0.5, nextZoom));
    viewerWindow.webContents.setZoomFactor(boundedZoom);
  });

  const source = resolvePdfViewerSource(rawTarget);
  await viewerWindow.loadURL(source);
  viewerWindow.webContents.setZoomFactor(1);
  return true;
}

async function bootstrap() {
  const state = await readState();
  return {
    token: await callBridge('token-status'),
    favorites: await listFavorites(),
    favoriteGroups: listFavoriteGroupsFromState(state),
    history: state.history,
    aiConfig: state.aiConfig,
    aiConfigStatus: state.aiConfigStatus,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1200,
    minHeight: 800,
    title: 'DeepXiv Mac Client',
    backgroundColor: '#0f172a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'));
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  ipcMain.handle('bootstrap', bootstrap);
  ipcMain.handle('status:refresh', refreshStatus);
  ipcMain.handle('token:status', () => callBridge('token-status'));
  ipcMain.handle('token:save', (_, token) => callBridge('save-token', { token }));
  ipcMain.handle('token:register', () => callBridge('register-token'));
  ipcMain.handle('papers:search', (_, payload) => callBridge('search', payload));
  ipcMain.handle('papers:trending', (_, payload) => callBridge('trending', payload));
  ipcMain.handle('pdf:prefetch', (_, payload) => prefetchPdf(payload));
  ipcMain.handle('pdf:resolve', (_, payload) => resolvePdfForOpen(payload));
  ipcMain.handle('papers:snapshot', async (_, payload) => {
    const bridgePayload = typeof payload === 'string'
      ? { arxiv_id: payload }
      : (payload || {});
    const paperId = String(
      bridgePayload.arxiv_id
      || bridgePayload.openalex_id
      || bridgePayload.europepmc_id
      || bridgePayload.paperId
      || ''
    ).trim();
    const trackHistory = typeof payload === 'object' ? payload?.trackHistory !== false : true;
    const snapshot = await callBridge('snapshot', bridgePayload);
    if (trackHistory) {
      await addHistory('paper', {
        paper_key: snapshot.head?.paper_key || bridgePayload.paper_key || favoriteKeyFromPaper(snapshot.head || bridgePayload),
        favorite_key: snapshot.head?.favorite_key || bridgePayload.favorite_key || favoriteKeyFromPaper(snapshot.head || bridgePayload),
        arxiv_id: snapshot.arxiv_id || bridgePayload.arxiv_id || '',
        openalex_id: snapshot.openalex_id || bridgePayload.openalex_id || '',
        europepmc_id: snapshot.europepmc_id || bridgePayload.europepmc_id || '',
        europepmc_source: snapshot.europepmc_source || bridgePayload.europepmc_source || '',
        source_kind: snapshot.source_kind || bridgePayload.source_kind || 'arxiv',
        source_label: snapshot.source_label || bridgePayload.source_label || '',
        title: snapshot.brief?.title || snapshot.head?.title || paperId,
        author_line: snapshot.head?.author_line || bridgePayload.author_line || '',
        abstract: snapshot.head?.abstract || snapshot.brief?.tldr || bridgePayload.abstract || '',
        external_url: snapshot.brief?.src_url || snapshot.head?.src_url || bridgePayload.external_url || '',
        pdf_url: snapshot.brief?.pdf_url || snapshot.head?.pdf_url || '',
        local_pdf_path: snapshot.local_pdf_path || snapshot.head?.local_pdf_path || bridgePayload.local_pdf_path || '',
        full_context_text: snapshot.head?.full_context_text || bridgePayload.full_context_text || '',
        supports_favorite: snapshot.head?.supports_favorite ?? bridgePayload.supports_favorite ?? true,
      });
    }
    return snapshot;
  });
  ipcMain.handle('papers:section', (_, payload) => callBridge('section', payload));
  ipcMain.handle('favorites:list', listFavorites);
  ipcMain.handle('favorites:toggle', (_, paper) => toggleFavorite(paper));
  ipcMain.handle('favorites:remove', (_, paperId) => removeFavorite(paperId));
  ipcMain.handle('favorites:groups:list', listFavoriteGroups);
  ipcMain.handle('favorites:groups:create', (_, name) => createFavoriteGroup(name));
  ipcMain.handle('favorites:groups:rename', (_, payload) => renameFavoriteGroup(payload?.groupId, payload?.name));
  ipcMain.handle('favorites:setGroup', (_, payload) => setFavoriteGroup(payload?.favoriteKey, payload?.groupId));
  ipcMain.handle('favorites:importLocalPdf', (_, payload) => importLocalPdf(payload || {}));
  ipcMain.handle('history:list', async () => (await readState()).history);
  ipcMain.handle('history:add', (_, payload) => addHistory(payload.kind, payload.payload));
  ipcMain.handle('ai:config:get', getAiConfig);
  ipcMain.handle('ai:config:save', (_, payload) => saveAiConfig(payload));
  ipcMain.handle('ai:chat', (_, payload) => callAi(payload));
  ipcMain.handle('pdf:openViewer', (_, payload) => openPdfViewer(payload));
  ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url));
  ipcMain.handle('shell:openPath', (_, targetPath) => openLocalPath(targetPath));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

process.on('uncaughtException', async () => {
  if (mainWindow) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '应用异常',
      message: '应用遇到异常，请重新打开。'
    });
  }
});
