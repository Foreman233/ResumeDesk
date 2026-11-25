import { useRef, useState } from 'react';
import { Check, ChevronDown, FileText, FolderOpen, Upload } from 'lucide-react';
import { JOB_STATUS, PARSE_LABELS, errorText, importBytes, previewImportBytes, type ImportCandidate, type ImportResult, type ImportTarget, type Job, type ParseStatus } from './api';
import { Button, Field, Modal, Notice, Pill, fileSize } from './ui';

type Entry = { key: number; name: string; size: number; result?: ImportResult; error?: string };
type Draft = { key: number; file: File; text: string; status: ParseStatus; candidates: ImportCandidate[]; error?: string };
const emptyText = { text: '', status: 'empty' } as const;

function validateFile(file: File) {
  if (!/\.(pdf|docx)$/i.test(file.name)) throw new Error('只支持 PDF 和 DOCX。');
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('请导入不超过 25 MB 的非空文件。');
}

async function extract(file: File, bytes: Uint8Array<ArrayBuffer>, preservePageBoundaries = false) {
  if (!/\.pdf$/i.test(file.name)) return emptyText;
  const { extractPdf } = await import('./pdf');
  return extractPdf(bytes, preservePageBoundaries);
}

export function ImportDialog({ target, initial, jobs = [], onClose, onDone }: {
  target: ImportTarget; initial?: File[]; jobs?: Job[]; onClose: () => void; onDone: (items: ImportResult[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const [items, setItems] = useState<Entry[]>([]);
  const [queue, setQueue] = useState<File[]>(initial ?? []);
  const [drafts, setDrafts] = useState<Draft[]>();
  const [openDraft, setOpenDraft] = useState<number>();
  const [autoParse, setAutoParse] = useState(true);
  const [jobId, setJobId] = useState<number>();
  const [busy, setBusy] = useState<'preview' | 'save'>();
  const [hover, setHover] = useState(false);
  const [error, setError] = useState('');
  const isNew = target.kind === 'new';
  const reviewedCandidates = drafts?.reduce((count, draft) => count + draft.candidates.length, 0) ?? 0;
  const savedCandidates = items.reduce((count, item) => count + (item.result?.state === 'imported' ? item.result.candidates?.length ?? 1 : 0), 0);

  function add(files: File[]) {
    setError(files.length + queue.length > 60 ? '每批最多选择 60 个文件。' : '');
    setQueue((old) => [...old, ...files].slice(0, 60));
  }

  async function prepareReview() {
    if (busy || !queue.length) return;
    setBusy('preview');
    setError('');
    const next: Draft[] = [];
    for (const file of queue) {
      const key = ++counter.current;
      try {
        validateFile(file);
        if (autoParse) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const result = await extract(file, bytes, true);
          const preview = await previewImportBytes(file.name, result.text, result.status, bytes);
          next.push({ key, file, text: result.text, status: preview.parseStatus, candidates: preview.candidates });
        } else {
          const name = [...file.name.replace(/\.[^.]+$/, '').trim()].slice(0, 90).join('') || '未命名候选人';
          next.push({ key, file, ...emptyText, candidates: [{ name, headline: '', email: '', phone: '' }] });
        }
      } catch (e) { next.push({ key, file, ...emptyText, candidates: [], error: errorText(e) }); }
    }
    setQueue([]);
    setDrafts(next);
    setOpenDraft(next.find((draft) => draft.candidates.length)?.key);
    setBusy(undefined);
  }

  function editCandidate(key: number, index: number, change: Partial<ImportCandidate>) {
    setError('');
    setDrafts((old) => old?.map((draft) => draft.key !== key ? draft : {
      ...draft, candidates: draft.candidates.map((candidate, position) => position === index ? { ...candidate, ...change } : candidate),
    }));
  }

  function removeCandidate(key: number, index: number) {
    setError('');
    setDrafts((old) => old?.map((draft) => draft.key !== key ? draft : {
      ...draft, candidates: draft.candidates.filter((_, position) => position !== index),
    }));
  }

  async function runImport() {
    if (busy) return;
    const reviewed = drafts?.filter((draft) => draft.candidates.length > 0);
    const invalid = reviewed?.find((draft) => draft.candidates.some((candidate) => !candidate.name.trim()));
    if (invalid) {
      setOpenDraft(invalid.key);
      setError('请填写每位候选人的姓名后再导入。');
      return;
    }
    const batch: Draft[] = reviewed ?? queue.map((file) => ({ file, key: ++counter.current, ...emptyText, candidates: [] }));
    if (!batch.length) return;
    setBusy('save');
    setError('');
    setDrafts(undefined);
    setQueue([]);
    const resultRows = (drafts ?? batch).map(({ key, file, error }): Entry => ({
      key, name: file.name, size: file.size, error,
    }));
    setItems((previous) => [...previous, ...resultRows]);
    const results: ImportResult[] = [];
    for (const item of batch) {
      const update = (result: Partial<Entry>) => setItems((entries) => entries.map((entry) => entry.key === item.key ? { ...entry, ...result } : entry));
      try {
        validateFile(item.file);
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        const extraction = reviewed ? item : await extract(item.file, bytes);
        const options = reviewed ? { jobId, autoParse, candidates: item.candidates } : undefined;
        const result = await importBytes(item.file.name, target, extraction.text, extraction.status, bytes, options);
        results.push(result);
        update({ result });
      } catch (e) { update({ error: errorText(e) }); }
    }
    onDone(results);
    setBusy(undefined);
  }

  const title = target.kind === 'candidate' ? '为候选人添加简历' : '导入简历';
  return <Modal title={drafts ? '核对候选人资料' : title} onClose={onClose} busy={!!busy} wide={!!drafts}
    description={drafts ? '核对姓名、联系方式和岗位后，再保存到候选人库。' : isNew ? '选择文件后，可设置岗位和解析方式。' : undefined}>
    {!drafts && <>
      <input type="file" ref={ref} multiple accept=".pdf,.docx" className="sr-only" aria-label="选择简历文件"
        onChange={(event) => { add(Array.from(event.target.files ?? [])); event.target.value = ''; }} disabled={!!busy} />
      <button type="button" className={'dropzone' + (hover ? ' dropzone-active' : '')} disabled={!!busy}
        onClick={() => ref.current?.click()} onDragOver={(event) => { event.preventDefault(); setHover(true); }}
        onDragLeave={() => setHover(false)} onDrop={(event) => {
          event.preventDefault(); event.stopPropagation(); setHover(false);
          if (!busy) add(Array.from(event.dataTransfer.files));
        }}>
        <Upload size={23} /><strong>选择或拖拽简历文件</strong><span>支持 PDF、DOCX · 每份最多 25 MB</span>
      </button>
    </>}
    {isNew && (!!queue.length || !!drafts) && <div className="import-options">
      <Field label="关联岗位" hint={jobs.length ? '选定岗位后，新建的候选人会进入该岗位的待初筛阶段。' : '暂无岗位，可以先将简历导入候选人库。'}>
        <select value={jobId ?? ''} disabled={!!busy || !jobs.length} onChange={(e) => setJobId(e.target.value ? Number(e.target.value) : undefined)}>
          <option value="">不关联岗位</option>
          {jobs.map((job) => <option key={job.id} value={job.id}>
            {job.title}{job.department ? ' · ' + job.department : ''}{job.status !== 'open' ? ' · ' + JOB_STATUS[job.status] : ''}
          </option>)}
        </select>
      </Field>
      {!drafts && <div>
        <label className="check-line"><input type="checkbox" checked={autoParse} disabled={!!busy}
          onChange={(e) => setAutoParse(e.target.checked)} />自动解析候选人简历</label>
        <small className="muted">{autoParse
          ? '在本机提取简历文字。识别出多位候选人时，可逐一核对后分别建档。'
          : '每份文件手动建立一位候选人，只保存原件和填写的资料。'}</small>
      </div>}
    </div>}
    {error && <Notice>{error}</Notice>}
    {drafts && <div className="import-review">
      <div className="import-review-summary" role="status">待核对 {reviewedCandidates} 位候选人 · {drafts.length} 份文件</div>
      {drafts.map((draft) => <div key={draft.key} className="import-review-file">
        <div className="import-review-header">
          <button type="button" className="import-review-toggle" disabled={!draft.candidates.length} aria-expanded={openDraft === draft.key}
            onClick={() => setOpenDraft(openDraft === draft.key ? undefined : draft.key)}>
            <ChevronDown size={15} className={openDraft === draft.key ? '' : 'import-review-closed'} />
            <span className="truncate" title={draft.file.name}>{draft.file.name}</span>
            {!!draft.candidates.length && <Pill tone="indigo">{draft.candidates.length} 位</Pill>}
          </button>
          <Button tone="quiet" onClick={() => setDrafts((old) => old?.filter((entry) => entry.key !== draft.key))}
            aria-label={'移除文件 ' + draft.file.name}>移除文件</Button>
        </div>
        {draft.error && <div className="import-review-warning text-error">{draft.error}</div>}
        {openDraft === draft.key && !!draft.candidates.length && <div className="import-candidates">
          {autoParse && draft.status !== 'complete' && <small className="muted">{PARSE_LABELS[draft.status]}，请核对填入的资料。</small>}
          {draft.candidates.map((candidate, index) => <fieldset key={candidate.section ?? index} className="import-candidate-fields">
            <legend>候选人 {index + 1}</legend>
            {draft.candidates.length > 1 && <div className="import-candidate-actions">
              <Button tone="quiet" aria-label={'移除候选人 ' + (index + 1)} onClick={() => removeCandidate(draft.key, index)}>不导入此人</Button>
            </div>}
            <div className="form-grid">
              <Field label="姓名"><input value={candidate.name} maxLength={90} required
                onChange={(e) => editCandidate(draft.key, index, { name: e.target.value })} /></Field>
              <Field label="当前职位"><input value={candidate.headline} maxLength={160}
                onChange={(e) => editCandidate(draft.key, index, { headline: e.target.value })} /></Field>
              <Field label="邮箱"><input type="email" value={candidate.email} maxLength={180}
                onChange={(e) => editCandidate(draft.key, index, { email: e.target.value })} /></Field>
              <Field label="电话"><input type="tel" value={candidate.phone} maxLength={64}
                onChange={(e) => editCandidate(draft.key, index, { phone: e.target.value })} /></Field>
            </div>
          </fieldset>)}
        </div>}
      </div>)}
    </div>}
    {!drafts && (items.length > 0 || queue.length > 0) && <div className="batch-list">
      {queue.map((file, index) => <div key={index} className="file-row">
        <FileText size={17} /><span className="truncate">{file.name}</span><span className="muted">{fileSize(file.size)}</span>
        <Button tone="quiet" disabled={!!busy} onClick={() => setQueue((files) => files.filter((_, i) => i !== index))}>移除</Button>
      </div>)}
      {items.map((item) => <div key={item.key} className="file-row">
        <FileText size={17} /><span className="truncate" title={item.name}>{item.name}</span>
        {item.error ? <span className="text-error">{item.error}</span> : item.result?.state === 'duplicate'
          ? <Pill tone="amber">重复 · {item.result.ownerName}</Pill>
          : item.result?.state === 'imported'
            ? <Pill tone="green"><Check size={12} />{(item.result.candidates?.length ?? 0) > 1
              ? '已导入 ' + item.result.candidates!.length + ' 位'
              : item.result.parseStatus === 'complete' ? '已导入' : '原件已保存'}</Pill>
            : <Pill tone="indigo">处理中</Pill>}
      </div>)}
    </div>}
    {isNew && !drafts && !busy && savedCandidates > 0 && <Notice tone="success">已创建 {savedCandidates} 位候选人档案。</Notice>}
    <div className="form-actions">
      {drafts ? <>
        <Button onClick={() => { setQueue(drafts.map((draft) => draft.file)); setDrafts(undefined); setError(''); }}>返回修改</Button>
        <Button tone="primary" disabled={!reviewedCandidates} onClick={() => void runImport()}>确认导入</Button>
      </> : <>
        <Button onClick={onClose} disabled={!!busy}>{items.length ? '完成' : '取消'}</Button>
        <Button tone="primary" busy={!!busy} disabled={!queue.length} onClick={() => void (isNew ? prepareReview() : runImport())}>
          {!busy && <FolderOpen size={16} />}
          {busy === 'preview' ? '正在读取简历' : busy === 'save' ? '正在导入' : (isNew ? '核对导入' : '导入') + (queue.length ? '（' + queue.length + '）' : '')}
        </Button>
      </>}
    </div>
  </Modal>;
}
