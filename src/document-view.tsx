import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, Maximize2, Minimize2, Minus, Plus, ScanLine } from 'lucide-react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import { errorText, PARSE_LABELS, readOriginal, rpc, type ResumeDocument, type ResumeRef } from './api';
import { Button, Empty, Loading, Notice, useResource } from './ui';

export function TextView({ reference, document }: { reference: ResumeRef; document: ResumeDocument }) {
  const result = useResource(() => rpc('document_text', { reference }), [reference.kind, reference.id]);
  if (result.loading) return <Loading>正在读取提取文字…</Loading>;
  if (result.error) return <Notice>{result.error}</Notice>;
  return <div className="text-view">
    <div className="text-view-note"><FileText size={15} />提取文字 · 原件排版请在原始文件中查看</div>
    {result.data ? <pre>{result.data}</pre> : <Empty icon={<ScanLine size={26} />}
      title={PARSE_LABELS[document.parseStatus]} description="扫描件或加密文件可能没有可读取的文字。" />}
  </div>;
}

export function PdfView({ reference, fullscreen, onFullscreen }: { reference: ResumeRef; fullscreen: boolean; onFullscreen: () => void }) {
  const identity = reference.kind + reference.id;
  return <PdfViewer key={identity} identity={identity} load={() => readOriginal(reference)} fullscreen={fullscreen}
    onFullscreen={onFullscreen} />;
}

export function PdfViewer({ identity, load, initialPage = 1, fullscreen = false, onFullscreen, active: visible = true }: {
  identity: string; load: () => Promise<ArrayBuffer | number[]>; initialPage?: number;
  fullscreen?: boolean; onFullscreen?: () => void; active?: boolean;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState<number | null>(null);
  const [scaleShown, setScaleShown] = useState(1);
  const [width, setWidth] = useState(560);
  const [error, setError] = useState('');
  const [renderError, setRenderError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    let timer = 0;
    const run = async () => {
      const raw = await load();
      const { openPdf } = await import('./pdf');
      if (!active) return;
      task = openPdf(raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw));
      timer = window.setTimeout(() => {
        if (active) setError('PDF 打开超时，可以使用系统程序打开原件。');
        void task?.destroy().catch(() => {});
      }, 15_000);
      const loaded = await task.promise;
      window.clearTimeout(timer);
      if (active) { setPage(Math.max(1, Math.min(initialPage, loaded.numPages))); setPdf(loaded); }
    };
    run().catch((e: unknown) => {
      window.clearTimeout(timer);
      if (active) setError((e instanceof Error && e.name === 'PasswordException')
        ? '此 PDF 需要密码，请使用系统程序打开原件。' : '无法渲染此 PDF。可尝试使用系统程序打开原件。');
    });
    return () => { active = false; window.clearTimeout(timer); void task?.destroy().catch(() => {}); };
  }, [identity, initialPage]);
  useEffect(() => {
    const node = region.current;
    if (!node || !visible) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(160, (entries[0]?.contentRect.width ?? 600) - 1)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible || !pdf || !canvas.current) return;
    let active = true;
    let work: RenderTask | undefined;
    const node = canvas.current;
    setRenderError('');
    void pdf.getPage(page).then(async (current) => {
      if (!active) return;
      const natural = current.getViewport({ scale: 1 });
      const factor = scale ?? Math.min(2.4, width / natural.width);
      const viewport = current.getViewport({ scale: factor });
      if (viewport.width < 1 || viewport.height < 1 || viewport.width > 12000 || viewport.height > 12000) {
        throw new Error('此页尺寸过大，请缩小预览。');
      }
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(14_000_000 / (viewport.width * viewport.height)));
      node.width = Math.max(1, Math.floor(viewport.width * ratio));
      node.height = Math.max(1, Math.floor(viewport.height * ratio));
      node.style.width = Math.round(viewport.width) + 'px';
      node.style.height = Math.round(viewport.height) + 'px';
      setScaleShown(factor);
      work = current.render({ canvas: node, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await work.promise;
      if (active) node.dataset.rendered = 'yes';
    }).catch((e: unknown) => {
      if (active) setRenderError(e instanceof Error && e.message.includes('尺寸') ? e.message : '此页无法显示。请尝试其他页或打开原件。');
    });
    return () => { active = false; work?.cancel(); delete node.dataset.rendered; };
  }, [visible, pdf, page, scale, width]);
  const toggle = (value: number) => setScale(Math.max(.25, Math.min(3, Math.round(value * 100) / 100)));
  return <div className="pdf-view">
    <div className="pdf-tools">
      <Button tone="quiet" className="icon-btn" aria-label="上一页" disabled={!pdf || page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={16} /></Button>
      <span className="page-no">{pdf ? page + ' / ' + pdf.numPages : '—'}</span>
      <Button tone="quiet" className="icon-btn" aria-label="下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={16} /></Button>
      <span className="tool-separator" />
      <Button tone="quiet" className="icon-btn" aria-label="缩小" disabled={!pdf} onClick={() => toggle(scaleShown / 1.2)}><Minus size={16} /></Button>
      <span className="zoom-no">{pdf ? Math.round(scaleShown * 100) + '%' : '—'}</span>
      <Button tone="quiet" className="icon-btn" aria-label="放大" disabled={!pdf} onClick={() => toggle(scaleShown * 1.2)}><Plus size={16} /></Button>
      <Button tone="quiet" aria-pressed={scale === null} className={scale === null ? 'tool-selected' : ''} disabled={!pdf} onClick={() => setScale(null)}>适应宽度</Button>
      {onFullscreen && <Button tone="quiet" className="icon-btn ml-auto" aria-label={fullscreen ? '还原预览区域' : '最大化预览区域'}
        onClick={onFullscreen}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</Button>}
    </div>
    <div ref={region} className="pdf-scroll">
      {error ? <Notice>{error}</Notice> : !pdf ? <Loading>正在打开 PDF…</Loading> :
        <>{renderError && <Notice>{renderError}</Notice>}<div className="pdf-paper" hidden={!!renderError}><canvas ref={canvas} aria-label={'PDF 第 ' + page + ' 页'} /></div></>}
    </div>
  </div>;
}

export async function showDocumentError(action: () => Promise<void>, report: (message: string, error?: boolean) => void) {
  try { await action(); } catch (e) { report(errorText(e), true); }
}
