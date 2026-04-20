import { useEffect, useMemo, useState } from 'react';

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
  settings: { title: '设置', subtitle: '配置 DeepXiv Token 与 AI 助手' }
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
  { value: 'high', label: 'high' },
  { value: 'medium', label: 'medium' },
  { value: 'low', label: 'low' },
  { value: 'minimal', label: 'minimal' }
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

const AI_CHAT_STORAGE_KEY = 'deepxiv-ai-chat-histories-v1';

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
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '').replace(/^Error: /, '').trim() || fallback;
}

function looksLikePdfUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  return value.includes('.pdf') || value.includes('/pdf/') || value.includes('arxiv.org/pdf/');
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
      content: String(message?.content || '').trim(),
      isError: message?.isError === true,
      thinkingState: message?.thinkingState === 'done' ? 'done' : (message?.thinkingState === 'thinking' ? 'thinking' : ''),
      reasoningSummary: String(message?.reasoningSummary || '').trim(),
      reasoningSteps: Array.isArray(message?.reasoningSteps)
        ? message.reasoningSteps
            .map((step, stepIndex) => ({
              id: String(step?.id || `reasoning-${index + 1}-${stepIndex + 1}`),
              text: String(step?.text || '').trim(),
            }))
            .filter((step) => step.text)
        : [],
    }))
    .filter((message) => message.content)
    .slice(-40);
}

function loadAiChatStore() {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(AI_CHAT_STORAGE_KEY) || '{}');
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
    error: String(next.error || '').trim(),
  };
}

function formatPdfPrefetchMessage(status) {
  if (!status) return '';
  if (status.isLocal) return '本地 PDF，打开最快';
  if (status.state === 'ready' && status.cachedPath) return status.message || 'PDF 已缓存，下次打开更快';
  if (status.state === 'downloading') {
    return status.message || (status.progress > 0 ? `正在缓存 PDF… ${Math.round(status.progress * 100)}%` : '正在缓存 PDF…');
  }
  if (status.state === 'error') {
    return status.message || 'PDF 缓存失败，已回退直连打开';
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
    external_url: externalUrl,
    pdf_url: pdfUrl,
    local_pdf_path: localPdfPath,
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
  const candidates = [head.pdf_url, brief.pdf_url, paper.pdf_url, head.src_url, brief.src_url];
  for (const candidate of candidates) {
    const url = String(candidate || '').trim();
    if (url && looksLikePdfUrl(url)) {
      if (paper.arxiv_id && url.includes('/pdf/') && !url.endsWith('.pdf')) {
        return `${url}.pdf`;
      }
      return url;
    }
  }
  if (paper.arxiv_id) {
    return `https://arxiv.org/pdf/${paper.arxiv_id}.pdf`;
  }
  const pmcid = String(head.pmcid || brief.pmcid || paper.pmcid || '').trim().toUpperCase();
  if (pmcid.startsWith('PMC')) {
    return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/`;
  }
  return '';
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

function toEmbeddedPdfUrl(target) {
  const value = String(target || '').trim();
  if (!value) return '';
  if (isRemoteHttpUrl(value)) return value;
  return encodeURI(`file://${value}`);
}

function buildEmbeddedPdfSrc(target) {
  const base = toEmbeddedPdfUrl(target).split('#')[0];
  return base || '';
}

function buildPdfPrefetchPayload(snapshot, rawPaper) {
  const paper = normalizePaper(rawPaper || {});
  const target = resolveOpenTarget(snapshot, paper);
  if (!target?.value) return null;
  if (target.kind !== 'path' && !looksLikePdfUrl(target.value)) {
    return null;
  }

  return {
    paper_key: paper.paper_key,
    favorite_key: getPaperSessionKey(snapshot, paper),
    source_kind: snapshot?.source_kind || paper.source_kind,
    source_label: snapshot?.source_label || paper.source_label,
    arxiv_id: snapshot?.arxiv_id || paper.arxiv_id,
    openalex_id: snapshot?.openalex_id || paper.openalex_id,
    europepmc_id: snapshot?.europepmc_id || paper.europepmc_id,
    europepmc_source: snapshot?.europepmc_source || paper.europepmc_source,
    title: snapshot?.brief?.title || snapshot?.head?.title || paper.title || '论文 PDF',
    external_url: snapshot?.head?.src_url || snapshot?.brief?.src_url || paper.external_url || '',
    pdf_url: resolvePdfUrl(snapshot, paper),
    local_pdf_path: resolveLocalPdfPath(snapshot, paper),
    target: target.value,
    target_kind: target.kind,
  };
}

function buildAiPaperContext(snapshot, rawPaper) {
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
    contextText: String(head.full_context_text || paper.full_context_text || '').trim(),
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

function EmbeddedPdfPane({ viewer, onClose, pdfStatus }) {
  if (!viewer?.target) return null;

  const frameSrc = buildEmbeddedPdfSrc(viewer.target);
  const pdfStatusText = formatPdfPrefetchMessage(pdfStatus);
  const pdfStatusClass = pdfStatus?.state === 'ready'
    ? 'ready'
    : pdfStatus?.state === 'downloading'
      ? 'downloading'
      : pdfStatus?.state === 'error'
        ? 'error'
        : 'idle';

  return (
    <div className="embedded-pdf-pane">
      <div className="embedded-pdf-toolbar">
        <div className="embedded-pdf-toolbar-copy">
          <div className="embedded-pdf-title">PDF 阅读</div>
          {pdfStatusText && <div className={`embedded-pdf-status ${pdfStatusClass}`}>{pdfStatusText}</div>}
        </div>
        <div className="embedded-pdf-actions">
          <button className="mini-btn" onClick={onClose}>关闭 PDF</button>
        </div>
      </div>
      <iframe className="embedded-pdf-frame" src={frameSrc} title={viewer.title || '论文 PDF'} />
    </div>
  );
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
    brief: {
      title: normalized.title,
      tldr: normalized.abstract,
      author_line: normalized.author_line || '',
      publish_at: normalized.publish_at || '',
      src_url: srcUrl,
      pdf_url: normalized.pdf_url || '',
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
      full_context_text: normalized.full_context_text || '',
      contribution_points: normalized.contribution_points || [],
      citations: normalized.citation || normalized.citations || 0,
    },
    sections: normalized.sections || []
  };
}

function ResultList({ items, activeId, onSelect, emptyText }) {
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

function AIChatPanel({ snapshot, paper, aiConfig, aiConfigStatus, onAskAI, messages = [], onMessagesChange }) {
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const snapshotKey = snapshot?.arxiv_id || snapshot?.openalex_id || snapshot?.europepmc_id || paper?.paper_key || paper?.title || '';
  const paperContext = useMemo(() => buildAiPaperContext(snapshot, paper), [snapshot, paper, snapshotKey]);
  const needsAuth = aiConfig?.provider?.requiresOpenAIAuth !== false;
  const hasApiKey = Boolean(aiConfig?.openAIApiKey);
  const validated = !needsAuth || aiConfigStatus?.ok === true;
  const ready = !needsAuth ? true : hasApiKey && validated;
  const hasTextContext = Boolean(paperContext.contextText);
  const hasPdfContext = Boolean(paperContext.pdfUrl);
  const readinessHint = !hasApiKey
    ? '请先在设置中填写 OPENAI_API_KEY'
    : (aiConfigStatus?.message || '请先在设置页保存并验证 AI 配置');
  const contextStatus = hasPdfContext
    ? '已附带 PDF 原文上下文'
    : hasTextContext
      ? '已附带论文正文摘录上下文'
      : '未找到 PDF，已回退为标题与摘要上下文';

  useEffect(() => {
    setDraft('');
    setLoading(false);
  }, [snapshotKey]);

  async function handleSend() {
    const prompt = draft.trim();
    if (!prompt || loading || !snapshot) return;
    const history = messages.map((item) => ({ role: item.role, content: item.content }));
    const nextUserMessages = [...messages, { role: 'user', content: prompt }];
    onMessagesChange?.(nextUserMessages);
    setDraft('');
    setLoading(true);
    try {
      const result = await onAskAI({ paperContext, messages: history, prompt });
      onMessagesChange?.([...nextUserMessages, {
        role: 'assistant',
        content: result.answer,
        thinkingState: 'done',
        reasoningSummary: String(result.reasoningSummary || '').trim(),
        reasoningSteps: Array.isArray(result.reasoningSteps)
          ? result.reasoningSteps
              .map((item, index) => ({
                id: String(item?.id || `reasoning-${index + 1}`),
                text: String(item?.text || '').trim(),
              }))
              .filter((item) => item.text)
          : [],
      }]);
    } catch (error) {
      onMessagesChange?.([...nextUserMessages, { role: 'assistant', content: toUserErrorMessage(error, 'AI 请求失败'), isError: true }]);
    } finally {
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
          <div key={`${message.role}-${index}`} className={`ai-bubble ${message.role} ${message.isError ? 'error' : ''}`}>
            <div className="ai-bubble-role">{message.role === 'assistant' ? 'AI' : '你'}</div>
            {message.role === 'assistant' && !message.isError && (
              <div className={`ai-thinking-status ${message.thinkingState === 'done' ? 'done' : 'thinking'}`}>
                {message.thinkingState === 'done' ? '思考完毕' : '思考中'}
              </div>
            )}
            <MarkdownText text={message.content} className="ai-bubble-text markdown-light" />
            {message.role === 'assistant' && !message.isError && (message.reasoningSteps?.length || message.reasoningSummary || message.thinkingState === 'done') && (
              <div className="ai-reasoning-block">
                <div className="ai-reasoning-label">{message.reasoningSteps?.length ? '思考过程' : '思考结果'}</div>
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
                {!message.reasoningSteps?.length && !message.reasoningSummary && (
                  <div className="ai-reasoning-text">本次响应未返回可展示的详细思考过程。</div>
                )}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="ai-bubble assistant thinking">
            <div className="ai-bubble-role">AI</div>
            <div className="ai-thinking-status thinking">思考中</div>
            <div className="ai-bubble-text">正在结合论文上下文思考…</div>
          </div>
        )}
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

function DetailView({ snapshot, paper, isFavorite, canFavorite, onToggleFavorite, onOpenPdf, emptyText, aiConfig, aiConfigStatus, onAskAI, embeddedPdf, onClosePdf, aiMessages, onAiMessagesChange, pdfStatus }) {
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
  const openTarget = resolveOpenTarget(effectiveSnapshot, paper);
  const openLabel = openTarget?.kind === 'path' || looksLikePdfUrl(openTarget?.value) || sourceKind === 'local-pdf' || sourceKind === 'arxiv' ? '打开 PDF' : '打开来源';
  const pdfStatusText = formatPdfPrefetchMessage(pdfStatus);

  if (embeddedPdf?.target) {
    return (
      <div className="detail-frame pdf-only">
        <EmbeddedPdfPane
          viewer={embeddedPdf}
          onClose={onClosePdf}
          pdfStatus={pdfStatus}
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
            <button className="btn" disabled={!openTarget} onClick={onOpenPdf}>{openLabel}</button>
          </div>
          {pdfStatusText && <div className={`pdf-prefetch-hint ${pdfStatus?.state || 'idle'}`}>{pdfStatusText}</div>}
        </div>
          <AIChatPanel snapshot={effectiveSnapshot} paper={paper} aiConfig={aiConfig} aiConfigStatus={aiConfigStatus} onAskAI={onAskAI} messages={aiMessages} onMessagesChange={onAiMessagesChange} />
        </div>
      </div>

    </div>
  );
}

export default function App() {
  const [page, setPage] = useState('search');
  const [statusText, setStatusText] = useState('');
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
  const [searchLimit, setSearchLimit] = useState(10);
  const [searchResults, setSearchResults] = useState([]);
  const [activePaper, setActivePaper] = useState({ search: null, library: null, history: null });
  const [snapshots, setSnapshots] = useState({ search: null, library: null, history: null });
  const [embeddedPdf, setEmbeddedPdf] = useState({ search: null, library: null, history: null });
  const [activeHistoryKey, setActiveHistoryKey] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [aiConfig, setAiConfig] = useState(normalizeAiConfig());
  const [aiConfigStatus, setAiConfigStatus] = useState(defaultAiConfigStatus(normalizeAiConfig()));
  const [aiConfigForm, setAiConfigForm] = useState(normalizeAiConfig());
  const [aiChatStore, setAiChatStore] = useState(() => loadAiChatStore());
  const [pdfPrefetchStore, setPdfPrefetchStore] = useState({});

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
  async function refreshBootstrap() {
    const bootstrap = await window.deepxiv.bootstrap();
    setToken(bootstrap.token);
    setFavorites((bootstrap.favorites || []).map(normalizePaper));
    setFavoriteGroups(bootstrap.favoriteGroups || []);
    setHistory(bootstrap.history || []);
    const nextAiConfig = normalizeAiConfig(bootstrap.aiConfig || {});
    setAiConfig(nextAiConfig);
    setAiConfigStatus(normalizeAiConfigStatus(bootstrap.aiConfigStatus, nextAiConfig));
    setAiConfigForm(nextAiConfig);
    if (bootstrap.token?.token) {
      setTokenInput(bootstrap.token.token);
    }
  }

  async function handleRefreshStatus() {
    setStatusText('正在刷新状态…');
    try {
      const result = await window.deepxiv.refreshStatus();
      setToken(result.token || null);
      const nextAiConfig = normalizeAiConfig(result.aiConfig || aiConfig);
      setAiConfig(nextAiConfig);
      setAiConfigForm(nextAiConfig);
      setAiConfigStatus(normalizeAiConfigStatus(result.aiConfigStatus, nextAiConfig));
      if (result.token?.token) {
        setTokenInput(result.token.token);
      }
      setStatusText('状态已刷新');
    } catch (error) {
      setStatusText(toUserErrorMessage(error, '刷新状态失败'));
    }
  }

  useEffect(() => {
    refreshBootstrap().catch(() => {
      setStatusText('初始化失败');
    });
  }, []);

  useEffect(() => {
    if (activeGroupId !== 'all' && !favoriteGroups.some((group) => group.id === activeGroupId)) {
      setActiveGroupId('all');
    }
  }, [favoriteGroups, activeGroupId]);

  useEffect(() => {
    const unsubscribe = window.deepxiv.onPdfPrefetchStatus?.((payload) => {
      const status = normalizePdfPrefetchStatus(payload);
      if (!status.paperKey) return;
      setPdfPrefetchStore((prev) => ({ ...prev, [status.paperKey]: status }));
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    saveAiChatStore(aiChatStore);
  }, [aiChatStore]);

  useEffect(() => {
    setEmbeddedPdf((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const context of Object.keys(prev)) {
        const viewer = prev[context];
        if (!viewer?.target || !viewer?.paperKey) continue;
        const status = pdfPrefetchStore[viewer.paperKey];
        if (!status?.cachedPath || status.state !== 'ready') continue;
        if (viewer.target === status.cachedPath) continue;
        if (!isRemoteHttpUrl(viewer.target)) continue;
        next[context] = { ...viewer, target: status.cachedPath };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [pdfPrefetchStore]);

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
    setPdfPrefetchStore((prev) => ({ ...prev, [status.paperKey]: status }));
    return status;
  }

  function getPdfStatus(snapshot, paper) {
    const key = getPaperSessionKey(snapshot, paper);
    return key ? (pdfPrefetchStore[key] || null) : null;
  }

  async function prefetchPdfForPaper(snapshot, paper) {
    const payload = buildPdfPrefetchPayload(snapshot, paper);
    if (!payload) return null;
    try {
      return mergePdfPrefetchStatus(await window.deepxiv.prefetchPdf(payload));
    } catch (error) {
      return null;
    }
  }

  async function resolvePdfOpenForPaper(snapshot, paper) {
    const payload = buildPdfPrefetchPayload(snapshot, paper);
    if (!payload) return null;
    return mergePdfPrefetchStatus(await window.deepxiv.resolvePdf(payload));
  }

  async function openPaper(context, rawPaper, options = {}) {
    const paper = normalizePaper(rawPaper);
    const canLoadSnapshot = Boolean(paper.arxiv_id || paper.openalex_id || paper.europepmc_id || paper.local_pdf_path || paper.source_kind === 'local-pdf');
    const previewSnapshot = makeExternalSnapshot(paper);
    setActivePaper((prev) => ({ ...prev, [context]: paper }));
    setSnapshots((prev) => ({ ...prev, [context]: previewSnapshot }));
    setEmbeddedPdf((prev) => ({ ...prev, [context]: null }));
    void prefetchPdfForPaper(previewSnapshot, paper);
    try {
      if (canLoadSnapshot) {
        const snapshot = await window.deepxiv.snapshot({
          paper_key: paper.paper_key,
          favorite_key: paper.favorite_key,
          arxiv_id: paper.arxiv_id,
          openalex_id: paper.openalex_id,
          europepmc_id: paper.europepmc_id,
          europepmc_source: paper.europepmc_source,
          source_kind: paper.source_kind,
          source_label: paper.source_label,
          title: paper.title,
          publish_at: paper.publish_at,
          external_url: paper.external_url,
          pdf_url: paper.pdf_url,
          local_pdf_path: paper.local_pdf_path,
          author_line: paper.author_line,
          abstract: paper.abstract,
          full_context_text: paper.full_context_text,
          sections: paper.sections,
          contribution_points: paper.contribution_points,
          supports_favorite: paper.supports_favorite,
          trackHistory: options.trackHistory !== false
        });
        setSnapshots((prev) => ({ ...prev, [context]: snapshot }));
        void prefetchPdfForPaper(snapshot, paper);
        if (options.trackHistory !== false) {
          const nextHistory = await window.deepxiv.historyList();
          setHistory(nextHistory || []);
        }
      } else {
        setSnapshots((prev) => ({ ...prev, [context]: previewSnapshot }));
        if (options.trackHistory !== false) {
          const nextHistory = await window.deepxiv.historyAdd({ kind: 'paper', payload: paper });
          setHistory(nextHistory || []);
        }
      }
    } catch (error) {
      setSnapshots((prev) => ({ ...prev, [context]: previewSnapshot }));
      setStatusText(toUserErrorMessage(error, '加载详情失败'));
    }
  }

  async function handleSearch() {
    const query = searchQuery.trim();
    if (!query) return;
    setStatusText(showSearchLimit ? '正在搜索论文…' : '正在打开论文…');
    try {
      const result = await window.deepxiv.search({ query, limit: Number(searchLimit), mode: searchMode, source_scope: searchSourceScope });
      const papers = dedupePapers(sortPapersByTime((result.results || []).map(normalizePaper)));
      setSearchResults(papers);
      if (papers[0]) {
        await openPaper('search', papers[0]);
      } else {
        setSnapshots((prev) => ({ ...prev, search: null }));
        setActivePaper((prev) => ({ ...prev, search: null }));
      }
      setStatusText('');
    } catch (error) {
      setSearchResults([]);
      setSnapshots((prev) => ({ ...prev, search: null }));
      setActivePaper((prev) => ({ ...prev, search: null }));
      setStatusText(toUserErrorMessage(error, '搜索失败'));
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
    const result = await window.deepxiv.favoritesToggle(paper);
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
      const result = await window.deepxiv.importLocalPdf({
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
      const result = await window.deepxiv.createFavoriteGroup(name);
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
      const result = await window.deepxiv.renameFavoriteGroup({ groupId, name });
      setFavoriteGroups(result.favoriteGroups || []);
      setEditingGroupId('');
      setEditingGroupName('');
    } finally {
      setStatusText('');
    }
  }

  async function handleSetFavoriteGroup(favoriteKey, groupId) {
    const result = await window.deepxiv.setFavoriteGroup({ favoriteKey, groupId });
    setFavorites((result.favorites || []).map(normalizePaper));
    setFavoriteGroups(result.favoriteGroups || favoriteGroups);
  }

  async function handleSaveToken() {
    setStatusText('正在保存 Token…');
    try {
      const nextToken = await window.deepxiv.saveToken(tokenInput);
      setToken(nextToken);
      setStatusText('Token 已保存');
    } catch (error) {
      setStatusText(toUserErrorMessage(error, '保存 Token 失败'));
    }
  }

  async function handleRegisterToken() {
    setStatusText('正在匿名注册…');
    try {
      const nextToken = await window.deepxiv.registerToken();
      setToken(nextToken);
      setTokenInput(nextToken.token || '');
      setStatusText('匿名注册成功');
    } catch (error) {
      setStatusText(toUserErrorMessage(error, '匿名注册失败'));
    }
  }

  async function handleSaveAiConfig() {
    setStatusText('正在保存 AI 配置…');
    try {
      const saved = await window.deepxiv.saveAiConfig(aiConfigForm);
      const normalized = normalizeAiConfig(saved?.config || {});
      const nextStatus = normalizeAiConfigStatus(saved?.status, normalized);
      setAiConfig(normalized);
      setAiConfigForm(normalized);
      setAiConfigStatus(nextStatus);
      setStatusText(nextStatus.ok ? 'AI 配置已保存并验证通过' : `AI 配置已保存，但当前不可用：${nextStatus.message}`);
    } catch (error) {
      setStatusText(toUserErrorMessage(error, '保存 AI 配置失败'));
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
    updateEmbeddedPdfViewer(context, null);
  }

  async function handleAskAI(payload) {
    setStatusText('AI 正在结合论文上下文思考…');
    try {
      return await window.deepxiv.aiChat(payload);
    } catch (error) {
      throw new Error(toUserErrorMessage(error, 'AI 请求失败'));
    } finally {
      setStatusText('');
    }
  }

  async function handleRemoveFavorite(paperId) {
    const result = await window.deepxiv.favoriteRemove(paperId);
    setFavorites((result.favorites || []).map(normalizePaper));
    setFavoriteGroups(result.favoriteGroups || favoriteGroups);
    if (getFavoriteKey(activePaper.library) === paperId) {
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
    const target = resolveOpenTarget(snapshot, paper);
    if (!target?.value) return;
    if (target.kind === 'path' || looksLikePdfUrl(target.value)) {
      const resolved = await resolvePdfOpenForPaper(snapshot, paper).catch(() => null);
      updateEmbeddedPdfViewer(context, {
        target: resolved?.openTarget || target.value,
        title: snapshot?.brief?.title || snapshot?.head?.title || paper?.title || '论文 PDF',
        paperKey: getPaperSessionKey(snapshot, paper),
      });
      return;
    }
    await window.deepxiv.openExternal(target.value);
  }

  const tokenStatusLabel = token?.has_token ? '已就绪' : '未配置';
  const tokenStatusHint = token?.has_token ? (token?.daily_limit ? `每日额度 ${token.daily_limit}` : '可立即搜索与阅读') : '请先保存或匿名注册 Token';
  const aiStatusLabel = aiConfigStatus?.ok
    ? 'AI 已就绪'
    : (aiConfig?.provider?.requiresOpenAIAuth && !aiConfig?.openAIApiKey ? 'AI 未配置' : 'AI 不可用');
  const aiStatusHint = aiConfigStatus?.ok
    ? (aiConfigStatus?.message || `${aiConfig.provider.name} · ${aiConfig.model}`)
    : (aiConfigStatus?.message || '请先填写 OPENAI_API_KEY');
  const aiIndicator = aiConfigStatus?.ok ? '✓' : '✕';
  const aiIndicatorClass = aiConfigStatus?.ok ? 'success' : 'error';
  const liveStatusText = statusText || (
    page === 'search'
      ? `${selectedSearchSource.label} · ${showSearchLimit ? `最多 ${searchLimit} 条结果` : '直接打开目标'}`
      : page === 'library'
        ? `当前视图 ${visibleFavorites.length} 篇论文`
        : page === 'history'
          ? `最近访问 ${history.length} 条`
          : `${tokenStatusLabel} · ${aiStatusLabel}`
  );

  return (
    <div className="app-shell">
      <div className="app-bg" aria-hidden="true">
        <div className="app-bg-grid" />
        <div className="app-bg-noise" />
        <div className="app-bg-glow glow-blue" />
        <div className="app-bg-glow glow-purple" />
        <div className="app-bg-glow glow-teal" />
      </div>
      <aside className="sidebar">
        <div className="window-controls" aria-hidden="true">
          <span className="window-dot red" />
          <span className="window-dot yellow" />
          <span className="window-dot green" />
        </div>

        <div className="brand">
          <div className="brand-mark">DX</div>
          <div className="brand-copy">
            <h1>DeepXiv</h1>
            <p>Desktop Client</p>
          </div>
        </div>

        <div className="token-card status-card">
          <div className="sidebar-label">连接与 AI</div>
          <div className="status-card-section">
            <div className="status-card-heading">账号连接</div>
            <div className="token-card-row">
              <div className="token-card-copy">
                <div className="token-label">DeepXiv Token</div>
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
            <div className="split-layout">
              <div className="card list-panel">
                <ResultList items={searchResults} activeId={activePaper.search?.paper_key} onSelect={(paper) => openPaper('search', paper)} emptyText="暂无结果" />
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
                />
              </div>
            </div>
          </section>
        )}

        {page === 'library' && (
          <section className="page active">
            <div className="split-layout">
              <div className="card list-panel">
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
                />
              </div>
            </div>
          </section>
        )}

        {page === 'history' && (
          <section className="page active">
            <div className="split-layout">
              <div className="card list-panel">
                <HistoryList items={history} activeKey={activeHistoryKey} onSelect={handleOpenHistory} emptyText="暂无记录" />
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
                  <button className="btn primary" onClick={handleRegisterToken}>匿名注册</button>
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

            </div>
          </section>
        )}
      </main>
    </div>
  );
}
