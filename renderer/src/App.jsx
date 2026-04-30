import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PdfReaderPane from './components/PdfReaderPane';

function renderInlineMarkdown(text, keyPrefix = 'md-inline') {
  const source = String(text || '');
  const parts = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let lastIndex = 0;
  let match;
  let index = 0;

  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      parts.push(source.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={`${keyPrefix}-strong-${index}`}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<code key={`${keyPrefix}-code-${index}`}>{match[3]}</code>);
    } else if (match[4] && match[5]) {
      parts.push(
        <a key={`${keyPrefix}-link-${index}`} href={match[5]} target="_blank" rel="noreferrer">
          {match[4]}
        </a>
      );
    }
    lastIndex = pattern.lastIndex;
    index += 1;
  }

  if (lastIndex < source.length) {
    parts.push(source.slice(lastIndex));
  }

  return parts.length ? parts : source;
}

function MarkdownText({ text, className = '' }) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) return null;

  const lines = source.split('\n');
  const blocks = [];
  let paragraph = [];
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const content = paragraph.join(' ');
    blocks.push({ type: 'paragraph', text: content });
    paragraph = [];
  };

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push({ type: 'list', items: listItems });
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      continue;
    }

    const orderedMatch = line.match(/^\d+[.)]\s+(.+)$/);
    const unorderedMatch = line.match(/^[-*+]\s+(.+)$/);
    if (orderedMatch || unorderedMatch) {
      flushParagraph();
      listItems.push((orderedMatch || unorderedMatch)[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  return (
    <div className={`markdown-block ${className}`.trim()}>
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const HeadingTag = block.level === 1 ? 'h4' : block.level === 2 ? 'h5' : 'h6';
          return <HeadingTag key={`md-heading-${index}`} className="markdown-heading">{renderInlineMarkdown(block.text, `heading-${index}`)}</HeadingTag>;
        }
        if (block.type === 'list') {
          return (
            <ul key={`md-list-${index}`} className="markdown-list">
              {block.items.map((item, itemIndex) => (
                <li key={`md-list-${index}-${itemIndex}`}>{renderInlineMarkdown(item, `list-${index}-${itemIndex}`)}</li>
              ))}
            </ul>
          );
        }
        return <p key={`md-paragraph-${index}`} className="markdown-paragraph">{renderInlineMarkdown(block.text, `paragraph-${index}`)}</p>;
      })}
    </div>
  );
}

const PAGE_META = {
  search: { title: '论文搜索', subtitle: '搜索论文并进行渐进式阅读' },
  library: { title: '收藏', subtitle: '管理收藏论文' },
  history: { title: '最近访问', subtitle: '查看最近打开的论文' },
  settings: { title: '设置', subtitle: '配置连接 Token 与 AI 助手' }
};

const PAGE_DECOR = {
  search: { icon: '⌕', eyebrow: 'Discovery', note: '检索、筛选与沉浸式阅读' },
  library: { icon: '★', eyebrow: 'Library', note: '分组管理、导入与持续积累' },
  history: { icon: '◴', eyebrow: 'Recent', note: '回到最近打开过的论文现场' },
  settings: { icon: '⚙', eyebrow: 'Connect', note: '连接 Token 与 AI 能力' }
};

const SEARCH_MODE_OPTIONS = [
  { value: 'hybrid', label: '智能混合', help: '同时结合关键词匹配和语义向量召回，通常是最稳妥的默认模式。' },
  { value: 'bm25', label: '关键词匹配', help: '更偏向字面关键词命中，适合已知术语或精确短语。' },
  { value: 'vector', label: '语义检索', help: '更偏向语义相近内容，适合概念型、描述型查询。' }
];

const SEARCH_SOURCE_OPTIONS = [
  {
    value: 'mixed',
    label: '多源混合',
    help: '聚合 arXiv、OpenAlex 与 Europe PMC 的真实关键词检索结果，再按时间统一排序。',
    placeholder: '输入关键词，例如 agent memory',
    supportsSearchMode: true,
    supportsLimit: true,
  },
  {
    value: 'arxiv',
    label: 'arXiv（官方检索）',
    help: '官网文档中的主检索入口，支持关键词、BM25、向量与混合检索。',
    placeholder: '输入关键词，例如 agent memory',
    supportsSearchMode: true,
    supportsLimit: true,
  },
  {
    value: 'openalex',
    label: 'OpenAlex',
    help: '真实关键词检索源，覆盖广泛学术元数据，适合补足 arXiv 之外的论文发现。',
    placeholder: '输入关键词，例如 retrieval augmented generation',
    supportsSearchMode: false,
    supportsLimit: true,
  },
  {
    value: 'europepmc',
    label: 'Europe PMC',
    help: '真实关键词检索源，适合生命科学、医学和部分预印本内容。',
    placeholder: '输入关键词，例如 protein folding',
    supportsSearchMode: false,
    supportsLimit: true,
  }
];

const SOURCE_LABELS = {
  paper: '论文',
  arxiv: 'arXiv',
  openalex: 'OpenAlex',
  europepmc: 'Europe PMC',
  'local-pdf': '本地 PDF',
  pmc: 'PMC',
  pubmed: 'PubMed',
  preprint: 'Preprint'
};

const AI_REASONING_OPTIONS = [
  { value: 'xhigh', label: 'xhigh' },
  { value: 'high', label: 'high' },
  { value: 'medium', label: 'medium' },
  { value: 'low', label: 'low' },
  { value: 'minimal', label: 'minimal' },
  { value: 'none', label: 'none' }
];

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

const AI_CHAT_STORAGE_KEY = 'ohmypaper-ai-chat-histories-v1';
const LEGACY_AI_CHAT_STORAGE_KEYS = ['deepxiv-ai-chat-histories-v1'];
const THEME_STORAGE_KEY = 'ohmypaper-theme-v1';
const THEME_OPTIONS = [
  { value: 'original', label: '原始蓝紫', note: 'OhMyPaper 默认清爽配色', colors: ['#2563eb', '#7c3aed', '#f4f7fb'] },
  { value: 'champagne-rose', label: '香槟玫瑰', note: '取自香槟玫瑰、蜜桃与深红棕', colors: ['#E5D6CB', '#D49285', '#62382D'] },
  { value: 'linen-indigo', label: '雾蓝亚麻', note: '取自亚麻白、雾蓝与靛灰', colors: ['#FBFAFF', '#D0D2DB', '#697188'] },
  { value: 'sakura-plum', label: '樱影暮紫', note: '取自樱粉、木槿紫与近黑暮色', colors: ['#F0D9E4', '#C1A0AC', '#16131F'] },
  { value: 'deep-ocean', label: '深海青潮', note: '取自海雾蓝、礁石青与深海墨绿', colors: ['#A9C7CE', '#3A747D', '#051D25'] },
];
const AI_FALLBACK_REASONING_START = '正在读取论文上下文…';
const AI_FALLBACK_REASONING_ANSWER = '正在生成回答…';
const AI_FALLBACK_REASONING_DONE = '已完成论文上下文分析。';
const AI_PANEL_DEFAULT_WIDTH = 430;
const AI_PANEL_MIN_WIDTH = 320;
const AI_PANEL_MAX_WIDTH = 760;
const AI_PANEL_DETAIL_MIN_WIDTH = 420;

function createAiRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isFallbackReasoningText(text) {
  const normalized = String(text || '').trim();
  return normalized === AI_FALLBACK_REASONING_START
    || normalized === AI_FALLBACK_REASONING_ANSWER
    || normalized === AI_FALLBACK_REASONING_DONE
    || normalized === `${AI_FALLBACK_REASONING_START}\n${AI_FALLBACK_REASONING_ANSWER}`;
}

function clampAiPanelWidth(value, maxWidth = AI_PANEL_MAX_WIDTH) {
  const numeric = Number(value || AI_PANEL_DEFAULT_WIDTH);
  const upperBound = Math.max(AI_PANEL_MIN_WIDTH, Math.min(AI_PANEL_MAX_WIDTH, Number(maxWidth || AI_PANEL_MAX_WIDTH)));
  return Math.round(Math.min(Math.max(numeric, AI_PANEL_MIN_WIDTH), upperBound));
}

function normalizeTheme(value) {
  const normalized = String(value || '').trim();
  return THEME_OPTIONS.some((item) => item.value === normalized) ? normalized : 'original';
}

function loadTheme() {
  if (typeof window === 'undefined' || !window.localStorage) return 'original';
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch (error) {
    return 'original';
  }
}

function saveTheme(theme) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, normalizeTheme(theme));
  } catch (error) {
  }
}

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

function normalizeAiConfig(raw) {
  const next = raw || {};
  const provider = next.provider || {};
  return {
    modelProvider: String(next.modelProvider || DEFAULT_AI_CONFIG.modelProvider).trim() || DEFAULT_AI_CONFIG.modelProvider,
    model: String(next.model || DEFAULT_AI_CONFIG.model).trim() || DEFAULT_AI_CONFIG.model,
    modelReasoningEffort: String(next.modelReasoningEffort || DEFAULT_AI_CONFIG.modelReasoningEffort).trim() || DEFAULT_AI_CONFIG.modelReasoningEffort,
    disableResponseStorage: next.disableResponseStorage !== false,
    openAIApiKey: String(next.openAIApiKey || '').trim(),
    provider: {
      name: String(provider.name || DEFAULT_AI_CONFIG.provider.name).trim() || DEFAULT_AI_CONFIG.provider.name,
      baseUrl: String(provider.baseUrl || DEFAULT_AI_CONFIG.provider.baseUrl).trim() || DEFAULT_AI_CONFIG.provider.baseUrl,
      wireApi: String(provider.wireApi || DEFAULT_AI_CONFIG.provider.wireApi).trim() || DEFAULT_AI_CONFIG.provider.wireApi,
      requiresOpenAIAuth: provider.requiresOpenAIAuth !== false,
    },
  };
}

function normalizeAiConfigStatus(raw, aiConfig = normalizeAiConfig()) {
  const next = raw || {};
  const fallback = defaultAiConfigStatus(aiConfig);
  return {
    ok: next.ok === true,
    code: String(next.code || fallback.code).trim() || fallback.code,
    message: String(next.message || (next.ok === true ? `${aiConfig.provider.name} · ${aiConfig.model} 已通过连通性测试` : fallback.message)).trim() || fallback.message,
    checkedAt: String(next.checkedAt || '').trim(),
  };
}

function toUserErrorMessage(error, fallback = '操作失败') {
  const raw = String(error?.message || fallback).trim();
  return raw
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Command failed:[\s\S]*?(?:\r?\n|$)/, '')
    .replace(/\[PYI-[^\n]+(?:\r?\n|$)/g, '')
    .replace(/^Error: /, '')
    .trim() || fallback;
}

function looksLikePdfUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  return (
    value.includes('.pdf')
    || value.includes('/pdf/')
    || value.includes('/pdfdirect/')
    || value.includes('arxiv.org/pdf/')
    || value.includes('/download/')
    || /[?&](download=1|download=true|format=pdf|type=pdf)\b/.test(value)
  );
}

function isRemoteHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function getFavoriteKey(paper) {
  const explicitKey = String(paper?.favorite_key || '').trim();
  if (explicitKey) return explicitKey;

  const arxivId = String(paper?.arxiv_id || '').trim();
  if (arxivId) return arxivId;

  const openalexId = String(paper?.openalex_id || '').trim();
  if (openalexId) return `openalex:${openalexId}`;

  const europepmcId = String(paper?.europepmc_id || '').trim();
  if (europepmcId) {
    const europepmcSource = String(paper?.europepmc_source || paper?.source_kind || 'europepmc').trim().toLowerCase();
    return `${europepmcSource}:${europepmcId}`;
  }

  const localPdfPath = String(paper?.local_pdf_path || '').trim();
  if (localPdfPath) return `local-pdf:${localPdfPath}`;

  const paperKey = String(paper?.paper_key || '').trim();
  if (paperKey) return paperKey;

  const externalUrl = String(paper?.external_url || paper?.src_url || '').trim();
  if (externalUrl) {
    return `${String(paper?.source_kind || 'paper').trim().toLowerCase() || 'paper'}:${externalUrl}`;
  }

  const title = String(paper?.title || '').trim();
  if (title) {
    return `${String(paper?.source_kind || 'paper').trim().toLowerCase() || 'paper'}:${title}`;
  }

  return '';
}

function normalizeSearchKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\W+/g, ' ').trim();
}

function extractPublishYear(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : '';
}

function getPaperDedupeKeys(rawPaper) {
  const paper = normalizePaper(rawPaper || {});
  const keys = new Set();
  const doi = normalizeSearchKey(String(paper?.doi || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ''));
  const titleKey = normalizeSearchKey(paper.title || '');
  const yearKey = extractPublishYear(paper.publish_at || paper.published_at || paper.published || paper.created_at || '');
  const authorKey = normalizeSearchKey(String(paper.author_line || '').split(/[;,]/)[0] || '');

  if (doi) keys.add(`doi:${doi}`);
  if (paper.arxiv_id) keys.add(`arxiv:${String(paper.arxiv_id).trim().toLowerCase()}`);
  if (paper.openalex_id) keys.add(`openalex:${String(paper.openalex_id).trim().toLowerCase()}`);
  if (paper.europepmc_id) keys.add(`europepmc:${String(paper.europepmc_source || paper.source_kind || 'europepmc').trim().toLowerCase()}:${String(paper.europepmc_id).trim().toLowerCase()}`);
  if (titleKey && yearKey) keys.add(`title-year:${titleKey}:${yearKey}`);
  if (titleKey && authorKey && yearKey) keys.add(`title-author-year:${titleKey}:${authorKey}:${yearKey}`);
  if (titleKey && authorKey) keys.add(`title-author:${titleKey}:${authorKey}`);
  if (titleKey) keys.add(`title:${titleKey}`);

  return [...keys].filter(Boolean);
}

function dedupePapers(items) {
  const seen = new Set();
  const result = [];

  for (const rawPaper of items || []) {
    const paper = normalizePaper(rawPaper);
    const keys = getPaperDedupeKeys(paper);
    if (keys.some((key) => seen.has(key))) {
      continue;
    }
    keys.forEach((key) => seen.add(key));
    result.push(paper);
  }

  return result;
}

function normalizeAiConversationMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message, index) => ({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: String(message?.content || ''),
      isError: message?.isError === true,
      thinkingState: message?.thinkingState === 'done' ? 'done' : (message?.thinkingState === 'thinking' ? 'thinking' : ''),
      reasoningSummary: String(message?.reasoningSummary || ''),
      reasoningSteps: Array.isArray(message?.reasoningSteps)
        ? message.reasoningSteps
            .map((step, stepIndex) => ({
              id: String(step?.id || `reasoning-${index + 1}-${stepIndex + 1}`),
              text: String(step?.text || '').trim(),
            }))
            .filter((step) => step.text)
        : [],
    }))
    .filter((message) => message.content.trim() || message.thinkingState || message.reasoningSummary.trim() || message.reasoningSteps.length)
    .slice(-40);
}

function loadAiChatStore() {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const stored = window.localStorage.getItem(AI_CHAT_STORAGE_KEY)
      || LEGACY_AI_CHAT_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean)
      || '{}';
    const raw = JSON.parse(stored);
    return Object.fromEntries(
      Object.entries(raw || {})
        .map(([key, messages]) => [String(key || '').trim(), normalizeAiConversationMessages(messages)])
        .filter(([key, messages]) => key && messages.length)
    );
  } catch (error) {
    return {};
  }
}

function saveAiChatStore(store) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(store || {}));
  } catch (error) {
  }
}

function getPaperSessionKey(snapshot, rawPaper) {
  const paper = normalizePaper({
    ...(rawPaper || {}),
    source_kind: snapshot?.source_kind || rawPaper?.source_kind,
    source_label: snapshot?.source_label || rawPaper?.source_label,
    arxiv_id: snapshot?.arxiv_id || rawPaper?.arxiv_id,
    openalex_id: snapshot?.openalex_id || rawPaper?.openalex_id,
    europepmc_id: snapshot?.europepmc_id || rawPaper?.europepmc_id,
    europepmc_source: snapshot?.europepmc_source || rawPaper?.europepmc_source,
    local_pdf_path: snapshot?.local_pdf_path || rawPaper?.local_pdf_path,
    title: snapshot?.brief?.title || snapshot?.head?.title || rawPaper?.title,
    external_url: snapshot?.head?.src_url || snapshot?.brief?.src_url || rawPaper?.external_url || rawPaper?.src_url,
  });
  return getFavoriteKey(paper) || paper.paper_key || '';
}

function getAiConversationKey(snapshot, rawPaper) {
  return getPaperSessionKey(snapshot, rawPaper);
}

function normalizePdfPrefetchStatus(raw) {
  const next = raw || {};
  return {
    paperKey: String(next.paperKey || next.paper_key || '').trim(),
    state: String(next.state || '').trim() || 'idle',
    progress: Number.isFinite(Number(next.progress)) ? Math.max(0, Math.min(1, Number(next.progress))) : 0,
    message: String(next.message || '').trim(),
    target: String(next.target || '').trim(),
    sourceUrl: String(next.sourceUrl || next.source_url || '').trim(),
    cachedPath: String(next.cachedPath || next.cached_path || '').trim(),
    openTarget: String(next.openTarget || next.open_target || '').trim(),
    isCached: next.isCached === true,
    isLocal: next.isLocal === true,
    reasonCode: String(next.reasonCode || next.reason_code || next.pdf_reason_code || '').trim(),
    error: String(next.error || '').trim(),
    resolvedFromSibling: next.resolvedFromSibling === true || next.resolved_from_sibling === true,
    resolvedFromPaperKey: String(next.resolvedFromPaperKey || next.resolved_from_paper_key || '').trim(),
    resolvedSourceKind: String(next.resolvedSourceKind || next.resolved_source_kind || '').trim(),
    resolvedSourceLabel: String(next.resolvedSourceLabel || next.resolved_source_label || '').trim(),
    resolvedMatchReason: String(next.resolvedMatchReason || next.resolved_match_reason || '').trim(),
    resolvedPaperTitle: String(next.resolvedPaperTitle || next.resolved_paper_title || '').trim(),
  };
}

function normalizePdfCandidates(rawCandidates) {
  if (!Array.isArray(rawCandidates)) return [];
  const seen = new Set();
  const candidates = [];
  for (const rawCandidate of rawCandidates) {
    const url = String(rawCandidate?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const kind = String(rawCandidate?.kind || '').trim().toLowerCase() || (looksLikePdfUrl(url) ? 'direct_pdf' : 'landing_page');
    const key = `${kind}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      url,
      kind,
      source: String(rawCandidate?.source || '').trim(),
      label: String(rawCandidate?.label || '').trim(),
      host: String(rawCandidate?.host || '').trim(),
      version: String(rawCandidate?.version || '').trim(),
      license: String(rawCandidate?.license || '').trim(),
      is_oa: rawCandidate?.is_oa === true,
    });
  }
  return candidates;
}

function pdfCandidatePriority(candidate) {
  const url = String(candidate?.url || '').trim().toLowerCase();
  const source = String(candidate?.source || '').trim().toLowerCase();
  let score = 100;
  if (candidate?.kind === 'direct_pdf') score -= 20;
  if (candidate?.kind === 'content_api') score += 35;
  if (source.includes('arxiv') || url.includes('arxiv.org/')) score -= 50;
  if (source.includes('pmc') || url.includes('ncbi.nlm.nih.gov')) score -= 45;
  if (source.includes('open_access')) score -= 35;
  if (url.includes('europepmc.org')) score -= 25;
  if (url.includes('onlinelibrary.wiley.com') || url.includes('ieeexplore.ieee.org') || url.includes('dl.acm.org') || url.includes('pubs.acs.org')) score += 20;
  return score;
}

const PDF_RESOLVING_HINT_DELAY_MS = 400;

function hasReusablePdfStatus(status) {
  if (!status) return false;
  return !['idle', 'checking', ''].includes(String(status.state || '').trim());
}

function normalizePdfViewerState(raw) {
  const next = raw || {};
  const state = String(next.state || '').trim() || 'idle';
  return {
    paperKey: String(next.paperKey || next.paper_key || '').trim(),
    requestId: String(next.requestId || next.request_id || '').trim(),
    state,
    message: String(next.message || '').trim(),
    error: String(next.error || '').trim(),
    hasLoaded: next.hasLoaded === true || state === 'loaded',
    sourceUrl: String(next.sourceUrl || next.source_url || '').trim(),
    localPath: String(next.localPath || next.local_path || '').trim(),
    attachMode: String(next.attachMode || next.attach_mode || '').trim(),
    aiAttachable: next.aiAttachable === false ? false : (next.aiAttachable === true ? true : null),
    aiAttachmentMessage: String(next.aiAttachmentMessage || next.ai_attachment_message || '').trim(),
    isLocal: next.isLocal === true,
  };
}

function formatPdfPrefetchMessage(status) {
  if (!status) return '';
  if (status.isLocal) return '本地 PDF，打开最快';
  if (status.state === 'ready' && status.cachedPath) return status.message || 'PDF 已缓存，下次打开更快';
  if (status.state === 'checking') {
    return status.message || '';
  }
  if (status.state === 'downloading') {
    if (status.message) return status.message;
    return status.progress > 0 ? `正在准备 PDF… ${Math.round(status.progress * 100)}%` : '正在准备 PDF…';
  }
  if (status.state === 'verifying') {
    return status.message || '正在准备 PDF…';
  }
  if (status.state === 'missing') {
    return status.message || '当前论文暂未提供可打开的 PDF';
  }
  if (status.state === 'error') {
    return status.message || 'PDF 缓存失败';
  }
  return status.message || '';
}

function normalizePaper(paper) {
  const legacyPmcId = String(paper?.pmc_id || '').trim();
  const arxivId = String(paper?.arxiv_id || '').trim();
  const openalexId = String(paper?.openalex_id || '').trim();
  const europepmcId = String(paper?.europepmc_id || legacyPmcId || '').trim();
  const europepmcSource = String(paper?.europepmc_source || (legacyPmcId ? 'PMC' : '')).trim();
  const localPdfPath = String(paper?.local_pdf_path || '').trim();
  const pmcid = String(paper?.pmcid || '').trim().toUpperCase();
  const sourceKind = String(
    paper?.source_kind
    || (localPdfPath ? 'local-pdf' : openalexId ? 'openalex' : europepmcId ? 'europepmc' : arxivId ? 'arxiv' : legacyPmcId ? 'pmc' : 'paper')
  ).trim().toLowerCase();
  const sourceLabel = paper?.source_label || SOURCE_LABELS[sourceKind] || '论文';
  const externalUrl = String(paper?.external_url || paper?.src_url || '').trim();
  const pdfUrl = String(paper?.pdf_url || '').trim();
  const title = String(paper?.title || arxivId || openalexId || europepmcId || localPdfPath || 'Untitled').trim();
  const identitySeed = arxivId || openalexId || (europepmcId ? `${europepmcSource || sourceKind}:${europepmcId}` : '') || localPdfPath || externalUrl || title;
  const paperKey = String(paper?.paper_key || `${sourceKind}:${identitySeed}`).trim();
  const favoriteKey = String(paper?.favorite_key || getFavoriteKey({
    ...paper,
    source_kind: sourceKind,
    arxiv_id: arxivId,
    openalex_id: openalexId,
    europepmc_id: europepmcId,
    europepmc_source: europepmcSource,
    local_pdf_path: localPdfPath,
    external_url: externalUrl,
    paper_key: paperKey,
  })).trim();

  return {
    ...paper,
    title,
    paper_key: paperKey,
    favorite_key: favoriteKey,
    source_kind: sourceKind,
    source_label: sourceLabel,
    arxiv_id: arxivId,
    openalex_id: openalexId,
    europepmc_id: europepmcId,
    europepmc_source: europepmcSource,
    pmcid,
    doi: String(paper?.doi || '').trim(),
    external_url: externalUrl,
    pdf_url: pdfUrl,
    local_pdf_path: localPdfPath,
    explicit_arxiv_id: paper?.explicit_arxiv_id === true,
    pdf_reason_code: String(paper?.pdf_reason_code || '').trim(),
    pdf_reason_message: String(paper?.pdf_reason_message || '').trim(),
    pdf_candidates: normalizePdfCandidates(paper?.pdf_candidates),
    openalex_content_url: String(paper?.openalex_content_url || '').trim(),
    openalex_oa_url: String(paper?.openalex_oa_url || '').trim(),
    openalex_oa_status: String(paper?.openalex_oa_status || '').trim(),
    openalex_is_oa: paper?.openalex_is_oa === true,
    openalex_has_content_pdf: paper?.openalex_has_content_pdf === true,
    group_id: String(paper?.group_id || '').trim() || 'default',
    abstract: String(paper?.abstract || paper?.snippet || '').trim(),
    author_line: paper?.author_line || (Array.isArray(paper?.author_names) ? paper.author_names.slice(0, 6).join(', ') : ''),
    full_context_text: String(paper?.full_context_text || '').trim(),
    contribution_points: Array.isArray(paper?.contribution_points) ? paper.contribution_points.filter(Boolean) : [],
    sections: Array.isArray(paper?.sections) ? paper.sections : [],
    supports_favorite: Boolean(paper?.supports_favorite || arxivId || openalexId || europepmcId || localPdfPath || externalUrl)
  };
}

function parsePublishTime(paper) {
  const raw = paper?.publish_at || paper?.published_at || paper?.published || paper?.created_at || '';
  const timestamp = Date.parse(String(raw).trim());
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortPapersByTime(items) {
  return [...items].sort((left, right) => parsePublishTime(right) - parsePublishTime(left));
}

function resolvePdfUrl(snapshot, rawPaper) {
  const paper = normalizePaper(rawPaper || {});
  const brief = snapshot?.brief || {};
  const head = snapshot?.head || {};
  const directCandidates = [
    ...normalizePdfCandidates(head.pdf_candidates),
    ...normalizePdfCandidates(brief.pdf_candidates),
    ...(paper.pdf_candidates || []),
  ].filter((candidate) => candidate.kind !== 'content_api');
  const candidateUrls = directCandidates
    .sort((left, right) => pdfCandidatePriority(left) - pdfCandidatePriority(right))
    .map((candidate) => candidate.url);
  const candidates = [head.pdf_url, brief.pdf_url, paper.pdf_url, ...candidateUrls, head.src_url, brief.src_url];
  for (const candidate of candidates) {
    const url = String(candidate || '').trim();
    if (url && looksLikePdfUrl(url)) {
      if (paper.arxiv_id && url.includes('/pdf/') && !url.endsWith('.pdf')) {
        return `${url}.pdf`;
      }
      return url;
    }
  }
  const hasExplicitArxivId = head.explicit_arxiv_id === true || brief.explicit_arxiv_id === true || paper.explicit_arxiv_id === true;
  if (paper.arxiv_id && hasExplicitArxivId) {
    return `https://arxiv.org/pdf/${paper.arxiv_id}.pdf`;
  }
  const pmcid = String(head.pmcid || brief.pmcid || paper.pmcid || '').trim().toUpperCase();
  if (pmcid.startsWith('PMC')) {
    return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/`;
  }
  return '';
}

function derivePdfReason(snapshot, rawPaper) {
  const paper = normalizePaper(rawPaper || {});
  const brief = snapshot?.brief || {};
  const head = snapshot?.head || {};
  const reasonCode = String(head.pdf_reason_code || brief.pdf_reason_code || paper.pdf_reason_code || '').trim();
  const reasonMessage = String(head.pdf_reason_message || brief.pdf_reason_message || paper.pdf_reason_message || '').trim();
  const localPdfPath = resolveLocalPdfPath(snapshot, paper);
  if (localPdfPath) {
    return { code: reasonCode || 'ready_local', message: reasonMessage || '本地 PDF 已就绪' };
  }
  const pdfUrl = resolvePdfUrl(snapshot, paper);
  if (pdfUrl) {
    const pmcid = String(head.pmcid || brief.pmcid || paper.pmcid || '').trim().toUpperCase();
    if (pmcid.startsWith('PMC') && paper.source_kind !== 'local-pdf') {
      return { code: reasonCode || 'needs_pmc_resolution', message: reasonMessage || '正在准备 PDF…可稍后打开' };
    }
    return { code: reasonCode || 'ready_remote', message: reasonMessage || '已发现可缓存 PDF' };
  }
  const externalUrl = String(head.src_url || brief.src_url || paper.external_url || '').trim();
  if (externalUrl) {
    return { code: reasonCode || 'landing_page_only', message: reasonMessage || '源站仅提供论文落地页，未发现可用 PDF' };
  }
  return { code: reasonCode || 'no_open_access_pdf', message: reasonMessage || '源站未提供可用 PDF' };
}

function resolveLocalPdfPath(snapshot, rawPaper) {
  const paper = normalizePaper(rawPaper || {});
  const brief = snapshot?.brief || {};
  const head = snapshot?.head || {};
  return String(head.local_pdf_path || snapshot?.local_pdf_path || paper.local_pdf_path || brief.local_pdf_path || '').trim();
}

function resolveOpenTarget(snapshot, rawPaper) {
  const localPdfPath = resolveLocalPdfPath(snapshot, rawPaper);
  if (localPdfPath) {
    return { kind: 'path', value: localPdfPath };
  }

  const pdfUrl = resolvePdfUrl(snapshot, rawPaper);
  if (pdfUrl && isRemoteHttpUrl(pdfUrl)) {
    return { kind: 'url', value: pdfUrl };
  }

  const paper = normalizePaper(rawPaper || {});
  const brief = snapshot?.brief || {};
  const head = snapshot?.head || {};
  const externalUrl = String(head.src_url || brief.src_url || paper.external_url || '').trim();
  if (externalUrl) {
    return isRemoteHttpUrl(externalUrl)
      ? { kind: 'url', value: externalUrl }
      : { kind: 'path', value: externalUrl };
  }

  return null;
}

function buildPdfPrefetchPayload(snapshot, rawPaper) {
  const paper = normalizePaper(rawPaper || {});
  const target = resolveOpenTarget(snapshot, paper);
  const pdfReason = derivePdfReason(snapshot, paper);
  const fallbackTarget = String(snapshot?.head?.src_url || snapshot?.brief?.src_url || paper.external_url || '').trim();
  const targetValue = String(target?.value || fallbackTarget || '').trim();
  const targetKind = String(target?.kind || (isRemoteHttpUrl(targetValue) ? 'url' : 'path')).trim().toLowerCase() || 'path';
  const pdfCandidates = normalizePdfCandidates([
    ...(snapshot?.head?.pdf_candidates || []),
    ...(snapshot?.brief?.pdf_candidates || []),
    ...(paper.pdf_candidates || []),
  ]);

  return {
    paper_key: paper.paper_key,
    favorite_key: getPaperSessionKey(snapshot, paper),
    source_kind: snapshot?.source_kind || paper.source_kind,
    source_label: snapshot?.source_label || paper.source_label,
    arxiv_id: snapshot?.arxiv_id || paper.arxiv_id,
    openalex_id: snapshot?.openalex_id || paper.openalex_id,
    europepmc_id: snapshot?.europepmc_id || paper.europepmc_id,
    europepmc_source: snapshot?.europepmc_source || paper.europepmc_source,
    pmcid: snapshot?.head?.pmcid || snapshot?.brief?.pmcid || paper.pmcid || '',
    explicit_arxiv_id: snapshot?.head?.explicit_arxiv_id === true || snapshot?.brief?.explicit_arxiv_id === true || paper.explicit_arxiv_id === true,
    title: snapshot?.brief?.title || snapshot?.head?.title || paper.title || '论文 PDF',
    author_line: snapshot?.head?.author_line || snapshot?.brief?.author_line || paper.author_line || '',
    publish_at: snapshot?.brief?.publish_at || snapshot?.head?.publish_at || paper.publish_at || '',
    doi: snapshot?.head?.doi || paper.doi || '',
    external_url: snapshot?.head?.src_url || snapshot?.brief?.src_url || paper.external_url || '',
    pdf_url: resolvePdfUrl(snapshot, paper),
    pdf_candidates: pdfCandidates,
    pdf_reason_code: pdfReason.code,
    pdf_reason_message: pdfReason.message,
    local_pdf_path: resolveLocalPdfPath(snapshot, paper),
    openalex_content_url: String(snapshot?.head?.openalex_content_url || paper.openalex_content_url || '').trim(),
    openalex_oa_url: String(snapshot?.head?.openalex_oa_url || paper.openalex_oa_url || '').trim(),
    openalex_oa_status: String(snapshot?.head?.openalex_oa_status || paper.openalex_oa_status || '').trim(),
    openalex_is_oa: snapshot?.head?.openalex_is_oa === true || paper.openalex_is_oa === true,
    openalex_has_content_pdf: snapshot?.head?.openalex_has_content_pdf === true || paper.openalex_has_content_pdf === true,
    target: targetValue,
    target_kind: targetKind,
  };
}

function buildSnapshotPayload(paper, options = {}) {
  const normalizedPaper = normalizePaper(paper);
  const basePayload = {
    paper_key: normalizedPaper.paper_key,
    favorite_key: normalizedPaper.favorite_key,
    arxiv_id: normalizedPaper.arxiv_id,
    openalex_id: normalizedPaper.openalex_id,
    europepmc_id: normalizedPaper.europepmc_id,
    europepmc_source: normalizedPaper.europepmc_source,
    source_kind: normalizedPaper.source_kind,
    source_label: normalizedPaper.source_label,
    trackHistory: options.trackHistory !== false,
  };

  if (normalizedPaper.local_pdf_path || normalizedPaper.source_kind === 'local-pdf') {
    return {
      ...basePayload,
      title: normalizedPaper.title,
      publish_at: normalizedPaper.publish_at,
      external_url: normalizedPaper.external_url,
      pdf_url: normalizedPaper.pdf_url,
      local_pdf_path: normalizedPaper.local_pdf_path,
      author_line: normalizedPaper.author_line,
      abstract: normalizedPaper.abstract,
      full_context_text: normalizedPaper.full_context_text,
      sections: normalizedPaper.sections,
      contribution_points: normalizedPaper.contribution_points,
      supports_favorite: normalizedPaper.supports_favorite,
    };
  }

  return basePayload;
}

function buildAiPaperContext(snapshot, rawPaper, pdfStatus = null) {
  const paper = normalizePaper(rawPaper || {});
  const brief = snapshot?.brief || {};
  const head = snapshot?.head || {};
  const sourceKind = snapshot?.source_kind || paper.source_kind || 'paper';
  const sourceLabel = snapshot?.source_label || paper.source_label || SOURCE_LABELS[sourceKind] || '论文';
  const paperId = snapshot?.arxiv_id || snapshot?.openalex_id || snapshot?.europepmc_id || paper.arxiv_id || paper.openalex_id || paper.europepmc_id || '';

  return {
    paperKey: paper.paper_key,
    sourceKind,
    sourceLabel,
    paperId,
    title: brief.title || head.title || paper.title || 'Untitled',
    abstract: head.abstract || brief.tldr || paper.abstract || '',
    publishAt: brief.publish_at || head.publish_at || paper.publish_at || '',
    sourceUrl: head.src_url || brief.src_url || paper.external_url || '',
    pdfUrl: resolvePdfUrl(snapshot, paper),
    localPdfPath: resolveLocalPdfPath(snapshot, paper),
    contextText: String(head.full_context_text || paper.full_context_text || '').trim(),
    resolvedFromSibling: pdfStatus?.resolvedFromSibling === true,
    pdfSourceKind: String(pdfStatus?.resolvedSourceKind || '').trim(),
    pdfSourceLabel: String(pdfStatus?.resolvedSourceLabel || '').trim(),
  };
}

function resolveAiPdfAttachment(snapshot, rawPaper, pdfStatus, pdfViewerState, embeddedPdf) {
  const paperContext = buildAiPaperContext(snapshot, rawPaper, pdfStatus);
  const viewerPayload = embeddedPdf?.payload || {};
  const viewerTarget = String(embeddedPdf?.target || '').trim();
  const pdfLoaded = pdfViewerState?.hasLoaded === true;
  const remotePdfUrl = [
    viewerPayload.pdf_url,
    pdfViewerState?.sourceUrl,
    pdfStatus?.sourceUrl,
    paperContext.pdfUrl,
  ]
    .map((value) => String(value || '').trim())
    .find((value) => isRemoteHttpUrl(value) && looksLikePdfUrl(value)) || '';
  const localPdfPath = [
    viewerPayload.local_pdf_path,
    (!isRemoteHttpUrl(viewerTarget) ? viewerTarget : ''),
    pdfViewerState?.localPath,
    paperContext.localPdfPath,
  ]
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
  const requestedAttachMode = String(pdfViewerState?.attachMode || '').trim();
  const aiAttachable = pdfViewerState?.aiAttachable !== false;

  let attachMode = 'none';
  if (
    pdfLoaded
    && aiAttachable
    && (requestedAttachMode === 'file_data' || !requestedAttachMode)
    && (localPdfPath || remotePdfUrl)
  ) {
    attachMode = 'file_data';
  }

  const blockedMessage = pdfLoaded && attachMode === 'none'
    ? (String(pdfViewerState?.aiAttachmentMessage || '').trim() || 'PDF 已打开，但当前未附带原文，仅使用标题/摘要/摘录上下文')
    : '';

  return {
    paperContext,
    pdfLoaded,
    hasTextContext: Boolean(paperContext.contextText),
    remotePdfUrl,
    localPdfPath,
    attachMode,
    aiAttachable,
    blockedMessage,
  };
}

function EmptyState({ text }) {
  return <div className="empty-state">{text}</div>;
}

function SourceBadge({ sourceKind, sourceLabel }) {
  const badgeClass = `source-badge source-${String(sourceKind || 'paper').replace(/[^a-z0-9]+/g, '-')}`;
  return <span className={badgeClass}>{sourceLabel || '论文'}</span>;
}

function TitleWithSource({ title, sourceKind, sourceLabel }) {
  return (
    <div className="title-row">
      <span className="result-title-text">{title || 'Untitled'}</span>
      <SourceBadge sourceKind={sourceKind} sourceLabel={sourceLabel} />
    </div>
  );
}

function EmbeddedPdfPane({ viewer, onClose, pdfStatus, onLoadDocument, onViewerStateChange }) {
  if (!viewer?.target && !viewer?.payload) return null;
  return <PdfReaderPane viewer={viewer} onClose={onClose} pdfStatus={pdfStatus} onLoadDocument={onLoadDocument} onViewerStateChange={onViewerStateChange} />;
}

function makeExternalSnapshot(paper) {
  const normalized = normalizePaper(paper);
  const srcUrl = normalized.external_url || normalized.src_url || '';
  return {
    source_kind: normalized.source_kind,
    source_label: normalized.source_label,
    local_pdf_path: normalized.local_pdf_path || '',
    arxiv_id: normalized.arxiv_id,
    openalex_id: normalized.openalex_id,
    europepmc_id: normalized.europepmc_id,
    europepmc_source: normalized.europepmc_source,
    pmcid: normalized.pmcid || '',
    brief: {
      title: normalized.title,
      tldr: normalized.abstract,
      author_line: normalized.author_line || '',
      publish_at: normalized.publish_at || '',
      src_url: srcUrl,
      pdf_url: normalized.pdf_url || '',
      pmcid: normalized.pmcid || '',
      explicit_arxiv_id: normalized.explicit_arxiv_id === true,
      pdf_reason_code: normalized.pdf_reason_code || '',
      pdf_reason_message: normalized.pdf_reason_message || '',
      pdf_candidates: normalized.pdf_candidates || [],
      citations: normalized.citation || normalized.citations || 0,
    },
    head: {
      title: normalized.title,
      author_line: normalized.author_line || '',
      abstract: normalized.abstract || '暂无内容',
      publish_at: normalized.publish_at || '',
      src_url: srcUrl,
      pdf_url: normalized.pdf_url || '',
      local_pdf_path: normalized.local_pdf_path || '',
      pmcid: normalized.pmcid || '',
      explicit_arxiv_id: normalized.explicit_arxiv_id === true,
      pdf_reason_code: normalized.pdf_reason_code || '',
      pdf_reason_message: normalized.pdf_reason_message || '',
      pdf_candidates: normalized.pdf_candidates || [],
      openalex_content_url: normalized.openalex_content_url || '',
      openalex_oa_url: normalized.openalex_oa_url || '',
      openalex_oa_status: normalized.openalex_oa_status || '',
      openalex_is_oa: normalized.openalex_is_oa === true,
      openalex_has_content_pdf: normalized.openalex_has_content_pdf === true,
      full_context_text: normalized.full_context_text || '',
      contribution_points: normalized.contribution_points || [],
      citations: normalized.citation || normalized.citations || 0,
    },
    sections: normalized.sections || []
  };
}

function ResultList({ items, activeId, onSelect, emptyText, isLoading = false, loadingText = '正在搜索论文...' }) {
  if (isLoading) return <EmptyState text={loadingText} />;
  if (!items.length) return <EmptyState text={emptyText} />;

  return (
    <div className="result-list">
      {items.map((paper) => {
        const paperId = paper.arxiv_id || paper.openalex_id || paper.europepmc_id || '';
        const meta = [paper.author_line || '', paper.publish_at || '', paperId].filter(Boolean).join(' · ');
        return (
          <button
            key={paper.paper_key || paper.arxiv_id || paper.title}
            className={`result-item ${paper.paper_key === activeId ? 'active' : ''}`}
            onClick={() => onSelect(paper)}
          >
            <div className="result-title">
              <TitleWithSource title={paper.title || paperId || 'Untitled'} sourceKind={paper.source_kind} sourceLabel={paper.source_label} />
            </div>
            <div className="result-meta">{meta || '暂无信息'}</div>
          </button>
        );
      })}
    </div>
  );
}

function HistoryList({ items, activeKey, onSelect, emptyText }) {
  if (!items.length) return <EmptyState text={emptyText} />;

  return (
    <div className="result-list">
      {items.map((entry, index) => {
        const payload = normalizePaper(entry.payload || {});
        const paperId = payload.arxiv_id || payload.openalex_id || payload.europepmc_id || '';
        const title = payload.title || payload.query || paperId || '记录';
        const meta = [payload.source_label || '', payload.author_line || paperId || '', entry.at || ''].filter(Boolean).join(' · ');
        const itemKey = `${payload.paper_key || payload.external_url || 'history'}-${entry.at || index}-${index}`;
        const canOpen = Boolean(paperId || payload.external_url || payload.local_pdf_path);

        if (!canOpen) {
          return (
            <div key={itemKey} className="result-item static">
              <div className="result-title">
                <TitleWithSource title={title} sourceKind={payload.source_kind} sourceLabel={payload.source_label} />
              </div>
              <div className="result-meta">{entry.at || ''}</div>
            </div>
          );
        }

        return (
          <button
            key={itemKey}
            className={`result-item ${activeKey === itemKey ? 'active' : ''}`}
            onClick={() => onSelect(entry, itemKey)}
          >
            <div className="result-title">
              <TitleWithSource title={title} sourceKind={payload.source_kind} sourceLabel={payload.source_label} />
            </div>
            <div className="result-meta">{meta || '最近访问'}</div>
          </button>
        );
      })}
    </div>
  );
}

function AIChatPanel({ snapshot, paper, pdfStatus, pdfViewerState, embeddedPdf, aiConfig, aiConfigStatus, onAskAI, messages = [], onMessagesChange }) {
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState({});
  const messagesRef = useRef(messages);
  const messagesEndRef = useRef(null);
  const snapshotKey = snapshot?.arxiv_id || snapshot?.openalex_id || snapshot?.europepmc_id || paper?.paper_key || paper?.title || '';
  const pdfAttachment = useMemo(
    () => resolveAiPdfAttachment(snapshot, paper, pdfStatus, pdfViewerState, embeddedPdf),
    [snapshot, paper, pdfStatus, pdfViewerState, embeddedPdf, snapshotKey],
  );
  const paperContext = pdfAttachment.paperContext;
  const needsAuth = aiConfig?.provider?.requiresOpenAIAuth !== false;
  const hasApiKey = Boolean(aiConfig?.openAIApiKey);
  const validated = !needsAuth || aiConfigStatus?.ok === true;
  const ready = !needsAuth ? true : hasApiKey && validated;
  const hasTextContext = pdfAttachment.hasTextContext;
  const hasPdfContext = pdfAttachment.attachMode !== 'none';
  const effectivePaperContext = useMemo(() => ({
    ...paperContext,
    pdfLoaded: hasPdfContext,
    attachMode: pdfAttachment.attachMode,
    pdfUrl: hasPdfContext ? pdfAttachment.remotePdfUrl : '',
    localPdfPath: hasPdfContext ? pdfAttachment.localPdfPath : '',
  }), [paperContext, hasPdfContext, pdfAttachment]);
  const readinessHint = !hasApiKey
    ? '请先在设置中填写 OPENAI_API_KEY'
    : (aiConfigStatus?.message || '请先在设置页保存并验证 AI 配置');
  const contextStatus = pdfAttachment.attachMode === 'file_data'
    ? (paperContext.resolvedFromSibling ? `已附带开放兄弟版本 PDF 上下文${paperContext.pdfSourceLabel ? `（${paperContext.pdfSourceLabel}）` : ''}` : '已附带 PDF 原文上下文')
    : pdfAttachment.blockedMessage
      ? pdfAttachment.blockedMessage
    : hasTextContext
      ? '已附带论文正文摘录上下文'
      : '未附带 PDF 原文，仅使用标题与摘要上下文';

  useEffect(() => {
    setDraft('');
    setLoading(false);
    setExpandedReasoning({});
    messagesRef.current = messages;
  }, [snapshotKey]);

  useEffect(() => {
    if (!loading) {
      messagesRef.current = messages;
    }
  }, [messages, loading]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, loading]);

  async function handleSend() {
    const prompt = draft.trim();
    if (!prompt || loading || !snapshot) return;
    const requestId = createAiRequestId();
    const baseMessages = messagesRef.current || messages;
    const history = baseMessages
      .filter((item) => item.role === 'user' || (item.role === 'assistant' && !item.isError && item.content.trim()))
      .map((item) => ({ role: item.role, content: item.content }));
    const nextUserMessages = [...baseMessages, { role: 'user', content: prompt }];
    const assistantIndex = nextUserMessages.length;
    const publishMessages = (nextMessages) => {
      messagesRef.current = nextMessages;
      onMessagesChange?.(nextMessages);
    };
    const updateAssistantMessage = (updater) => {
      const current = [...(messagesRef.current || [])];
      let targetIndex = assistantIndex;
      if (!current[targetIndex] || current[targetIndex].role !== 'assistant') {
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (current[index]?.role === 'assistant') {
            targetIndex = index;
            break;
          }
        }
      }
      const currentAssistant = current[targetIndex]?.role === 'assistant'
        ? current[targetIndex]
        : { role: 'assistant', content: '', thinkingState: 'thinking', reasoningSummary: '', reasoningSteps: [] };
      current[targetIndex] = updater(currentAssistant);
      publishMessages(current);
    };
    const unsubscribeStream = window.ohMyPaper.onAiChatStream?.((event) => {
      if (!event || event.requestId !== requestId) return;
      if (event.type === 'reasoning_delta' && event.delta) {
        updateAssistantMessage((current) => ({
          ...current,
          thinkingState: 'thinking',
          reasoningSummary: isFallbackReasoningText(current.reasoningSummary)
            ? event.delta
            : `${current.reasoningSummary || ''}${event.delta}`,
        }));
      }
      if (event.type === 'answer_delta' && event.delta) {
        updateAssistantMessage((current) => ({
          ...current,
          thinkingState: current.thinkingState || 'thinking',
          reasoningSummary: current.reasoningSummary === AI_FALLBACK_REASONING_START
            ? `${AI_FALLBACK_REASONING_START}\n${AI_FALLBACK_REASONING_ANSWER}`
            : current.reasoningSummary,
          content: `${current.content || ''}${event.delta}`,
        }));
      }
      if (event.type === 'error' && event.message) {
        updateAssistantMessage((current) => ({
          ...current,
          isError: true,
          thinkingState: '',
          content: event.message,
        }));
      }
    });
    setLoading(true);
    publishMessages([...nextUserMessages, { role: 'assistant', content: '', thinkingState: 'thinking', reasoningSummary: AI_FALLBACK_REASONING_START, reasoningSteps: [] }]);
    setDraft('');
    try {
      const result = await onAskAI({ paperContext: effectivePaperContext, messages: history, prompt, requestId });
      updateAssistantMessage((current) => ({
        ...current,
        role: 'assistant',
        content: String(result.answer || current.content || ''),
        isError: false,
        thinkingState: 'done',
        reasoningSummary: String(result.reasoningSummary || (isFallbackReasoningText(current.reasoningSummary) ? AI_FALLBACK_REASONING_DONE : current.reasoningSummary) || ''),
        reasoningSteps: Array.isArray(result.reasoningSteps)
          ? result.reasoningSteps
              .map((item, index) => ({
                id: String(item?.id || `reasoning-${index + 1}`),
                text: String(item?.text || '').trim(),
              }))
              .filter((item) => item.text)
          : (current.reasoningSteps || []),
      }));
    } catch (error) {
      updateAssistantMessage(() => ({ role: 'assistant', content: toUserErrorMessage(error, 'AI 请求失败'), isError: true }));
    } finally {
      unsubscribeStream?.();
      setLoading(false);
    }
  }

  if (!snapshot) return null;

  return (
    <div className="ai-chat-panel inline">
      <div className="ai-chat-header">
        <div>
          <div className="ai-chat-title">AI 论文助手</div>
          <div className="ai-chat-subtitle">{aiConfig?.provider?.name || aiConfig?.modelProvider || 'fox'} · {aiConfig?.model || 'gpt-5'}</div>
        </div>
      </div>
      <div className="ai-chat-context">
        <span className={`ai-context-chip ${hasPdfContext || hasTextContext ? 'ok' : 'warn'}`}>{contextStatus}</span>
        {!ready && <span className="ai-context-chip warn">{readinessHint}</span>}
      </div>
      <div className="ai-chat-messages">
        {!messages.length && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-title">可直接提问这篇论文</div>
            <div className="ai-chat-empty-copy">例如：总结这篇论文的核心方法、指出主要贡献、解释实验设置。</div>
          </div>
        )}
        {messages.map((message, index) => (
          (() => {
            const reasoningKey = `${message.role}-${index}`;
            const hasReasoning = message.role === 'assistant' && !message.isError && Boolean(message.reasoningSteps?.length || message.reasoningSummary);
            const reasoningOpen = expandedReasoning[reasoningKey] ?? message.thinkingState === 'thinking';
            return (
              <div key={reasoningKey} className={`ai-bubble ${message.role} ${message.isError ? 'error' : ''}`}>
                <div className="ai-bubble-role">{message.role === 'assistant' ? 'AI' : '你'}</div>
                {message.role === 'assistant' && !message.isError && (
                  <div className={`ai-thinking-status ${message.thinkingState === 'done' ? 'done' : 'thinking'}`}>
                    {message.thinkingState === 'done' ? '思考完毕' : '思考中'}
                  </div>
                )}
                <MarkdownText text={message.content || (message.role === 'assistant' && message.thinkingState === 'thinking' ? '正在生成回答…' : '')} className="ai-bubble-text markdown-light" />
                {hasReasoning && (
                  <div className="ai-reasoning-block">
                    <button
                      type="button"
                      className="ai-reasoning-toggle"
                      aria-expanded={reasoningOpen}
                      onClick={() => setExpandedReasoning((prev) => ({ ...prev, [reasoningKey]: !reasoningOpen }))}
                    >
                      <span className="ai-reasoning-label">思考过程</span>
                      <span className="ai-reasoning-toggle-state">{reasoningOpen ? '收起' : '展开'}</span>
                    </button>
                    {reasoningOpen && (
                      <div className="ai-reasoning-content">
                        {message.reasoningSteps?.length > 0 && (
                          <div className="ai-reasoning-steps">
                            {message.reasoningSteps.map((step, stepIndex) => (
                              <div key={step.id || `reasoning-step-${stepIndex + 1}`} className="ai-reasoning-step">
                                <span className="ai-reasoning-step-index">{stepIndex + 1}</span>
                                <MarkdownText text={step.text} className="ai-reasoning-step-text markdown-light" />
                              </div>
                            ))}
                          </div>
                        )}
                        {message.reasoningSummary && (
                          <MarkdownText text={message.reasoningSummary} className="ai-reasoning-text markdown-light" />
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="ai-chat-footer">
        <textarea
          className="ai-chat-input"
          value={draft}
          placeholder={ready ? '输入你想问这篇论文的问题' : readinessHint}
          disabled={!ready || loading}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
        />
        <button className="btn primary" disabled={!ready || loading || !draft.trim()} onClick={handleSend}>发送</button>
      </div>
    </div>
  );
}

function DetailView({ snapshot, paper, isFavorite, canFavorite, onToggleFavorite, onOpenPdf, emptyText, aiConfig, aiConfigStatus, onAskAI, embeddedPdf, onClosePdf, aiMessages, onAiMessagesChange, pdfStatus, pdfViewerState, onLoadPdfDocument, onPdfViewerStateChange }) {
  const effectiveSnapshot = snapshot || (paper ? makeExternalSnapshot(paper) : null);
  if (!effectiveSnapshot) return <EmptyState text={emptyText} />;

  const brief = effectiveSnapshot.brief || {};
  const head = effectiveSnapshot.head || {};
  const sourceKind = effectiveSnapshot.source_kind || paper?.source_kind || 'paper';
  const sourceLabel = effectiveSnapshot.source_label || paper?.source_label || SOURCE_LABELS[sourceKind] || '论文';
  const title = brief.title || head.title || paper?.title || 'Untitled';
  const authorLine = head.author_line || brief.author_line || paper?.author_line || '';
  const paperId = effectiveSnapshot.arxiv_id || effectiveSnapshot.openalex_id || effectiveSnapshot.europepmc_id || paper?.arxiv_id || paper?.openalex_id || paper?.europepmc_id || '';
  const meta = [authorLine, paperId, brief.publish_at || head.publish_at || paper?.publish_at || '', `引用 ${brief.citations || head.citations || 0}`].filter(Boolean).join(' · ');
  const canOpenPdf = Boolean(pdfStatus?.state === 'ready' && (pdfStatus?.cachedPath || pdfStatus?.openTarget));
  const isOpeningPdf = pdfViewerState?.state === 'loading';
  const fallbackPdfReason = derivePdfReason(effectiveSnapshot, paper);
  const formattedPdfStatus = formatPdfPrefetchMessage(pdfStatus);
  const pdfStatusText = isOpeningPdf
    ? (pdfViewerState?.message || '正在打开 PDF…')
    : (pdfViewerState?.state === 'error'
      ? (pdfViewerState?.message || pdfViewerState?.error || 'PDF 打开失败')
      : (pdfStatus?.state === 'checking'
        ? formattedPdfStatus
        : (formattedPdfStatus || fallbackPdfReason.message)));

  if (embeddedPdf?.target) {
    return (
      <div className="detail-frame pdf-only">
        <EmbeddedPdfPane
          viewer={embeddedPdf}
          onClose={onClosePdf}
          pdfStatus={pdfStatus}
          onLoadDocument={onLoadPdfDocument}
          onViewerStateChange={onPdfViewerStateChange}
        />
      </div>
    );
  }

  return (
    <div className="detail-frame">
      <div className="detail-reading-pane">
        <div className="detail-shell">
        <div className="detail-header">
          <div className="detail-title-row">
            <h3 className="detail-title">{title}</h3>
            <SourceBadge sourceKind={sourceKind} sourceLabel={sourceLabel} />
          </div>
          <div className="detail-meta">{meta}</div>
          <div className="detail-actions">
            <button className="btn" disabled={!canFavorite} onClick={onToggleFavorite}>{canFavorite ? (isFavorite ? '取消收藏' : '加入收藏') : '暂不支持收藏'}</button>
            <button className="btn" disabled={!canOpenPdf || isOpeningPdf} onClick={onOpenPdf}>{isOpeningPdf ? '正在打开…' : '打开 PDF'}</button>
          </div>
          {pdfStatusText && <div className={`pdf-prefetch-hint ${pdfStatus?.state || 'idle'}`}>{pdfStatusText}</div>}
        </div>
          <AIChatPanel
            snapshot={effectiveSnapshot}
            paper={paper}
            pdfStatus={pdfStatus}
            pdfViewerState={pdfViewerState}
            embeddedPdf={embeddedPdf}
            aiConfig={aiConfig}
            aiConfigStatus={aiConfigStatus}
            onAskAI={onAskAI}
            messages={aiMessages}
            onMessagesChange={onAiMessagesChange}
          />
        </div>
      </div>

    </div>
  );
}

function AppBackground() {
  return (
    <div className="app-bg" aria-hidden="true">
      <div className="app-bg-grid" />
      <div className="app-bg-noise" />
      <div className="app-bg-glow glow-blue" />
      <div className="app-bg-glow glow-purple" />
      <div className="app-bg-glow glow-teal" />
    </div>
  );
}

function OnboardingView({
  token,
  tokenStatusLabel,
  tokenStatusHint,
  tokenIndicator,
  tokenIndicatorClass: baseTokenIndicatorClass,
  aiConfigForm,
  aiConfigStatus,
  aiStatusLabel,
  aiStatusHint,
  aiIndicator,
  aiIndicatorClass,
  isInitializing,
  isAutoRegistering,
  isSavingAiConfig,
  onboardingMessage,
  showOnboardingAiForm,
  onToggleAiForm,
  onRetryConnection,
  onContinue,
  onResetAiConfig,
  onSaveAiConfig,
  updateAiFormField,
}) {
  const canContinue = Boolean(token?.has_token) && !isInitializing && !isAutoRegistering && !isSavingAiConfig;
  const connectionIndicator = token?.has_token ? '✓' : ((isInitializing || isAutoRegistering) ? '…' : tokenIndicator);
  const connectionIndicatorClass = token?.has_token ? 'success' : ((isInitializing || isAutoRegistering) ? 'loading' : baseTokenIndicatorClass);
  const connectionTitle = token?.has_token
    ? '已自动完成匿名注册'
    : (isInitializing || isAutoRegistering)
      ? '正在自动匿名注册'
      : '自动注册暂未完成';
  const shouldShowAiForm = showOnboardingAiForm || !aiConfigStatus?.ok;

  return (
    <div className="onboarding-shell">
      <AppBackground />
      <div className="onboarding-layout">
        <section className="card onboarding-panel onboarding-panel-minimal">
          <div className="onboarding-panel-header">
            <div className="brand onboarding-brand">
              <div className="brand-mark">OM</div>
              <div className="brand-copy">
                <h1>OhMyPaper</h1>
                <p>自动连接后即可开始</p>
              </div>
            </div>
            <div className={`status-pill ${(isInitializing || isAutoRegistering || isSavingAiConfig) ? 'active' : ''}`}>
              {isInitializing ? '初始化中' : isAutoRegistering ? '连接中' : isSavingAiConfig ? '验证中' : '已就绪'}
            </div>
          </div>

          <div className="onboarding-copy minimal compact">
            <p>{token?.has_token ? '匿名连接已准备好。' : (onboardingMessage || '正在自动连接…')}</p>
          </div>

          <div className="settings-card onboarding-section-card compact">
            <div className="onboarding-status-list">
              <div className="onboarding-status-item">
                <div className="onboarding-status-meta">
                  <span className="onboarding-status-name">连接</span>
                  <span className="settings-status-hint">{token?.has_token ? tokenStatusLabel : connectionTitle}</span>
                </div>
                <div className={`token-indicator ${connectionIndicatorClass}`} title={tokenStatusHint}>{connectionIndicator}</div>
              </div>
              <div className="onboarding-status-item">
                <div className="onboarding-status-meta">
                  <span className="onboarding-status-name">AI</span>
                  <span className="settings-status-hint">{aiStatusLabel}</span>
                </div>
                <div className={`token-indicator ${aiIndicatorClass}`} title={aiStatusHint}>{aiIndicator}</div>
              </div>
            </div>
            {!token?.has_token && !isInitializing && !isAutoRegistering && (
              <div className="btn-row onboarding-inline-actions">
                <button className="btn" onClick={onRetryConnection}>重新连接</button>
              </div>
            )}
          </div>

          <div className="settings-card onboarding-section-card compact">
            <div className="onboarding-section-head">
              <div>
                <div className="onboarding-section-title">可选 AI 配置</div>
              </div>
              <button className="mini-btn" onClick={onToggleAiForm}>{shouldShowAiForm ? '收起' : '配置'}</button>
            </div>
            {shouldShowAiForm && (
              <>
                <div className="form-grid onboarding-form-grid">
                  <label className="form-field">
                    <span>model</span>
                    <input className="input" value={aiConfigForm.model} onChange={(event) => updateAiFormField('model', event.target.value)} list="model-options-onboarding" />
                    <datalist id="model-options-onboarding">
                      <option value="gpt-5.4" />
                      <option value="gpt-5.4-fast" />
                      <option value="gpt-5-codex" />
                    </datalist>
                  </label>
                  <label className="form-field">
                    <span>reasoning_effort</span>
                    <select className="select" value={aiConfigForm.modelReasoningEffort} onChange={(event) => updateAiFormField('modelReasoningEffort', event.target.value)}>
                      {AI_REASONING_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </label>
                  <label className="form-field form-field-wide">
                    <span>OPENAI_API_KEY</span>
                    <input className="input" type="password" placeholder="sk-..." value={aiConfigForm.openAIApiKey} onChange={(event) => updateAiFormField('openAIApiKey', event.target.value)} />
                  </label>
                </div>
                <div className="btn-row">
                  <button className="btn primary" onClick={onSaveAiConfig} disabled={isSavingAiConfig}>保存并测试 AI</button>
                  <button className="btn" onClick={onResetAiConfig}>恢复默认</button>
                </div>
              </>
            )}
          </div>

          <div className="onboarding-footer">
            <div className="btn-row">
              <button className="btn" onClick={onToggleAiForm}>{shouldShowAiForm ? '稍后配置' : '配置 AI'}</button>
              <button className="btn primary" disabled={!canContinue} onClick={onContinue}>进入 OhMyPaper</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default function App() {
  const openPaperRequestRef = useRef({ search: 0, library: 0, history: 0 });
  const pdfOpenRequestRef = useRef({ search: 0, library: 0, history: 0 });
  const activePaperKeyRef = useRef({ search: '', library: '', history: '' });
  const pdfResolveHintTimerRef = useRef({ search: null, library: null, history: null });
  const [page, setPage] = useState('search');
  const [statusText, setStatusText] = useState('');
  const [isInitializing, setIsInitializing] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [isAutoRegistering, setIsAutoRegistering] = useState(false);
  const [onboardingMessage, setOnboardingMessage] = useState('正在准备 OhMyPaper…');
  const [showOnboardingAiForm, setShowOnboardingAiForm] = useState(false);
  const [isSavingAiConfig, setIsSavingAiConfig] = useState(false);
  const [theme, setTheme] = useState(() => loadTheme());
  const [token, setToken] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [favoriteGroups, setFavoriteGroups] = useState([]);
  const [activeGroupId, setActiveGroupId] = useState('all');
  const [showGroupCreator, setShowGroupCreator] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [editingGroupId, setEditingGroupId] = useState('');
  const [editingGroupName, setEditingGroupName] = useState('');
  const [history, setHistory] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchSourceScope, setSearchSourceScope] = useState('mixed');
  const [searchMode] = useState('hybrid');
  const [searchLimit, setSearchLimit] = useState(20);
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [activePaper, setActivePaper] = useState({ search: null, library: null, history: null });
  const [snapshots, setSnapshots] = useState({ search: null, library: null, history: null });
  const [embeddedPdf, setEmbeddedPdf] = useState({ search: null, library: null, history: null });
  const [aiPanelWidths, setAiPanelWidths] = useState({
    search: AI_PANEL_DEFAULT_WIDTH,
    library: AI_PANEL_DEFAULT_WIDTH,
    history: AI_PANEL_DEFAULT_WIDTH,
  });
  const [activeHistoryKey, setActiveHistoryKey] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [aiConfig, setAiConfig] = useState(normalizeAiConfig());
  const [aiConfigStatus, setAiConfigStatus] = useState(defaultAiConfigStatus(normalizeAiConfig()));
  const [aiConfigForm, setAiConfigForm] = useState(normalizeAiConfig());
  const [aiChatStore, setAiChatStore] = useState(() => loadAiChatStore());
  const [pdfPrefetchStore, setPdfPrefetchStore] = useState({});
  const [pdfViewerStateStore, setPdfViewerStateStore] = useState({});
  const pdfPrefetchStoreRef = useRef({});

  const pageMeta = PAGE_META[page];
  const favoriteKeys = useMemo(() => new Set(favorites.map((item) => getFavoriteKey(item)).filter(Boolean)), [favorites]);
  const defaultFavoriteGroupId = favoriteGroups[0]?.id || 'default';
  const favoriteGroupCounts = useMemo(() => {
    const counts = { all: favorites.length };
    for (const group of favoriteGroups) {
      counts[group.id] = 0;
    }
    for (const paper of favorites) {
      const groupId = paper.group_id || defaultFavoriteGroupId;
      counts[groupId] = (counts[groupId] || 0) + 1;
    }
    return counts;
  }, [favorites, favoriteGroups, defaultFavoriteGroupId]);
  const visibleFavorites = useMemo(() => {
    if (activeGroupId === 'all') {
      return favorites;
    }
    return favorites.filter((paper) => (paper.group_id || defaultFavoriteGroupId) === activeGroupId);
  }, [favorites, activeGroupId, defaultFavoriteGroupId]);
  const selectedSearchSource = useMemo(() => SEARCH_SOURCE_OPTIONS.find((item) => item.value === searchSourceScope) || SEARCH_SOURCE_OPTIONS[0], [searchSourceScope]);
  const searchPlaceholder = selectedSearchSource?.placeholder || '输入关键词';
  const showSearchLimit = selectedSearchSource?.supportsLimit !== false;
  const searchActionLabel = showSearchLimit ? '搜索' : '打开';
  const tokenIndicator = token?.has_token ? '✓' : '✕';
  const tokenIndicatorClass = token?.has_token ? 'success' : 'error';

  function applyBootstrapData(bootstrap = {}, options = {}) {
    const preserveAiForm = options.preserveAiForm === true;
    setToken(bootstrap.token || null);
    setFavorites((bootstrap.favorites || []).map(normalizePaper));
    setFavoriteGroups(bootstrap.favoriteGroups || []);
    setHistory(bootstrap.history || []);
    const nextAiConfig = normalizeAiConfig(bootstrap.aiConfig || {});
    setAiConfig(nextAiConfig);
    setAiConfigStatus(normalizeAiConfigStatus(bootstrap.aiConfigStatus, nextAiConfig));
    if (!preserveAiForm) {
      setAiConfigForm(nextAiConfig);
    }
    if (bootstrap.token?.token) {
      setTokenInput(bootstrap.token.token);
    }
    return nextAiConfig;
  }

  async function refreshBootstrap(options = {}) {
    const bootstrap = await window.ohMyPaper.bootstrap();
    applyBootstrapData(bootstrap, options);
    return bootstrap;
  }

  async function performAnonymousRegistration(options = {}) {
    const silentStatus = options.silentStatus === true;
    setIsAutoRegistering(true);
    setOnboardingMessage('正在为你自动匿名注册…');
    if (!silentStatus) {
      setStatusText('正在匿名注册…');
    }
    try {
      const nextToken = await window.ohMyPaper.registerToken();
      setToken(nextToken);
      setTokenInput(nextToken?.token || '');
      setOnboardingMessage('已自动完成匿名注册，可以直接开始使用。');
      if (!silentStatus) {
        setStatusText('匿名注册成功');
      }
      return nextToken;
    } catch (error) {
      const message = toUserErrorMessage(error, '匿名注册失败');
      setOnboardingMessage(message);
      if (!silentStatus) {
        setStatusText(message);
      }
      throw error;
    } finally {
      setIsAutoRegistering(false);
    }
  }

  async function initializeApp() {
    setIsInitializing(true);
    setOnboardingMessage('正在准备 OhMyPaper…');
    try {
      const bootstrap = await refreshBootstrap();
      if (bootstrap.token?.has_token) {
        setOnboardingMessage('已自动连接 OhMyPaper，可按需配置 AI 后进入软件。');
      } else {
        await performAnonymousRegistration({ silentStatus: true }).catch(() => {});
      }
    } catch (error) {
      const message = toUserErrorMessage(error, '初始化失败');
      setStatusText(message);
      setOnboardingMessage(message);
    } finally {
      setIsInitializing(false);
    }
  }

  async function handleRefreshStatus() {
    setStatusText('正在刷新状态…');
    try {
      const result = await window.ohMyPaper.refreshStatus();
      setToken(result.token || null);
      const nextAiConfig = normalizeAiConfig(result.aiConfig || aiConfig);
      setAiConfig(nextAiConfig);
      setAiConfigForm(nextAiConfig);
      setAiConfigStatus(normalizeAiConfigStatus(result.aiConfigStatus, nextAiConfig));
      if (result.token?.token) {
        setTokenInput(result.token.token);
      } else {
        await performAnonymousRegistration({ silentStatus: true }).catch(() => {});
      }
      setStatusText('状态已刷新');
    } catch (error) {
      setStatusText(toUserErrorMessage(error, '刷新状态失败'));
    }
  }

  useEffect(() => {
    initializeApp();
  }, []);

  useEffect(() => {
    if (activeGroupId !== 'all' && !favoriteGroups.some((group) => group.id === activeGroupId)) {
      setActiveGroupId('all');
    }
  }, [favoriteGroups, activeGroupId]);

  useEffect(() => {
    activePaperKeyRef.current = {
      search: getPaperSessionKey(snapshots.search, activePaper.search),
      library: getPaperSessionKey(snapshots.library, activePaper.library),
      history: getPaperSessionKey(snapshots.history, activePaper.history),
    };
  }, [snapshots, activePaper]);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(pdfResolveHintTimerRef.current || {})) {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.ohMyPaper.onPdfPrefetchStatus?.((payload) => {
      const status = normalizePdfPrefetchStatus(payload);
      if (!status.paperKey) return;
      setPdfPrefetchStore((prev) => {
        const next = { ...prev, [status.paperKey]: status };
        pdfPrefetchStoreRef.current = next;
        return next;
      });
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    pdfPrefetchStoreRef.current = pdfPrefetchStore;
  }, [pdfPrefetchStore]);

  useEffect(() => {
    saveAiChatStore(aiChatStore);
  }, [aiChatStore]);

  useEffect(() => {
    const normalizedTheme = normalizeTheme(theme);
    document.documentElement.dataset.theme = normalizedTheme;
    saveTheme(normalizedTheme);
  }, [theme]);

  function getAiConversationMessages(snapshot, paper) {
    const key = getAiConversationKey(snapshot, paper);
    return key ? (aiChatStore[key] || []) : [];
  }

  function setAiConversationMessages(snapshot, paper, messages) {
    const key = getAiConversationKey(snapshot, paper);
    if (!key) return;
    const normalized = normalizeAiConversationMessages(messages);
    setAiChatStore((prev) => {
      if (!normalized.length) {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: normalized };
    });
  }

  function mergePdfPrefetchStatus(rawStatus) {
    const status = normalizePdfPrefetchStatus(rawStatus);
    if (!status.paperKey) return status;
    setPdfPrefetchStore((prev) => {
      const next = { ...prev, [status.paperKey]: status };
      pdfPrefetchStoreRef.current = next;
      return next;
    });
    return status;
  }

  const mergePdfViewerState = useCallback((rawState) => {
    const next = normalizePdfViewerState(rawState);
    if (!next.paperKey) return next;
    setPdfViewerStateStore((prev) => {
      const current = normalizePdfViewerState(prev[next.paperKey] || {});
      const merged = {
        ...current,
        ...next,
        hasLoaded: current.hasLoaded || next.hasLoaded,
      };
      if (
        current.paperKey === merged.paperKey
        && current.requestId === merged.requestId
        && current.state === merged.state
        && current.message === merged.message
        && current.error === merged.error
        && current.hasLoaded === merged.hasLoaded
        && current.sourceUrl === merged.sourceUrl
        && current.localPath === merged.localPath
        && current.attachMode === merged.attachMode
        && current.aiAttachable === merged.aiAttachable
        && current.aiAttachmentMessage === merged.aiAttachmentMessage
        && current.isLocal === merged.isLocal
      ) {
        return prev;
      }
      return { ...prev, [next.paperKey]: merged };
    });
    return next;
  }, []);

  function getPdfStatus(snapshot, paper) {
    const key = getPaperSessionKey(snapshot, paper);
    return key ? (pdfPrefetchStoreRef.current[key] || null) : null;
  }

  function getPdfViewerState(snapshot, paper) {
    const key = getPaperSessionKey(snapshot, paper);
    return key ? (pdfViewerStateStore[key] || null) : null;
  }

  function markPdfChecking(snapshot, paper, message = '正在检查 PDF…') {
    const payload = buildPdfPrefetchPayload(snapshot, paper);
    if (!payload?.favorite_key) return null;
    return mergePdfPrefetchStatus({
      paperKey: payload.favorite_key,
      state: 'checking',
      message,
      target: payload.target || '',
      sourceUrl: payload.pdf_url || '',
      openTarget: payload.target || '',
      reasonCode: payload.pdf_reason_code || '',
      isLocal: Boolean(payload.local_pdf_path),
      isCached: false,
    });
  }

  function clearPdfResolveHint(context) {
    const timer = pdfResolveHintTimerRef.current?.[context];
    if (timer) {
      clearTimeout(timer);
    }
    pdfResolveHintTimerRef.current = {
      ...pdfResolveHintTimerRef.current,
      [context]: null,
    };
  }

  function schedulePdfResolveHint(context, requestId, snapshot, paper) {
    clearPdfResolveHint(context);
    const payload = buildPdfPrefetchPayload(snapshot, paper);
    if (!payload?.favorite_key) return;
    if (hasReusablePdfStatus(pdfPrefetchStoreRef.current[payload.favorite_key] || null)) return;
    const timer = setTimeout(() => {
      if (!isLatestContextRequest(openPaperRequestRef, context, requestId)) return;
      if (activePaperKeyRef.current[context] && activePaperKeyRef.current[context] !== payload.favorite_key) return;
      if (hasReusablePdfStatus(pdfPrefetchStoreRef.current[payload.favorite_key] || null)) return;
      markPdfChecking(snapshot, paper, '正在加载论文信息…');
    }, PDF_RESOLVING_HINT_DELAY_MS);
    pdfResolveHintTimerRef.current = {
      ...pdfResolveHintTimerRef.current,
      [context]: timer,
    };
  }

  async function prefetchPdfForPaper(snapshot, paper) {
    const payload = buildPdfPrefetchPayload(snapshot, paper);
    try {
    return mergePdfPrefetchStatus(await window.ohMyPaper.prefetchPdf(payload));
    } catch (error) {
      return null;
    }
  }

  async function resolvePdfOpenForPaper(snapshot, paper) {
    const payload = buildPdfPrefetchPayload(snapshot, paper);
    return mergePdfPrefetchStatus(await window.ohMyPaper.resolvePdf(payload));
  }

  async function openPaper(context, rawPaper, options = {}) {
    const paper = normalizePaper(rawPaper);
    const canLoadSnapshot = Boolean(paper.arxiv_id || paper.openalex_id || paper.europepmc_id || paper.local_pdf_path || paper.source_kind === 'local-pdf');
    const previewSnapshot = makeExternalSnapshot(paper);
    const previewPaperKey = getPaperSessionKey(previewSnapshot, paper);
    const requestId = bumpContextRequest(openPaperRequestRef, context);
    bumpContextRequest(pdfOpenRequestRef, context);
    activePaperKeyRef.current = { ...activePaperKeyRef.current, [context]: previewPaperKey };
    setActivePaper((prev) => ({ ...prev, [context]: paper }));
    setSnapshots((prev) => ({ ...prev, [context]: previewSnapshot }));
    setEmbeddedPdf((prev) => ({ ...prev, [context]: null }));
    clearPdfResolveHint(context);
    const existingPreviewPdfStatus = getPdfStatus(previewSnapshot, paper);
    const reusePreviewPdfStatus = hasReusablePdfStatus(existingPreviewPdfStatus);
    if (paper.local_pdf_path || paper.source_kind === 'local-pdf') {
      if (!reusePreviewPdfStatus) {
        void prefetchPdfForPaper(previewSnapshot, paper);
      }
    } else if (!canLoadSnapshot) {
      if (!reusePreviewPdfStatus) {
        void prefetchPdfForPaper(previewSnapshot, paper);
      }
    } else if (canLoadSnapshot) {
      if (!reusePreviewPdfStatus) {
        markPdfChecking(previewSnapshot, paper, '');
        schedulePdfResolveHint(context, requestId, previewSnapshot, paper);
      }
    }
    try {
      if (canLoadSnapshot) {
        const snapshot = await window.ohMyPaper.snapshot(buildSnapshotPayload(paper, options));
        clearPdfResolveHint(context);
        if (!isLatestContextRequest(openPaperRequestRef, context, requestId)) return;
        activePaperKeyRef.current = { ...activePaperKeyRef.current, [context]: getPaperSessionKey(snapshot, paper) || previewPaperKey };
        setSnapshots((prev) => ({ ...prev, [context]: snapshot }));
        const existingSnapshotPdfStatus = getPdfStatus(snapshot, paper) || existingPreviewPdfStatus;
        if (!hasReusablePdfStatus(existingSnapshotPdfStatus)) {
          markPdfChecking(snapshot, paper, '');
          void prefetchPdfForPaper(snapshot, paper);
        }
        if (options.trackHistory !== false) {
          const nextHistory = await window.ohMyPaper.historyList();
          if (!isLatestContextRequest(openPaperRequestRef, context, requestId)) return;
          setHistory(nextHistory || []);
        }
      } else {
        clearPdfResolveHint(context);
        if (!isLatestContextRequest(openPaperRequestRef, context, requestId)) return;
        setSnapshots((prev) => ({ ...prev, [context]: previewSnapshot }));
        if (options.trackHistory !== false) {
          const nextHistory = await window.ohMyPaper.historyAdd({ kind: 'paper', payload: paper });
          if (!isLatestContextRequest(openPaperRequestRef, context, requestId)) return;
          setHistory(nextHistory || []);
        }
      }
    } catch (error) {
      clearPdfResolveHint(context);
      if (!isLatestContextRequest(openPaperRequestRef, context, requestId)) return;
      setSnapshots((prev) => ({ ...prev, [context]: previewSnapshot }));
      if (!reusePreviewPdfStatus) {
        mergePdfPrefetchStatus({
          paperKey: previewPaperKey,
          state: 'error',
          message: '加载详情失败，暂时无法检查 PDF',
          error: toUserErrorMessage(error, '加载详情失败'),
          target: buildPdfPrefetchPayload(previewSnapshot, paper)?.target || '',
          sourceUrl: buildPdfPrefetchPayload(previewSnapshot, paper)?.pdf_url || '',
        });
      }
      setStatusText(toUserErrorMessage(error, '加载详情失败'));
    }
  }

  async function handleSearch() {
    const query = searchQuery.trim();
    if (!query) return;
    clearPdfResolveHint('search');
    bumpContextRequest(openPaperRequestRef, 'search');
    bumpContextRequest(pdfOpenRequestRef, 'search');
    activePaperKeyRef.current = { ...activePaperKeyRef.current, search: '' };
    setEmbeddedPdf((prev) => ({ ...prev, search: null }));
    setSnapshots((prev) => ({ ...prev, search: null }));
    setActivePaper((prev) => ({ ...prev, search: null }));
    setIsSearching(true);
    setStatusText(showSearchLimit ? '正在搜索论文…' : '正在打开论文…');
    try {
      const result = await window.ohMyPaper.search({ query, limit: Number(searchLimit), mode: searchMode, source_scope: searchSourceScope });
      const papers = dedupePapers(sortPapersByTime((result.results || []).map(normalizePaper)));
      setSearchResults(papers);
      if (!papers[0]) {
        activePaperKeyRef.current = { ...activePaperKeyRef.current, search: '' };
        setEmbeddedPdf((prev) => ({ ...prev, search: null }));
        setSnapshots((prev) => ({ ...prev, search: null }));
        setActivePaper((prev) => ({ ...prev, search: null }));
      }
      setStatusText('');
    } catch (error) {
      activePaperKeyRef.current = { ...activePaperKeyRef.current, search: '' };
      setSearchResults([]);
      setEmbeddedPdf((prev) => ({ ...prev, search: null }));
      setSnapshots((prev) => ({ ...prev, search: null }));
      setActivePaper((prev) => ({ ...prev, search: null }));
      setStatusText(toUserErrorMessage(error, '搜索失败'));
    } finally {
      setIsSearching(false);
    }
  }

  async function handleToggleFavorite(context) {
    const paper = normalizePaper({
      ...(activePaper[context] || {}),
      ...(snapshots[context]?.brief || {}),
      ...(snapshots[context]?.head || {}),
      group_id: activeGroupId !== 'all' ? activeGroupId : defaultFavoriteGroupId,
    });
    if (!getFavoriteKey(paper)) return;
    const result = await window.ohMyPaper.favoritesToggle(paper);
    setFavorites((result.favorites || []).map(normalizePaper));
    setFavoriteGroups(result.favoriteGroups || favoriteGroups);
    if (context === 'library' && result?.isFavorite === false) {
      setActivePaper((prev) => ({ ...prev, library: null }));
      setSnapshots((prev) => ({ ...prev, library: null }));
    }
  }

  async function handleImportLocalPdf() {
    setStatusText('正在导入本地 PDF…');
    try {
      const result = await window.ohMyPaper.importLocalPdf({
        groupId: activeGroupId !== 'all' ? activeGroupId : defaultFavoriteGroupId,
      });
      if (result?.canceled) {
        setStatusText('');
        return;
      }
      const nextFavorites = (result.favorites || []).map(normalizePaper);
      setFavorites(nextFavorites);
      setFavoriteGroups(result.favoriteGroups || favoriteGroups);
      const importedCount = Number(result?.importedCount || (Array.isArray(result?.importedItems) ? result.importedItems.length : result?.imported ? 1 : 0));
      const failedCount = Number(result?.failedCount || (Array.isArray(result?.failedItems) ? result.failedItems.length : 0));
      let statusMessage = '';
      if (importedCount > 0) {
        const statusParts = [`已导入 ${importedCount} 个 PDF`];
        if (failedCount > 0) {
          statusParts.push(`${failedCount} 个失败`);
        }
        statusMessage = statusParts.join('，');
      } else {
        statusMessage = failedCount > 0 ? `导入失败 ${failedCount} 个 PDF` : '';
      }
      const firstImported = result?.imported || result?.importedItems?.[0];
      if (firstImported) {
        await openPaper('library', normalizePaper(firstImported));
      }
      setStatusText(statusMessage);
    } catch (error) {
      setStatusText(toUserErrorMessage(error, '导入本地 PDF 失败'));
    }
  }

  async function handleCreateFavoriteGroup() {
    if (!showGroupCreator) {
      setShowGroupCreator(true);
      setNewGroupName('');
      return;
    }
    const name = newGroupName.trim();
    if (!name) return;
    setStatusText('正在创建分组…');
    try {
      const result = await window.ohMyPaper.createFavoriteGroup(name);
      setFavoriteGroups(result.favoriteGroups || []);
      setNewGroupName('');
      setShowGroupCreator(false);
      if (result?.group?.id) {
        setActiveGroupId(result.group.id);
      }
    } finally {
      setStatusText('');
    }
  }

  function handleStartRenameGroup(group) {
    if (!group?.id) return;
    setEditingGroupId(group.id);
    setEditingGroupName(group.name || '');
  }

  function handleCancelRenameGroup() {
    setEditingGroupId('');
    setEditingGroupName('');
  }

  async function handleRenameFavoriteGroup(groupId = editingGroupId) {
    if (!groupId) return;
    const name = editingGroupName.trim();
    if (!name) return;
    setStatusText('正在重命名分组…');
    try {
      const result = await window.ohMyPaper.renameFavoriteGroup({ groupId, name });
      setFavoriteGroups(result.favoriteGroups || []);
      setEditingGroupId('');
      setEditingGroupName('');
    } finally {
      setStatusText('');
    }
  }

  async function handleSetFavoriteGroup(favoriteKey, groupId) {
    const result = await window.ohMyPaper.setFavoriteGroup({ favoriteKey, groupId });
    setFavorites((result.favorites || []).map(normalizePaper));
    setFavoriteGroups(result.favoriteGroups || favoriteGroups);
  }

  async function handleSaveToken() {
    setStatusText('正在保存 Token…');
    try {
      const nextToken = await window.ohMyPaper.saveToken(tokenInput);
      setToken(nextToken);
      setStatusText('Token 已保存');
    } catch (error) {
      setStatusText(toUserErrorMessage(error, '保存 Token 失败'));
    }
  }

  async function handleRegisterToken() {
    try {
      await performAnonymousRegistration();
    } catch (error) {
    }
  }

  async function persistAiConfig(nextConfig = aiConfigForm, options = {}) {
    const silentStatus = options.silentStatus === true;
    setIsSavingAiConfig(true);
    if (!silentStatus) {
      setStatusText('正在保存 AI 配置…');
    }
    try {
      const saved = await window.ohMyPaper.saveAiConfig(nextConfig);
      const normalized = normalizeAiConfig(saved?.config || {});
      const nextStatus = normalizeAiConfigStatus(saved?.status, normalized);
      setAiConfig(normalized);
      setAiConfigForm(normalized);
      setAiConfigStatus(nextStatus);
      const message = nextStatus.ok ? 'AI 配置已保存并验证通过' : `AI 配置已保存，但当前不可用：${nextStatus.message}`;
      if (!silentStatus) {
        setStatusText(message);
      }
      return { config: normalized, status: nextStatus };
    } catch (error) {
      const message = toUserErrorMessage(error, '保存 AI 配置失败');
      if (!silentStatus) {
        setStatusText(message);
      }
      throw error;
    } finally {
      setIsSavingAiConfig(false);
    }
  }

  async function handleSaveAiConfig() {
    try {
      await persistAiConfig();
    } catch (error) {
    }
  }

  function handleResetAiConfig() {
    setAiConfigForm(normalizeAiConfig());
  }

  function updateAiFormField(key, value) {
    setAiConfigForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateAiProviderField(key, value) {
    setAiConfigForm((prev) => ({ ...prev, provider: { ...prev.provider, [key]: value } }));
  }

  function updateEmbeddedPdfViewer(context, updater) {
    setEmbeddedPdf((prev) => {
      const currentViewer = prev[context];
      const nextViewer = typeof updater === 'function' ? updater(currentViewer) : updater;
      return {
        ...prev,
        [context]: nextViewer?.target ? nextViewer : null,
      };
    });
  }

  function closeEmbeddedPdf(context) {
    bumpContextRequest(pdfOpenRequestRef, context);
    updateEmbeddedPdfViewer(context, null);
  }

  const handlePdfViewerStateChange = useCallback((context, rawState) => {
    const normalized = normalizePdfViewerState(rawState);
    if (!normalized.paperKey) return;
    if (activePaperKeyRef.current[context] && activePaperKeyRef.current[context] !== normalized.paperKey) {
      return;
    }
    mergePdfViewerState(normalized);
  }, [mergePdfViewerState]);

  async function handleAskAI(payload) {
    setStatusText('AI 正在结合论文上下文思考…');
    try {
      return await window.ohMyPaper.aiChat(payload);
    } catch (error) {
      throw new Error(toUserErrorMessage(error, 'AI 请求失败'));
    } finally {
      setStatusText('');
    }
  }

  async function handleRemoveFavorite(paperId) {
    const result = await window.ohMyPaper.favoriteRemove(paperId);
    setFavorites((result.favorites || []).map(normalizePaper));
    setFavoriteGroups(result.favoriteGroups || favoriteGroups);
    if (getFavoriteKey(activePaper.library) === paperId) {
      activePaperKeyRef.current = { ...activePaperKeyRef.current, library: '' };
      setEmbeddedPdf((prev) => ({ ...prev, library: null }));
      setActivePaper((prev) => ({ ...prev, library: null }));
      setSnapshots((prev) => ({ ...prev, library: null }));
    }
  }

  async function handleOpenHistory(entry, itemKey) {
    const payload = entry?.payload || {};
    const paper = normalizePaper(payload);
    if (!paper.arxiv_id && !paper.openalex_id && !paper.europepmc_id && !paper.external_url && !paper.local_pdf_path) return;
    setActiveHistoryKey(itemKey);
    await openPaper('history', paper, { trackHistory: false });
  }

  async function openPaperAsset(context, snapshot, paper) {
    const payload = buildPdfPrefetchPayload(snapshot, paper);
    if (!payload) {
      setStatusText('当前论文暂未提供可打开的 PDF');
      return;
    }
    const paperKey = getPaperSessionKey(snapshot, paper);
    const requestId = bumpContextRequest(pdfOpenRequestRef, context);
    const readyStatus = getPdfStatus(snapshot, paper);
    try {
      mergePdfViewerState({
        paperKey,
        state: 'loading',
        message: '正在打开 PDF…',
      });
      const resolved = readyStatus?.state === 'ready' ? readyStatus : await resolvePdfOpenForPaper(snapshot, paper);
      if (!isLatestContextRequest(pdfOpenRequestRef, context, requestId)) return;
      if (activePaperKeyRef.current[context] && activePaperKeyRef.current[context] !== paperKey) return;
      if (resolved?.state !== 'ready') {
        mergePdfViewerState({
          paperKey,
          state: 'error',
          error: resolved?.message || '当前论文暂未提供可打开的 PDF',
          message: resolved?.message || '当前论文暂未提供可打开的 PDF',
        });
        setStatusText(toUserErrorMessage({ message: resolved?.message || '当前论文暂未提供可打开的 PDF' }, '打开 PDF 失败'));
        return;
      }
      const openTarget = resolved?.cachedPath || resolved?.openTarget || payload.local_pdf_path || payload.target;
      if (!openTarget) {
        mergePdfViewerState({
          paperKey,
          state: 'error',
          error: '当前论文暂未提供可打开的 PDF',
          message: '当前论文暂未提供可打开的 PDF',
        });
        setStatusText('当前论文暂未提供可打开的 PDF');
        return;
      }
      const viewerPayload = {
        ...payload,
        target: openTarget,
        local_pdf_path: resolved?.cachedPath || payload.local_pdf_path,
        pdf_url: resolved?.sourceUrl || payload.pdf_url,
      };
      updateEmbeddedPdfViewer(context, {
        target: openTarget,
        title: snapshot?.brief?.title || snapshot?.head?.title || paper?.title || '论文 PDF',
        paperKey,
        requestId,
        payload: viewerPayload,
      });
      setStatusText('');
    } catch (error) {
      if (!isLatestContextRequest(pdfOpenRequestRef, context, requestId)) return;
      if (activePaperKeyRef.current[context] && activePaperKeyRef.current[context] !== paperKey) return;
      mergePdfViewerState({
        paperKey,
        state: 'error',
        error: toUserErrorMessage(error, '打开 PDF 失败'),
        message: toUserErrorMessage(error, '打开 PDF 失败'),
      });
      setStatusText(toUserErrorMessage(error, '打开 PDF 失败'));
    }
  }

  const loadEmbeddedPdfDocument = useCallback(async (payload) => {
    return window.ohMyPaper.loadPdfDocument(payload);
  }, []);

  const handleSearchPdfViewerStateChange = useCallback((state) => {
    handlePdfViewerStateChange('search', state);
  }, [handlePdfViewerStateChange]);

  const handleLibraryPdfViewerStateChange = useCallback((state) => {
    handlePdfViewerStateChange('library', state);
  }, [handlePdfViewerStateChange]);

  const handleHistoryPdfViewerStateChange = useCallback((state) => {
    handlePdfViewerStateChange('history', state);
  }, [handlePdfViewerStateChange]);

  const tokenStatusLabel = token?.has_token ? '已就绪' : '未配置';
  const tokenStatusHint = token?.has_token ? (token?.daily_limit ? `每日额度 ${token.daily_limit}` : '可立即搜索与阅读') : '启动时会自动匿名注册，也可在此重新连接';
  const aiStatusLabel = aiConfigStatus?.ok
    ? 'AI 已就绪'
    : (aiConfig?.provider?.requiresOpenAIAuth && !aiConfig?.openAIApiKey ? 'AI 未配置' : 'AI 不可用');
  const aiStatusHint = aiConfigStatus?.ok
    ? (aiConfigStatus?.message || `${aiConfig.provider.name} · ${aiConfig.model}`)
    : (aiConfigStatus?.message || '请先填写 OPENAI_API_KEY');
  const aiIndicator = aiConfigStatus?.ok ? '✓' : '✕';
  const aiIndicatorClass = aiConfigStatus?.ok ? 'success' : 'error';

  function bumpContextRequest(ref, context) {
    const next = (ref.current[context] || 0) + 1;
    ref.current = { ...ref.current, [context]: next };
    return next;
  }

  function isLatestContextRequest(ref, context, requestId) {
    return ref.current[context] === requestId;
  }

  function aiPanelLayoutStyle(context) {
    if (!embeddedPdf[context]?.target) {
      return undefined;
    }
    return {
      '--ai-panel-width': `${clampAiPanelWidth(aiPanelWidths[context])}px`,
      '--ai-panel-min-width': `${AI_PANEL_MIN_WIDTH}px`,
    };
  }

  function resizeAiPanelTo(context, nextWidth, maxWidth = AI_PANEL_MAX_WIDTH) {
    setAiPanelWidths((prev) => ({
      ...prev,
      [context]: clampAiPanelWidth(nextWidth, maxWidth),
    }));
  }

  function handleAiPanelResizeStart(context, event) {
    if (!embeddedPdf[context]?.target) return;
    if (event.button != null && event.button !== 0) return;

    const layout = event.currentTarget.closest('.split-layout');
    const rect = layout?.getBoundingClientRect();
    if (!rect) return;

    const maxWidth = Math.max(
      AI_PANEL_MIN_WIDTH,
      Math.min(AI_PANEL_MAX_WIDTH, rect.width - AI_PANEL_DETAIL_MIN_WIDTH),
    );
    const updateWidth = (clientX) => resizeAiPanelTo(context, clientX - rect.left, maxWidth);
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      document.documentElement.classList.remove('is-ai-panel-resizing');
    };
    const handlePointerMove = (moveEvent) => {
      moveEvent.preventDefault();
      updateWidth(moveEvent.clientX);
    };

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.documentElement.classList.add('is-ai-panel-resizing');
    updateWidth(event.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
  }

  function handleAiPanelResizeKeyDown(context, event) {
    if (!embeddedPdf[context]?.target) return;
    const step = event.shiftKey ? 48 : 24;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      resizeAiPanelTo(context, (aiPanelWidths[context] || AI_PANEL_DEFAULT_WIDTH) - step);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      resizeAiPanelTo(context, (aiPanelWidths[context] || AI_PANEL_DEFAULT_WIDTH) + step);
    }
    if (event.key === 'Home') {
      event.preventDefault();
      resizeAiPanelTo(context, AI_PANEL_MIN_WIDTH);
    }
    if (event.key === 'End') {
      event.preventDefault();
      resizeAiPanelTo(context, AI_PANEL_MAX_WIDTH);
    }
  }

  function renderAiPanelResizeHandle(context) {
    if (!embeddedPdf[context]?.target) {
      return null;
    }
    return (
      <div
        className="ai-panel-resize-handle"
        role="separator"
        aria-label="调整 AI 助手宽度"
        aria-orientation="vertical"
        tabIndex={0}
        title="拖动调整 AI 助手宽度，双击恢复默认"
        onPointerDown={(event) => handleAiPanelResizeStart(context, event)}
        onKeyDown={(event) => handleAiPanelResizeKeyDown(context, event)}
        onDoubleClick={() => resizeAiPanelTo(context, AI_PANEL_DEFAULT_WIDTH)}
      >
        <span />
      </div>
    );
  }

  const liveStatusText = statusText || (
    page === 'search'
      ? `${selectedSearchSource.label} · ${showSearchLimit ? `最多 ${searchLimit} 条结果` : '直接打开目标'}`
      : page === 'library'
        ? `当前视图 ${visibleFavorites.length} 篇论文`
        : page === 'history'
          ? `最近访问 ${history.length} 条`
          : `${tokenStatusLabel} · ${aiStatusLabel}`
  );

  function renderContextAiPanel(context, emptyText) {
    const viewer = embeddedPdf[context];
    const contextSnapshot = snapshots[context];
    const contextPaper = activePaper[context] || (viewer?.payload ? normalizePaper(viewer.payload) : null);
    const effectiveSnapshot = contextSnapshot || (contextPaper ? makeExternalSnapshot(contextPaper) : null);

    if (!effectiveSnapshot) {
      return <EmptyState text={emptyText} />;
    }

    return (
      <AIChatPanel
        snapshot={effectiveSnapshot}
        paper={contextPaper}
        pdfStatus={getPdfStatus(effectiveSnapshot, contextPaper)}
        pdfViewerState={getPdfViewerState(effectiveSnapshot, contextPaper)}
        embeddedPdf={viewer}
        aiConfig={aiConfig}
        aiConfigStatus={aiConfigStatus}
        onAskAI={handleAskAI}
        messages={getAiConversationMessages(effectiveSnapshot, contextPaper)}
        onMessagesChange={(messages) => setAiConversationMessages(effectiveSnapshot, contextPaper, messages)}
      />
    );
  }

  if (showOnboarding) {
    return (
      <OnboardingView
        token={token}
        tokenStatusLabel={tokenStatusLabel}
        tokenStatusHint={tokenStatusHint}
        tokenIndicator={tokenIndicator}
        tokenIndicatorClass={tokenIndicatorClass}
        aiConfigForm={aiConfigForm}
        aiConfigStatus={aiConfigStatus}
        aiStatusLabel={aiStatusLabel}
        aiStatusHint={aiStatusHint}
        aiIndicator={aiIndicator}
        aiIndicatorClass={aiIndicatorClass}
        isInitializing={isInitializing}
        isAutoRegistering={isAutoRegistering}
        isSavingAiConfig={isSavingAiConfig}
        onboardingMessage={onboardingMessage}
        showOnboardingAiForm={showOnboardingAiForm}
        onToggleAiForm={() => setShowOnboardingAiForm((prev) => !prev)}
        onRetryConnection={() => performAnonymousRegistration()}
        onContinue={() => {
          setShowOnboarding(false);
          setStatusText('');
          setPage('search');
        }}
        onResetAiConfig={handleResetAiConfig}
        onSaveAiConfig={handleSaveAiConfig}
        updateAiFormField={updateAiFormField}
      />
    );
  }

  return (
    <div className="app-shell">
      <AppBackground />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">OM</div>
          <div className="brand-copy">
            <h1>OhMyPaper</h1>
            <p>Desktop Client</p>
          </div>
        </div>

        <div className="token-card status-card">
          <div className="sidebar-label">连接与 AI</div>
          <div className="status-card-section">
            <div className="status-card-heading">账号连接</div>
            <div className="token-card-row">
              <div className="token-card-copy">
                <div className="token-label">连接 Token</div>
                <div className="token-state">{tokenStatusLabel}</div>
              </div>
              <div className={`token-indicator ${tokenIndicatorClass}`} title={token?.has_token ? 'Token 可用' : 'Token 未配置'}>{tokenIndicator}</div>
            </div>
            <div className="token-value">{tokenStatusHint}</div>
          </div>
          <div className="status-card-divider" />
          <div className="status-card-section">
            <div className="status-card-heading">AI 状态</div>
            <div className="sidebar-footer-row">
              <div className={`token-indicator ${aiIndicatorClass}`} title={aiStatusHint}>{aiIndicator}</div>
              <div className="sidebar-footer-copy">
                <div className="sidebar-footer-label">{aiStatusLabel}</div>
                <div className="sidebar-footer-meta">{aiConfig?.provider?.name || aiConfig?.modelProvider || 'fox'} · {aiConfig?.model || 'gpt-5.4'}</div>
              </div>
            </div>
            <div className="sidebar-footer-hint">{aiStatusHint}</div>
          </div>
        </div>

        <nav className="nav">
          {Object.entries(PAGE_META).map(([key, meta]) => (
            <button key={key} className={`nav-btn ${page === key ? 'active' : ''}`} onClick={() => setPage(key)}>
              <span className="nav-icon" aria-hidden="true">{PAGE_DECOR[key]?.icon || '•'}</span>
              <span className="nav-copy">
                <span className="nav-title">{meta.title}</span>
                <span className="nav-subtitle">{PAGE_DECOR[key]?.note || meta.subtitle}</span>
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="content">
        {page === 'settings' ? (
          <header className="topbar card">
            <div className="topbar-copy">
              <div className="topbar-title-row">
                <h2>{pageMeta.title}</h2>
              </div>
              <p>{pageMeta.subtitle}</p>
            </div>
            <div className="topbar-status">
              <div className={`status-pill ${statusText ? 'active' : ''}`}>{liveStatusText}</div>
            </div>
          </header>
        ) : (
          <div className="page-header-plain">
            <div className="page-header-copy">
              <h2>{pageMeta.title}</h2>
              <p>{pageMeta.subtitle}</p>
            </div>
            <div className="page-header-status">
              <div className={`status-pill ${statusText ? 'active' : ''}`}>{liveStatusText}</div>
            </div>
          </div>
        )}

        {page === 'search' && (
          <section className="page active">
            <div className="toolbar card">
              <input className="input grow search-query-input" placeholder={searchPlaceholder} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && handleSearch()} />
              <select className="select search-source-select" value={searchSourceScope} onChange={(event) => setSearchSourceScope(event.target.value)}>
                {SEARCH_SOURCE_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
              {showSearchLimit && (
                <input className="input small" type="number" min="1" max="50" value={searchLimit} onChange={(event) => setSearchLimit(event.target.value)} />
              )}
              <button className="btn primary" onClick={handleSearch}>{searchActionLabel}</button>
            </div>
            <div className="mode-hint">{selectedSearchSource.label}：{selectedSearchSource.help}</div>
            <div className={`split-layout ${embeddedPdf.search?.target ? 'ai-resizable-layout' : ''}`} style={aiPanelLayoutStyle('search')}>
              <div className={`card list-panel ${embeddedPdf.search?.target ? 'ai-list-panel' : ''}`}>
                {embeddedPdf.search?.target ? renderContextAiPanel('search', '请选择一篇论文。') : (
                  <ResultList
                    items={searchResults}
                    activeId={activePaper.search?.paper_key}
                    onSelect={(paper) => openPaper('search', paper)}
                    isLoading={isSearching}
                    loadingText="正在搜索论文..."
                    emptyText="暂无结果"
                  />
                )}
                {renderAiPanelResizeHandle('search')}
              </div>
              <div className="card detail-panel">
                <DetailView
                  snapshot={snapshots.search}
                  paper={activePaper.search}
                  isFavorite={favoriteKeys.has(getFavoriteKey(activePaper.search))}
                  canFavorite={Boolean(activePaper.search?.supports_favorite)}
                  onToggleFavorite={() => handleToggleFavorite('search')}
                  onOpenPdf={() => openPaperAsset('search', snapshots.search, activePaper.search)}
                  emptyText="请选择一篇论文。"
                  aiConfig={aiConfig}
                  aiConfigStatus={aiConfigStatus}
                  onAskAI={handleAskAI}
                  embeddedPdf={embeddedPdf.search}
                  onClosePdf={() => closeEmbeddedPdf('search')}
                  aiMessages={getAiConversationMessages(snapshots.search, activePaper.search)}
                  onAiMessagesChange={(messages) => setAiConversationMessages(snapshots.search, activePaper.search, messages)}
                  pdfStatus={getPdfStatus(snapshots.search, activePaper.search)}
                  pdfViewerState={getPdfViewerState(snapshots.search, activePaper.search)}
                  onLoadPdfDocument={loadEmbeddedPdfDocument}
                  onPdfViewerStateChange={handleSearchPdfViewerStateChange}
                />
              </div>
            </div>
          </section>
        )}

        {page === 'library' && (
          <section className="page active">
            <div className={`split-layout ${embeddedPdf.library?.target ? 'ai-resizable-layout' : ''}`} style={aiPanelLayoutStyle('library')}>
              <div className={`card list-panel ${embeddedPdf.library?.target ? 'ai-list-panel' : ''}`}>
                {embeddedPdf.library?.target ? renderContextAiPanel('library', '请选择一篇收藏论文。') : (
                  <div className="favorites-shell">
                    <div className="favorite-groups-panel">
                      <div className="favorite-groups-toolbar">
                        <div className="favorite-groups-row">
                          <button className={`group-chip ${activeGroupId === 'all' ? 'active' : ''}`} onClick={() => setActiveGroupId('all')}>
                            全部
                            <span>{favoriteGroupCounts.all || 0}</span>
                          </button>
                          {favoriteGroups.map((group) => (
                            editingGroupId === group.id ? (
                              <input
                                key={group.id}
                                className="input group-chip-input"
                                autoFocus
                                value={editingGroupName}
                                onChange={(event) => setEditingGroupName(event.target.value)}
                                onBlur={() => handleRenameFavoriteGroup(group.id)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    handleRenameFavoriteGroup(group.id);
                                  }
                                  if (event.key === 'Escape') {
                                    handleCancelRenameGroup();
                                  }
                                }}
                              />
                            ) : (
                              <button
                                key={group.id}
                                className={`group-chip ${activeGroupId === group.id ? 'active' : ''}`}
                                onClick={() => setActiveGroupId(group.id)}
                                onDoubleClick={() => handleStartRenameGroup(group)}
                              >
                                {group.name}
                                <span>{favoriteGroupCounts[group.id] || 0}</span>
                              </button>
                            )
                          ))}
                        </div>
                        <div className="favorite-groups-actions">
                          <button className="btn primary import-pdf-btn" onClick={handleImportLocalPdf}>批量导入 PDF</button>
                          <button className="btn group-create-btn" onClick={handleCreateFavoriteGroup}>{showGroupCreator ? '确认创建' : '新建分组'}</button>
                        </div>
                      </div>
                      {showGroupCreator && (
                        <div className="favorite-group-editor">
                          <div className="favorite-group-create">
                            <input
                              className="input"
                              autoFocus
                              placeholder="输入新分组名称"
                              value={newGroupName}
                              onChange={(event) => setNewGroupName(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  handleCreateFavoriteGroup();
                                }
                                if (event.key === 'Escape') {
                                  setShowGroupCreator(false);
                                  setNewGroupName('');
                                }
                              }}
                            />
                            <button className="btn" onClick={() => { setShowGroupCreator(false); setNewGroupName(''); }}>取消</button>
                          </div>
                        </div>
                      )}
                    </div>
                    {visibleFavorites.length ? (
                      <div className="result-list">
                        {visibleFavorites.map((paper) => {
                          const favoriteKey = getFavoriteKey(paper);
                          const meta = [paper.author_line || '', paper.publish_at || '', paper.source_label || ''].filter(Boolean).join(' · ');
                          return (
                            <div key={favoriteKey || paper.paper_key} className={`result-item ${getFavoriteKey(activePaper.library) === favoriteKey ? 'active' : ''}`}>
                              <button className="result-button" onClick={() => openPaper('library', paper)}>
                                <div className="result-title">
                                  <TitleWithSource title={paper.title || favoriteKey || 'Untitled'} sourceKind={paper.source_kind} sourceLabel={paper.source_label} />
                                </div>
                                <div className="result-meta">{meta || '暂无信息'}</div>
                              </button>
                              <div className="favorite-item-actions">
                                <select className="select favorite-group-select" value={paper.group_id || defaultFavoriteGroupId} onChange={(event) => handleSetFavoriteGroup(favoriteKey, event.target.value)}>
                                  {favoriteGroups.map((group) => (
                                    <option key={group.id} value={group.id}>{group.name}</option>
                                  ))}
                                </select>
                                <button className="mini-btn" onClick={() => handleRemoveFavorite(favoriteKey)}>移除</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : <EmptyState text={favorites.length ? '当前分组暂无论文。' : '暂无收藏，可先导入本地 PDF 或收藏搜索结果。'} />}
                  </div>
                )}
                {renderAiPanelResizeHandle('library')}
              </div>

              <div className="card detail-panel">
                <DetailView
                  snapshot={snapshots.library}
                  paper={activePaper.library}
                  isFavorite={favoriteKeys.has(getFavoriteKey(activePaper.library))}
                  canFavorite={Boolean(activePaper.library?.supports_favorite)}
                  onToggleFavorite={() => handleToggleFavorite('library')}
                  onOpenPdf={() => openPaperAsset('library', snapshots.library, activePaper.library)}
                  emptyText="请选择一篇收藏论文。"
                  aiConfig={aiConfig}
                  aiConfigStatus={aiConfigStatus}
                  onAskAI={handleAskAI}
                  embeddedPdf={embeddedPdf.library}
                  onClosePdf={() => closeEmbeddedPdf('library')}
                  aiMessages={getAiConversationMessages(snapshots.library, activePaper.library)}
                  onAiMessagesChange={(messages) => setAiConversationMessages(snapshots.library, activePaper.library, messages)}
                  pdfStatus={getPdfStatus(snapshots.library, activePaper.library)}
                  pdfViewerState={getPdfViewerState(snapshots.library, activePaper.library)}
                  onLoadPdfDocument={loadEmbeddedPdfDocument}
                  onPdfViewerStateChange={handleLibraryPdfViewerStateChange}
                />
              </div>
            </div>
          </section>
        )}

        {page === 'history' && (
          <section className="page active">
            <div className={`split-layout ${embeddedPdf.history?.target ? 'ai-resizable-layout' : ''}`} style={aiPanelLayoutStyle('history')}>
              <div className={`card list-panel ${embeddedPdf.history?.target ? 'ai-list-panel' : ''}`}>
                {embeddedPdf.history?.target ? renderContextAiPanel('history', '请选择一篇最近访问的论文。') : (
                  <HistoryList items={history} activeKey={activeHistoryKey} onSelect={handleOpenHistory} emptyText="暂无记录" />
                )}
                {renderAiPanelResizeHandle('history')}
              </div>
              <div className="card detail-panel">
                <DetailView
                  snapshot={snapshots.history}
                  paper={activePaper.history}
                  isFavorite={favoriteKeys.has(getFavoriteKey(activePaper.history))}
                  canFavorite={Boolean(activePaper.history?.supports_favorite)}
                  onToggleFavorite={() => handleToggleFavorite('history')}
                  onOpenPdf={() => openPaperAsset('history', snapshots.history, activePaper.history)}
                  emptyText="请选择一篇最近访问的论文。"
                  aiConfig={aiConfig}
                  aiConfigStatus={aiConfigStatus}
                  onAskAI={handleAskAI}
                  embeddedPdf={embeddedPdf.history}
                  onClosePdf={() => closeEmbeddedPdf('history')}
                  aiMessages={getAiConversationMessages(snapshots.history, activePaper.history)}
                  onAiMessagesChange={(messages) => setAiConversationMessages(snapshots.history, activePaper.history, messages)}
                  pdfStatus={getPdfStatus(snapshots.history, activePaper.history)}
                  pdfViewerState={getPdfViewerState(snapshots.history, activePaper.history)}
                  onLoadPdfDocument={loadEmbeddedPdfDocument}
                  onPdfViewerStateChange={handleHistoryPdfViewerStateChange}
                />
              </div>
            </div>
          </section>
        )}

        {page === 'settings' && (
          <section className="page active">
            <div className="settings-grid settings-grid-wide">
              <div className="card settings-card">
                <h3>Token 设置</h3>
                <div className="settings-status-row">
                  <div className={`token-indicator ${tokenIndicatorClass}`} title={token?.has_token ? 'Token 可用' : 'Token 未配置'}>{tokenIndicator}</div>
                  <div className="settings-status-copy">
                    <div className="settings-status-label">{tokenStatusLabel}</div>
                    <div className="settings-status-hint">{tokenStatusHint}</div>
                  </div>
                </div>
                <input className="input" placeholder="粘贴 DEEPXIV_TOKEN" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} />
                <div className="btn-row">
                  <button className="btn" onClick={handleSaveToken}>保存</button>
                  <button className="btn primary" onClick={handleRegisterToken}>重新匿名注册</button>
                  <button className="btn" onClick={handleRefreshStatus}>刷新状态</button>
                </div>
              </div>

              <div className="card settings-card">
                <h3>AI 助手</h3>
                <div className="settings-status-row">
                  <div className={`token-indicator ${aiIndicatorClass}`} title={aiStatusHint}>{aiIndicator}</div>
                  <div className="settings-status-copy">
                    <div className="settings-status-label">{aiStatusLabel}</div>
                    <div className="settings-status-hint">{aiStatusHint}</div>
                  </div>
                </div>

                <div className="form-grid">
                  <label className="form-field">
                    <span>model_provider</span>
                    <input className="input" value={aiConfigForm.modelProvider} onChange={(event) => updateAiFormField('modelProvider', event.target.value)} />
                  </label>
                  <label className="form-field">
                    <span>provider.name</span>
                    <input className="input" value={aiConfigForm.provider.name} onChange={(event) => updateAiProviderField('name', event.target.value)} />
                  </label>
                  <label className="form-field form-field-wide">
                    <span>provider.base_url</span>
                    <input className="input" value={aiConfigForm.provider.baseUrl} onChange={(event) => updateAiProviderField('baseUrl', event.target.value)} />
                  </label>
                  <label className="form-field">
                    <span>provider.wire_api</span>
                    <select className="select" value={aiConfigForm.provider.wireApi} onChange={(event) => updateAiProviderField('wireApi', event.target.value)}>
                      <option value="responses">responses</option>
                    </select>
                  </label>
                  <label className="form-field">
                    <span>model</span>
                    <input className="input" value={aiConfigForm.model} onChange={(event) => updateAiFormField('model', event.target.value)} list="model-options" />
                    <datalist id="model-options">
                      <option value="gpt-5.4" />
                      <option value="gpt-5.4-fast" />
                      <option value="gpt-5-codex" />
                    </datalist>
                  </label>
                  <label className="form-field">
                    <span>reasoning_effort</span>
                    <select className="select" value={aiConfigForm.modelReasoningEffort} onChange={(event) => updateAiFormField('modelReasoningEffort', event.target.value)}>
                      {AI_REASONING_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </label>
                  <label className="form-field checkbox-field">
                    <input type="checkbox" checked={aiConfigForm.disableResponseStorage} onChange={(event) => updateAiFormField('disableResponseStorage', event.target.checked)} />
                    <span>disable_response_storage</span>
                  </label>
                  <label className="form-field checkbox-field">
                    <input type="checkbox" checked={aiConfigForm.provider.requiresOpenAIAuth} onChange={(event) => updateAiProviderField('requiresOpenAIAuth', event.target.checked)} />
                    <span>requires_openai_auth</span>
                  </label>
                  <label className="form-field form-field-wide">
                    <span>OPENAI_API_KEY</span>
                    <input className="input" type="password" placeholder="sk-..." value={aiConfigForm.openAIApiKey} onChange={(event) => updateAiFormField('openAIApiKey', event.target.value)} />
                  </label>
                </div>

                <div className="btn-row">
                  <button className="btn primary" onClick={handleSaveAiConfig}>保存 AI 配置</button>
                  <button className="btn" onClick={handleResetAiConfig}>恢复默认</button>
                </div>
              </div>

              <div className="card settings-card">
                <h3>主题配色</h3>
                <div className="settings-status-row">
                  <div className="settings-status-copy">
                    <div className="settings-status-label">当前主题</div>
                    <div className="settings-status-hint">{THEME_OPTIONS.find((item) => item.value === theme)?.label || '原始蓝紫'}</div>
                  </div>
                </div>
                <div className="theme-options">
                  {THEME_OPTIONS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={`theme-option ${theme === item.value ? 'active' : ''}`}
                      aria-pressed={theme === item.value}
                      onClick={() => setTheme(item.value)}
                    >
                      <span className="theme-swatch" aria-hidden="true">
                        {item.colors.map((color) => <span key={color} style={{ background: color }} />)}
                      </span>
                      <span className="theme-option-copy">
                        <span className="theme-option-title">{item.label}</span>
                        <span className="theme-option-note">{item.note}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

            </div>
          </section>
        )}
      </main>
    </div>
  );
}
