import { useEffect, useState } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, CalendarClock, ChevronLeft, ChevronRight, ExternalLink, FileText, MessageSquarePlus,
  FolderOpen, Mail, Maximize2, Minimize2, Pencil, Phone, Plus, Search, SlidersHorizontal, Star, Trash2, Upload, UserRound,
} from 'lucide-react';
import { errorText, openOriginal, PARSE_LABELS, rpc, STAGES, type CandidateDetail, type Filter, type Job, type Stage } from './api';
import { ApplicationStageControl } from './application-stage';
import { PdfView, showDocumentError, TextView } from './document-view';
import { ImportDialog } from './imports';
import { CandidateForm, LinkJob } from './recruit-forms';
import { applicationTodoSeed, CreateTodoDialog } from './todos';
import { Avatar, Button, Confirm, Empty, Field, Loading, Modal, Notice, PageHeading, Pill, date, fileSize, useDebounced, useResource } from './ui';

type Props = {
  initialId?: number; preset?: Filter; revision: number; jobs: Job[];
  refresh: () => void; report: (message: string, error?: boolean) => void;
  importNew: () => void; openJobs: (jobId?: number, applicationId?: number) => void;
};

export function Library({ initialId, preset, revision, jobs, refresh, report, importNew, openJobs }: Props) {
  const [filter, setFilter] = useState<Filter>(preset ?? {});
  const query = useDebounced(filter.query ?? '');
  const [selected, setSelected] = useState(initialId);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [newCandidate, setNewCandidate] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const rows = useResource(() => rpc('candidate_list', { filter: { ...filter, query } }),
    [query, filter.jobId, filter.stage, filter.tag, filter.favorite, filter.stale, filter.offset, revision]);
  const tags = useResource(() => rpc('tags'), [revision]);
  const activeFilters = Boolean(filter.jobId || filter.stage || filter.tag || filter.favorite || filter.stale);
  useEffect(() => {
    if (rows.loading || !rows.data) return;
    if (selected === undefined || ((query || activeFilters || filter.offset) && !rows.data.items.some((item) => item.id === selected))) {
      setSelected(rows.data.items[0]?.id);
    }
  }, [selected, rows.loading, rows.data, query, activeFilters, filter.offset]);
  useEffect(() => {
    if (!fullscreen) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[role=dialog]')) setFullscreen(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [fullscreen]);
  function change(input: Partial<Filter>) {
    setFilter((old) => ({ ...old, offset: 0, ...input }));
  }
  const offset = filter.offset ?? 0;
  return <main className={'page library-page' + (fullscreen ? ' library-fullscreen' : '')}>
    <PageHeading title="候选人库" description="查找简历、核对候选人资料并跟进岗位申请。">
      <Button onClick={() => setNewCandidate(true)}><Plus size={16} />新建候选人</Button>
      <Button tone="primary" onClick={importNew}><Upload size={16} />导入简历</Button>
    </PageHeading>
    <div className="library-grid">
      <section className="panel candidate-list" aria-label="候选人列表">
        <div className="candidate-filters">
          <div className="search-row">
            <label className="search-input"><Search size={17} /><input aria-label="搜索候选人"
              placeholder="姓名、标签或简历关键词" value={filter.query ?? ''} onChange={(e) => change({ query: e.target.value })} maxLength={180} /></label>
            <Button className="icon-btn" aria-label="组合筛选" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={16} /></Button>
          </div>
          {filtersOpen && <div className="filters-grid">
            <select aria-label="按岗位筛选" value={filter.jobId ?? ''} onChange={(e) => change({ jobId: Number(e.target.value) || undefined })}>
              <option value="">全部岗位</option>{jobs.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}
            </select>
            <select aria-label="按招聘阶段筛选" value={filter.stage ?? ''} onChange={(e) => change({ stage: (e.target.value || undefined) as Stage | undefined })}>
              <option value="">全部阶段</option>{Object.entries(STAGES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <select aria-label="按标签筛选" value={filter.tag ?? ''} onChange={(e) => change({ tag: e.target.value || undefined })}>
              <option value="">全部标签</option>{tags.data?.map((tag) => <option key={tag}>{tag}</option>)}
            </select>
            <Button tone={filter.favorite ? 'primary' : 'secondary'} aria-pressed={!!filter.favorite} onClick={() => change({ favorite: !filter.favorite })}>
              <Star size={14} />仅收藏
            </Button>
          </div>}
          {filter.stale && <div className="retention-filter"><Pill tone="amber">超过保留期限</Pill><Button tone="quiet" onClick={() => change({ stale: undefined })}>清除</Button></div>}
        </div>
        <div className="list-count"><span>{rows.data ? rows.data.total + ' 位候选人' : '候选人'}</span>
          {!!activeFilters && <button className="text-button" onClick={() => setFilter({ query: filter.query })}>清除筛选</button>}</div>
        <div className="list-scroll">
          {rows.error ? <Notice action={<Button tone="quiet" onClick={rows.retry}>重试</Button>}>{rows.error}</Notice>
            : rows.loading && !rows.data ? <Loading /> : !rows.data?.items.length ?
              <Empty icon={<UserRound size={24} />} title={query || activeFilters ? '没有符合条件的候选人' : '候选人库为空'}
                description={query || activeFilters ? '可缩短关键词或调整筛选组合。' : '导入第一份简历即可建立候选人档案。'} />
              : rows.data.items.map((item) => <div className={'candidate-list-item' + (item.id === selected ? ' selected' : '')} key={item.id}>
                <button type="button" className={'candidate-row' + (item.id === selected ? ' selected' : '')}
                  aria-pressed={item.id === selected} onClick={() => setSelected(item.id)}>
                <Avatar name={item.name} id={item.id} />
                <span className="candidate-row-copy"><strong>{item.name}</strong><small>{item.headline || item.resumeCount + ' 份简历'}</small>
                  {item.tags.length > 0 && <span className="list-tags">{item.tags.slice(0, 2).map((tag) => <Pill key={tag}>{tag}</Pill>)}</span>}</span>
                {item.favorite && <Star size={15} className="favorited" />}
                </button>
                <div className="candidate-list-stage">
                  <ApplicationStageControl applications={item.applications} label={item.name} refresh={refresh} report={report} />
                </div>
              </div>)}
        </div>
        {(rows.data?.total ?? 0) > 60 && <div className="pagination"><span>{offset + 1}–{Math.min(offset + 60, rows.data!.total)} / {rows.data!.total}</span>
          <Button aria-label="上一批候选人" tone="quiet" className="icon-btn" disabled={offset === 0} onClick={() => change({ offset: offset - 60 })}><ChevronLeft size={15} /></Button>
          <Button aria-label="下一批候选人" tone="quiet" className="icon-btn" disabled={offset + 60 >= rows.data!.total} onClick={() => change({ offset: offset + 60 })}><ChevronRight size={15} /></Button></div>}
      </section>
      <section className="panel candidate-preview" aria-label="当前候选人">
        {selected !== undefined ? <CandidatePane key={selected} id={selected} jobFilter={filter.jobId} jobs={jobs} revision={revision}
          fullscreen={fullscreen} toggleFullscreen={() => setFullscreen(!fullscreen)} refresh={refresh} report={report}
          openJobs={openJobs} removed={() => { setSelected(undefined); setFullscreen(false); }} /> :
          <Empty icon={<FileText size={29} />} title="简历预览" description="选中候选人后，可浏览简历和查看招聘记录。">
            <Button onClick={importNew}><FolderOpen size={16} />选择简历文件</Button>
          </Empty>}
      </section>
    </div>
    {newCandidate && <CandidateForm onClose={() => setNewCandidate(false)} onSaved={(id) => { setSelected(id); refresh(); report('候选人已创建'); }} />}
  </main>;
}

function CandidatePane({ id, jobFilter, jobs, revision, fullscreen, toggleFullscreen, refresh, report, openJobs, removed }: {
  id: number; jobFilter?: number; jobs: Job[]; revision: number; fullscreen: boolean; toggleFullscreen: () => void;
  refresh: () => void; report: Props['report']; openJobs: Props['openJobs']; removed: () => void;
}) {
  const detail = useResource(() => rpc('candidate', { id }), [id, revision]);
  const [tab, setTab] = useState<'preview' | 'details'>('preview');
  const [documentId, setDocumentId] = useState<number>();
  const [textMode, setTextMode] = useState(false);
  const [modal, setModal] = useState<'edit' | 'delete' | 'unlink' | 'upload' | 'link' | 'todo' | 'interview' | 'note'>();
  const [applicationId, setApplicationId] = useState<number>();
  const candidate = detail.data;
  const scoped = candidate?.applications.find((app) => app.jobId === jobFilter);
  const applications = scoped ? [scoped] : candidate?.applications ?? [];
  const selectedApplication = applications.length === 1 ? applications[0] : applications.find((app) => app.id === applicationId);
  const resume = candidate?.resumes.find((doc) => doc.id === documentId) ?? candidate?.resumes[0];
  const reference = resume ? { kind: 'resume' as const, id: resume.id } : undefined;
  useEffect(() => {
    if (candidate) void rpc('record_candidate_view', { id }).catch(() => {});
  }, [candidate?.id]);
  if (detail.error) return <Notice action={<Button tone="quiet" onClick={detail.retry}>重试</Button>}>{detail.error}</Notice>;
  if (!candidate) return <Loading />;
  return <>
    <header className="candidate-detail-head">
      <Avatar name={candidate.name} id={id} />
      <div className="candidate-detail-name"><h2>{candidate.name}</h2><span>{candidate.headline || candidate.resumeCount + ' 份简历'}</span></div>
      <div className="inline-actions">
        <Button className="icon-btn" aria-label={candidate.favorite ? '取消收藏' : '收藏候选人'} aria-pressed={candidate.favorite}
          onClick={() => void showDocumentError(async () => { await rpc('favorite', { id, favorite: !candidate.favorite }); refresh(); }, report)}>
          <Star size={17} className={candidate.favorite ? 'favorited' : ''} /></Button>
        <Button onClick={() => setModal('edit')}><Pencil size={14} />编辑档案</Button>
      </div>
    </header>
    <div className="candidate-quick-actions" aria-label="候选人快捷操作">
      <ApplicationStageControl key={jobFilter ?? 'all'} applications={applications} label="当前候选人" refresh={refresh} report={report}
        onSelect={setApplicationId} />
      <Button tone="quiet" onClick={() => setModal('note')}><MessageSquarePlus size={15} />添加备注</Button>
      <Button tone="quiet" onClick={() => setModal('todo')}><Plus size={15} />新建待办</Button>
      <Button tone="quiet" onClick={() => setModal('interview')}><CalendarClock size={15} />安排面试</Button>
    </div>
    <div className="tabs candidate-tabs" role="tablist" aria-label="候选人视图">
      <button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}><FileText size={15} />简历预览</button>
      <button role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}><UserRound size={15} />候选人详情</button>
      {fullscreen && <Button className="ml-auto" tone="quiet" onClick={toggleFullscreen}><ArrowLeft size={15} />返回列表</Button>}
    </div>
    {tab === 'preview' && resume && reference ? <>
      <div className="document-bar">
        <div className={'file-icon file-' + resume.format}><FileText size={17} /></div>
        <div className="document-info">
          <select aria-label="选择候选人的简历" value={resume.id} onChange={(event) => { setDocumentId(Number(event.target.value)); setTextMode(false); }}>
            {candidate.resumes.map((doc) => <option value={doc.id} key={doc.id}>{doc.originalName}</option>)}
          </select>
          <small>{resume.format.toUpperCase()} · {fileSize(resume.byteSize)} · {date(resume.importedAt)}
            {resume.parseStatus !== 'complete' && ' · ' + PARSE_LABELS[resume.parseStatus]}</small>
        </div>
        <div className="inline-actions">
          {resume.format === 'pdf' && <Button tone="quiet" aria-pressed={textMode} onClick={() => setTextMode(!textMode)}>
            {textMode ? '查看 PDF' : '提取文字'}</Button>}
          <Button tone="quiet" onClick={() => void showDocumentError(() => openOriginal(reference), report)}><ExternalLink size={15} />打开原件</Button>
          {(textMode || resume.format === 'docx') && <Button tone="quiet" className="icon-btn" aria-label={fullscreen ? '还原预览区域' : '最大化预览区域'}
            onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</Button>}
        </div>
      </div>
      {resume.format === 'pdf' && !textMode ? <PdfView key={resume.id} reference={reference} fullscreen={fullscreen} onFullscreen={toggleFullscreen} />
        : <div className="document-text-scroll"><TextView key={resume.id} reference={reference} document={resume} /></div>}
    </> : tab === 'preview' ? <Empty icon={<ArrowDownToLine size={26} />} title="此候选人还没有简历文件">
      <Button onClick={() => setModal('upload')}><Plus size={16} />添加简历</Button>
    </Empty> : <CandidateDetails candidate={candidate} refresh={refresh} report={report} onLink={() => setModal('link')}
      onUpload={() => setModal('upload')} onDelete={() => setModal('delete')} openJobs={openJobs}
      selectResume={(id) => { setDocumentId(id); setTextMode(false); setTab('preview'); }}
      removeResume={(id) => { setDocumentId(id); setModal('unlink'); }} />}
    {modal === 'edit' && <CandidateForm initial={candidate} onClose={() => setModal(undefined)} onSaved={() => { refresh(); report('候选人档案已保存'); }} />}
    {modal === 'note' && <NoteDialog id={id} name={candidate.name} onClose={() => setModal(undefined)}
      onSave={() => { refresh(); report('备注已保存'); }} />}
    {(modal === 'todo' || modal === 'interview') && <CreateTodoDialog jobs={jobs} initial={{
      ...(selectedApplication ? applicationTodoSeed(selectedApplication) : { candidateId: candidate.id, candidateName: candidate.name }),
      title: (modal === 'interview' ? '安排面试' : '跟进候选人') + ' · ' + candidate.name,
      category: modal === 'interview' ? 'interview' : 'follow_up', priority: 'normal',
    }} onClose={() => setModal(undefined)} onSaved={() => { refresh(); report('待办已保存'); }} />}
    {modal === 'upload' && <ImportDialog target={{ kind: 'candidate', id }} onClose={() => setModal(undefined)}
      onDone={(items) => {
        const imported = items.find((item) => item.state === 'imported');
        if (imported) { setDocumentId(imported.documentId); setTextMode(false); setTab('preview'); refresh(); }
      }} />}
    {modal === 'link' && <LinkJob jobs={jobs.filter((job) => !candidate.applications.some((app) => app.jobId === job.id))}
      candidateId={id} onClose={() => setModal(undefined)} onSaved={() => { refresh(); report('岗位申请已建立'); }} />}
    {modal === 'delete' && <Confirm title={'删除 ' + candidate.name + '？'} description="删除此候选人的档案、申请、备注及关联记录。"
      onClose={() => setModal(undefined)} onConfirm={async () => {
        const cleaned = await rpc('delete_candidate', { id }); refresh(); removed();
        report(cleaned ? '候选人已删除' : '档案已删除。请关闭占用的原件，下次启动时会继续清理。');
      }} />}
    {modal === 'unlink' && reference && <Confirm title="删除此简历？" description="删除此简历及相关引用。"
      onClose={() => setModal(undefined)} onConfirm={async () => {
        const cleaned = await rpc('delete_document', { reference }); refresh();
        report(cleaned ? '简历已删除' : '请关闭占用的原件，下次启动时会继续清理。');
      }} />}
  </>;
}

function NoteDialog({ id, name, onClose, onSave }: { id: number; name: string; onClose: () => void; onSave: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try { await rpc('add_note', { candidateId: id, body: note }); onSave(); onClose(); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <Modal title="添加候选人备注" description={name} busy={busy} onClose={onClose}>
    <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Field label="招聘备注"><textarea autoFocus rows={5} maxLength={4000} required value={note} onChange={(event) => setNote(event.target.value)} /></Field>
      {error && <Notice>{error}</Notice>}
      <div className="form-actions"><Button onClick={onClose} disabled={busy}>取消</Button>
        <Button type="submit" tone="primary" busy={busy} disabled={!note.trim()}>保存备注</Button></div>
    </form>
  </Modal>;
}

function CandidateDetails({ candidate, refresh, report, onLink, onUpload, onDelete, openJobs, selectResume, removeResume }: {
  candidate: CandidateDetail; refresh: () => void; report: Props['report']; onLink: () => void; onUpload: () => void; onDelete: () => void;
  openJobs: Props['openJobs']; selectResume: (id: number) => void; removeResume: (id: number) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [removeNote, setRemoveNote] = useState<number>();
  const id = candidate.id;
  async function saveNote() {
    setBusy(true);
    await showDocumentError(async () => {
      await rpc('add_note', { candidateId: id, body: note }); setNote(''); refresh(); report('备注已保存');
    }, report);
    setBusy(false);
  }
  return <div className="candidate-detail-scroll">
    <section className="detail-section">
      <h3>基础信息</h3>
      <div className="contact-grid">
        <span><Mail size={16} />{candidate.email || '未添加邮箱'}</span><span><Phone size={16} />{candidate.phone || '未添加电话'}</span>
      </div>
      {candidate.tags.length ? <div className="wrap">{candidate.tags.map((tag) => <Pill key={tag} tone="indigo">{tag}</Pill>)}</div> : <small className="muted">还没有标签</small>}
    </section>
    <section className="detail-section">
      <div className="subheading"><h3>原始简历</h3><Button onClick={onUpload}><Plus size={15} />添加简历</Button></div>
      {!candidate.resumes.length && <p className="muted">还没有简历文件。</p>}
      {candidate.resumes.map((file) => <div className="simple-row" key={file.id}>
        <span className={'file-icon file-' + file.format}><FileText size={15} /></span>
        <button className="text-button truncate" title={file.originalName} onClick={() => selectResume(file.id)}>{file.originalName}</button>
        <span className="muted ml-auto">{date(file.importedAt)}</span><Button tone="quiet" className="icon-btn" aria-label={'删除 ' + file.originalName}
          onClick={() => removeResume(file.id)}><Trash2 size={15} /></Button>
      </div>)}
    </section>
    <section className="detail-section">
      <div className="subheading"><h3>岗位申请</h3><Button onClick={onLink}><Plus size={15} />关联岗位</Button></div>
      {!candidate.applications.length && <p className="muted">此候选人还没有关联岗位。</p>}
      {candidate.applications.map((app) => <button type="button" key={app.id} className="application-link" onClick={() => openJobs(app.jobId, app.id)}>
        <span>{app.jobTitle}</span><Pill tone={app.stage === 'hired' ? 'green' : 'indigo'}>{STAGES[app.stage]}</Pill><ArrowRight size={15} />
      </button>)}
    </section>
    <section className="detail-section">
      <h3>HR 备注</h3>
      <div className="note-form"><textarea aria-label="新的 HR 备注" rows={3} placeholder="记录沟通进展或下一步安排" value={note} maxLength={4000}
        onChange={(event) => setNote(event.target.value)} /><Button busy={busy} disabled={!note.trim()} onClick={() => void saveNote()}>添加备注</Button></div>
      {candidate.notes.map((entry) => <div className="note" key={entry.id}>
        <div><small>{date(entry.createdAt, true)}</small><Button tone="quiet" className="icon-btn" aria-label="删除此备注" onClick={() => setRemoveNote(entry.id)}><Trash2 size={14} /></Button></div>
        <p>{entry.body}</p>
      </div>)}
    </section>
    <Button tone="quiet" className="text-error" onClick={onDelete}><Trash2 size={15} />删除候选人</Button>
    {removeNote !== undefined && <Confirm title="删除此备注？" description="此条招聘备注将从候选人档案移除。" onClose={() => setRemoveNote(undefined)}
      onConfirm={async () => { await rpc('delete_note', { candidateId: id, id: removeNote }); refresh(); }} />}
  </div>;
}
