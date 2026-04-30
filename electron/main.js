const { app, BrowserWindow, ipcMain, shell, dialog, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const { createAiNetworkHelpers, parseJsonResponse } = require('./ai_network');

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

const AI_REASONING_LEVELS = new Set(['xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
const AI_INLINE_PDF_MAX_BYTES = 8 * 1024 * 1024;
const AI_PDF_TEXT_CONTEXT_MAX_CHARS = 120000;
const LEGACY_APP_DATA_NAMES = ['DeepXiv Client', 'deepxiv-client'];
let mainWindow = null;
const pdfViewerWindows = new Set();
const pdfPrefetchTasks = new Map();
const pdfPrefetchStatuses = new Map();
const pdfDocumentSessions = new Map();
const PDF_CACHE_NAMESPACE = 'v1';
const PDF_FETCH_TIMEOUT_MS = 90000;
const PDF_LANDING_FETCH_TIMEOUT_MS = 45000;
const PDF_HTML_PREVIEW_LIMIT_BYTES = 768 * 1024;
const PDF_RESOLVER_MAX_CANDIDATES = 18;
const PDF_RESOLVER_PARALLELISM = 3;
const PDF_BROWSER_RESOLUTION_TIMEOUT_MS = 25000;
const PDF_BROWSER_RESOLUTION_POLL_MS = 1200;
const PDF_SIBLING_SEARCH_LIMIT = 12;
const PDF_SIBLING_MAX_ATTEMPTS = 3;
const PDF_DOCUMENT_PROTOCOL = 'ohmypaper-pdf';
let pdfDocumentProtocolRegistered = false;
const RESTRICTED_DIRECT_PDF_HOSTS = new Set(['dl.acm.org', 'www.gbv.de', 'pubs.acs.org']);
const WEAK_PDF_SOURCE_HOSTS = new Set([
  'www.researchgate.net',
  'researchgate.net',
  'academia.edu',
  'www.academia.edu',
]);
const BROWSER_ASSISTED_PDF_HOSTS = new Set([
  'onlinelibrary.wiley.com',
  'www.onlinelibrary.wiley.com',
  'ieeexplore.ieee.org',
  'dl.acm.org',
  'pubs.acs.org',
  'link.springer.com',
  'www.sciencedirect.com',
]);

protocol.registerSchemesAsPrivileged([
  {
    scheme: PDF_DOCUMENT_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

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
  if (process.env.OHMYPAPER_PROJECT_ROOT || process.env.DEEPXIV_PROJECT_ROOT) {
    return process.env.OHMYPAPER_PROJECT_ROOT || process.env.DEEPXIV_PROJECT_ROOT;
  }
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.join(__dirname, '..');
}

function pythonCandidates() {
  const root = appRoot();
  return [
    process.env.OHMYPAPER_PYTHON,
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
    ? [path.join(bridgeDir, 'ohmypaper-bridge.exe'), path.join(bridgeDir, 'deepxiv-bridge.exe')]
    : [path.join(bridgeDir, 'ohmypaper-bridge'), path.join(bridgeDir, 'deepxiv-bridge')];
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
  return (
    value.includes('.pdf')
    || value.includes('/pdf/')
    || value.includes('/pdfdirect/')
    || value.includes('/epdf/')
    || value.includes('arxiv.org/pdf/')
    || value.includes('/download/')
    || value.includes('downloadpdf')
    || value.includes('articlepdf')
    || value.includes('fullpdf')
    || /[?&](download=1|download=true|format=pdf|type=pdf|pdf=1)\b/.test(value)
  );
}

function isRemoteHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function prunePdfDocumentSessions(maxSize = 256) {
  if (pdfDocumentSessions.size <= maxSize) {
    return;
  }
  const entries = [...pdfDocumentSessions.entries()].sort((left, right) => Number(left[1]?.updatedAt || 0) - Number(right[1]?.updatedAt || 0));
  for (const [token] of entries.slice(0, Math.max(0, entries.length - maxSize))) {
    pdfDocumentSessions.delete(token);
  }
}

function rememberPdfDocument(filePath, paperKey = '') {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) {
    return '';
  }
  const token = sha1(`${paperKey}|${normalizedPath}`);
  pdfDocumentSessions.set(token, {
    filePath: normalizedPath,
    updatedAt: Date.now(),
  });
  prunePdfDocumentSessions();
  return token;
}

function buildPdfDocumentUrl(filePath, paperKey = '') {
  const token = rememberPdfDocument(filePath, paperKey);
  if (!token) {
    return '';
  }
  const filename = encodeURIComponent(path.basename(filePath || '') || 'document.pdf');
  return `${PDF_DOCUMENT_PROTOCOL}://document/${token}/${filename}`;
}

function requestHeaderValue(request, headerName) {
  if (request?.headers?.get) {
    return String(request.headers.get(headerName) || '').trim();
  }
  const headers = request?.headers || {};
  return String(headers[headerName] || headers[String(headerName || '').toLowerCase()] || '').trim();
}

function parsePdfByteRange(rangeHeader, totalSize) {
  const value = String(rangeHeader || '').trim();
  if (!value || !Number.isFinite(totalSize) || totalSize <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match) {
    return null;
  }
  const startRaw = match[1];
  const endRaw = match[2];

  let start = startRaw === '' ? NaN : Number(startRaw);
  let end = endRaw === '' ? NaN : Number(endRaw);

  if (Number.isNaN(start) && Number.isNaN(end)) {
    return null;
  }

  if (Number.isNaN(start)) {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    if (!Number.isFinite(start) || start < 0 || start >= totalSize) {
      return null;
    }
    if (Number.isNaN(end) || end >= totalSize) {
      end = totalSize - 1;
    }
  }

  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  return {
    start,
    end,
    length: (end - start) + 1,
  };
}

function textResponse(message, status = 400) {
  return new Response(String(message || ''), {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function createPdfProtocolResponse(filePath, request) {
  const stats = await fsp.stat(filePath);
  if (!stats.isFile() || stats.size < 4) {
    return textResponse('PDF 文件不存在', 404);
  }

  const headers = new Headers({
    'content-type': 'application/pdf',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  const range = parsePdfByteRange(requestHeaderValue(request, 'range'), stats.size);

  if (range) {
    headers.set('content-length', String(range.length));
    headers.set('content-range', `bytes ${range.start}-${range.end}/${stats.size}`);
    return new Response(
      Readable.toWeb(fs.createReadStream(filePath, { start: range.start, end: range.end })),
      {
        status: 206,
        headers,
      }
    );
  }

  headers.set('content-length', String(stats.size));
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers,
  });
}

function registerPdfDocumentProtocol() {
  if (pdfDocumentProtocolRegistered) {
    return;
  }
  protocol.handle(PDF_DOCUMENT_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      const [token] = url.pathname.split('/').filter(Boolean);
      const filePath = String(pdfDocumentSessions.get(token)?.filePath || '').trim();
      if (!filePath) {
        return textResponse('PDF 会话不存在', 404);
      }
      const valid = await validatePdfFilePath(filePath);
      if (!valid) {
        pdfDocumentSessions.delete(token);
        return textResponse('PDF 文件无效', 410);
      }
      return createPdfProtocolResponse(filePath, request);
    } catch (error) {
      return textResponse(String(error?.message || error || 'PDF 协议处理失败').trim(), 500);
    }
  });
  pdfDocumentProtocolRegistered = true;
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

function pdfCandidateKindFromUrl(url, fallbackKind = 'direct_pdf') {
  const value = String(url || '').trim();
  if (!value) return fallbackKind;
  return looksLikePdfUrl(value) ? 'direct_pdf' : fallbackKind;
}

function normalizePdfCandidate(rawCandidate = {}, fallbackKind = 'direct_pdf') {
  if (typeof rawCandidate === 'string') {
    const url = String(rawCandidate || '').trim();
    if (!isRemoteHttpUrl(url)) return null;
    return {
      url,
      kind: pdfCandidateKindFromUrl(url, fallbackKind),
      source: '',
      label: '',
      host: (() => {
        try {
          return new URL(url).host.toLowerCase();
        } catch (error) {
          return '';
        }
      })(),
      version: '',
      license: '',
      isOa: false,
    };
  }
  const url = String(rawCandidate?.url || '').trim();
  if (!isRemoteHttpUrl(url)) return null;
  const kind = String(rawCandidate?.kind || '').trim().toLowerCase() || pdfCandidateKindFromUrl(url, fallbackKind);
  return {
    url,
    kind,
    source: String(rawCandidate?.source || '').trim(),
    label: String(rawCandidate?.label || '').trim(),
    host: String(rawCandidate?.host || (() => {
      try {
        return new URL(url).host.toLowerCase();
      } catch (error) {
        return '';
      }
    })()).trim().toLowerCase(),
    version: String(rawCandidate?.version || '').trim(),
    license: String(rawCandidate?.license || '').trim(),
    isOa: rawCandidate?.is_oa === true || rawCandidate?.isOa === true,
  };
}

function normalizePdfCandidates(rawCandidates = [], fallbackKind = 'direct_pdf') {
  if (!Array.isArray(rawCandidates)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const rawCandidate of rawCandidates) {
    const candidate = normalizePdfCandidate(rawCandidate, fallbackKind);
    if (!candidate?.url) continue;
    const key = `${candidate.kind}:${candidate.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function addUniquePdfCandidate(list, seen, rawCandidate, fallbackKind = 'direct_pdf', extra = {}) {
  const candidate = normalizePdfCandidate({ ...(rawCandidate || {}), ...extra }, fallbackKind);
  if (!candidate?.url) {
    return;
  }
  const key = `${candidate.kind}:${candidate.url}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  list.push(candidate);
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
  const explicitPdfUrl = String(payload.pdf_url || '').trim();
  const sourceUrl = isRemoteHttpUrl(explicitPdfUrl)
    ? explicitPdfUrl
    : (isRemoteHttpUrl(target) ? target : '');
  const externalUrl = String(payload.external_url || '').trim();
  const localPath = !isRemoteHttpUrl(target) ? target : String(payload.local_pdf_path || '').trim();
  const cacheSeed = sourceUrl || externalUrl || localPath || target;
  const cachePath = cacheSeed ? path.join(pdfCacheDir(), `${sha1(`${paperKey}|${cacheSeed}`)}.pdf`) : '';
  return {
    ...payload,
    paperKey,
    title: String(payload.title || '论文 PDF').trim() || '论文 PDF',
    authorLine: String(payload.author_line || payload.authorLine || '').trim(),
    publishAt: String(payload.publish_at || payload.publishAt || '').trim(),
    doi: String(payload.doi || '').trim(),
    sourceKind: String(payload.source_kind || '').trim().toLowerCase(),
    sourceLabel: String(payload.source_label || '').trim(),
    target,
    targetKind,
    sourceUrl,
    externalUrl,
    localPath,
    cachePath,
    pmcid: String(payload.pmcid || '').trim().toUpperCase(),
    reasonCode: String(payload.pdf_reason_code || payload.reasonCode || '').trim(),
    reasonMessage: String(payload.pdf_reason_message || payload.reasonMessage || '').trim(),
    arxivId: String(payload.arxiv_id || '').trim(),
    openalexId: String(payload.openalex_id || '').trim(),
    explicitArxivId: payload.explicit_arxiv_id === true,
    pdfCandidates: normalizePdfCandidates(payload.pdf_candidates || [], 'landing_page'),
    openalexContentUrl: String(payload.openalex_content_url || '').trim(),
    openalexOaUrl: String(payload.openalex_oa_url || '').trim(),
    openalexOaStatus: String(payload.openalex_oa_status || '').trim(),
    openalexIsOa: payload.openalex_is_oa === true,
    openalexHasContentPdf: payload.openalex_has_content_pdf === true,
    disableSiblingFallback: payload.disable_sibling_fallback === true || payload.disableSiblingFallback === true,
    resolvedFromSibling: payload.resolved_from_sibling === true || payload.resolvedFromSibling === true,
    resolvedFromPaperKey: String(payload.resolved_from_paper_key || payload.resolvedFromPaperKey || '').trim(),
    resolvedSourceKind: String(payload.resolved_source_kind || payload.resolvedSourceKind || '').trim(),
    resolvedSourceLabel: String(payload.resolved_source_label || payload.resolvedSourceLabel || '').trim(),
    resolvedMatchReason: String(payload.resolved_match_reason || payload.resolvedMatchReason || '').trim(),
    resolvedPaperTitle: String(payload.resolved_paper_title || payload.resolvedPaperTitle || '').trim(),
  };
}

function clonePdfStatus(status) {
  return status ? JSON.parse(JSON.stringify(status)) : null;
}

function defaultPdfReasonMessage(normalized) {
  const code = String(normalized?.reasonCode || '').trim();
  if (normalized?.localPath) {
    return '本地 PDF 已就绪';
  }
  switch (code) {
    case 'ready_remote':
      return '已发现可缓存 PDF';
    case 'ready_local':
      return '本地 PDF 已就绪';
    case 'needs_pmc_resolution':
      return '正在准备 PDF…可稍后打开';
    case 'needs_browser_resolution':
      return '正在浏览器验证…';
    case 'browser_verified_no_pdf':
      return '浏览器验证后未发现可下载 PDF';
    case 'source_paywalled':
      return '源站存在权限限制';
    case 'source_restricted':
      return '源站限制 PDF 直连';
    case 'landing_page_only':
      return '源站仅提供论文落地页，未发现可用 PDF';
    case 'no_open_access_pdf':
      return '源站未提供可用 PDF';
    case 'invalid_arxiv_fallback':
      return '当前记录未提供有效 arXiv PDF';
    case 'source_timeout':
      return 'PDF 缓存超时';
    case 'cache_failed':
      return 'PDF 缓存失败';
    default:
      return normalized?.reasonMessage || (normalized?.target ? '当前论文没有可缓存的 PDF 直链' : '未找到可用 PDF');
  }
}

function resolvedPdfStatusFields(raw = {}) {
  return {
    resolvedFromSibling: raw?.resolvedFromSibling === true,
    resolvedFromPaperKey: String(raw?.resolvedFromPaperKey || '').trim(),
    resolvedSourceKind: String(raw?.resolvedSourceKind || '').trim(),
    resolvedSourceLabel: String(raw?.resolvedSourceLabel || '').trim(),
    resolvedMatchReason: String(raw?.resolvedMatchReason || '').trim(),
    resolvedPaperTitle: String(raw?.resolvedPaperTitle || '').trim(),
  };
}

function formatResolvedPdfReadyMessage(baseMessage, raw = {}) {
  const resolved = resolvedPdfStatusFields(raw);
  if (!resolved.resolvedFromSibling) {
    return baseMessage;
  }
  const label = resolved.resolvedSourceLabel || resolved.resolvedSourceKind || '开放兄弟版本';
  return `${baseMessage} · 已自动切换到开放兄弟版本（${label}）`;
}

function createPdfPrefetchStatus(normalized, overrides = {}) {
  return {
    paperKey: normalized?.paperKey || '',
    title: normalized?.title || '论文 PDF',
    state: 'missing',
    progress: 0,
    target: normalized?.target || '',
    sourceUrl: normalized?.sourceUrl || '',
    cachedPath: '',
    openTarget: normalized?.localPath || normalized?.target || '',
    message: defaultPdfReasonMessage(normalized),
    reasonCode: normalized?.reasonCode || '',
    isCached: false,
    isLocal: Boolean(normalized?.localPath),
    error: '',
    ...resolvedPdfStatusFields(normalized),
    ...overrides,
  };
}

function pdfPrefetchTaskSignature(normalized) {
  return sha1(JSON.stringify({
    paperKey: normalized?.paperKey || '',
    title: normalized?.title || '',
    authorLine: normalized?.authorLine || '',
    publishAt: normalized?.publishAt || '',
    doi: normalized?.doi || '',
    target: normalized?.target || '',
    sourceUrl: normalized?.sourceUrl || '',
    externalUrl: normalized?.externalUrl || '',
    localPath: normalized?.localPath || '',
    cachePath: normalized?.cachePath || '',
    pmcid: normalized?.pmcid || '',
    reasonCode: normalized?.reasonCode || '',
    pdfCandidates: normalized?.pdfCandidates || [],
    disableSiblingFallback: normalized?.disableSiblingFallback === true,
  }));
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

async function readPdfFileHeader(filePath, byteLength = 8) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(4, byteLength));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function validatePdfFilePath(filePath) {
  const target = String(filePath || '').trim();
  if (!target) {
    return false;
  }
  try {
    const stats = await fsp.stat(target);
    if (!stats.isFile() || stats.size < 4) {
      return false;
    }
    const header = await readPdfFileHeader(target, 8);
    return header.length >= 4 && header.subarray(0, 4).toString('latin1') === '%PDF';
  } catch (error) {
    return false;
  }
}

async function resolveAiPdfAttachmentDescriptor({ sourceUrl = '', localPath = '', isLocal = false } = {}) {
  const remoteSourceUrl = String(sourceUrl || '').trim();
  const candidateLocalPath = String(localPath || '').trim();
  const localFlag = isLocal === true || Boolean(candidateLocalPath);
  const hasRemotePdf = isRemoteHttpUrl(remoteSourceUrl) && looksLikePdfUrl(remoteSourceUrl);

  if (candidateLocalPath) {
    const valid = await validatePdfFilePath(candidateLocalPath);
    if (valid) {
      return {
        sourceUrl: remoteSourceUrl,
        localPath: candidateLocalPath,
        attachMode: 'file_data',
        aiAttachable: true,
        aiAttachmentMessage: '',
        isLocal: true,
      };
    }
    if (!hasRemotePdf) {
      return {
        sourceUrl: remoteSourceUrl,
        localPath: candidateLocalPath,
        attachMode: 'none',
        aiAttachable: false,
        aiAttachmentMessage: 'PDF 已打开，但本地文件无效，当前未附带原文',
        isLocal: true,
      };
    }
  }

  if (hasRemotePdf) {
    return {
      sourceUrl: remoteSourceUrl,
      localPath: candidateLocalPath,
      attachMode: 'file_data',
      aiAttachable: true,
      aiAttachmentMessage: '',
      isLocal: localFlag,
    };
  }

  return {
    sourceUrl: remoteSourceUrl,
    localPath: '',
    attachMode: 'none',
    aiAttachable: false,
    aiAttachmentMessage: 'PDF 已打开，但当前未附带可供 AI 使用的原文文件',
    isLocal: localFlag,
  };
}

async function cacheRemotePdfForAi(remotePdfUrl = '') {
  const normalizedUrl = String(remotePdfUrl || '').trim();
  if (!isRemoteHttpUrl(normalizedUrl) || !looksLikePdfUrl(normalizedUrl)) {
    throw new Error('未找到可缓存的远程 PDF 地址');
  }

  await fsp.mkdir(pdfCacheDir(), { recursive: true });
  const cachePath = path.join(pdfCacheDir(), `${sha1(`ai-file-data|${normalizedUrl}`)}.pdf`);
  if (await fileExists(cachePath)) {
    const valid = await validatePdfFilePath(cachePath);
    if (valid) {
      return cachePath;
    }
    await fsp.rm(cachePath, { force: true }).catch(() => {});
  }

  const candidate = normalizePdfCandidate({ url: normalizedUrl }, 'direct_pdf') || {
    url: normalizedUrl,
    kind: 'direct_pdf',
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchWithAppSession(normalizedUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: pdfFetchHeaders(candidate),
    });
    if (!response.ok) {
      throw new Error(`远程 PDF 下载失败（HTTP ${response.status}）`);
    }

    const reader = response.body?.getReader ? response.body.getReader() : null;
    let firstChunk = Buffer.alloc(0);
    let bodyBuffer = null;

    if (reader) {
      const first = await reader.read();
      if (!first.done) {
        firstChunk = Buffer.from(first.value);
      }
    } else {
      bodyBuffer = Buffer.from(await response.arrayBuffer());
      firstChunk = bodyBuffer.subarray(0, Math.min(bodyBuffer.length, 1024));
    }

    if (!validatePdfSignature(firstChunk, response, { sourceUrl: normalizedUrl, target: normalizedUrl })) {
      const classification = classifyInvalidPdfResponse(firstChunk, response, { sourceUrl: normalizedUrl, target: normalizedUrl }, candidate);
      throw new Error(classification?.message || '远程源站返回的内容不是有效 PDF');
    }

    await streamPdfToTempPath({
      tempPath: cachePath,
      response,
      reader,
      firstChunk,
      bodyBuffer,
      initialStatus: { openTarget: normalizedUrl, message: '正在缓存 PDF…' },
      candidate,
      emitIfCurrent: () => {},
      ensureCurrentTask: () => {},
    });

    const valid = await validatePdfFilePath(cachePath);
    if (!valid) {
      throw new Error('缓存后的 PDF 文件无效');
    }
    return cachePath;
  } catch (error) {
    await fsp.rm(cachePath, { force: true }).catch(() => {});
    if (error?.name === 'AbortError') {
      throw new Error('远程 PDF 下载超时');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function buildAiInputFileAttachment(paperContext = {}) {
  if (paperContext?.pdfLoaded !== true) {
    return { inputFile: null, attachMode: 'none' };
  }

  const remotePdfUrl = String(paperContext.pdfUrl || '').trim();
  const localPdfPath = String(paperContext.localPdfPath || '').trim();
  const descriptor = await resolveAiPdfAttachmentDescriptor({
    sourceUrl: remotePdfUrl,
    localPath: localPdfPath,
    isLocal: Boolean(localPdfPath),
  });

  if (descriptor.attachMode !== 'file_data') {
    return {
      inputFile: null,
      attachMode: 'none',
      aiAttachmentMessage: descriptor.aiAttachmentMessage,
    };
  }

  try {
    const filePath = descriptor.localPath || await cacheRemotePdfForAi(descriptor.sourceUrl);
    let attachPath = filePath;
    let stats = await fsp.stat(attachPath);
    if (stats.size > AI_INLINE_PDF_MAX_BYTES) {
      const compressedPath = await compressPdfForAi(filePath).catch(() => '');
      if (compressedPath) {
        const compressedStats = await fsp.stat(compressedPath);
        if (compressedStats.size > 0 && compressedStats.size < stats.size && compressedStats.size <= AI_INLINE_PDF_MAX_BYTES) {
          attachPath = compressedPath;
          stats = compressedStats;
        }
      }
    }

    if (stats.size > AI_INLINE_PDF_MAX_BYTES) {
      const extracted = await extractPdfTextForAi(attachPath, AI_PDF_TEXT_CONTEXT_MAX_CHARS);
      const text = String(extracted?.text || '').trim();
      if (!text) {
        throw new Error('PDF 文件超过 AI 服务直传上限，且未能提取到可用正文');
      }
      return {
        inputFile: null,
        inputText: {
          type: 'input_text',
          text: [
            `PDF 原文过大（${formatFileSize(stats.size)}），已自动改用 PDF 正文文本上下文。`,
            extracted.pageCount ? `页数：${extracted.pageCount}` : '',
            extracted.truncated ? `已截取前 ${extracted.chars || text.length} 个字符。` : '',
            text,
          ].filter(Boolean).join('\n\n'),
        },
        attachMode: 'text_extract',
        localPath: filePath,
        aiAttachmentMessage: 'PDF 原文过大，已自动改用 PDF 正文文本上下文',
      };
    }

    const buffer = await fsp.readFile(attachPath);
    return {
      inputFile: {
        type: 'input_file',
        filename: path.basename(attachPath) || 'paper.pdf',
        file_data: `data:application/pdf;base64,${buffer.toString('base64')}`,
      },
      attachMode: 'file_data',
      localPath: attachPath,
    };
  } catch (error) {
    return {
      inputFile: null,
      attachMode: 'none',
      aiAttachmentMessage: String(error?.message || error || 'PDF 读取失败，当前未附带原文').trim() || 'PDF 读取失败，当前未附带原文',
    };
  }
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '未知大小';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

async function extractPdfTextForAi(filePath, maxChars = AI_PDF_TEXT_CONTEXT_MAX_CHARS) {
  return callBridge('extract-pdf-text', {
    path: filePath,
    max_chars: maxChars,
  });
}

async function compressPdfForAi(filePath) {
  const sourcePath = String(filePath || '').trim();
  if (!sourcePath) return '';
  await fsp.mkdir(pdfCacheDir(), { recursive: true });
  const outputPath = path.join(pdfCacheDir(), `${sha1(`ai-compressed|${sourcePath}`)}.pdf`);
  if (await fileExists(outputPath)) {
    const valid = await validatePdfFilePath(outputPath);
    if (valid) {
      return outputPath;
    }
    await fsp.rm(outputPath, { force: true }).catch(() => {});
  }
  const result = await callBridge('compress-pdf', {
    path: sourcePath,
    output_path: outputPath,
  });
  const compressedPath = String(result?.path || outputPath).trim();
  if (!compressedPath || !(await validatePdfFilePath(compressedPath))) {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    return '';
  }
  return compressedPath;
}

async function getCachedPdfStatus(normalized) {
  if (!normalized?.paperKey) {
    return null;
  }
  if (normalized.localPath) {
    if (!(await fileExists(normalized.localPath))) {
      return emitPdfPrefetchStatus(createPdfPrefetchStatus(normalized, {
        state: 'error',
        message: '本地 PDF 文件不存在',
        error: '本地 PDF 文件不存在',
        openTarget: '',
        reasonCode: 'cache_failed',
      }));
    }
    const valid = await validatePdfFilePath(normalized.localPath);
    if (!valid) {
      return emitPdfPrefetchStatus(createPdfPrefetchStatus(normalized, {
        state: 'error',
        message: '本地 PDF 文件无效',
        error: '本地 PDF 文件无效',
        openTarget: '',
        reasonCode: 'cache_failed',
      }));
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
      message: formatResolvedPdfReadyMessage('本地 PDF 已就绪', normalized),
      reasonCode: 'ready_local',
      isLocal: true,
      isCached: true,
      ...resolvedPdfStatusFields(normalized),
    });
  }
  if (normalized.cachePath && await fileExists(normalized.cachePath)) {
    const previousStatus = clonePdfStatus(pdfPrefetchStatuses.get(normalized.paperKey) || null);
    const valid = await validatePdfFilePath(normalized.cachePath);
    if (!valid) {
      await fsp.rm(normalized.cachePath, { force: true }).catch(() => {});
      pdfPrefetchStatuses.delete(normalized.paperKey);
      return null;
    }
    return emitPdfPrefetchStatus({
      paperKey: normalized.paperKey,
      title: normalized.title,
      state: 'ready',
      progress: 1,
      target: normalized.target,
      sourceUrl: previousStatus?.sourceUrl || normalized.sourceUrl || normalized.externalUrl,
      cachedPath: normalized.cachePath,
      openTarget: normalized.cachePath,
      message: formatResolvedPdfReadyMessage('PDF 已缓存', previousStatus || normalized),
      reasonCode: 'ready_remote',
      isCached: true,
      ...resolvedPdfStatusFields(previousStatus || normalized),
    });
  }
  return clonePdfStatus(pdfPrefetchStatuses.get(normalized.paperKey) || null);
}

function validatePdfSignature(firstChunk, response, normalized) {
  const buffer = Buffer.isBuffer(firstChunk) ? firstChunk : Buffer.from(firstChunk || []);
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF') {
    return true;
  }
  return false;
}

function isKnownRestrictedPdfHost(url) {
  try {
    const host = new URL(String(url || '').trim()).host.toLowerCase();
    return RESTRICTED_DIRECT_PDF_HOSTS.has(host);
  } catch (error) {
    return false;
  }
}

function decodePdfResponsePreview(firstChunk, byteLimit = 512) {
  const buffer = Buffer.isBuffer(firstChunk) ? firstChunk : Buffer.from(firstChunk || []);
  if (!buffer.length) return '';
  return buffer.subarray(0, Math.min(buffer.length, byteLimit)).toString('utf8').trim().toLowerCase();
}

function isLikelyHtmlLikeResponse(contentType, previewText) {
  const type = String(contentType || '').toLowerCase();
  if (/(text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml|application\/json)/.test(type)) {
    return true;
  }
  return previewText.startsWith('<!doctype html') || previewText.startsWith('<html') || previewText.startsWith('<?xml') || previewText.startsWith('{');
}

function classifyInvalidPdfResponse(firstChunk, response, normalized, candidate = {}) {
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  const finalUrl = String(response?.url || candidate?.url || normalized?.sourceUrl || normalized?.externalUrl || normalized?.target || '').trim();
  const previewText = decodePdfResponsePreview(firstChunk);
  const cfMitigated = String(response?.headers?.get?.('cf-mitigated') || '').trim().toLowerCase();
  const host = hostFromUrl(finalUrl);
  if (Number(response?.status || 0) === 401 || Number(response?.status || 0) === 403) {
    return {
      message: '源站限制 PDF 直连',
      reasonCode: 'source_restricted',
      finalUrl,
      previewText,
      canParseLandingPage: true,
      needsBrowserVerification: cfMitigated === 'challenge' || BROWSER_ASSISTED_PDF_HOSTS.has(host),
    };
  }
  if (isLikelyHtmlLikeResponse(contentType, previewText)) {
    return {
      message: isKnownRestrictedPdfHost(finalUrl) ? '源站限制 PDF 直连' : '源站仅提供论文落地页',
      reasonCode: isKnownRestrictedPdfHost(finalUrl) ? 'source_restricted' : 'landing_page_only',
      finalUrl,
      previewText,
      canParseLandingPage: true,
      needsBrowserVerification: cfMitigated === 'challenge' || BROWSER_ASSISTED_PDF_HOSTS.has(host),
    };
  }
  if (isKnownRestrictedPdfHost(finalUrl)) {
    return {
      message: '源站限制 PDF 直连',
      reasonCode: 'source_restricted',
      finalUrl,
      previewText,
      canParseLandingPage: true,
      needsBrowserVerification: true,
    };
  }
  return {
    message: '返回内容不是 PDF 文件',
    reasonCode: 'cache_failed',
    finalUrl,
    previewText,
    canParseLandingPage: false,
    needsBrowserVerification: false,
  };
}

function isPmcOaCandidate(normalized) {
  const sourceKind = String(normalized?.sourceKind || normalized?.source_kind || '').trim().toLowerCase();
  return Boolean(normalized?.pmcid && ['pubmed', 'pmc', 'preprint', 'europepmc'].includes(sourceKind));
}

function decodeHtmlEntitiesLite(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#x2f;|&#47;/gi, '/')
    .replace(/&#x3a;|&#58;/gi, ':')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\\\//g, '/');
}

function resolveCandidateUrl(url, baseUrl) {
  const raw = decodeHtmlEntitiesLite(String(url || '').trim());
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl).toString();
  } catch (error) {
    return '';
  }
}

function enqueuePdfCandidate(queue, seen, rawCandidate, fallbackKind = 'direct_pdf', extra = {}, { front = false } = {}) {
  const candidate = normalizePdfCandidate({ ...(rawCandidate || {}), ...extra }, fallbackKind);
  if (!candidate?.url) return;
  const key = `${candidate.kind}:${candidate.url}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (front) {
    queue.unshift(candidate);
  } else {
    queue.push(candidate);
  }
}

function pdfCandidatePriority(candidate) {
  const url = String(candidate?.url || '').trim().toLowerCase();
  const host = hostFromUrl(url);
  const source = String(candidate?.source || '').trim().toLowerCase();
  let score = 100;

  if (candidate?.kind === 'direct_pdf') score -= 20;
  if (candidate?.kind === 'content_api') score += 35;
  if (source.includes('arxiv')) score -= 50;
  if (source.includes('pmc')) score -= 45;
  if (source.includes('open_access')) score -= 35;
  if (host === 'arxiv.org') score -= 40;
  if (host.endsWith('ncbi.nlm.nih.gov')) score -= 35;
  if (host.endsWith('europepmc.org')) score -= 25;
  if (BROWSER_ASSISTED_PDF_HOSTS.has(host)) score += 20;
  if (RESTRICTED_DIRECT_PDF_HOSTS.has(host)) score += 25;

  return score;
}

function buildPdfResolverCandidates(normalized) {
  const queue = [];
  const seen = new Set();

  for (const candidate of normalized?.pdfCandidates || []) {
    enqueuePdfCandidate(queue, seen, candidate, candidate.kind || 'landing_page');
  }

  if (normalized?.sourceUrl) {
    enqueuePdfCandidate(queue, seen, { url: normalized.sourceUrl }, looksLikePdfUrl(normalized.sourceUrl) ? 'direct_pdf' : 'landing_page', {
      source: 'payload:source_url',
      label: 'Source',
    });
  }

  if (normalized?.externalUrl) {
    enqueuePdfCandidate(queue, seen, { url: normalized.externalUrl }, 'landing_page', {
      source: 'payload:external_url',
      label: 'Landing page',
    });
  }

  if (normalized?.openalexOaUrl) {
    enqueuePdfCandidate(queue, seen, { url: normalized.openalexOaUrl }, looksLikePdfUrl(normalized.openalexOaUrl) ? 'direct_pdf' : 'landing_page', {
      source: 'payload:openalex_oa',
      label: 'Open access',
    });
  }

  if (normalized?.openalexContentUrl) {
    enqueuePdfCandidate(queue, seen, { url: normalized.openalexContentUrl }, 'content_api', {
      source: 'payload:openalex_content',
      label: 'OpenAlex Content API',
    });
  }

  if (!queue.length && normalized?.arxivId && normalized?.explicitArxivId) {
    enqueuePdfCandidate(queue, seen, { url: `https://arxiv.org/pdf/${normalized.arxivId}.pdf` }, 'direct_pdf', {
      source: 'payload:arxiv_fallback',
      label: 'arXiv',
    });
    enqueuePdfCandidate(queue, seen, { url: `https://arxiv.org/abs/${normalized.arxivId}` }, 'landing_page', {
      source: 'payload:arxiv_abs',
      label: 'arXiv',
    });
  }

  return queue
    .sort((left, right) => pdfCandidatePriority(left) - pdfCandidatePriority(right))
    .slice(0, PDF_RESOLVER_MAX_CANDIDATES);
}

function abortPdfPrefetchControllers(taskRecord) {
  if (taskRecord?.abortController) {
    try {
      taskRecord.abortController.abort();
    } catch (error) {
    }
  }
  for (const controller of taskRecord?.abortControllers || []) {
    try {
      controller.abort();
    } catch (error) {
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostFromUrl(url) {
  try {
    return new URL(String(url || '').trim()).host.toLowerCase();
  } catch (error) {
    return '';
  }
}

function normalizePaperTitleForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\babstract reprint\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokenSet(value) {
  return new Set(normalizePaperTitleForMatch(value).split(' ').filter(Boolean));
}

function titleSimilarityScore(left, right) {
  const leftNormalized = normalizePaperTitleForMatch(left);
  const rightNormalized = normalizePaperTitleForMatch(right);
  if (!leftNormalized || !rightNormalized) {
    return 0;
  }
  if (leftNormalized === rightNormalized) {
    return 1;
  }
  if (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) {
    return 0.95;
  }
  const leftTokens = titleTokenSet(left);
  const rightTokens = titleTokenSet(right);
  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  const union = new Set([...leftTokens, ...rightTokens]).size || 1;
  return overlap / union;
}

function normalizeAuthorNames(authorLine) {
  return String(authorLine || '')
    .split(/[,;]| and /i)
    .map((item) => item.replace(/[^\p{L}\p{N}\s.-]+/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
}

function firstAuthorKey(authorLine) {
  return normalizeAuthorNames(authorLine)[0] || '';
}

function authorOverlapScore(left, right) {
  const leftAuthors = normalizeAuthorNames(left);
  const rightAuthors = normalizeAuthorNames(right);
  if (!leftAuthors.length || !rightAuthors.length) {
    return 0;
  }
  if (leftAuthors[0] && rightAuthors[0] && leftAuthors[0] === rightAuthors[0]) {
    return 1;
  }
  let overlap = 0;
  const rightSet = new Set(rightAuthors);
  for (const author of leftAuthors) {
    if (rightSet.has(author)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftAuthors.length, rightAuthors.length, 1);
}

function extractPublishYear(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : 0;
}

function isWeakPdfSourceHost(host) {
  return WEAK_PDF_SOURCE_HOSTS.has(String(host || '').trim().toLowerCase());
}

function isTrustedRepositoryHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return false;
  return (
    value === 'arxiv.org'
    || value.endsWith('ncbi.nlm.nih.gov')
    || value.endsWith('europepmc.org')
    || value.startsWith('ojs.')
    || value.includes('diva-portal')
    || value.includes('worktribe')
    || value.includes('repository')
    || value.includes('eprints')
    || value.includes('escholarship')
    || value.includes('zenodo')
    || value.includes('hal.science')
    || value.includes('ora.ox.ac.uk')
  );
}

function siblingCandidateTrustScore(candidate = {}, paper = {}) {
  const host = hostFromUrl(candidate.url || candidate.host || '');
  const sourceKind = String(paper?.source_kind || '').trim().toLowerCase();
  if (!host || isWeakPdfSourceHost(host)) {
    return -1000;
  }
  let score = 0;
  if (candidate.kind === 'direct_pdf') score += 60;
  if (candidate.kind === 'landing_page') score -= 20;
  if (candidate.kind === 'content_api') score -= 40;

  if (sourceKind === 'arxiv' || host === 'arxiv.org') {
    score += 320;
  } else if (['pmc', 'pubmed', 'preprint', 'europepmc'].includes(sourceKind) || host.endsWith('ncbi.nlm.nih.gov') || host.endsWith('europepmc.org')) {
    score += 260;
  } else if (host.startsWith('ojs.') || /\b(proceedings|conference|journal)\b/i.test(String(candidate.label || ''))) {
    score += 220;
  } else if (isTrustedRepositoryHost(host)) {
    score += 180;
  } else if (candidate.isOa === true) {
    score += 80;
  }

  if (BROWSER_ASSISTED_PDF_HOSTS.has(host)) score -= 40;
  if (RESTRICTED_DIRECT_PDF_HOSTS.has(host)) score -= 50;
  return score;
}

function buildSiblingPaperPdfCandidates(rawPaper = {}) {
  const paper = {
    ...rawPaper,
    pdf_candidates: normalizePdfCandidates(rawPaper?.pdf_candidates || [], 'landing_page'),
  };
  const seen = new Set();
  const candidates = [];
  const add = (rawCandidate, fallbackKind = 'direct_pdf', extra = {}) => {
    const candidate = normalizePdfCandidate({ ...(rawCandidate || {}), ...extra }, fallbackKind);
    if (!candidate?.url) return;
    const key = `${candidate.kind}:${candidate.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const candidate of paper.pdf_candidates || []) {
    add(candidate, candidate.kind || 'landing_page');
  }
  if (paper.pdf_url) {
    add({ url: paper.pdf_url, source: 'sibling:paper_pdf', label: paper.source_label || '' }, 'direct_pdf');
  }
  if (paper.openalex_oa_url) {
    add({ url: paper.openalex_oa_url, source: 'sibling:openalex_oa', label: 'Open access' }, looksLikePdfUrl(paper.openalex_oa_url) ? 'direct_pdf' : 'landing_page');
  }
  if (paper.openalex_content_url) {
    add({ url: paper.openalex_content_url, source: 'sibling:openalex_content', label: 'OpenAlex Content API' }, 'content_api');
  }
  if (paper.arxiv_id) {
    add({ url: `https://arxiv.org/pdf/${paper.arxiv_id}.pdf`, source: 'sibling:arxiv_pdf', label: 'arXiv' }, 'direct_pdf');
  }
  if (paper.external_url || paper.src_url) {
    add({ url: paper.external_url || paper.src_url, source: 'sibling:external', label: paper.source_label || '' }, 'landing_page');
  }

  return candidates
    .map((candidate) => ({ ...candidate, trustScore: siblingCandidateTrustScore(candidate, paper) }))
    .filter((candidate) => candidate.trustScore > -1000)
    .sort((left, right) => right.trustScore - left.trustScore || pdfCandidatePriority(left) - pdfCandidatePriority(right));
}

function dedupeSiblingSearchResults(items = []) {
  const seen = new Set();
  const result = [];
  for (const rawItem of items) {
    const paperKey = String(rawItem?.paper_key || '').trim();
    const externalUrl = String(rawItem?.external_url || rawItem?.src_url || '').trim();
    const title = normalizePaperTitleForMatch(rawItem?.title || '');
    const key = paperKey || externalUrl || title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(rawItem);
  }
  return result;
}

function buildSiblingSearchQueries(title) {
  const rawTitle = String(title || '').trim();
  if (!rawTitle) return [];

  const normalizedTitle = normalizePaperTitleForMatch(rawTitle);
  const prefixTitle = rawTitle.split(':')[0]?.trim() || '';
  const suffixTitle = rawTitle.includes(':') ? rawTitle.split(':').slice(1).join(':').trim() : '';

  const seen = new Set();
  const queries = [];
  const add = (value) => {
    const query = String(value || '').trim();
    if (!query) return;
    const key = query.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(query);
  };

  add(rawTitle);
  add(normalizedTitle);

  if (prefixTitle && prefixTitle.length >= 4) {
    add(prefixTitle);
  }
  if (suffixTitle && suffixTitle.length >= 16) {
    add(suffixTitle);
  }

  return queries;
}

async function collectSiblingSearchResults(normalized) {
  const queries = buildSiblingSearchQueries(normalized?.title);
  if (!queries.length) return [];

  const requestMap = new Map();
  const addRequest = (payload) => {
    const query = String(payload?.query || '').trim();
    const sourceScope = String(payload?.source_scope || '').trim().toLowerCase();
    if (!query || !sourceScope) return;
    const key = `${sourceScope}:${query.toLowerCase()}`;
    if (!requestMap.has(key)) {
      requestMap.set(key, payload);
    }
  };

  addRequest({ query: queries[0], limit: PDF_SIBLING_SEARCH_LIMIT, source_scope: 'mixed', mode: 'hybrid' });

  for (const query of queries) {
    addRequest({
      query,
      limit: Math.max(6, Math.floor(PDF_SIBLING_SEARCH_LIMIT / 2)),
      source_scope: 'arxiv',
      mode: 'hybrid',
    });
  }

  const settled = await Promise.allSettled(
    Array.from(requestMap.values()).map((payload) => callBridge('search', payload)),
  );

  const result = [];
  for (const item of settled) {
    if (item.status !== 'fulfilled') continue;
    if (Array.isArray(item.value?.results)) {
      result.push(...item.value.results);
    }
  }

  return dedupeSiblingSearchResults(result);
}

function buildSiblingMatchReason(titleScore, authorScore, yearDelta) {
  if (titleScore >= 0.999) {
    return 'title_exact';
  }
  if (titleScore >= 0.9 && authorScore >= 0.99) {
    return yearDelta <= 1 ? 'title_author_year' : 'title_author';
  }
  if (titleScore >= 0.9) {
    return 'title_close';
  }
  return 'title_fuzzy';
}

function scoreSiblingPaper(rawPaper, normalized) {
  const paper = rawPaper || {};
  const currentPaperKey = String(normalized?.paperKey || '').trim();
  const currentOpenalexId = String(normalized?.openalexId || '').trim();
  const paperKey = String(paper.paper_key || '').trim();
  const openalexId = String(paper.openalex_id || '').trim();

  if (paperKey && currentPaperKey && paperKey === currentPaperKey) {
    return null;
  }
  if (openalexId && currentOpenalexId && openalexId === currentOpenalexId) {
    return null;
  }

  const siblingCandidates = buildSiblingPaperPdfCandidates(paper);
  if (!siblingCandidates.length) {
    return null;
  }

  const titleScore = titleSimilarityScore(normalized?.title, paper.title);
  const authorScore = authorOverlapScore(normalized?.authorLine, paper.author_line);
  const currentYear = extractPublishYear(normalized?.publishAt);
  const paperYear = extractPublishYear(paper.publish_at);
  const yearDelta = currentYear && paperYear ? Math.abs(currentYear - paperYear) : 0;

  if (titleScore < 0.82) {
    return null;
  }
  if (titleScore < 0.9 && authorScore < 0.5) {
    return null;
  }
  if (currentYear && paperYear && yearDelta > 2 && titleScore < 0.95) {
    return null;
  }

  const bestCandidate = siblingCandidates[0];
  const overallScore = (titleScore * 1000) + (authorScore * 180) - (yearDelta * 20) + (bestCandidate?.trustScore || 0);

  return {
    paper,
    score: overallScore,
    titleScore,
    authorScore,
    yearDelta,
    matchReason: buildSiblingMatchReason(titleScore, authorScore, yearDelta),
    siblingCandidates,
    bestCandidate,
  };
}

function buildSiblingFallbackPayload(normalized, match) {
  const bestCandidate = match?.bestCandidate || {};
  return normalizePdfPayload({
    paper_key: normalized?.paperKey || '',
    favorite_key: normalized?.paperKey || '',
    title: normalized?.title || match?.paper?.title || '论文 PDF',
    author_line: normalized?.authorLine || match?.paper?.author_line || '',
    publish_at: normalized?.publishAt || match?.paper?.publish_at || '',
    doi: normalized?.doi || '',
    source_kind: normalized?.sourceKind || match?.paper?.source_kind || '',
    source_label: normalized?.sourceLabel || match?.paper?.source_label || '',
    external_url: match?.paper?.external_url || match?.paper?.src_url || bestCandidate?.url || normalized?.externalUrl || '',
    pdf_url: bestCandidate?.kind === 'direct_pdf' ? bestCandidate.url : '',
    pdf_candidates: match?.siblingCandidates || [],
    openalex_content_url: match?.paper?.openalex_content_url || '',
    openalex_oa_url: match?.paper?.openalex_oa_url || '',
    openalex_oa_status: match?.paper?.openalex_oa_status || '',
    openalex_is_oa: match?.paper?.openalex_is_oa === true,
    openalex_has_content_pdf: match?.paper?.openalex_has_content_pdf === true,
    disable_sibling_fallback: true,
    resolved_from_sibling: true,
    resolved_from_paper_key: match?.paper?.paper_key || '',
    resolved_source_kind: match?.paper?.source_kind || '',
    resolved_source_label: bestCandidate?.label || match?.paper?.source_label || '',
    resolved_match_reason: match?.matchReason || '',
    resolved_paper_title: match?.paper?.title || '',
  });
}

async function resolvePdfViaSiblingFallback({
  normalized,
  tempPath,
  taskRecord,
  initialStatus,
  emitIfCurrent,
  ensureCurrentTask,
}) {
  if (normalized?.disableSiblingFallback || normalized?.localPath) {
    return null;
  }
  if (!String(normalized?.title || '').trim()) {
    return null;
  }

  emitIfCurrent({
    ...initialStatus,
    state: 'checking',
    progress: 0,
    openTarget: normalized?.externalUrl || normalized?.target || '',
    message: '正在尝试开放兄弟版本…',
    reasonCode: normalized?.reasonCode || 'landing_page_only',
    ...resolvedPdfStatusFields(normalized),
  });

  const matches = (await collectSiblingSearchResults(normalized))
    .map((paper) => scoreSiblingPaper(paper, normalized))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, PDF_SIBLING_MAX_ATTEMPTS);

  const failures = [];
  for (const match of matches) {
    ensureCurrentTask();
    const siblingPayload = buildSiblingFallbackPayload(normalized, match);
    emitIfCurrent({
      ...initialStatus,
      state: 'checking',
      progress: 0,
      openTarget: match?.bestCandidate?.url || siblingPayload.externalUrl || normalized?.externalUrl || '',
      message: `已找到开放兄弟版本，正在尝试 ${siblingPayload.resolvedSourceLabel || siblingPayload.resolvedSourceKind || '开放来源'}…`,
      reasonCode: 'ready_remote',
      ...resolvedPdfStatusFields(siblingPayload),
    });

    const siblingResult = await resolvePdfCandidatesInParallel({
      normalized: siblingPayload,
      tempPath,
      taskRecord,
      initialStatus: {
        ...initialStatus,
        ...resolvedPdfStatusFields(siblingPayload),
      },
      emitIfCurrent,
      ensureCurrentTask,
    });
    if (siblingResult?.winner) {
      return {
        winner: {
          ...siblingResult.winner,
          ...resolvedPdfStatusFields(siblingPayload),
        },
      };
    }
    failures.push(...(siblingResult?.failures || []));
  }

  return { failures };
}

function shouldAttemptBrowserResolution(candidate, classification = null) {
  const url = String(candidate?.url || '').trim();
  const host = hostFromUrl(url);
  if (!url || !isRemoteHttpUrl(url)) {
    return false;
  }
  if (candidate?.kind === 'content_api') {
    return false;
  }
  if (classification?.reasonCode === 'source_restricted') {
    return BROWSER_ASSISTED_PDF_HOSTS.has(host) || candidate?.kind === 'landing_page';
  }
  if (classification?.needsBrowserVerification === true) {
    return true;
  }
  if (candidate?.kind === 'landing_page' && BROWSER_ASSISTED_PDF_HOSTS.has(host)) {
    return true;
  }
  return false;
}

function browserResolverUserAgent() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow.webContents.getUserAgent();
  }
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
}

async function sessionFetchWithFallback(ses, url, options = {}) {
  if (ses && typeof ses.fetch === 'function') {
    return ses.fetch(url, options);
  }
  return fetch(url, options);
}

function getAppNetworkSession() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow.webContents.session || null;
    }
  } catch (error) {
  }
  try {
    return session.defaultSession || null;
  } catch (error) {
  }
  return null;
}

const { fetchWithAppSession, postResponsesRequest } = createAiNetworkHelpers({
  getSession: getAppNetworkSession,
  fallbackFetch: (...args) => fetch(...args),
  normalizeBaseUrl,
  formatAiConnectivityError,
});

async function waitForBrowserResolutionSettled(webContents, timeoutMs = PDF_BROWSER_RESOLUTION_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastActivityAt = Date.now();

  const markActivity = () => {
    lastActivityAt = Date.now();
  };

  webContents.on('did-start-loading', markActivity);
  webContents.on('did-stop-loading', markActivity);
  webContents.on('did-navigate', markActivity);
  webContents.on('did-redirect-navigation', markActivity);
  webContents.on('dom-ready', markActivity);

  try {
    while ((Date.now() - startedAt) < timeoutMs) {
      if (!webContents.isLoading() && (Date.now() - lastActivityAt) >= 900) {
        return;
      }
      await delay(250);
    }
  } finally {
    webContents.removeListener('did-start-loading', markActivity);
    webContents.removeListener('did-stop-loading', markActivity);
    webContents.removeListener('did-navigate', markActivity);
    webContents.removeListener('did-redirect-navigation', markActivity);
    webContents.removeListener('dom-ready', markActivity);
  }
}

async function extractPdfCandidatesFromDom(webContents) {
  return webContents.executeJavaScript(`
    (() => {
      const currentUrl = String(location.href || '');
      const seen = new Set();
      const candidates = [];
      const push = (rawUrl, kind = 'direct_pdf', source = 'browser:dom') => {
        const value = String(rawUrl || '').trim();
        if (!value) return;
        let absoluteUrl = '';
        try {
          absoluteUrl = new URL(value, currentUrl).toString();
        } catch (error) {
          return;
        }
        const key = kind + ':' + absoluteUrl;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ url: absoluteUrl, kind, source });
      };

      const metaSelectors = [
        'meta[name="citation_pdf_url"]',
        'meta[property="citation_pdf_url"]',
        'meta[name="pdf_url"]',
        'meta[property="pdf_url"]',
        'meta[name="wkhealth_pdf_url"]',
        'link[rel="alternate"][type="application/pdf"]',
      ];
      for (const selector of metaSelectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          push(node.content || node.href || '', 'direct_pdf', 'browser:meta');
        }
      }

      const linkNodes = Array.from(document.querySelectorAll('a[href], iframe[src], embed[src], object[data], link[href]'));
      for (const node of linkNodes) {
        const rawUrl = node.getAttribute('href') || node.getAttribute('src') || node.getAttribute('data') || '';
        const text = String(node.textContent || node.getAttribute('title') || node.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const url = String(rawUrl || '').trim().toLowerCase();
        if (!rawUrl) continue;
        const pdfLike = url.includes('.pdf') || url.includes('/pdf/') || url.includes('/pdfdirect/') || url.includes('/epdf/') || url.includes('/download/') || url.includes('downloadpdf');
        const textLike = /\\b(pdf|download|full text|view pdf)\\b/.test(text);
        if (pdfLike || textLike) {
          push(rawUrl, 'direct_pdf', 'browser:anchor');
        }
      }

      if (/\\.pdf(?:$|[?#])|\\/pdf\\/|\\/pdfdirect\\/|\\/epdf\\//i.test(currentUrl)) {
        push(currentUrl, 'direct_pdf', 'browser:location');
      } else {
        push(currentUrl, 'landing_page', 'browser:location');
      }

      const scriptTexts = Array.from(document.scripts || [])
        .slice(0, 60)
        .map((node) => String(node.textContent || '').slice(0, 20000))
        .join('\\n');
      const patterns = [
        /"(?:citation_pdf_url|pdf_url|pdfUrl|downloadPdfUrl|download_url)"\\s*:\\s*"([^"]+)"/gi,
        /'(?:citation_pdf_url|pdf_url|pdfUrl|downloadPdfUrl|download_url)'\\s*:\\s*'([^']+)'/gi,
      ];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(scriptTexts)) !== null) {
          push(match[1], 'direct_pdf', 'browser:script');
        }
      }

      return {
        url: currentUrl,
        title: String(document.title || '').trim(),
        contentType: String(document.contentType || '').trim(),
        candidates,
      };
    })();
  `, true);
}

async function tryBrowserResolvedPdfCandidates({
  browserWindow,
  normalized,
  discoveredCandidates,
  tempPath,
  candidate,
  initialStatus,
  emitIfCurrent,
  ensureCurrentTask,
}) {
  const ses = browserWindow.webContents.session;
  for (const rawDiscoveredCandidate of discoveredCandidates || []) {
    ensureCurrentTask();
    const discoveredCandidate = normalizePdfCandidate(rawDiscoveredCandidate, rawDiscoveredCandidate?.kind || 'direct_pdf');
    if (!discoveredCandidate?.url || discoveredCandidate.kind !== 'direct_pdf') {
      continue;
    }
    emitIfCurrent({
      ...initialStatus,
      state: 'downloading',
      progress: 0,
      openTarget: discoveredCandidate.url,
      message: '已发现真实 PDF，正在缓存…',
      reasonCode: 'ready_remote',
    });
    const response = await sessionFetchWithFallback(ses, discoveredCandidate.url, {
      redirect: 'follow',
      headers: pdfFetchHeaders(discoveredCandidate),
    });
    if (!response.ok) {
      continue;
    }
    const reader = response.body?.getReader ? response.body.getReader() : null;
    let firstChunk = Buffer.alloc(0);
    let bodyBuffer = null;
    if (reader) {
      const first = await reader.read();
      ensureCurrentTask();
      if (!first.done) {
        firstChunk = Buffer.from(first.value);
      }
    } else {
      bodyBuffer = Buffer.from(await response.arrayBuffer());
      ensureCurrentTask();
      firstChunk = bodyBuffer.subarray(0, Math.min(bodyBuffer.length, 1024));
    }
    if (!validatePdfSignature(firstChunk, response, normalized)) {
      continue;
    }
    const streamed = await streamPdfToTempPath({
      tempPath,
      response,
      reader,
      firstChunk,
      bodyBuffer,
      initialStatus,
      candidate: discoveredCandidate,
      emitIfCurrent,
      ensureCurrentTask,
    });
    return {
      status: 'success',
      tempPath,
      sourceUrl: String(response.url || discoveredCandidate.url || '').trim(),
      ...streamed,
    };
  }
  return null;
}

async function resolvePdfViaBrowserSession({
  normalized,
  candidate,
  tempPath,
  initialStatus,
  emitIfCurrent,
  ensureCurrentTask,
}) {
  const browserWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 920,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: `persist:ohmypaper-pdf-resolver`,
    },
  });

  try {
    browserWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url && /^https?:\/\//i.test(url)) {
        browserWindow.loadURL(url).catch(() => {});
      }
      return { action: 'deny' };
    });
    browserWindow.webContents.setUserAgent(browserResolverUserAgent());

    emitIfCurrent({
      ...initialStatus,
      state: 'checking',
      progress: 0,
      openTarget: candidate?.url || normalized?.target,
      message: '正在浏览器验证…',
      reasonCode: 'needs_browser_resolution',
    });

    await browserWindow.loadURL(candidate.url, { userAgent: browserResolverUserAgent() });
    await waitForBrowserResolutionSettled(browserWindow.webContents, PDF_BROWSER_RESOLUTION_TIMEOUT_MS);
    ensureCurrentTask();

    const discoveredCandidates = [];
    const seen = new Set();
    const pushDiscovered = (rawCandidate) => {
      const normalizedCandidate = normalizePdfCandidate(rawCandidate, rawCandidate?.kind || 'landing_page');
      if (!normalizedCandidate?.url) return;
      const key = `${normalizedCandidate.kind}:${normalizedCandidate.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      discoveredCandidates.push(normalizedCandidate);
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      ensureCurrentTask();
      const domResult = await extractPdfCandidatesFromDom(browserWindow.webContents).catch(() => null);
      if (domResult?.url) {
        pushDiscovered({
          url: domResult.url,
          kind: looksLikePdfUrl(domResult.url) ? 'direct_pdf' : 'landing_page',
          source: 'browser:location',
        });
      }
      for (const rawCandidate of domResult?.candidates || []) {
        pushDiscovered(rawCandidate);
      }

      const directCandidates = discoveredCandidates.filter((item) => item.kind === 'direct_pdf');
      if (directCandidates.length) {
        const resolved = await tryBrowserResolvedPdfCandidates({
          browserWindow,
          normalized,
          discoveredCandidates: directCandidates,
          tempPath,
          candidate,
          initialStatus,
          emitIfCurrent,
          ensureCurrentTask,
        });
        if (resolved) {
          return resolved;
        }
      }

      if (attempt < 3) {
        await delay(PDF_BROWSER_RESOLUTION_POLL_MS);
      }
    }

    return {
      status: 'continue',
      failure: {
        reasonCode: 'browser_verified_no_pdf',
        url: candidate?.url || '',
        message: '浏览器验证后未发现可下载 PDF',
      },
      discoveredCandidates: discoveredCandidates.filter((item) => item.kind !== 'direct_pdf'),
    };
  } finally {
    if (!browserWindow.isDestroyed()) {
      browserWindow.destroy();
    }
  }
}

async function readResponseBodyPreview(reader, firstChunk, byteLimit = PDF_HTML_PREVIEW_LIMIT_BYTES) {
  const chunks = [];
  let total = 0;
  const pushChunk = (chunk) => {
    if (!chunk?.length || total >= byteLimit) return;
    const remaining = byteLimit - total;
    const sliced = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(sliced);
    total += sliced.length;
  };
  pushChunk(Buffer.isBuffer(firstChunk) ? firstChunk : Buffer.from(firstChunk || []));
  if (!reader) {
    return Buffer.concat(chunks, total);
  }
  while (total < byteLimit) {
    const { done, value } = await reader.read();
    if (done) break;
    pushChunk(Buffer.from(value));
  }
  try {
    await reader.cancel();
  } catch (error) {
  }
  return Buffer.concat(chunks, total);
}

function extractPdfCandidatesFromHtml(htmlText, baseUrl, depth = 0) {
  const html = String(htmlText || '');
  if (!html.trim()) return [];
  const seen = new Set();
  const result = [];

  const push = (url, kind, source) => {
    const resolved = resolveCandidateUrl(url, baseUrl);
    if (!resolved) return;
    const key = `${kind}:${resolved}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      url: resolved,
      kind,
      source,
      label: 'Landing page',
      depth,
    });
  };

  const metaPatterns = [
    /<meta[^>]+(?:name|property)=["']citation_pdf_url["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']citation_pdf_url["'][^>]*>/gi,
    /<meta[^>]+(?:name|property)=["']wkhealth_pdf_url["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+(?:name|property)=["']dc\.identifier["'][^>]+content=["']([^"']+pdf[^"']*)["'][^>]*>/gi,
    /<meta[^>]+(?:name|property)=["']pdf_url["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
  ];

  for (const pattern of metaPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      push(match[1], 'direct_pdf', 'html:meta');
    }
  }

  const jsonPatterns = [
    /"(?:citation_pdf_url|pdf_url|pdfUrl|downloadPdfUrl|download_url)"\s*:\s*"([^"]+)"/gi,
    /'(?:citation_pdf_url|pdf_url|pdfUrl|downloadPdfUrl|download_url)'\s*:\s*'([^']+)'/gi,
  ];
  for (const pattern of jsonPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      push(match[1], 'direct_pdf', 'html:json');
    }
  }

  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,240}?)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkPattern.exec(html)) !== null) {
    const href = linkMatch[1];
    const label = decodeHtmlEntitiesLite(linkMatch[2]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (looksLikePdfUrl(href) || /\b(pdf|download)\b/.test(label)) {
      push(href, 'direct_pdf', 'html:anchor');
    }
  }

  const hrefPattern = /\b(?:href|src|data-pdf-url|data-pdf|data-url)=["']([^"']+)["']/gi;
  let hrefMatch;
  while ((hrefMatch = hrefPattern.exec(html)) !== null) {
    const href = hrefMatch[1];
    if (looksLikePdfUrl(href)) {
      push(href, 'direct_pdf', 'html:href');
    }
  }

  return result.slice(0, PDF_RESOLVER_MAX_CANDIDATES);
}

function summarizePdfResolutionFailure(failures, normalized) {
  const reasons = new Set((failures || []).map((item) => String(item?.reasonCode || '').trim()).filter(Boolean));
  if (reasons.has('source_timeout')) {
    return { message: 'PDF 缓存超时', reasonCode: 'source_timeout' };
  }
  if (reasons.has('browser_verified_no_pdf')) {
    return { message: '浏览器验证后未发现可下载 PDF', reasonCode: 'browser_verified_no_pdf' };
  }
  if (reasons.has('source_paywalled')) {
    return { message: '源站存在权限限制', reasonCode: 'source_paywalled' };
  }
  if (reasons.has('landing_page_only') && reasons.has('source_restricted')) {
    return { message: '源站限制 PDF 直连，且落地页未发现可用 PDF', reasonCode: 'landing_page_only' };
  }
  if (reasons.has('landing_page_only')) {
    return { message: '源站仅提供论文落地页，未发现可用 PDF', reasonCode: 'landing_page_only' };
  }
  if (reasons.has('source_restricted')) {
    return { message: '源站限制 PDF 直连', reasonCode: 'source_restricted' };
  }
  if (reasons.has('no_open_access_pdf')) {
    return { message: '源站未提供可用 PDF', reasonCode: 'no_open_access_pdf' };
  }
  if (reasons.has('cache_failed')) {
    return { message: '返回内容不是 PDF 文件', reasonCode: 'cache_failed' };
  }
  return {
    message: defaultPdfReasonMessage(normalized) || 'PDF 缓存失败',
    reasonCode: normalized?.reasonCode || 'cache_failed',
  };
}

function toPdfPrefetchUserMessage(error) {
  const message = String(error?.message || error || '').trim();
  if (/正在浏览器验证/.test(message)) {
    return '正在浏览器验证…';
  }
  if (/浏览器验证后未发现可下载 PDF/.test(message)) {
    return '浏览器验证后未发现可下载 PDF';
  }
  if (/源站存在权限限制/.test(message)) {
    return '源站存在权限限制';
  }
  if (/限制 PDF 直连/.test(message)) {
    return '源站限制 PDF 直连';
  }
  if (/仅提供论文落地页/.test(message)) {
    return '源站仅提供论文落地页';
  }
  if (/不是 PDF 文件/.test(message)) {
    return '返回内容不是 PDF 文件';
  }
  if (/403/.test(message)) {
    return '源站限制 PDF 直连';
  }
  if (/404/.test(message)) {
    return '源站未提供可用 PDF';
  }
  if (/源站未提供可用 PDF/.test(message)) {
    return '源站未提供可用 PDF';
  }
  if (/落地页未发现可用 PDF/.test(message)) {
    return '源站仅提供论文落地页，未发现可用 PDF';
  }
  if (/缺少有效的 PMCID|PMC 当前未提供可下载|PMC OA 包中未找到 PDF/i.test(message)) {
    return '该记录暂无可缓存 PMC PDF';
  }
  if (/不是有效 PDF|不是有效 pdf|返回内容不是有效 PDF|缓存后的 PDF 文件无效/i.test(message)) {
    return '返回内容不是 PDF 文件';
  }
  if (/timed out|timeout/i.test(message)) {
    return 'PDF 缓存超时';
  }
  if (/open access|开放获取|PMCID|PMC/.test(message)) {
    return 'PMC 当前未提供可缓存 PDF';
  }
  return 'PDF 缓存失败';
}

async function cachePmcPdfViaBridge(normalized, tempPath) {
  if (!normalized?.pmcid || !tempPath) {
    throw new Error('缺少 PMCID 缓存参数');
  }
  const result = await callBridge('cache-pmc-pdf', {
    pmcid: normalized.pmcid,
    cache_path: tempPath,
  });
  return {
    cachedPath: String(result?.cached_path || tempPath).trim() || tempPath,
    sourceUrl: String(result?.source_url || normalized.sourceUrl || '').trim(),
  };
}

function clampPdfProgress(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(0.99, numeric));
}

function pdfFetchHeaders(candidate) {
  if (candidate?.kind === 'landing_page') {
    return {
      'User-Agent': `OhMyPaper/${app.getVersion()}`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7',
    };
  }
  return {
    'User-Agent': `OhMyPaper/${app.getVersion()}`,
    'Accept': 'application/pdf,application/octet-stream;q=0.9,text/html;q=0.6,*/*;q=0.5',
  };
}

async function streamPdfToTempPath({ tempPath, response, reader, firstChunk, bodyBuffer, initialStatus, candidate, emitIfCurrent, ensureCurrentTask }) {
  const totalBytes = Number(response.headers.get('content-length') || 0);
  let receivedBytes = 0;
  let fileHandle = null;
  try {
    fileHandle = await fsp.open(tempPath, 'w');
    if (bodyBuffer?.length) {
      await fileHandle.write(bodyBuffer);
      receivedBytes = bodyBuffer.length;
    } else {
      const first = Buffer.isBuffer(firstChunk) ? firstChunk : Buffer.from(firstChunk || []);
      if (first.length) {
        receivedBytes += first.length;
        await fileHandle.write(first);
      }
      while (reader) {
        const { done, value } = await reader.read();
        ensureCurrentTask();
        if (done) break;
        const chunk = Buffer.from(value);
        receivedBytes += chunk.length;
        await fileHandle.write(chunk);
        const progress = totalBytes > 0 ? clampPdfProgress(receivedBytes / totalBytes) : 0;
        emitIfCurrent({
          ...initialStatus,
          state: 'downloading',
          progress,
          openTarget: candidate?.url || initialStatus.openTarget,
          message: totalBytes > 0 ? `正在准备 PDF… ${Math.round(progress * 100)}%` : '正在准备 PDF…',
        });
      }
    }
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
  }
  return {
    totalBytes: totalBytes || receivedBytes,
    receivedBytes,
  };
}

async function resolvePdfCandidateToCache({ normalized, candidate, tempPath, taskRecord, initialStatus, emitIfCurrent, ensureCurrentTask }) {
  const controller = new AbortController();
  if (!taskRecord.abortControllers) {
    taskRecord.abortControllers = new Set();
  }
  taskRecord.abortController = controller;
  taskRecord.abortControllers.add(controller);
  const timeoutMs = candidate?.kind === 'landing_page' ? PDF_LANDING_FETCH_TIMEOUT_MS : PDF_FETCH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let succeeded = false;
  try {
    emitIfCurrent({
      ...initialStatus,
      state: candidate?.kind === 'landing_page' ? 'checking' : 'downloading',
      progress: 0,
      openTarget: candidate?.url || normalized?.target,
      message: candidate?.kind === 'landing_page' ? '正在解析源站页面…' : '正在准备 PDF…',
    });

    const response = await fetch(candidate.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: pdfFetchHeaders(candidate),
    });
    clearTimeout(timer);
    ensureCurrentTask();

    if (!response.ok) {
      const reasonCode = response.status === 401 || response.status === 403
        ? 'source_restricted'
        : response.status === 404
          ? 'no_open_access_pdf'
          : 'cache_failed';
      const failedClassification = {
        reasonCode,
        finalUrl: String(response.url || candidate.url || '').trim(),
        needsBrowserVerification: reasonCode === 'source_restricted' && shouldAttemptBrowserResolution(candidate, { reasonCode }),
      };
      if (shouldAttemptBrowserResolution(candidate, failedClassification)) {
        const browserResolved = await resolvePdfViaBrowserSession({
          normalized,
          candidate: {
            ...candidate,
            url: String(normalized.externalUrl || candidate.url || '').trim() || candidate.url,
          },
          tempPath,
          initialStatus,
          emitIfCurrent,
          ensureCurrentTask,
        });
        if (browserResolved?.status === 'success') {
          succeeded = true;
          return browserResolved;
        }
        return browserResolved || {
          status: 'continue',
          failure: {
            reasonCode,
            url: candidate.url,
            status: response.status,
          },
          discoveredCandidates: [],
        };
      }
      return {
        status: 'continue',
        failure: {
          reasonCode,
          url: candidate.url,
          status: response.status,
        },
        discoveredCandidates: [],
      };
    }

    const reader = response.body?.getReader ? response.body.getReader() : null;
    let firstChunk = Buffer.alloc(0);
    let bodyBuffer = null;

    if (reader) {
      const first = await reader.read();
      ensureCurrentTask();
      if (!first.done) {
        firstChunk = Buffer.from(first.value);
      }
    } else {
      bodyBuffer = Buffer.from(await response.arrayBuffer());
      ensureCurrentTask();
      firstChunk = bodyBuffer.subarray(0, Math.min(bodyBuffer.length, 1024));
    }

    if (validatePdfSignature(firstChunk, response, normalized)) {
      const streamed = await streamPdfToTempPath({
        tempPath,
        response,
        reader,
        firstChunk,
        bodyBuffer,
        initialStatus,
        candidate,
        emitIfCurrent,
        ensureCurrentTask,
      });
      succeeded = true;
      return {
        status: 'success',
        tempPath,
        sourceUrl: String(response.url || candidate.url || '').trim(),
        ...streamed,
      };
    }

    const previewBuffer = bodyBuffer || await readResponseBodyPreview(reader, firstChunk, PDF_HTML_PREVIEW_LIMIT_BYTES);
    const classification = classifyInvalidPdfResponse(previewBuffer, response, normalized, candidate);
    const discoveredCandidates = [];
    if (classification.canParseLandingPage && (candidate.depth || 0) < 2) {
      discoveredCandidates.push(...extractPdfCandidatesFromHtml(
        previewBuffer.toString('utf8'),
        classification.finalUrl || response.url || candidate.url,
        (candidate.depth || 0) + 1,
      ));
    }

    if (shouldAttemptBrowserResolution(candidate, classification) || (!discoveredCandidates.length && candidate?.kind === 'landing_page')) {
      const browserResolved = await resolvePdfViaBrowserSession({
        normalized,
        candidate: {
          ...candidate,
          url: String(classification.finalUrl || normalized.externalUrl || candidate.url || '').trim() || candidate.url,
        },
        tempPath,
        initialStatus,
        emitIfCurrent,
        ensureCurrentTask,
      });
      if (browserResolved?.status === 'success') {
        succeeded = true;
        return browserResolved;
      }
      if (browserResolved?.discoveredCandidates?.length) {
        discoveredCandidates.push(...browserResolved.discoveredCandidates);
      }
      if (browserResolved?.failure) {
        return {
          status: 'continue',
          failure: browserResolved.failure,
          discoveredCandidates,
        };
      }
    }

    return {
      status: 'continue',
      failure: {
        reasonCode: classification.reasonCode,
        url: classification.finalUrl || candidate.url,
        message: classification.message,
      },
      discoveredCandidates,
    };
  } catch (error) {
    if (String(error?.message || '') === '__PDF_PREFETCH_REPLACED__') {
      throw error;
    }
    return {
      status: 'continue',
      failure: {
        reasonCode: String(error?.name || '') === 'AbortError' ? 'source_timeout' : 'cache_failed',
        url: candidate?.url || '',
        message: String(error?.name || '') === 'AbortError'
          ? 'PDF 缓存超时'
          : String(error?.message || error || 'PDF 缓存失败').trim(),
      },
      discoveredCandidates: [],
    };
  } finally {
    clearTimeout(timer);
    taskRecord.abortControllers?.delete(controller);
    if (!succeeded) {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

async function resolvePdfCandidatesInParallel({ normalized, tempPath, taskRecord, initialStatus, emitIfCurrent, ensureCurrentTask }) {
  const queue = buildPdfResolverCandidates(normalized);
  const queueSeen = new Set(queue.map((candidate) => `${candidate.kind}:${candidate.url}`));
  const failures = [];
  const active = new Map();
  let winner = null;
  let attemptId = 0;

  const launchNext = () => {
    while (!winner && active.size < PDF_RESOLVER_PARALLELISM && queue.length) {
      const candidate = queue.shift();
      const currentAttemptId = ++attemptId;
      const attemptTempPath = `${tempPath}.${currentAttemptId}`;
      const promise = resolvePdfCandidateToCache({
        normalized,
        candidate,
        tempPath: attemptTempPath,
        taskRecord,
        initialStatus,
        emitIfCurrent,
        ensureCurrentTask,
      }).then((result) => ({
        attemptId: currentAttemptId,
        candidate,
        ...result,
      }));
      active.set(currentAttemptId, promise);
    }
  };

  launchNext();

  while (!winner && active.size) {
    ensureCurrentTask();
    const settled = await Promise.race(active.values());
    active.delete(settled.attemptId);

    if (settled.status === 'success') {
      winner = settled;
      break;
    }

    if (settled.failure) {
      failures.push(settled.failure);
    }

    for (const discoveredCandidate of settled.discoveredCandidates || []) {
      enqueuePdfCandidate(
        queue,
        queueSeen,
        discoveredCandidate,
        discoveredCandidate.kind || 'direct_pdf',
        { depth: discoveredCandidate.depth || ((settled.candidate?.depth || 0) + 1) },
        { front: discoveredCandidate.kind === 'direct_pdf' },
      );
    }

    launchNext();
  }

  if (winner) {
    abortPdfPrefetchControllers(taskRecord);
    const remaining = await Promise.allSettled(active.values());
    for (const entry of remaining) {
      if (entry.status !== 'fulfilled') continue;
      const result = entry.value;
      if (result?.status === 'success' && result.tempPath && result.tempPath !== winner.tempPath) {
        await fsp.rm(result.tempPath, { force: true }).catch(() => {});
      }
    }
  } else if (active.size) {
    await Promise.allSettled(active.values());
  }

  return { winner, failures };
}

async function startPdfPrefetch(normalized) {
  const signature = pdfPrefetchTaskSignature(normalized);
  const existing = pdfPrefetchTasks.get(normalized.paperKey);
  if (existing?.signature === signature) {
    return clonePdfStatus(pdfPrefetchStatuses.get(normalized.paperKey) || null);
  }
  abortPdfPrefetchControllers(existing);

  const taskToken = sha1(`${normalized.paperKey}|${signature}|${Date.now()}|${Math.random()}`);
  const taskRecord = {
    signature,
    token: taskToken,
    abortController: null,
    abortControllers: new Set(),
    promise: null,
  };
  pdfPrefetchTasks.set(normalized.paperKey, taskRecord);

  const isCurrentTask = () => pdfPrefetchTasks.get(normalized.paperKey)?.token === taskToken;
  const ensureCurrentTask = () => {
    if (!isCurrentTask()) {
      throw new Error('__PDF_PREFETCH_REPLACED__');
    }
  };
  const emitIfCurrent = (status) => {
    if (!isCurrentTask()) {
      return clonePdfStatus(status);
    }
    return emitPdfPrefetchStatus(status);
  };

  const initialStatus = emitIfCurrent(createPdfPrefetchStatus(normalized, {
    state: 'downloading',
    progress: 0,
    openTarget: normalized.sourceUrl || normalized.externalUrl || normalized.target,
    message: isPmcOaCandidate(normalized) ? '正在准备 PDF…可稍后打开' : '正在准备 PDF…',
    reasonCode: normalized.reasonCode || (isPmcOaCandidate(normalized) ? 'needs_pmc_resolution' : 'ready_remote'),
  }));

  taskRecord.promise = (async () => {
    const tempPath = `${normalized.cachePath}.${taskToken}.download`;
    let winningTempPath = '';
    try {
      await fsp.mkdir(path.dirname(normalized.cachePath), { recursive: true });
      ensureCurrentTask();

      if (isPmcOaCandidate(normalized)) {
        const pmcResult = await cachePmcPdfViaBridge(normalized, tempPath);
        ensureCurrentTask();
        emitIfCurrent({
          ...initialStatus,
          state: 'verifying',
          progress: 0.99,
          sourceUrl: pmcResult.sourceUrl || normalized.sourceUrl,
          cachedPath: '',
          openTarget: normalized.target,
          message: '正在准备 PDF…可稍后打开',
          isCached: false,
          reasonCode: 'needs_pmc_resolution',
        });
        await fsp.rename(pmcResult.cachedPath, normalized.cachePath);
        ensureCurrentTask();
        const valid = await validatePdfFilePath(normalized.cachePath);
        if (!valid) {
          await fsp.rm(normalized.cachePath, { force: true }).catch(() => {});
          throw new Error('缓存后的 PDF 文件无效');
        }
        emitIfCurrent({
          ...initialStatus,
          state: 'ready',
          progress: 1,
          sourceUrl: pmcResult.sourceUrl || normalized.sourceUrl,
          cachedPath: normalized.cachePath,
          openTarget: normalized.cachePath,
          message: 'PDF 已缓存，下次打开更快',
          isCached: true,
          reasonCode: 'ready_remote',
        });
        return;
      }

      const primaryResolution = await resolvePdfCandidatesInParallel({
        normalized,
        tempPath,
        taskRecord,
        initialStatus,
        emitIfCurrent,
        ensureCurrentTask,
      });
      let winner = primaryResolution?.winner || null;
      let failures = [...(primaryResolution?.failures || [])];

      if (!winner) {
        const siblingResolution = await resolvePdfViaSiblingFallback({
          normalized,
          tempPath,
          taskRecord,
          initialStatus,
          emitIfCurrent,
          ensureCurrentTask,
        });
        if (siblingResolution?.winner) {
          winner = siblingResolution.winner;
        } else if (siblingResolution?.failures?.length) {
          failures = failures.concat(siblingResolution.failures);
        }
      }

      if (!winner) {
        const summary = summarizePdfResolutionFailure(failures, normalized);
        throw new Error(summary.message || 'PDF 缓存失败');
      }
      winningTempPath = winner.tempPath || '';
      let resolvedSourceUrl = winner.sourceUrl || normalized.sourceUrl || normalized.externalUrl || '';
      const resolvedStatus = resolvedPdfStatusFields(winner);

      ensureCurrentTask();
      emitIfCurrent({
        ...initialStatus,
        state: 'verifying',
        progress: 0.99,
        sourceUrl: resolvedSourceUrl,
        cachedPath: '',
        openTarget: normalized.target,
        message: '正在校验 PDF…',
        isCached: false,
        ...resolvedStatus,
      });

      await fsp.rename(winner.tempPath, normalized.cachePath);
      ensureCurrentTask();
      const valid = await validatePdfFilePath(normalized.cachePath);
      if (!valid) {
        await fsp.rm(normalized.cachePath, { force: true }).catch(() => {});
        throw new Error('缓存后的 PDF 文件无效');
      }

      emitIfCurrent({
        ...initialStatus,
        state: 'ready',
        progress: 1,
        sourceUrl: resolvedSourceUrl,
        cachedPath: normalized.cachePath,
        openTarget: normalized.cachePath,
        message: formatResolvedPdfReadyMessage('PDF 已缓存，下次打开更快', winner),
        isCached: true,
        reasonCode: 'ready_remote',
        totalBytes: winner.totalBytes,
        receivedBytes: winner.receivedBytes,
        ...resolvedStatus,
      });
    } catch (error) {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      if (winningTempPath) {
        await fsp.rm(winningTempPath, { force: true }).catch(() => {});
      }
      if (String(error?.message || '') === '__PDF_PREFETCH_REPLACED__') {
        return;
      }
      emitIfCurrent({
        ...initialStatus,
        state: 'error',
        progress: 0,
        openTarget: normalized.sourceUrl || normalized.externalUrl || normalized.target,
        message: String(error?.name || '') === 'AbortError' ? 'PDF 缓存超时' : toPdfPrefetchUserMessage(error),
        error: String(error?.message || error || 'PDF 缓存失败').trim(),
        reasonCode: String(error?.name || '') === 'AbortError' ? 'source_timeout' : 'cache_failed',
        isCached: false,
      });
    } finally {
      abortPdfPrefetchControllers(taskRecord);
      if (isCurrentTask()) {
        pdfPrefetchTasks.delete(normalized.paperKey);
      }
    }
  })();

  return initialStatus;
}

async function prefetchPdf(payload = {}) {
  const normalized = normalizePdfPayload(payload);
  if (!normalized.paperKey || (!normalized.target && !normalized.externalUrl && !normalized.sourceUrl && !normalized.localPath && !normalized.pmcid && !(normalized.pdfCandidates || []).length)) {
    return createPdfPrefetchStatus(normalized, {
      state: 'missing',
      openTarget: '',
      message: defaultPdfReasonMessage(normalized),
    });
  }

  const cachedStatus = await getCachedPdfStatus(normalized);
  if (cachedStatus?.state === 'ready') {
    return cachedStatus;
  }

  if (normalized.localPath || normalized.sourceUrl || normalized.externalUrl || normalized.pmcid || (normalized.pdfCandidates || []).length) {
    return startPdfPrefetch(normalized);
  }

  return emitPdfPrefetchStatus(createPdfPrefetchStatus(normalized, {
    state: 'missing',
    openTarget: normalized.localPath || normalized.target,
    message: defaultPdfReasonMessage(normalized),
  }));
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

async function ensurePdfReadyForRead(normalized) {
  const cachedStatus = await getCachedPdfStatus(normalized);
  if (cachedStatus?.state === 'ready' && cachedStatus.openTarget && !isRemoteHttpUrl(cachedStatus.openTarget)) {
    return cachedStatus;
  }
  return cachedStatus;
}

async function loadPdfDocument(payload = {}) {
  const normalized = normalizePdfPayload(payload);
  if (!normalized.paperKey || !normalized.target) {
    throw new Error('未找到可用 PDF');
  }

  const readyStatus = await ensurePdfReadyForRead(normalized);
  const openTarget = String(readyStatus?.cachedPath || readyStatus?.openTarget || normalized.localPath || '').trim();

  if (!openTarget) {
    if (readyStatus?.state === 'error') {
      throw new Error(readyStatus.message || readyStatus.error || '当前论文暂未提供可打开的 PDF');
    }
    if (readyStatus?.state === 'missing') {
      throw new Error(readyStatus.message || '当前论文暂未提供可打开的 PDF');
    }
    throw new Error('PDF 尚未缓存完成');
  }

  if (isRemoteHttpUrl(openTarget)) {
    throw new Error(readyStatus?.message || 'PDF 尚未缓存完成');
  }

  const valid = await validatePdfFilePath(openTarget);
  if (!valid) {
    if (normalized.cachePath && openTarget === normalized.cachePath) {
      await fsp.rm(normalized.cachePath, { force: true }).catch(() => {});
      pdfPrefetchStatuses.delete(normalized.paperKey);
    }
    throw new Error('缓存后的 PDF 文件无效');
  }

  const documentUrl = buildPdfDocumentUrl(openTarget, normalized.paperKey);
  if (!documentUrl) {
    throw new Error('无法创建 PDF 读取地址');
  }

  const sourceUrl = String(readyStatus?.sourceUrl || normalized.sourceUrl || '').trim();
  const localPath = String(openTarget || normalized.localPath || '').trim();
  const aiAttachment = await resolveAiPdfAttachmentDescriptor({
    sourceUrl,
    localPath,
    isLocal: readyStatus?.isLocal === true || Boolean(normalized.localPath),
  });

  return {
    paperKey: normalized.paperKey,
    title: normalized.title,
    openTarget,
    documentUrl,
    sourceUrl: aiAttachment.sourceUrl,
    localPath: aiAttachment.localPath,
    attachMode: aiAttachment.attachMode,
    aiAttachable: aiAttachment.aiAttachable,
    aiAttachmentMessage: aiAttachment.aiAttachmentMessage,
    isCached: readyStatus?.isCached === true,
    isLocal: aiAttachment.isLocal,
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
    pmcid: String(paper.pmcid || '').trim().toUpperCase(),
    explicit_arxiv_id: paper.explicit_arxiv_id === true,
    pdf_reason_code: String(paper.pdf_reason_code || '').trim(),
    pdf_reason_message: String(paper.pdf_reason_message || '').trim(),
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
  if (paperContext.resolvedFromSibling) {
    lines.push(`PDF 来源：开放兄弟版本${paperContext.pdfSourceLabel ? `（${paperContext.pdfSourceLabel}）` : ''}`);
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
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
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

function extractNetworkErrorCode(error) {
  const directCodes = [
    error?.cause?.code,
    error?.code,
    error?.cause?.errno,
    error?.errno,
  ];

  for (const rawCode of directCodes) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (code) {
      return code;
    }
  }

  const messageCandidates = [
    error?.cause?.message,
    error?.message,
    error?.stack,
    String(error || ''),
  ];

  for (const rawMessage of messageCandidates) {
    const message = String(rawMessage || '').trim().toUpperCase();
    if (!message) continue;

    const chromiumMatch = message.match(/ERR_[A-Z0-9_]+/);
    if (chromiumMatch?.[0]) {
      return chromiumMatch[0];
    }

    const certMatch = message.match(/\bCERT_[A-Z0-9_]+\b/);
    if (certMatch?.[0]) {
      return certMatch[0];
    }

    const nodeMatch = message.match(/\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/);
    if (nodeMatch?.[0]) {
      return nodeMatch[0];
    }
  }

  return '';
}

function formatAiConnectivityError(baseUrl, error) {
  const rawMessage = String(error?.message || '').trim();
  const causeCode = extractNetworkErrorCode(error);
  let host = normalizeBaseUrl(baseUrl);
  try {
    host = new URL(baseUrl).host || host;
  } catch (parseError) {
  }

  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN' || causeCode === 'ERR_NAME_NOT_RESOLVED') {
    return `无法解析 AI 服务地址 ${host}`;
  }
  if (causeCode === 'ERR_PROXY_CONNECTION_FAILED') {
    return `AI 服务代理连接失败：${host}`;
  }
  if (causeCode.startsWith('CERT_') || causeCode.startsWith('ERR_CERT_')) {
    return `AI 服务证书校验失败：${host}`;
  }
  if (causeCode === 'ECONNRESET' || causeCode === 'ERR_CONNECTION_RESET') {
    return `AI 服务连接被重置，请检查 ${host} 是否可访问`;
  }
  if (causeCode === 'ECONNREFUSED' || causeCode === 'ERR_CONNECTION_REFUSED') {
    return `AI 服务拒绝连接：${host}`;
  }
  if (causeCode === 'ETIMEDOUT' || causeCode === 'ERR_TIMED_OUT' || causeCode === 'ERR_CONNECTION_TIMED_OUT') {
    return `连接 AI 服务超时：${host}`;
  }
  if (causeCode === 'EHOSTUNREACH' || causeCode === 'ENETUNREACH' || causeCode === 'ERR_INTERNET_DISCONNECTED') {
    return `当前网络不可用，无法连接 AI 服务：${host}`;
  }
  if (/error code:\s*502|bad gateway|\bHTTP\s*502\b|\b502\b/i.test(rawMessage)) {
    return 'AI 上游服务暂时不可用（HTTP 502）。如果正在附带较大的 PDF，通常是服务网关无法处理过大的文件请求';
  }
  if (/maximum size|request entity too large|payload too large|body too large|\bHTTP\s*413\b|\b413\b/i.test(rawMessage)) {
    return 'PDF 原文过大，超过当前 AI 服务请求上限';
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

function parseBridgeResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (error) {
    }
  }
  return null;
}

function normalizeBridgeErrorMessage(rawMessage, fallback = '服务调用失败') {
  const raw = String(rawMessage || '').trim();
  const cleaned = raw
    .replace(/^Command failed:[\s\S]*?(?:\r?\n|$)/, '')
    .replace(/\[PYI-[^\n]+(?:\r?\n|$)/g, '')
    .replace(/^Error: /, '')
    .trim();
  return cleaned || fallback;
}

async function callBridge(command, payload = {}) {
  const bundledBridge = await findBundledBridge();
  const useBundledBridge = app.isPackaged || Boolean(bundledBridge);
  if (useBundledBridge && !bundledBridge) {
    throw new Error('内置服务组件缺失，请重新安装最新版客户端');
  }

  const executable = useBundledBridge ? bundledBridge : await findPython();
  const args = useBundledBridge
    ? [command, '--stdin']
    : [bridgePath(), command, '--stdin'];

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: appRoot(),
      env: bridgeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 120000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (!useBundledBridge && /ENOENT|not found|spawn .*python/i.test(String(error.message || ''))) {
        reject(new Error('未找到可用的 Python 运行环境；请安装 Python 3.10+，或使用正式安装包版本'));
        return;
      }
      reject(new Error(normalizeBridgeErrorMessage(error.message, '服务调用失败')));
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      const response = parseBridgeResponse(stdout) || parseBridgeResponse(stderr);
      if (code !== 0) {
        if (timedOut) {
          reject(new Error('服务请求超时'));
          return;
        }
        const rawError = response?.error || stderr || stdout || '';
        reject(new Error(normalizeBridgeErrorMessage(rawError, '服务调用失败')));
        return;
      }

      if (!response) {
        reject(new Error('服务返回格式异常'));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error || '请求失败'));
        return;
      }
      resolve(response.data);
    });

    try {
      child.stdin.end(JSON.stringify(payload));
    } catch (error) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('服务请求写入失败'));
      }
    }
    child.stdin.on('error', () => {});
  });
}

function statePath() {
  return path.join(app.getPath('userData'), 'state.json');
}

function legacyStatePaths() {
  const currentPath = statePath();
  const appDataRoot = app.getPath('appData');
  return LEGACY_APP_DATA_NAMES
    .map((name) => path.join(appDataRoot, name, 'state.json'))
    .filter((candidate, index, items) => candidate !== currentPath && items.indexOf(candidate) === index);
}

async function readState() {
  for (const candidate of [statePath(), ...legacyStatePaths()]) {
    try {
      const content = await fsp.readFile(candidate, 'utf-8');
      const payload = JSON.parse(content);
      const favoriteGroups = normalizeFavoriteGroupsMap(payload.favoriteGroups || {});
      const aiConfig = normalizeAiConfig(payload.aiConfig || {});
      const normalized = {
        favorites: normalizeFavoritesMap(payload.favorites || {}, favoriteGroups),
        favoriteGroups,
        history: payload.history || [],
        aiConfig,
        aiConfigStatus: normalizeAiConfigStatus(payload.aiConfigStatus || {}, aiConfig),
      };
      if (candidate !== statePath()) {
        await writeState(normalized);
      }
      return normalized;
    } catch (error) {
    }
  }
  return defaultState();
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

  try {
    const { response, data } = await postResponsesRequest(aiConfig, {
        model: aiConfig.model,
        store: false,
        reasoning: { effort: probeReasoningEffort(aiConfig.model) },
        instructions: 'Reply with OK only.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
      }, 20000);
    if (!response.ok) {
      const message = formatAiHttpError(response.status, data);
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
      code: String(extractNetworkErrorCode(error) || 'network_error').trim().toLowerCase() || 'network_error',
      message: formatAiConnectivityError(aiConfig.provider.baseUrl, error),
      checkedAt,
    }, aiConfig);
  }
}

function probeReasoningEffort(model = '') {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (normalizedModel.includes('5.4')) {
    return 'low';
  }
  return 'low';
}

function runtimeReasoningEffort(aiConfig = {}) {
  const effort = String(aiConfig.modelReasoningEffort || DEFAULT_AI_CONFIG.modelReasoningEffort).trim().toLowerCase();
  const model = String(aiConfig.model || '').trim().toLowerCase();
  if (effort === 'minimal' && model.includes('5.4')) {
    return 'low';
  }
  return AI_REASONING_LEVELS.has(effort) ? effort : DEFAULT_AI_CONFIG.modelReasoningEffort;
}

function runtimeReasoningOptions(aiConfig = {}) {
  const effort = runtimeReasoningEffort(aiConfig);
  if (effort === 'none') {
    return {};
  }
  return {
    effort,
    summary: 'auto',
  };
}

function formatAiHttpError(status, data = {}) {
  const statusCode = Number(status || 0);
  const rawMessage = String(data?.error?.message || data?.message || data?.rawText || '').trim();
  if (statusCode === 413 || /maximum size|request entity too large|payload too large|body too large/i.test(rawMessage)) {
    return 'PDF 原文过大，超过当前 AI 服务请求上限';
  }
  if (statusCode === 502 || /bad gateway|error code:\\s*502|\\b502\\b/i.test(rawMessage)) {
    return 'AI 上游服务暂时不可用（HTTP 502）。如果正在附带较大的 PDF，通常是服务网关无法处理过大的文件请求';
  }
  if (statusCode === 429) {
    return rawMessage || 'AI 服务请求过于频繁，请稍后重试';
  }
  if (statusCode >= 500) {
    return rawMessage || `AI 上游服务暂时不可用（HTTP ${statusCode}）`;
  }
  return rawMessage || `AI 请求失败（HTTP ${statusCode || '未知'}）`;
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

function sendAiStreamEvent(ipcEvent, requestId, payload = {}) {
  const id = String(requestId || '').trim();
  if (!id || !ipcEvent?.sender || ipcEvent.sender.isDestroyed?.()) {
    return;
  }
  ipcEvent.sender.send('ai:chat-stream', {
    requestId: id,
    ...payload,
  });
}

async function callAi(payload = {}, ipcEvent = null) {
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

  const streamRequestId = String(payload.requestId || '').trim();
  const emitStream = (event) => sendAiStreamEvent(ipcEvent, streamRequestId, event);
  const paperContext = payload.paperContext || {};
  const history = Array.isArray(payload.messages) ? payload.messages : [];
  const input = [];
  const hasTextContext = Boolean(String(paperContext.contextText || '').trim());
  const contextContent = [{ type: 'input_text', text: buildPaperContextText(paperContext) }];
  const pdfAttachment = await buildAiInputFileAttachment(paperContext);
  const hasPdfContext = Boolean(pdfAttachment.inputFile || pdfAttachment.inputText);
  if (pdfAttachment.inputFile) {
    contextContent.push(pdfAttachment.inputFile);
  }
  if (pdfAttachment.inputText) {
    contextContent.push(pdfAttachment.inputText);
  }
  input.push({ role: 'user', content: contextContent });

  for (const message of history) {
    const normalized = toResponseInputMessage(message);
    if (normalized) {
      input.push(normalized);
    }
  }
  input.push({ role: 'user', content: [{ type: 'input_text', text: prompt }] });

  try {
    emitStream({ type: 'started' });
    const { response, data } = await postResponsesRequest(aiConfig, {
        model: aiConfig.model,
        store: !aiConfig.disableResponseStorage,
        reasoning: runtimeReasoningOptions(aiConfig),
        instructions: 'You are OhMyPaper 的论文阅读助手。默认使用中文回答，优先依据随附 PDF 内容，其次参考论文元信息。回答应准确、简洁，并在不确定时明确说明。',
        input,
      }, 120000, {
        onEvent: (event) => {
          if (!event || event.type === 'response_text') {
            return;
          }
          emitStream(event);
        },
      });

    if (!response.ok) {
      const message = formatAiHttpError(response.status, data);
      throw new Error(message);
    }

    const reasoning = extractReasoningArtifacts(data);

    const result = {
      answer: extractResponseText(data),
      reasoningSummary: reasoning.summaryText,
      reasoningSteps: reasoning.steps,
      usedPdfContext: Boolean(hasPdfContext || hasTextContext),
      contextMode: pdfAttachment.inputFile ? 'pdf' : pdfAttachment.inputText ? 'pdf_text' : hasTextContext ? 'text' : 'metadata',
      providerName: aiConfig.provider.name || aiConfig.modelProvider,
      model: aiConfig.model,
    };
    emitStream({ type: 'final', ...result });
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') {
      emitStream({ type: 'error', message: 'AI 请求超时，请稍后重试' });
      throw new Error('AI 请求超时，请稍后重试');
    }
    const message = formatAiConnectivityError(aiConfig.provider.baseUrl, error);
    emitStream({ type: 'error', message });
    throw new Error(message);
  }
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
    title: 'OhMyPaper',
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
  registerPdfDocumentProtocol();
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
        pdf_candidates: snapshot.head?.pdf_candidates || bridgePayload.pdf_candidates || [],
        local_pdf_path: snapshot.local_pdf_path || snapshot.head?.local_pdf_path || bridgePayload.local_pdf_path || '',
        pmcid: snapshot.head?.pmcid || bridgePayload.pmcid || '',
        explicit_arxiv_id: snapshot.head?.explicit_arxiv_id === true || bridgePayload.explicit_arxiv_id === true,
        pdf_reason_code: snapshot.head?.pdf_reason_code || bridgePayload.pdf_reason_code || '',
        pdf_reason_message: snapshot.head?.pdf_reason_message || bridgePayload.pdf_reason_message || '',
        openalex_content_url: snapshot.head?.openalex_content_url || bridgePayload.openalex_content_url || '',
        openalex_oa_url: snapshot.head?.openalex_oa_url || bridgePayload.openalex_oa_url || '',
        openalex_oa_status: snapshot.head?.openalex_oa_status || bridgePayload.openalex_oa_status || '',
        openalex_is_oa: snapshot.head?.openalex_is_oa === true || bridgePayload.openalex_is_oa === true,
        openalex_has_content_pdf: snapshot.head?.openalex_has_content_pdf === true || bridgePayload.openalex_has_content_pdf === true,
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
  ipcMain.handle('ai:chat', (event, payload) => callAi(payload, event));
  ipcMain.handle('pdf:loadDocument', (_, payload) => loadPdfDocument(payload));
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
