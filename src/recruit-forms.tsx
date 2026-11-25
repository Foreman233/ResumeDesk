import { useState } from 'react';
import { BriefcaseBusiness, Search, UserRound } from 'lucide-react';
import { JOB_STATUS, STAGES, errorText, rpc, type Application, type CandidateInput, type JobInput, type Stage } from './api';
import { TODO_SUGGESTIONS, todo, todoChanged } from './todo-api';
import { CreateTodoDialog, applicationTodoSeed, type TodoSeed } from './todos';
import { Avatar, Button, Confirm, Empty, Field, Loading, Modal, Notice, date, splitTags, useDebounced, useResource } from './ui';

export function CandidateForm({ initial, onClose, onSaved }: {
  initial?: CandidateInput; onClose: () => void; onSaved: (id: number) => void;
}) {
  const [value, setValue] = useState<CandidateInput>(initial ?? { name: '', headline: '', phone: '', email: '', favorite: false, tags: [] });
  const [tags, setTags] = useState(value.tags.join('，'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError('');
    try { onSaved(await rpc('save_candidate', { input: {
      id: value.id, name: value.name, headline: value.headline, email: value.email, phone: value.phone,
      favorite: value.favorite, tags: splitTags(tags),
    } })); onClose(); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <Modal title={initial ? '编辑候选人' : '新建候选人'} onClose={onClose} busy={busy}>
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="form-stack">
      <div className="form-grid">
        <Field label="姓名"><input value={value.name} required maxLength={90} autoFocus onChange={(e) => setValue({ ...value, name: e.target.value })} /></Field>
        <Field label="当前职位"><input value={value.headline} maxLength={160} onChange={(e) => setValue({ ...value, headline: e.target.value })} /></Field>
        <Field label="邮箱"><input type="email" value={value.email} maxLength={180} onChange={(e) => setValue({ ...value, email: e.target.value })} /></Field>
        <Field label="电话"><input type="tel" value={value.phone} maxLength={64} onChange={(e) => setValue({ ...value, phone: e.target.value })} /></Field>
      </div>
      <Field label="标签" hint="使用逗号分隔多个标签。"><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="例如 数据分析，人才储备" /></Field>
      <label className="check-line"><input type="checkbox" checked={value.favorite} onChange={(e) => setValue({ ...value, favorite: e.target.checked })} />收藏候选人</label>
      {error && <Notice>{error}</Notice>}
      <div className="form-actions"><Button onClick={onClose} disabled={busy}>取消</Button>
        <Button type="submit" tone="primary" busy={busy}>保存候选人</Button></div>
    </form>
  </Modal>;
}

export function JobForm({ initial, onClose, onSaved }: { initial?: JobInput; onClose: () => void; onSaved: (id: number) => void }) {
  const [value, setValue] = useState<JobInput>(initial ?? { title: '', department: '', status: 'open', jd: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      const { id, title, department, status, jd } = value;
      onSaved(await rpc('save_job', { input: { id, title, department, status, jd } }));
      onClose();
    } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <Modal title={initial ? '编辑岗位' : '新建岗位'} onClose={onClose} busy={busy} wide>
    <form className="form-stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="岗位名称"><input value={value.title} required maxLength={120} autoFocus onChange={(e) => setValue({ ...value, title: e.target.value })} /></Field>
      <div className="form-grid">
        <Field label="招聘部门"><input value={value.department} maxLength={100} onChange={(e) => setValue({ ...value, department: e.target.value })} /></Field>
        <Field label="岗位状态"><select value={value.status} onChange={(e) => setValue({ ...value, status: e.target.value as JobInput['status'] })}>
          {Object.entries(JOB_STATUS).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></Field>
      </div>
      <Field label="岗位描述（JD）"><textarea rows={7} placeholder="岗位职责、必要要求和优先条件" value={value.jd}
        maxLength={24_000} onChange={(e) => setValue({ ...value, jd: e.target.value })} /></Field>
      {error && <Notice>{error}</Notice>}
      <div className="form-actions"><Button onClick={onClose} disabled={busy}>取消</Button>
        <Button type="submit" tone="primary" busy={busy}>保存岗位</Button></div>
    </form>
  </Modal>;
}

export function ApplicationForm({ item, onClose, onSaved, onTodoSaved }: {
  item: Application; onClose: () => void; onSaved: () => void; onTodoSaved: () => void;
}) {
  const [stage, setStage] = useState(item.stage);
  const [note, setNote] = useState(item.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remove, setRemove] = useState(false);
  const [newTodo, setNewTodo] = useState<TodoSeed>();
  const rules = useResource(() => todo('rules', {}), []);
  const suggestion = stage !== item.stage ? TODO_SUGGESTIONS[stage] : undefined;
  const ruleEnabled = rules.data?.some((rule) => rule.stage === stage && rule.enabled);
  async function save(createSuggested = false) {
    setBusy(true); setError('');
    try {
      await rpc('save_application', { id: item.id, stage, note });
      todoChanged(); onSaved();
      if (createSuggested) setNewTodo(applicationTodoSeed(item, stage, true));
      else onClose();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <><Modal title="编辑岗位申请" description={item.candidateName + ' · ' + item.jobTitle} onClose={onClose} busy={busy}>
    <form className="form-stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="招聘阶段"><select value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
        {Object.entries(STAGES).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></Field>
      <Field label="HR 备注"><textarea rows={5} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} /></Field>
      <small className="muted">最近更新 {date(item.updatedAt, true)}</small>
      {suggestion && rules.data && <div className="todo-suggestion">
        <span>{ruleEnabled ? '启用了此阶段规则，保存后将创建待办' : '建议创建待办'} · {suggestion.title}</span>
        {!ruleEnabled && <Button disabled={busy} onClick={() => void save(true)}>保存阶段并新建待办</Button>}
      </div>}
      <div className="inline-actions">
        <Button disabled={busy} onClick={() => setNewTodo(applicationTodoSeed(item))}>新建跟进待办</Button>
        <Button disabled={busy} onClick={() => setNewTodo({ ...applicationTodoSeed(item), title: '面试 · ' + item.candidateName, category: 'interview' })}>安排面试</Button>
      </div>
      {error && <Notice>{error}</Notice>}
      <div className="form-actions spaced"><Button tone="quiet" className="text-error" disabled={busy} onClick={() => setRemove(true)}>移除申请</Button>
        <Button type="submit" tone="primary" busy={busy}>保存申请</Button></div>
    </form>
  </Modal>{remove && <Confirm title="移除此岗位申请？" description="该岗位中的招聘阶段和备注将删除。" onClose={() => setRemove(false)}
    onConfirm={async () => { await rpc('unlink_application', { id: item.id }); onSaved(); onClose(); }} />}
    {newTodo && <CreateTodoDialog initial={newTodo} onClose={() => setNewTodo(undefined)} onSaved={onTodoSaved} />}</>;
}

export function LinkJob({ jobs, candidateId, onClose, onSaved }: {
  jobs: { id: number; title: string; department: string }[]; candidateId: number; onClose: () => void; onSaved: () => void;
}) {
  const [jobId, setJobId] = useState<number | undefined>(jobs[0]?.id);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!jobId) return;
    setBusy(true); setError('');
    try { await rpc('link_application', { candidateId, jobId }); onSaved(); onClose(); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <Modal title="关联岗位" onClose={onClose} busy={busy}>
    {jobs.length ? <Field label="招聘岗位"><select value={jobId} onChange={(e) => setJobId(Number(e.target.value))}>
      {jobs.map((job) => <option key={job.id} value={job.id}>{job.title}{job.department ? ' · ' + job.department : ''}</option>)}
    </select></Field> : <Empty icon={<BriefcaseBusiness size={24} />} title="没有可关联的岗位" description="可先新建一个岗位，或选择尚未申请的岗位。" />}
    {error && <Notice>{error}</Notice>}
    <div className="form-actions"><Button onClick={onClose} disabled={busy}>取消</Button>
      <Button tone="primary" onClick={() => void save()} busy={busy} disabled={!jobId}>关联</Button></div>
  </Modal>;
}

export function LinkCandidate({ jobId, excluded, onClose, onSaved }: { jobId: number; excluded: number[]; onClose: () => void; onSaved: () => void }) {
  const [query, setQuery] = useState('');
  const search = useDebounced(query);
  const found = useResource(() => rpc('candidate_list', { filter: { query: search } }), [search]);
  const [selected, setSelected] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const items = found.data?.items.filter((item) => !excluded.includes(item.id)) ?? [];
  async function save() {
    if (selected === undefined) return;
    setBusy(true); setError('');
    try { await rpc('link_application', { candidateId: selected, jobId }); onSaved(); onClose(); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <Modal title="关联候选人" onClose={onClose} busy={busy}>
    <label className="search-input"><Search size={17} /><input aria-label="搜索要关联的候选人" placeholder="搜索姓名、标签或简历文字" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
    <div className="picker-results">{found.error ? <Notice>{found.error}</Notice> : found.loading ? <Loading /> : items.length
      ? items.map((item) => <label className="pick-row" key={item.id}><input type="radio" name="candidate" checked={selected === item.id}
        onChange={() => setSelected(item.id)} /><Avatar name={item.name} id={item.id} /><span><strong>{item.name}</strong>
        {item.headline && <small>{item.headline}</small>}</span></label>)
      : <Empty icon={<UserRound size={24} />} title="没有可关联的候选人" />}</div>
    {error && <Notice>{error}</Notice>}
    <div className="form-actions"><Button onClick={onClose} disabled={busy}>取消</Button>
      <Button tone="primary" onClick={() => void save()} busy={busy} disabled={selected === undefined}>关联</Button></div>
  </Modal>;
}
