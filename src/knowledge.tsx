import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { BookOpen, CalendarDays, ChevronLeft, ChevronRight, ExternalLink, FileText, Folder, FolderPlus, MessageSquare, Pencil, Search, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { errorText } from './api';
import { PdfViewer, showDocumentError } from './document-view';
import {
  INDEX_LABELS, KNOWLEDGE_ACCEPT, knowledge, openKnowledge, openSourceLink, readKnowledge,
  type KnowledgeCategory, type KnowledgeDetail, type KnowledgeEdit, type KnowledgeFile, type KnowledgeTarget,
} from './knowledge-api';
import { useKnowledgeUpload } from './knowledge-upload';
import { Button, Confirm, Empty, Field, Loading, Modal, Notice, Pill, date, fileSize, splitTags, useDebounced, useResource } from './ui';
import './knowledge.css';

export function KnowledgeWorkspace({ initial, intentKey, active, revision, refresh, report, ask }: {
  initial?: KnowledgeTarget; intentKey: number; active: boolean; revision: number;
  refresh: () => void; report: (message: string, error?: boolean) => void; ask: (id: number) => void;
}) {
  const [selected, setSelected] = useState<number>();
  const [focus, setFocus] = useState<KnowledgeTarget>();
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState<number | 'none'>();
  const [tag, setTag] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [categoryForm, setCategoryForm] = useState<KnowledgeCategory | true>();
  const [deletingCategory, setDeletingCategory] = useState<KnowledgeCategory>();
  const [dragging, setDragging] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const search = useDebounced(query);
  const facets = useResource(() => knowledge('facets'), [revision], active);
  const results = useResource(() => knowledge('list', { filter: {
    query: search, categoryId: typeof categoryId === 'number' ? categoryId : undefined, uncategorized: categoryId === 'none', tag, offset,
  } }), [search, categoryId, tag, offset, revision], active);
  const categories = facets.data?.categories ?? [];
  const group = categories.find((item) => item.id === categoryId);

  const { uploading, errors, run } = useKnowledgeUpload({ refresh, report, onImported: (id, added, replaced) => {
    setSelected(id); setFocus(undefined);
    if (added && !replaced) {
      setTag(undefined); setQuery(''); setOffset(0);
      if (categoryId === 'none') setCategoryId(undefined);
    }
  } });
  useEffect(() => {
    if (initial?.id !== undefined) {
      setSelected(initial.id); setFocus(initial);
    }
    if (initial?.query !== undefined || initial?.categoryId !== undefined) {
      setQuery(initial.query ?? ''); setCategoryId(initial.categoryId); setTag(undefined); setOffset(0);
    }
  }, [intentKey]);

  function drop(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); event.stopPropagation(); setDragging(false);
    void run(Array.from(event.dataTransfer.files), { categoryId: group?.id });
  }
  function filterCategory(id?: number | 'none') { setCategoryId(id); setOffset(0); }

  return <section className="knowledge-page" aria-label="资料库工作区" onDragOver={(event) => {
    if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDragging(true); }
  }} onDragLeave={(event) => {
    if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
  }} onDrop={drop}>
    <div className="hub-workspace-actions">
      <Button tone="primary" onClick={() => files.current?.click()} disabled={!!uploading}><Upload size={16} />上传文件</Button>
    </div>
    <input ref={files} type="file" multiple className="sr-only" aria-label="选择资料文件" tabIndex={-1}
      accept={KNOWLEDGE_ACCEPT} onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = ''; void run(files, { categoryId: group?.id });
      }} />
    <input ref={replaceInput} type="file" className="sr-only" aria-label="选择替换原件" tabIndex={-1}
      accept={KNOWLEDGE_ACCEPT} onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = ''; if (selected) void run(files, { replaceId: selected });
      }} />
    {uploading && <Loading>正在处理 {uploading}</Loading>}
    {!!errors.length && <Notice><ul className="knowledge-errors">{errors.map((message, index) => <li key={index}>{message}</li>)}</ul></Notice>}
    {dragging && <div className="drop-hint" role="status">松开鼠标，将文件导入资料库</div>}
    <div className="knowledge-layout">
      <aside className="panel knowledge-facets" aria-label="资料分类和标签">
        <div className="panel-head"><h2>分类</h2><Button className="icon-btn" tone="quiet" aria-label="新建分类" onClick={() => setCategoryForm(true)}><FolderPlus size={17} /></Button></div>
        <div className="knowledge-groups">
          <button type="button" aria-pressed={categoryId === undefined} onClick={() => filterCategory()}><BookOpen size={15} />全部资料</button>
          <button type="button" aria-pressed={categoryId === 'none'} onClick={() => filterCategory('none')}><Folder size={15} />未分类</button>
          {categories.map((item) => <button type="button" key={item.id} aria-pressed={categoryId === item.id} onClick={() => filterCategory(item.id)}>
            <Folder size={15} /><span className="truncate">{item.name}</span><small>{item.count}</small></button>)}
        </div>
        {facets.error && <Notice>{facets.error}</Notice>}
        {group && <div className="knowledge-category-actions wrap">
          <Button tone="quiet" aria-label="重命名分类" onClick={() => setCategoryForm(group)}><Pencil size={15} /></Button>
          <Button tone="quiet" aria-label="删除分类" onClick={() => setDeletingCategory(group)}><Trash2 size={15} /></Button>
        </div>}
        <div className="knowledge-tag-filter">
          <Field label="标签"><select aria-label="按标签筛选资料" value={tag ?? ''} onChange={(event) => {
            setTag(event.target.value || undefined); setOffset(0);
          }}><option value="">全部标签</option>{facets.data?.tags.map((item) => <option key={item}>{item}</option>)}</select></Field>
        </div>
      </aside>
      <section className="panel knowledge-files" aria-label="资料列表">
        <div className="knowledge-file-search">
          <label className="search-input"><Search size={16} /><input aria-label="搜索资料文件" placeholder="搜索文件名或正文"
            value={query} maxLength={180} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></label>
          <small className="muted">{results.data ? results.data.total + ' 份资料 · 上传时间倒序' : '按上传时间排序'}</small>
        </div>
        {results.error ? <Notice action={<Button tone="quiet" onClick={results.retry}>重试</Button>}>{results.error}</Notice> :
          results.loading && !results.data ? <Loading /> : !results.data?.items.length ? <Empty icon={<BookOpen size={24} />}
            title={search || tag || categoryId !== undefined ? '没有匹配的资料' : '资料库为空'}
            description={search ? '可缩短关键词或查看文件的索引状态。' : '可上传文件，也可将文件拖入此页。'} /> :
            results.data.items.map((item) => <button className="knowledge-file-row" key={item.id} type="button" aria-pressed={selected === item.id}
              onClick={() => setSelected(item.id)}>
              <span className={'file-icon file-' + item.format}><FileText size={16} /></span>
              <span><strong>{item.name}</strong><small>{item.format.toUpperCase()} · {fileSize(item.byteSize)} · {date(item.uploadedAt)}</small></span>
            </button>)}
        {(results.data?.total ?? 0) > 60 && <div className="pagination">
          <span>{offset + 1}–{Math.min(offset + 60, results.data!.total)} / {results.data!.total}</span>
          <Button className="icon-btn" tone="quiet" aria-label="上一批资料" disabled={!offset} onClick={() => setOffset(offset - 60)}><ChevronLeft size={15} /></Button>
          <Button className="icon-btn" tone="quiet" aria-label="下一批资料" disabled={offset + 60 >= results.data!.total} onClick={() => setOffset(offset + 60)}><ChevronRight size={15} /></Button>
        </div>}
      </section>
      <section className="panel knowledge-preview" aria-label="资料详情">
        {selected === undefined ? <Empty icon={<FileText size={26} />} title="选择一份资料" description="查看索引文字、原件和授权设置。" /> :
          <KnowledgePane key={selected} id={selected} focus={selected === focus?.id ? focus : undefined} categories={categories}
            query={search} revision={revision} active={active} refresh={refresh} report={report} busy={!!uploading} ask={ask}
            replace={() => replaceInput.current?.click()} removed={() => setSelected(undefined)} />}
      </section>
    </div>
    {categoryForm && <CategoryDialog item={categoryForm === true ? undefined : categoryForm}
      onClose={() => setCategoryForm(undefined)} onSave={(id) => { filterCategory(id); refresh(); report('分类已保存'); }} />}
    {deletingCategory && <Confirm title="删除此分类？" description={'「' + deletingCategory.name + '」的文件会移至未分类。'}
      onClose={() => setDeletingCategory(undefined)} onConfirm={async () => {
        await knowledge('delete_category', { id: deletingCategory.id }); filterCategory(); refresh(); report('分类已删除');
      }} />}
  </section>;
}

function KnowledgePane({ id, focus, categories, query, revision, active, refresh, report, busy, ask, replace, removed }: {
  id: number; focus?: KnowledgeTarget; categories: KnowledgeCategory[]; query: string; revision: number;
  active: boolean; refresh: () => void; report: (text: string, error?: boolean) => void; busy: boolean;
  ask: (id: number) => void; replace: () => void; removed: () => void;
}) {
  const data = useResource(() => knowledge('detail', { id }), [id, revision], active);
  const [modal, setModal] = useState<'edit' | 'delete' | 'replace'>();
  const [pdf, setPdf] = useState(!!focus?.page);
  const chunkRef = useRef<HTMLDivElement>(null);
  const doc = data.data?.document;
  const chunks = data.data?.chunks ?? [];
  const activeChunk = focus?.chunk ?? (query && chunks.find((chunk) => chunk.text.toLowerCase().includes(query.toLowerCase()))?.ordinal);
  const usable = doc?.aiAllowed && (doc.parseStatus === 'complete' || doc.parseStatus === 'partial');
  useEffect(() => { if (focus?.page !== undefined) setPdf(true); }, [focus?.page]);
  useEffect(() => { if (active && !pdf) chunkRef.current?.scrollIntoView({ block: 'nearest' }); }, [activeChunk, data.data, pdf, active]);

  if (data.error) return <Notice action={<Button tone="quiet" onClick={data.retry}>重试</Button>}>{data.error}</Notice>;
  if (!doc) return <Loading />;
  const factLines = [
    ['适用地区', doc.region], ['发布机构', doc.issuer], ['发布日期', doc.publishedOn],
    ['生效日期', doc.effectiveOn], ['失效日期', doc.expiresOn],
  ].filter(([, value]) => value);
  return <>
    <div className="panel-head"><div className="knowledge-file-title"><h2>{doc.name}</h2>
      <p>{doc.format.toUpperCase()} · {fileSize(doc.byteSize)} · 上传于 {date(doc.uploadedAt)}</p></div>
      <Button className="icon-btn" aria-label="编辑资料信息" onClick={() => setModal('edit')} disabled={busy}><Pencil size={16} /></Button></div>
    <div className="knowledge-meta form-stack">
      <div className="wrap">
        <Pill tone={doc.parseStatus === 'complete' ? 'green' : 'amber'}>{INDEX_LABELS[doc.parseStatus]}</Pill>
        <Pill tone={doc.aiAllowed ? 'indigo' : 'neutral'}>{doc.aiAllowed ? '允许 AI 引用' : '仅本地使用'}</Pill>
      </div>
      <div className="wrap">
        <Button tone="primary" disabled={!usable || busy} onClick={() => ask(doc.id)}><MessageSquare size={15} />询问此资料</Button>
        <Button onClick={() => void showDocumentError(() => openKnowledge(doc.id), report)}><ExternalLink size={15} />打开原件</Button>
        {doc.format === 'pdf' && <Button tone="quiet" aria-pressed={pdf} onClick={() => setPdf(!pdf)}>{pdf ? '查看索引文字' : '预览 PDF'}</Button>}
      </div>
      {!usable && <small className="muted">询问此资料需要可用的正文索引和 AI 引用权限。</small>}
      {!!doc.tags.length && <div className="wrap">{doc.tags.map((tag) => <Pill key={tag}>{tag}</Pill>)}</div>}
      {(!!factLines.length || !!doc.sourceUrl) && <dl className="knowledge-facts">
        {factLines.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        {doc.sourceUrl && <div><dt>来源网址</dt><dd><button className="text-button" type="button" onClick={() =>
          void showDocumentError(() => openSourceLink({ kind: 'knowledge', id }), report)}>{doc.sourceUrl}</button></dd></div>}
      </dl>}
    </div>
    {pdf && doc.format === 'pdf' ? <div className="knowledge-pdf">
      <PdfViewer key={doc.revision} initialPage={focus?.page} identity={'knowledge-' + id + '-' + doc.revision} load={() => readKnowledge(id)} active={active} />
    </div> : <IndexedText detail={data.data!} activeChunk={activeChunk || undefined} chunkRef={chunkRef} />}
    <div className="knowledge-footer wrap">
      <Button tone="quiet" disabled={busy} onClick={() => setModal('replace')}><Upload size={15} />替换原件</Button>
      <Button tone="quiet" className="text-error" disabled={busy} onClick={() => setModal('delete')}><Trash2 size={15} />删除文件</Button>
    </div>
    {modal === 'edit' && <DocumentDialog doc={doc} categories={categories} onClose={() => setModal(undefined)}
      onSave={() => { refresh(); report('资料信息已保存'); }} />}
    {modal === 'delete' && <Confirm title="删除资料文件？" description="文件、正文索引和引用此文件的聊天会话会从当前资料库中移除。"
      onClose={() => setModal(undefined)} onConfirm={async () => {
        const cleaned = await knowledge('delete', { id }); removed(); refresh();
        report(cleaned ? '资料已删除' : '资料已删除。关闭占用文件的程序后，下次启动会继续清理原件。');
      }} />}
    {modal === 'replace' && <Modal title="替换资料原件" description="选择新文件后将更新索引、关闭该文件的 AI 引用权限，并移除引用旧内容的会话。" onClose={() => setModal(undefined)}>
      <div className="form-actions"><Button onClick={() => setModal(undefined)}>取消</Button><Button tone="primary" onClick={() => { setModal(undefined); replace(); }}>选择新文件</Button></div>
    </Modal>}
  </>;
}

function IndexedText({ detail, activeChunk, chunkRef }: {
  detail: KnowledgeDetail; activeChunk?: number; chunkRef: React.RefObject<HTMLDivElement | null>;
}) {
  return <div className="knowledge-extract" aria-label="正文索引">
    {detail.chunks.length ? detail.chunks.map((chunk) => <div ref={chunk.ordinal === activeChunk ? chunkRef : undefined}
      className={'knowledge-chunk' + (chunk.ordinal === activeChunk ? ' highlighted' : '')} key={chunk.ordinal}>
      <small>{chunk.page ? '第 ' + chunk.page + ' 页 · ' : ''}片段 {chunk.ordinal}</small><pre>{chunk.text}</pre></div>) :
      <Empty title={INDEX_LABELS[detail.document.parseStatus]} description={detail.document.format === 'pdf'
        ? '扫描或加密 PDF 可能无法提取文字，仍可打开原件。' : '可以打开原件，或替换为可提取文字的文件。'} />}
  </div>;
}

function CategoryDialog({ item, onClose, onSave }: { item?: KnowledgeCategory; onClose: () => void; onSave: (id: number) => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { onSave(await knowledge('save_category', { id: item?.id, name })); onClose(); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <Modal title={item ? '重命名分类' : '新建分类'} onClose={onClose} busy={busy}>
    <form className="form-stack" onSubmit={(event) => void save(event)}>
      <Field label="分类名称"><input autoFocus required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></Field>
      {error && <Notice>{error}</Notice>}
      <div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" tone="primary" busy={busy}>保存分类</Button></div>
    </form>
  </Modal>;
}

function DocumentDialog({ doc, categories, onClose, onSave }: {
  doc: KnowledgeFile; categories: KnowledgeCategory[]; onClose: () => void; onSave: () => void;
}) {
  const [value, setValue] = useState<KnowledgeEdit>({
    id: doc.id, name: doc.name, categoryId: doc.categoryId, tags: doc.tags, aiAllowed: doc.aiAllowed,
    region: doc.region, issuer: doc.issuer, publishedOn: doc.publishedOn, effectiveOn: doc.effectiveOn,
    expiresOn: doc.expiresOn, sourceUrl: doc.sourceUrl,
  });
  const [tags, setTags] = useState(doc.tags.join('，'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await knowledge('save', { edit: { ...value, tags: splitTags(tags) } }); onSave(); onClose(); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <Modal title="编辑资料信息" onClose={onClose} busy={busy} wide>
    <form className="form-stack" onSubmit={(event) => void save(event)}>
      <div className="form-grid">
        <Field label="文件名称"><input value={value.name} required maxLength={250} onChange={(event) => setValue({ ...value, name: event.target.value })} /></Field>
        <Field label="分类"><select value={value.categoryId ?? ''} onChange={(event) => setValue({ ...value, categoryId: Number(event.target.value) || null })}>
          <option value="">未分类</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
      </div>
      <Field label="标签"><input placeholder="用逗号分隔" value={tags} maxLength={600} onChange={(event) => setTags(event.target.value)} /></Field>
      <label className="check-line"><input type="checkbox" checked={value.aiAllowed} onChange={(event) => setValue({ ...value, aiAllowed: event.target.checked })} />
        <ShieldCheck size={15} />允许 AI 引用这份资料</label>
      <fieldset className="knowledge-validity"><legend><CalendarDays size={14} /> 来源与适用时间</legend>
        <div className="form-grid">
          <Field label="适用地区"><input value={value.region} maxLength={100} onChange={(event) => setValue({ ...value, region: event.target.value })} /></Field>
          <Field label="发布机构"><input value={value.issuer} maxLength={160} onChange={(event) => setValue({ ...value, issuer: event.target.value })} /></Field>
          <Field label="发布日期"><input type="date" value={value.publishedOn} onChange={(event) => setValue({ ...value, publishedOn: event.target.value })} /></Field>
          <Field label="生效日期"><input type="date" value={value.effectiveOn} onChange={(event) => setValue({ ...value, effectiveOn: event.target.value })} /></Field>
          <Field label="失效日期"><input type="date" value={value.expiresOn} onChange={(event) => setValue({ ...value, expiresOn: event.target.value })} /></Field>
          <Field label="来源网址"><input type="url" value={value.sourceUrl} maxLength={1500} onChange={(event) => setValue({ ...value, sourceUrl: event.target.value })} /></Field>
        </div>
      </fieldset>
      {error && <Notice>{error}</Notice>}
      <div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" busy={busy} tone="primary">保存资料</Button></div>
    </form>
  </Modal>;
}
