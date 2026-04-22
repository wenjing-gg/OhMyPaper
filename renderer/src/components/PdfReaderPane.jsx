import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

function resolvePdfWorkerSrc(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const resolved = new URL(value, window.location.href);
    if (resolved.protocol === 'file:' && resolved.pathname.includes('/app.asar/')) {
      resolved.pathname = resolved.pathname.replace('/app.asar/', '/app.asar.unpacked/');
    }
    return resolved.toString();
  } catch (error) {
    return value.includes('/app.asar/')
      ? value.replace('/app.asar/', '/app.asar.unpacked/')
      : value;
  }
}

GlobalWorkerOptions.workerSrc = resolvePdfWorkerSrc(workerSrc);

function normalizePdfBytes(bytes) {
  if (!bytes) return new Uint8Array();
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  if (Array.isArray(bytes)) {
    return Uint8Array.from(bytes);
  }
  if (Array.isArray(bytes?.data)) {
    return Uint8Array.from(bytes.data);
  }
  return new Uint8Array();
}

function normalizePdfDocumentSource(result) {
  const documentUrl = String(result?.documentUrl || result?.document_url || '').trim();
  if (documentUrl) {
    return { url: documentUrl };
  }

  const bytes = normalizePdfBytes(result?.bytes);
  if (bytes.length) {
    return { data: bytes };
  }

  return null;
}

function buildViewerAttachmentState(viewer, result = null) {
  const source = result || viewer?.payload || {};
  const target = String(
    result?.openTarget
    || result?.target
    || viewer?.target
    || source?.target
    || source?.local_pdf_path
    || ''
  ).trim();
  const sourceUrl = String(source?.sourceUrl || source?.source_url || source?.pdf_url || '').trim();
  const localPath = String(
    source?.localPath
    || source?.local_path
    || source?.local_pdf_path
    || (!/^https?:\/\//i.test(target) ? target : '')
    || ''
  ).trim();
  return {
    sourceUrl,
    localPath,
    attachMode: String(source?.attachMode || source?.attach_mode || '').trim(),
    aiAttachable: source?.aiAttachable !== false,
    aiAttachmentMessage: String(source?.aiAttachmentMessage || source?.ai_attachment_message || '').trim(),
    isLocal: source?.isLocal === true || Boolean(localPath),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const PAGE_META_HEIGHT = 34;
const PAGE_GAP = 22;

function formatScaleLabel(scale) {
  if (!Number.isFinite(scale) || scale <= 0) return '100%';
  return `${Math.round(scale * 100)}%`;
}

async function destroyLoadingTask(task) {
  if (!task || typeof task.destroy !== 'function') return;
  try {
    await task.destroy();
  } catch (error) {
  }
}

function calculatePageSpacerHeight(hiddenPageCount, pageStride) {
  if (!hiddenPageCount) return 0;
  return Math.max(0, (hiddenPageCount * pageStride) - PAGE_GAP);
}

class PdfPaneErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: '' };
  }

  static getDerivedStateFromError(error) {
    return {
      error: String(error?.message || error || 'PDF 渲染失败').trim() || 'PDF 渲染失败',
    };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: '' });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="embedded-pdf-error">
          <strong>PDF 打开失败</strong>
          <span>{this.state.error}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

function PdfPageCanvas({ pdfDocument, pageNumber, scale, estimatedHeight }) {
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [pageState, setPageState] = useState({ rendered: false, error: '', width: 0, height: 0 });

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) return undefined;

    let cancelled = false;
    let pageProxy = null;

    setPageState((prev) => ({ ...prev, rendered: false, error: '' }));

    (async () => {
      const page = await pdfDocument.getPage(pageNumber);
      pageProxy = page;
      if (cancelled) return;

      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;

      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.ceil(viewport.width * pixelRatio);
      canvas.height = Math.ceil(viewport.height * pixelRatio);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;

      const context = canvas.getContext('2d', { alpha: false });
      if (!context) {
        throw new Error('无法初始化 PDF 画布');
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);

      renderTaskRef.current?.cancel?.();
      const renderTask = page.render({ canvasContext: context, viewport });
      renderTaskRef.current = renderTask;

      setPageState({
        rendered: false,
        error: '',
        width: viewport.width,
        height: viewport.height,
      });

      await renderTask.promise;
      if (cancelled) return;

      setPageState({
        rendered: true,
        error: '',
        width: viewport.width,
        height: viewport.height,
      });
    })().catch((error) => {
      if (cancelled || error?.name === 'RenderingCancelledException') return;
      setPageState((prev) => ({
        ...prev,
        rendered: false,
        error: String(error?.message || error || 'PDF 渲染失败').trim() || 'PDF 渲染失败',
      }));
    });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel?.();
      pageProxy?.cleanup?.();
    };
  }, [pdfDocument, pageNumber, scale]);

  const shellStyle = pageState.height > 0
    ? { minHeight: `${Math.ceil(pageState.height)}px` }
    : { minHeight: `${Math.max(estimatedHeight, 280)}px` };

  return (
    <div className={`embedded-pdf-page ${pageState.error ? 'error' : ''}`.trim()}>
      <div className="embedded-pdf-page-meta">第 {pageNumber} 页</div>
      <div className="embedded-pdf-page-shell" style={shellStyle}>
        {pageState.error ? (
          <div className="embedded-pdf-page-error">{pageState.error}</div>
        ) : (
          <>
            <canvas ref={canvasRef} className="embedded-pdf-canvas" />
            {!pageState.rendered && <div className="embedded-pdf-page-placeholder">正在渲染第 {pageNumber} 页…</div>}
          </>
        )}
      </div>
    </div>
  );
}

export default function PdfReaderPane({ viewer, onClose, pdfStatus, onLoadDocument, onViewerStateChange }) {
  const stageRef = useRef(null);
  const onLoadDocumentRef = useRef(onLoadDocument);
  const onViewerStateChangeRef = useRef(onViewerStateChange);
  const lastViewerStateRef = useRef({ identity: '', signature: '' });
  const [pdfDocument, setPdfDocument] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  const [zoomMode, setZoomMode] = useState('fit-width');
  const [customScale, setCustomScale] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [baseViewport, setBaseViewport] = useState(null);
  const [loadState, setLoadState] = useState({ loading: false, error: '', message: '' });

  const pdfStatusText = useMemo(() => {
    if (!pdfStatus) return '';
    return String(pdfStatus.message || '').trim();
  }, [pdfStatus]);

  const viewerIdentity = useMemo(() => {
    const paperKey = String(viewer?.paperKey || viewer?.payload?.paper_key || '').trim();
    const requestId = String(viewer?.requestId || '').trim();
    const target = String(viewer?.target || viewer?.payload?.target || viewer?.payload?.local_pdf_path || '').trim();
    return `${paperKey}:${requestId}:${target}`;
  }, [viewer?.paperKey, viewer?.payload?.paper_key, viewer?.requestId, viewer?.target, viewer?.payload?.target, viewer?.payload?.local_pdf_path]);

  useEffect(() => {
    onLoadDocumentRef.current = onLoadDocument;
  }, [onLoadDocument]);

  useEffect(() => {
    onViewerStateChangeRef.current = onViewerStateChange;
  }, [onViewerStateChange]);

  useEffect(() => {
    lastViewerStateRef.current = { identity: viewerIdentity, signature: '' };
  }, [viewerIdentity]);

  const emitViewerState = useCallback((nextState) => {
    if (!nextState?.paperKey) return;
    const normalized = {
      paperKey: String(nextState.paperKey || '').trim(),
      requestId: String(nextState.requestId || '').trim(),
      state: String(nextState.state || '').trim(),
      message: String(nextState.message || '').trim(),
      error: String(nextState.error || '').trim(),
      hasLoaded: nextState.hasLoaded === true,
      sourceUrl: String(nextState.sourceUrl || nextState.source_url || '').trim(),
      localPath: String(nextState.localPath || nextState.local_path || '').trim(),
      attachMode: String(nextState.attachMode || nextState.attach_mode || '').trim(),
      aiAttachable: nextState.aiAttachable !== false,
      aiAttachmentMessage: String(nextState.aiAttachmentMessage || nextState.ai_attachment_message || '').trim(),
      isLocal: nextState.isLocal === true,
    };
    const signature = JSON.stringify(normalized);
    if (
      lastViewerStateRef.current.identity === viewerIdentity
      && lastViewerStateRef.current.signature === signature
    ) {
      return;
    }
    lastViewerStateRef.current = {
      identity: viewerIdentity,
      signature,
    };
    onViewerStateChangeRef.current?.(normalized);
  }, [viewerIdentity]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return undefined;

    const updateWidth = () => {
      const nextWidth = Math.max(0, Math.floor(node.clientWidth || 0));
      const nextHeight = Math.max(0, Math.floor(node.clientHeight || 0));
      setContainerWidth(nextWidth);
      setContainerHeight(nextHeight);
    };

    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(node);
    return () => observer.disconnect();
  }, [viewer?.paperKey]);

  useEffect(() => {
    stageRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    setScrollTop(0);
  }, [viewer?.paperKey]);

  useEffect(() => {
    if (!viewer?.payload && !viewer?.target) {
      setPdfDocument(null);
      setPageCount(0);
      setBaseViewport(null);
      setLoadState({ loading: false, error: '', message: '' });
      return undefined;
    }

    let cancelled = false;
    let loadingTask = null;
    let activeDocument = null;
    const paperKey = String(viewer?.paperKey || viewer?.payload?.paper_key || '').trim();
    const requestId = String(viewer?.requestId || '').trim();
    const loadingMessage = '正在加载 PDF…';

    setLoadState({ loading: true, error: '', message: loadingMessage });
    setPdfDocument(null);
    setPageCount(0);
    setBaseViewport(null);
    setZoomMode('fit-width');
    setCustomScale(1);
    emitViewerState({
      paperKey,
      requestId,
      state: 'loading',
      message: loadingMessage,
      ...buildViewerAttachmentState(viewer),
    });

    (async () => {
      const payload = viewer.payload || {
        paper_key: viewer.paperKey,
        favorite_key: viewer.paperKey,
        title: viewer.title,
        target: viewer.target,
      };
      const result = await onLoadDocumentRef.current(payload);
      const documentSource = normalizePdfDocumentSource(result);
      if (!documentSource) {
        throw new Error(result?.message || '未读取到 PDF 内容');
      }

      if (!cancelled) {
        setLoadState({ loading: true, error: '', message: '正在解析 PDF…' });
      }
      loadingTask = getDocument(documentSource);
      activeDocument = await loadingTask.promise;
      if (cancelled) {
        await activeDocument.destroy();
        return;
      }

      const firstPage = await activeDocument.getPage(1);
      const firstViewport = firstPage.getViewport({ scale: 1 });
      firstPage.cleanup?.();

      setBaseViewport(firstViewport);
      setPdfDocument(activeDocument);
      setPageCount(activeDocument.numPages || 0);
      setLoadState({ loading: false, error: '', message: '' });
      emitViewerState({
        paperKey,
        requestId,
        state: 'loaded',
        hasLoaded: true,
        message: 'PDF 已成功加载',
        ...buildViewerAttachmentState(viewer, result),
      });
    })().catch(async (error) => {
      if (cancelled) return;
      if (activeDocument) {
        await activeDocument.destroy().catch(() => {});
      }
      await destroyLoadingTask(loadingTask);
      const message = String(error?.message || error || 'PDF 加载失败').trim() || 'PDF 加载失败';
      setLoadState({
        loading: false,
        error: message,
        message: '',
      });
      emitViewerState({
        paperKey,
        requestId,
        state: 'error',
        error: message,
        message,
        ...buildViewerAttachmentState(viewer),
      });
    });

    return () => {
      cancelled = true;
      void destroyLoadingTask(loadingTask);
      if (activeDocument) {
        activeDocument.destroy().catch(() => {});
      }
    };
  }, [viewerIdentity, emitViewerState]);

  const fitWidthScale = useMemo(() => {
    if (!baseViewport?.width || !containerWidth) return 1;
    return clamp((containerWidth - 48) / baseViewport.width, 0.4, 3.5);
  }, [baseViewport, containerWidth]);

  const actualScale = useMemo(() => {
    return zoomMode === 'fit-width' ? fitWidthScale : clamp(customScale, 0.4, 3.5);
  }, [zoomMode, fitWidthScale, customScale]);

  const estimatedHeight = useMemo(() => {
    if (!baseViewport?.height || !baseViewport?.width) return 520;
    const ratio = baseViewport.height / baseViewport.width;
    const estimatedWidth = Math.max(320, (baseViewport.width || 1) * actualScale);
    return Math.round(estimatedWidth * ratio);
  }, [actualScale, baseViewport]);

  const pageStride = useMemo(() => {
    return Math.max(estimatedHeight + PAGE_META_HEIGHT + PAGE_GAP, 360);
  }, [estimatedHeight]);

  const visiblePageCount = useMemo(() => {
    if (!containerHeight || !pageStride) return 3;
    return Math.max(1, Math.ceil(containerHeight / pageStride));
  }, [containerHeight, pageStride]);

  const overscan = 2;
  const windowRange = useMemo(() => {
    if (!pageCount) return { start: 1, end: 0 };
    const firstVisibleIndex = Math.max(0, Math.floor(scrollTop / pageStride));
    const start = clamp(firstVisibleIndex - overscan + 1, 1, pageCount);
    const end = clamp(firstVisibleIndex + visiblePageCount + overscan, start, pageCount);
    return { start, end };
  }, [pageCount, pageStride, scrollTop, visiblePageCount]);

  const visiblePageNumbers = useMemo(() => {
    if (windowRange.end < windowRange.start) return [];
    return Array.from({ length: windowRange.end - windowRange.start + 1 }, (_, index) => windowRange.start + index);
  }, [windowRange.end, windowRange.start]);

  const topSpacerHeight = useMemo(() => {
    return calculatePageSpacerHeight(Math.max(0, windowRange.start - 1), pageStride);
  }, [windowRange.start, pageStride]);

  const bottomSpacerHeight = useMemo(() => {
    return calculatePageSpacerHeight(Math.max(0, pageCount - windowRange.end), pageStride);
  }, [pageCount, windowRange.end, pageStride]);

  const adjustZoom = useCallback((delta) => {
    setZoomMode('custom');
    setCustomScale((prev) => clamp((zoomMode === 'fit-width' ? fitWidthScale : prev) + delta, 0.4, 3.5));
  }, [fitWidthScale, zoomMode]);

  const handleWheel = useCallback((event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    adjustZoom(event.deltaY < 0 ? 0.12 : -0.12);
  }, [adjustZoom]);

  const handleScroll = useCallback((event) => {
    setScrollTop(event.currentTarget.scrollTop || 0);
  }, []);

  const statusClass = pdfStatus?.state === 'ready'
    ? 'ready'
    : pdfStatus?.state === 'downloading'
      ? 'downloading'
      : pdfStatus?.state === 'verifying'
        ? 'downloading'
      : pdfStatus?.state === 'error'
        ? 'error'
        : 'idle';

  return (
    <div className="embedded-pdf-pane">
      <div className="embedded-pdf-toolbar">
        <div className="embedded-pdf-toolbar-copy">
          <div className="embedded-pdf-title">{viewer?.title || 'PDF 阅读'}</div>
          {pdfStatusText && <div className={`embedded-pdf-status ${statusClass}`}>{pdfStatusText}</div>}
          {!pdfStatusText && loadState.message && <div className="embedded-pdf-status">{loadState.message}</div>}
        </div>
        <div className="embedded-pdf-actions embedded-pdf-actions-wide">
          <div className="embedded-pdf-counter">{pageCount ? `共 ${pageCount} 页` : '-- 页'}</div>
          <button className="mini-btn" onClick={() => adjustZoom(-0.12)} disabled={!pdfDocument}>－</button>
          <button className={`mini-btn ${zoomMode === 'fit-width' ? 'active' : ''}`.trim()} onClick={() => setZoomMode('fit-width')} disabled={!pdfDocument}>适宽</button>
          <button className={`mini-btn ${zoomMode === 'custom' && Math.abs(actualScale - 1) < 0.01 ? 'active' : ''}`.trim()} onClick={() => {
            setZoomMode('custom');
            setCustomScale(1);
          }} disabled={!pdfDocument}>100%</button>
          <div className="embedded-pdf-scale">{formatScaleLabel(actualScale)}</div>
          <button className="mini-btn" onClick={() => adjustZoom(0.12)} disabled={!pdfDocument}>＋</button>
          <button className="mini-btn" onClick={() => stageRef.current?.scrollTo({ top: 0, behavior: 'smooth' })} disabled={!pdfDocument}>回到顶部</button>
          <button className="mini-btn" onClick={onClose}>关闭 PDF</button>
        </div>
      </div>
      <div className="embedded-pdf-stage" ref={stageRef} onWheel={handleWheel} onScroll={handleScroll}>
        <PdfPaneErrorBoundary resetKey={`${viewer?.paperKey || ''}:${viewer?.requestId || ''}`}>
          {loadState.error ? (
            <div className="embedded-pdf-error">
              <strong>PDF 打开失败</strong>
              <span>{loadState.error}</span>
            </div>
          ) : loadState.loading ? (
            <div className="embedded-pdf-loading">
              <div className="embedded-pdf-spinner" />
              <span>{loadState.message || '正在加载 PDF…'}</span>
            </div>
          ) : !pdfDocument ? (
            <div className="embedded-pdf-empty">暂无 PDF 内容</div>
          ) : (
            <div className="embedded-pdf-pages">
              {topSpacerHeight > 0 && <div className="embedded-pdf-spacer" style={{ height: `${topSpacerHeight}px` }} aria-hidden="true" />}
              {visiblePageNumbers.map((pageNumber) => {
                const pageKey = `${viewer?.paperKey || viewer?.target || 'pdf'}-${pageNumber}`;
                return (
                  <PdfPageCanvas
                    key={pageKey}
                    pdfDocument={pdfDocument}
                    pageNumber={pageNumber}
                    scale={actualScale}
                    estimatedHeight={estimatedHeight}
                  />
                );
              })}
              {bottomSpacerHeight > 0 && <div className="embedded-pdf-spacer" style={{ height: `${bottomSpacerHeight}px` }} aria-hidden="true" />}
            </div>
          )}
        </PdfPaneErrorBoundary>
      </div>
    </div>
  );
}
