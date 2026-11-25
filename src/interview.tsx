import { useEffect, useRef, useState } from 'react';
import { ClipboardList, Copy, Download, FilePlus2, History, Plus, Save, Sparkles, Square, Trash2 } from 'lucide-react';
import { cancelAI, errorText, rpc, type Job } from './api';
import { blankQuestion, defaultConfig, dismissInterview, generateInterview, interview, MAX_QUESTIONS, prepareInterview,
  type GuideInput, type InterviewConfig, type InterviewGuide, type InterviewPreview, type InterviewQuestion, type InterviewSelection, type InterviewSummary, type InterviewTarget } from './interview-api';
import { InterviewExportDialog, QuestionList, questionRow, type QuestionRow } from './interview-editor';
import { CandidateChooser, InterviewConfiguration, InterviewSelectionPanel, validConfig } from './interview-setup';
import { Button, Confirm, Empty, Field, Loading, Modal, Notice, Pill, date, useDebounced, useResource } from './ui';
import './interview.css';

type Report = (message: string, error?: boolean) => void;
type Draft = Omit<GuideInput, 'questions'> & { questions: QuestionRow[] };
type Target = 'whole' | 'supplement' | { key: string };
type Pending = { preview: InterviewPreview; target: Target };

const blankSelection = (): InterviewSelection => ({ candidateId: null, resumeId: null, jobId: null, applicationId: null, jobTitle: '', temporaryJd: '' });
const blankDraft = (): Draft => ({ title: '', interviewDate: '', selection: blankSelection(), config: defaultConfig(), questions: [] });
const draftFrom = (guide: InterviewGuide): Draft => ({ ...guide.input, questions: guide.input.questions.map(questionRow) });
const normalizedQuestion = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

function GuideRow({ item, open }: { item: InterviewSummary; open: () => void }) {
  return <button type="button" className="interview-guide-row" onClick={open}>
    <ClipboardList size={16} /><span><strong>{item.title}</strong><small>{[item.candidateName, item.jobTitle].filter(Boolean).join(' · ')}</small></span>
    <small>{item.questionCount} 题 · {date(item.updatedAt)}</small>
  </button>;
}

export function InterviewCard({ active, revision, open }: { active: boolean; revision: number; open: (target?: InterviewTarget) => void }) {
  const past = useResource(() => interview('list', { limit: 4 }), [revision], active);
  return <div className="form-stack interview-card">
    <Button tone="primary" onClick={() => open({ fresh: true })}><Plus size={15} />新建面试提纲</Button>
    <CandidateChooser current={null} onPick={(candidateId) => open({ fresh: true, candidateId })} active={active} compact />
    <h3>最近面试提纲</h3>
    {past.error ? <Notice action={<Button tone="quiet" onClick={past.retry}>重试</Button>}>{past.error}</Notice> : past.loading && !past.data ? <Loading /> :
      past.data?.length ? <div>{past.data.map((item) => <GuideRow key={item.id} item={item} open={() => open({ guideId: item.id })} />)}</div> : <small className="muted">暂无已保存的提纲</small>}
  </div>;
}

async function draftFor(target: InterviewTarget): Promise<Draft> {
  const draft = blankDraft();
  if (!target.candidateId) return draft;
  const candidate = await rpc('candidate', { id: target.candidateId });
  const resume = candidate.resumes.find((item) => item.id === target.resumeId) ?? candidate.resumes[0];
  const application = candidate.applications.find((item) => item.id === target.applicationId && (!target.jobId || item.jobId === target.jobId))
    ?? candidate.applications.find((item) => item.jobId === target.jobId)
    ?? (!target.jobId && candidate.applications.length === 1 ? candidate.applications[0] : undefined);
  const jobId = application?.jobId ?? target.jobId ?? null;
  const jobTitle = application?.jobTitle ?? (jobId ? (await rpc('jobs')).find((item) => item.id === jobId)?.title : undefined) ?? '';
  return { ...draft, title: jobTitle ? jobTitle + '面试提纲' : '', selection: {
    ...draft.selection, candidateId: candidate.id, resumeId: resume?.id ?? null,
    jobId, jobTitle, applicationId: application?.id ?? null,
  } };
}

export function InterviewWorkspace({ active, initial, intentKey, jobs, revision, report, refresh, aiEnabled, openAiSettings }: {
  active: boolean; initial?: InterviewTarget; intentKey: number; jobs: Job[]; revision: number;
  report: Report; refresh: () => void; aiEnabled: boolean; openAiSettings: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [guide, setGuide] = useState<InterviewGuide>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'open' | 'save' | 'preview' | 'generate'>();
  const [pending, setPending] = useState<Pending>();
  const [running, setRunning] = useState<string>();
  const [outcome, setOutcome] = useState<{ message: string; error?: boolean }>();
  const [confirm, setConfirm] = useState<{ title: string; description: string; label: string; run: () => Promise<void> }>();
  const [showHistory, setShowHistory] = useState(false);
  const [exporting, setExporting] = useState(false);
  const runningRef = useRef<string | undefined>(undefined);
  const intentRef = useRef(0);
  const status = useResource(() => rpc('ai_status'), [intentKey, aiEnabled, active], active && aiEnabled);
  const selected = useResource(() => draft.selection.candidateId ? rpc('candidate', { id: draft.selection.candidateId }) : Promise.resolve(undefined),
    [draft.selection.candidateId, intentKey, revision], active);
  const candidate = selected.data?.id === draft.selection.candidateId ? selected.data : undefined;
  const configReady = validConfig(draft.config);
  const selectedResume = candidate?.resumes.find((item) => item.id === draft.selection.resumeId);
  const sourceReady = !!draft.selection.jobTitle.trim() && !!selectedResume && ['complete', 'partial'].includes(selectedResume.parseStatus);
  const aiReady = aiEnabled && !!status.data?.verified;
  const canGenerate = configReady && sourceReady && aiReady;
  const missing = draft.config.allocations.map((item) => ({ ...item,
    count: Math.max(0, item.count - draft.questions.filter((row) => row.value.category === item.category).length),
  })).filter((item) => item.count > 0);
  const missingCount = missing.reduce((sum, item) => sum + item.count, 0);
  const modelInput = (): GuideInput => ({ ...draft, questions: draft.questions.map(({ value }) => value) });

  function update(patch: Partial<Draft>) { setDraft((current) => ({ ...current, ...patch })); setDirty(true); }
  function install(next: Draft, stored?: InterviewGuide) { setDraft(next); setGuide(stored); setDirty(false); setOutcome(undefined); }
  function checkedChange(next: () => Promise<void>) {
    if (dirty) setConfirm({ title: '放弃未保存的修改？', description: '当前提纲有未保存的修改。可先取消并保存，再切换候选人或提纲。', label: '放弃修改并继续', run: next });
    else void next();
  }
  async function open(target: InterviewTarget) {
    setBusy('open');
    try {
      if (target.guideId) {
        const saved = await interview('get', { id: target.guideId });
        install(draftFrom(saved), saved);
      } else {
        install(await draftFor(target));
      }
      setShowHistory(false);
    } catch (err) { setOutcome({ message: errorText(err), error: true }); }
    finally { setBusy(undefined); }
  }
  useEffect(() => {
    if (!active || busy || intentRef.current === intentKey) return;
    intentRef.current = intentKey;
    if (initial?.guideId || initial?.candidateId || initial?.fresh) checkedChange(() => open(initial));
  }, [active, busy, intentKey]);
  useEffect(() => () => { if (runningRef.current) void cancelAI(runningRef.current).catch(() => {}); }, []);

  function changeSelection(selection: InterviewSelection) {
    if (!draft.title.trim() && selection.jobTitle.trim()) update({ selection, title: selection.jobTitle + '面试提纲' });
    else update({ selection });
  }
  function editQuestion(key: string, patch: Partial<InterviewQuestion>) {
    update({ questions: draft.questions.map((row) => row.key === key ? { ...row, value: { ...row.value, ...patch } } : row) });
  }
  function reorder(key: string, to: number) {
    const from = draft.questions.findIndex((row) => row.key === key);
    if (from < 0 || from === to || !draft.questions[to]) return;
    const rows = [...draft.questions];
    rows.splice(to, 0, ...rows.splice(from, 1));
    update({ questions: rows });
  }
  async function save() {
    setBusy('save'); setOutcome(undefined);
    try {
      const saved = await interview('save', { id: guide?.id, revision: guide?.revision, input: modelInput() });
      install({ ...saved.input, questions: draft.questions.map((row, index) => ({ key: row.key, value: saved.input.questions[index] })) }, saved);
      refresh(); report('面试提纲已保存');
    } catch (err) { setOutcome({ message: errorText(err), error: true }); }
    finally { setBusy(undefined); }
  }
  function copyGuide() {
    update({ title: (draft.title.trim().slice(0, 170) || '面试提纲') + '（副本）', questions: draft.questions.map(({ value }) => questionRow({
      ...value, answerSummary: '', interviewerNotes: '', verification: '',
    })) });
    setGuide(undefined); setOutcome({ message: '已复制题目，面试记录已留空。保存后会创建新提纲。' });
  }
  function deleteGuide() {
    if (!guide) return;
    setConfirm({ title: '删除这份面试提纲？', description: '此操作会删除提纲及其中的面试记录。', label: '删除提纲', run: async () => {
      await interview('delete', { id: guide.id, revision: guide.revision });
      install(blankDraft()); refresh(); report('面试提纲已删除');
    } });
  }

  function generationConfig(target: Target): InterviewConfig | undefined {
    if (target === 'whole') return draft.config;
    if (target === 'supplement') {
      const room = MAX_QUESTIONS - draft.questions.length;
      if (!missingCount || room < missingCount) return undefined;
      return { ...draft.config, total: missingCount, allocations: missing };
    }
    const row = draft.questions.find(({ key }) => key === target.key);
    return row ? { ...draft.config, total: 1, difficulty: row.value.difficulty, allocations: [{ category: row.value.category, count: 1 }] } : undefined;
  }

  async function run(next: Pending, confirmed: boolean, remember: boolean) {
    const { preview, target } = next;
    setPending(undefined); setRunning(preview.id); runningRef.current = preview.id; setBusy('generate');
    try {
      const result = await generateInterview(preview.id, confirmed, remember);
      const existing = new Set(draft.questions.filter((row) => typeof target === 'object' ? row.key !== target.key : target === 'supplement')
        .map(({ value }) => normalizedQuestion(value.question)));
      const rows = result.questions.filter((item) => {
        const normalized = normalizedQuestion(item.question);
        if (existing.has(normalized)) return false;
        existing.add(normalized); return true;
      }).map(questionRow);
      if (rows.length) {
        if (target === 'whole') update({ questions: rows });
        else if (target === 'supplement') update({ questions: [...draft.questions, ...rows] });
        else update({ questions: draft.questions.map((item) => item.key === target.key ? { ...item, value: { ...rows[0].value,
          answerSummary: item.value.answerSummary, interviewerNotes: item.value.interviewerNotes, verification: item.value.verification,
        } } : item) });
      }
      const complete = rows.length === result.requested && !result.adjusted;
      setOutcome({ message: complete ? (target === 'whole' ? `已生成 ${rows.length} 道题，请审核并保存。` : target === 'supplement' ? `已补充 ${rows.length} 道题。` : '已重新生成此题，面试记录已保留。') :
        `本次取得 ${rows.length} / ${result.requested} 道符合要求的题。${rows.length ? '可补充剩余题目或重新生成。' : '保留现有提纲，可重新生成。'}`, error: !rows.length });
    } catch (err) { setOutcome({ message: errorText(err), error: true }); }
    finally { setBusy(undefined); setRunning(undefined); runningRef.current = undefined; }
  }

  async function prepare(target: Target) {
    const config = generationConfig(target);
    if (!config) return;
    setBusy('preview'); setOutcome(undefined);
    try {
      const preview = await prepareInterview(draft.selection, config);
      const next = { preview, target };
      if (preview.confirmationRequired) { setPending(next); setBusy(undefined); }
      else await run(next, false, false);
    } catch (err) { setBusy(undefined); setOutcome({ message: errorText(err), error: true }); }
  }
  function requestGeneration(target: Target) {
    if (target === 'whole' && draft.questions.length) setConfirm({ title: '重新生成整份提纲？',
      description: '生成成功后会替换当前草稿的题目和题下记录。已保存的版本需再次保存才会更新。', label: '重新生成', run: () => prepare(target) });
    else void prepare(target);
  }

  return <div className="interview-workspace" aria-label="面试准备工作区">
    <div className="interview-workspace-bar wrap between">
      <div className="wrap"><Button disabled={!!busy || !!pending} onClick={() => checkedChange(() => open({ fresh: true }))}><FilePlus2 size={15} />新建提纲</Button>
        <Button disabled={!!busy || !!pending} onClick={() => setShowHistory(true)}><History size={15} />历史提纲</Button></div>
      <div className="wrap">{guide && <small className="muted">创建于 {date(guide.createdAt, true)} · 修改于 {date(guide.updatedAt, true)}</small>}
        <Pill tone={dirty ? 'gold' : 'neutral'}>{dirty ? '有未保存修改' : guide ? '已保存' : '新提纲'}</Pill></div>
    </div>
    {outcome && <Notice tone={outcome.error ? 'error' : 'hint'}>{outcome.message}</Notice>}
    <div className="interview-columns">
      <section className="panel interview-panel" aria-label="候选人与岗位">
        <h3>候选人与岗位</h3>
        <fieldset className="interview-fieldset form-stack" disabled={!!busy || !!pending}>
          <InterviewSelectionPanel selection={draft.selection} candidate={candidate} candidateError={selected.error} jobs={jobs} active={active}
            pick={(candidateId) => { if (candidateId !== draft.selection.candidateId) checkedChange(() => open({ candidateId })); }} update={changeSelection} />
          <Field label="面试日期"><input type="date" value={draft.interviewDate} onChange={(e) => update({ interviewDate: e.target.value })} /></Field>
        </fieldset>
      </section>
      <section className="panel interview-panel" aria-label="生成设置">
        <h3>生成设置</h3>
        <fieldset className="interview-fieldset" disabled={!!busy || !!pending}>
          <InterviewConfiguration config={draft.config} update={(config) => update({ config })} />
        </fieldset>
        {!aiEnabled ? <Notice tone="hint" action={<Button tone="quiet" onClick={openAiSettings}>打开设置</Button>}>AI 已关闭，可以手动编辑提纲。</Notice> :
          !status.loading && !aiReady ? <Notice tone="hint" action={<Button tone="quiet" onClick={openAiSettings}>配置 AI</Button>}>请先配置并测试 AI 连接。手动编辑可直接使用。</Notice> :
          aiReady && !sourceReady ? <small className="muted">请选择岗位和已提取文字的简历。</small> : null}
        <div className="wrap interview-generate-actions">
          <Button tone="primary" busy={busy === 'preview' || busy === 'generate'} disabled={!canGenerate || !!busy || !!pending}
            onClick={() => requestGeneration('whole')}><Sparkles size={16} />{draft.questions.length ? '重新生成提纲' : '生成面试问题'}</Button>
          {!!draft.questions.length && missingCount > 0 && draft.questions.length + missingCount <= MAX_QUESTIONS && <Button disabled={!canGenerate || !!busy || !!pending}
            onClick={() => requestGeneration('supplement')}>补充 {missingCount} 题</Button>}
          {running && <Button onClick={() => void cancelAI(running).catch((err: unknown) => report(errorText(err), true))}><Square size={14} />停止生成</Button>}
        </div>
      </section>
      <section className="panel interview-panel interview-result" aria-label="提纲编辑">
        <div className="wrap between"><h3>面试提纲</h3><Pill>{draft.questions.length} 题</Pill></div>
        <Field label="提纲名称"><input maxLength={180} value={draft.title} disabled={!!busy || !!pending} placeholder="例如 数据分析师一面"
          onChange={(event) => update({ title: event.target.value })} /></Field>
        <div className="wrap interview-edit-actions">
          <Button disabled={!!busy || !!pending || draft.questions.length >= MAX_QUESTIONS}
            onClick={() => update({ questions: [...draft.questions, questionRow(blankQuestion(draft.config.allocations[0]?.category))] })}><Plus size={15} />手动加题</Button>
          <Button tone="primary" busy={busy === 'save'} disabled={!!busy || !!pending || !configReady || !draft.title.trim() || !draft.selection.jobTitle.trim() || draft.questions.some(({ value }) => !value.question.trim())}
            onClick={() => void save()}><Save size={15} />保存提纲</Button>
          <Button disabled={!!busy || !!pending || !draft.questions.length} onClick={() => setExporting(true)}><Download size={15} />导出</Button>
          {guide && <><Button disabled={!!busy || !!pending} onClick={copyGuide}><Copy size={14} />复制提纲</Button>
            <Button className="icon-btn" tone="quiet" aria-label="删除提纲" disabled={!!busy || !!pending} onClick={deleteGuide}><Trash2 size={16} /></Button></>}
        </div>
        {busy === 'open' ? <Loading /> : draft.questions.length ? <QuestionList rows={draft.questions} readOnly={!!busy || !!pending}
          canGenerate={canGenerate} edited={editQuestion} remove={(key) => update({ questions: draft.questions.filter((row) => row.key !== key) })}
          reorder={reorder} regenerate={(key) => requestGeneration({ key })} /> :
          <Empty icon={<ClipboardList size={25} />} title="提纲还没有题目" description="从所选简历生成问题，或手动添加。" />}
      </section>
    </div>
    {active && pending && <InterviewPermission preview={pending.preview}
      cancel={() => { void dismissInterview(pending.preview.id).catch(() => {}); setPending(undefined); }}
      approve={(remember) => void run(pending, true, remember)} />}
    {active && showHistory && <InterviewHistory jobs={jobs} candidateId={draft.selection.candidateId}
      close={() => setShowHistory(false)} pick={(id) => { setShowHistory(false); checkedChange(() => open({ guideId: id })); }} />}
    {active && confirm && <Confirm title={confirm.title} description={confirm.description} label={confirm.label} onConfirm={confirm.run} onClose={() => setConfirm(undefined)} />}
    {active && exporting && <InterviewExportDialog input={modelInput()} candidateName={candidate?.name} close={() => setExporting(false)} report={report} />}
  </div>;
}

function InterviewPermission({ preview, approve, cancel }: { preview: InterviewPreview; approve: (remember: boolean) => void; cancel: () => void }) {
  const [remember, setRemember] = useState(false);
  return <Modal title="核对面试资料发送范围" description="仅发送以下已脱敏资料和本次出题设置。" wide onClose={cancel}>
    <div className="form-stack interview-permission">
      <small className="muted">{preview.model} · {preview.endpoint}</small>
      {preview.highRisk && <Notice tone="hint">资料中仍可能包含个人信息。请核对后再发送。</Notice>}
      {preview.context.truncated && <small className="muted">资料较长，本次仅发送下面显示的片段。</small>}
      <strong>{preview.context.role}</strong>
      <details open><summary>所选简历</summary><pre>{preview.context.resume}</pre></details>
      <details open><summary>岗位 JD</summary><pre>{preview.context.jd || '未提供'}</pre></details>
      {preview.context.focus && <details open><summary>关注重点</summary><pre>{preview.context.focus}</pre></details>}
      {!preview.highRisk && <label className="interview-check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />记住此模型和资料范围的授权</label>}
      <div className="form-actions"><Button onClick={cancel}>取消</Button><Button tone="primary" onClick={() => approve(remember)}>确认发送并生成</Button></div>
    </div>
  </Modal>;
}

function InterviewHistory({ jobs, candidateId, pick, close }: { jobs: Job[]; candidateId: number | null; pick: (id: number) => void; close: () => void }) {
  const [query, setQuery] = useState('');
  const [job, setJob] = useState<number>();
  const [onlyCandidate, setOnlyCandidate] = useState(false);
  const [offset, setOffset] = useState(0);
  const term = useDebounced(query);
  const page = useResource(() => interview('list', { candidateId: onlyCandidate ? candidateId ?? undefined : undefined, jobId: job, query: term, offset, limit: 18 }),
    [term, job, onlyCandidate, offset]);
  return <Modal title="历史面试提纲" description="按候选人、岗位或提纲名称查找。" onClose={close} wide>
    <div className="form-stack">
      <div className="interview-pair">
        <Field label="搜索提纲"><input maxLength={180} value={query} placeholder="姓名、岗位或提纲名称" onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></Field>
        <Field label="按岗位筛选"><select value={job ?? ''} onChange={(event) => { setJob(event.target.value ? Number(event.target.value) : undefined); setOffset(0); }}>
          <option value="">全部岗位</option>{jobs.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></Field>
      </div>
      {candidateId !== null && <label className="interview-check"><input type="checkbox" checked={onlyCandidate} onChange={(event) => { setOnlyCandidate(event.target.checked); setOffset(0); }} />仅显示当前候选人</label>}
      {page.error ? <Notice action={<Button tone="quiet" onClick={page.retry}>重试</Button>}>{page.error}</Notice> : page.loading && !page.data ? <Loading /> :
        page.data?.length ? <div className="interview-history-list">{page.data.map((item) => <GuideRow key={item.id} item={item} open={() => pick(item.id)} />)}</div> : <Empty title="暂无匹配提纲" />}
      {(offset > 0 || page.data?.length === 18) && <div className="wrap">
        <Button disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 18))}>上一页</Button>
        <Button disabled={page.data?.length !== 18} onClick={() => setOffset((value) => value + 18)}>下一页</Button>
      </div>}
    </div>
  </Modal>;
}
