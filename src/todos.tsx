import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Bell, CalendarClock, Check, ClipboardCheck, ExternalLink, ListTodo, Minus, Pin, Plus, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { STAGES, errorText, rpc, type Application, type Job, type Stage } from './api';
import {
  TODO_CATEGORIES, TODO_PRIORITY, TODO_STATUS, TODO_SUGGESTIONS, minimizeTodoWindow, navigateMain, setTodoOnTop, showTodoWindow, todo, todoChanged, watchTodoChanges,
  type MeetingMode, type Todo, type TodoCategory, type TodoInput, type TodoPriority, type TodoStatus, type TodoTarget,
} from './todo-api';
import { Button, Confirm, Empty, Field, Loading, Modal, Notice, Pill, date, useDebounced, useResource } from './ui';
import './todos.css';

const meetingLabels = { online: '线上', onsite: '线下' } as const;
const leadOptions = [
  { minutes: 0, label: '面试开始时' },
  { minutes: 10, label: '提前 10 分钟' },
  { minutes: 30, label: '提前 30 分钟' },
  { minutes: 60, label: '提前 1 小时' },
  { minutes: 1440, label: '提前 1 天' },
];
const today = () => {
  const time = new Date();
  time.setHours(0, 0, 0, 0);
  return Math.floor(time.getTime() / 1000);
};
const tomorrow = () => {
  const time = new Date();
  time.setHours(0, 0, 0, 0);
  time.setDate(time.getDate() + 1);
  return Math.floor(time.getTime() / 1000);
};
export const todoTime = (item: Todo) => item.dueAt ?? item.interviewAt ?? undefined;

export function useTodoEvents(reload: () => void, enabled = true) {
  const callback = useRef(reload);
  callback.current = reload;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let detach: (() => void) | undefined;
    void watchTodoChanges(() => callback.current()).then((unlisten) => {
      if (active) detach = unlisten;
      else unlisten();
    }).catch(() => {});
    return () => { active = false; detach?.(); };
  }, [enabled]);
}

export type TodoSeed = TodoInput & { candidateName?: string | null; jobTitle?: string | null };

function localDateInput(value?: number | null) {
  if (!value) return '';
  const time = new Date(value * 1000);
  const parts = [time.getFullYear(), time.getMonth() + 1, time.getDate(), time.getHours(), time.getMinutes()].map((n) => String(n).padStart(2, '0'));
  return parts[0] + '-' + parts[1] + '-' + parts[2] + 'T' + parts[3] + ':' + parts[4];
}

function unixTime(value: string) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error('请输入有效的日期和时间。');
  return Math.floor(time / 1000);
}

export function CreateTodoDialog({ initial, jobs = [], onClose, onSaved }: {
  initial?: TodoSeed; jobs?: Job[]; onClose: () => void; onSaved: (item: Todo) => void;
}) {
  const [value, setValue] = useState<TodoInput>(initial ?? { title: '', category: 'general', priority: 'normal' });
  const [due, setDue] = useState(localDateInput(initial?.dueAt));
  const [interview, setInterview] = useState(localDateInput(initial?.interviewAt));
  const [customLead, setCustomLead] = useState(!leadOptions.some((option) => option.minutes === (initial?.reminderMinutes ?? 30)));
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(initial?.candidateName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const search = useDebounced(query.trim());
  const results = useResource(() => search ? rpc('candidate_list', { filter: { query: search } }) : Promise.resolve(undefined), [search]);
  const apps = useResource(() => value.candidateId ? rpc('candidate', { id: value.candidateId }) : Promise.resolve(undefined), [value.candidateId]);
  const applications = (apps.data?.id === value.candidateId ? apps.data?.applications : undefined) ?? [];
  const isInterview = value.category === 'interview';

  function chooseApplication(id?: number) {
    const item = applications.find((application) => application.id === id);
    setValue((old) => ({ ...old, applicationId: id, jobId: item?.jobId ?? old.jobId, stage: item?.stage ?? old.stage }));
  }

  async function save() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const interviewAt = isInterview ? unixTime(interview) : null;
      const input: TodoInput = {
        id: value.id, title: value.title.trim(), description: value.description,
        priority: value.priority, category: value.category, dueAt: unixTime(due), interviewAt,
        candidateId: value.candidateId, jobId: value.jobId, applicationId: value.applicationId, stage: value.stage,
        reminderMinutes: isInterview && interviewAt ? value.reminderMinutes ?? 30 : null,
        meetingMode: isInterview ? value.meetingMode ?? null : null,
        meetingLink: isInterview && value.meetingMode === 'online' ? value.meetingLink : '',
        location: isInterview && value.meetingMode === 'onsite' ? value.location : '',
        notes: isInterview ? value.notes : '',
      };
      const item = await todo('save', { input });
      todoChanged(); onSaved(item); onClose();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  return <Modal title={initial?.id ? '编辑待办' : isInterview ? '安排面试' : '新建待办'} onClose={onClose} busy={busy} wide>
    <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Field label="待办标题"><input required maxLength={140} autoFocus value={value.title} onChange={(e) => setValue({ ...value, title: e.target.value })} /></Field>
      <div className="form-grid">
        <Field label="待办类型"><select value={value.category} onChange={(e) => setValue({ ...value, category: e.target.value as TodoCategory })}>
          {Object.entries(TODO_CATEGORIES).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></Field>
        <Field label="优先级"><select value={value.priority} onChange={(e) => setValue({ ...value, priority: e.target.value as TodoPriority })}>
          {Object.entries(TODO_PRIORITY).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></Field>
      </div>
      <Field label="描述"><textarea rows={2} maxLength={4000} value={value.description ?? ''} onChange={(e) => setValue({ ...value, description: e.target.value })} /></Field>
      <Field label="截止时间"><input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      <div className="form-grid">
        <div className="todo-candidate-picker">
          <Field label="关联候选人">
            <input type="search" placeholder="输入姓名搜索" disabled={!!value.applicationId}
              value={value.candidateId ? chosen || apps.data?.name || '已关联的候选人' : query}
              onChange={(e) => {
                setQuery(e.target.value); setChosen('');
                setValue({ ...value, candidateId: undefined, applicationId: undefined });
              }} />
          </Field>
          {!!value.candidateId && !value.applicationId && <button type="button" className="link-button"
            onClick={() => { setQuery(''); setChosen(''); setValue({ ...value, candidateId: undefined }); }}>清除候选人</button>}
          {!value.candidateId && !!search && !results.loading && <div className="todo-candidate-results">
            {results.error ? <small className="text-error">{results.error}</small> : !results.data?.items.length ? <small className="muted">没有匹配的候选人</small> :
              results.data.items.slice(0, 8).map((candidate) => <Button key={candidate.id} tone="quiet" onClick={() => {
                setValue({ ...value, candidateId: candidate.id }); setChosen(candidate.name); setQuery('');
              }}>{candidate.name}</Button>)}
          </div>}
        </div>
        <Field label="关联岗位"><select value={value.jobId ?? ''} disabled={!!value.applicationId} onChange={(e) => setValue({ ...value, jobId: Number(e.target.value) || undefined })}>
          <option value="">不关联岗位</option>
          {value.jobId && !jobs.some((job) => job.id === value.jobId) && <option value={value.jobId}>{initial?.jobTitle || '已关联的岗位'}</option>}
          {jobs.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}
        </select></Field>
        <Field label="关联岗位申请"><select value={value.applicationId ?? ''} disabled={!value.candidateId} onChange={(e) => chooseApplication(Number(e.target.value) || undefined)}>
          <option value="">不关联申请</option>
          {value.applicationId && !applications.some((app) => app.id === value.applicationId) && <option value={value.applicationId}>已关联的申请</option>}
          {applications.map((application) => <option key={application.id} value={application.id}>{application.jobTitle} · {STAGES[application.stage]}</option>)}
        </select></Field>
        <Field label="关联阶段"><select value={value.stage ?? ''} onChange={(e) => setValue({ ...value, stage: (e.target.value || undefined) as Stage | undefined })}>
          <option value="">不关联阶段</option>{Object.entries(STAGES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></Field>
      </div>
      {isInterview && <fieldset className="todo-interview-fields form-stack">
        <legend>面试安排</legend>
        <div className="form-grid">
          <Field label="面试时间"><input type="datetime-local" value={interview} onChange={(e) => setInterview(e.target.value)} /></Field>
          <Field label="提醒时间" hint="设置面试时间后生效。"><select
            disabled={!interview} value={customLead ? 'custom' : value.reminderMinutes ?? 30}
            onChange={(e) => {
              const selected = e.target.value;
              setCustomLead(selected === 'custom');
              if (selected !== 'custom') setValue({ ...value, reminderMinutes: Number(selected) });
            }}>
            {leadOptions.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
            <option value="custom">自定义</option>
          </select></Field>
        </div>
        {customLead && <Field label="提醒提前（分钟）"><input type="number" min={0} max={10080} step={1}
          disabled={!interview} value={value.reminderMinutes ?? 30}
          onChange={(e) => setValue({ ...value, reminderMinutes: e.target.value ? Number(e.target.value) : null })} /></Field>}
        <Field label="面试形式"><select value={value.meetingMode ?? ''} onChange={(e) => setValue({ ...value, meetingMode: (e.target.value || null) as MeetingMode | null })}>
          <option value="">未指定</option>{Object.entries(meetingLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
        </select></Field>
        {value.meetingMode === 'online' && <Field label="会议链接"><input type="url" maxLength={1000} placeholder="https://…"
          value={value.meetingLink ?? ''} onChange={(e) => setValue({ ...value, meetingLink: e.target.value })} /></Field>}
        {value.meetingMode === 'onsite' && <Field label="面试地点"><input maxLength={500} value={value.location ?? ''}
          onChange={(e) => setValue({ ...value, location: e.target.value })} /></Field>}
        <Field label="面试备注"><textarea rows={2} maxLength={4000} value={value.notes ?? ''} onChange={(e) => setValue({ ...value, notes: e.target.value })} /></Field>
      </fieldset>}
      {error && <Notice>{error}</Notice>}
      <div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" tone="primary" busy={busy} disabled={!value.title.trim()}>保存待办</Button></div>
    </form>
  </Modal>;
}

export function applicationTodoSeed(application: Application, stage = application.stage, suggested = false): TodoSeed {
  const suggestion = suggested ? TODO_SUGGESTIONS[stage] : undefined;
  return {
    title: (suggestion?.title ?? '跟进候选人') + ' · ' + application.candidateName,
    category: suggestion?.category ?? 'follow_up', priority: 'normal',
    candidateId: application.candidateId, candidateName: application.candidateName,
    jobId: application.jobId, jobTitle: application.jobTitle, applicationId: application.id, stage,
  };
}

type TodoReporter = (message: string, error?: boolean) => void;
type TodosProps = {
  jobs: Job[]; revision: number; refresh: () => void; report: TodoReporter;
  initial?: TodoTarget; intentKey: number; active: boolean;
  openCandidate: (id: number) => void; openJobs: (id: number, applicationId?: number) => void;
};

export function TodoWorkspace({ jobs, revision, refresh, report, initial, intentKey, active, openCandidate, openJobs }: TodosProps) {
  const [status, setStatus] = useState<TodoStatus | 'all'>('pending');
  const [category, setCategory] = useState<TodoCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<TodoSeed | true>();
  const [remove, setRemove] = useState<Todo>();
  const [rules, setRules] = useState(false);
  const [working, setWorking] = useState<number>();
  const opened = useRef<number | undefined>(undefined);
  const search = useDebounced(query);
  const resource = useResource(() => todo('list', { filter: {
    status: status === 'all' ? undefined : status, category: category === 'all' ? undefined : category, query: search.trim() || undefined,
  } }), [status, category, search, revision], active);
  useTodoEvents(resource.retry, active);
  const items = resource.data ?? [];
  useEffect(() => {
    if (initial?.category) setCategory(initial.category);
  }, [intentKey]);
  useEffect(() => {
    if (!active || initial?.id === undefined || opened.current === intentKey) return;
    let current = true;
    void todo('get', { id: initial.id }).then((item) => {
      if (current) { opened.current = intentKey; setEditing(item); }
    }).catch((e: unknown) => {
      if (current) { opened.current = intentKey; report(errorText(e), true); }
    });
    return () => { current = false; };
  }, [active, intentKey, initial?.id]);

  async function updateStatus(item: Todo, next: TodoStatus) {
    setWorking(item.id);
    try {
      await todo('set_status', { id: item.id, status: next });
      todoChanged(); refresh(); report(next === 'pending' ? '已恢复为待办' : '待办' + TODO_STATUS[next]);
    } catch (e) { report(errorText(e), true); }
    finally { setWorking(undefined); }
  }

  return <section className="todo-page" aria-label="待办工作区">
    <div className="hub-workspace-actions">
      <Button onClick={() => void showTodoWindow().catch((e: unknown) => report(errorText(e), true))}><ExternalLink size={16} />打开桌面待办</Button>
      <Button onClick={() => setRules(true)}><SlidersHorizontal size={16} />阶段规则</Button>
      <Button tone="primary" onClick={() => setEditing(true)}><Plus size={16} />新建待办</Button>
    </div>
    <section className="panel todo-main-panel">
      <div className="todo-toolbar">
        <label className="search-input"><Search size={16} /><input aria-label="搜索待办" placeholder="搜索待办…" value={query}
          onChange={(e) => setQuery(e.target.value)} /></label>
        <select aria-label="待办状态筛选" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="all">全部状态</option>{Object.entries(TODO_STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select aria-label="待办类型筛选" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
          <option value="all">全部类型</option>{Object.entries(TODO_CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      {resource.error ? <Notice action={<Button onClick={resource.retry}>重试</Button>}>{resource.error}</Notice> : resource.loading && !resource.data ? <Loading /> :
        !items.length ? <Empty icon={<ClipboardCheck size={26} />} title="没有符合条件的待办" description="可新增招聘跟进或面试安排。" /> :
          <div className="todo-table">
            {items.map((item) => <TodoRow key={item.id} item={item} onCandidate={openCandidate} onJob={openJobs} actions={
              <>
                {item.status === 'pending' ? <>
                  <Button tone="quiet" disabled={working === item.id} onClick={() => void updateStatus(item, 'completed')}><Check size={15} />完成</Button>
                  <Button tone="quiet" disabled={working === item.id} onClick={() => void updateStatus(item, 'cancelled')}>取消待办</Button>
                </> : <Button tone="quiet" disabled={working === item.id} onClick={() => void updateStatus(item, 'pending')}>恢复待办</Button>}
                <Button onClick={() => setEditing(item)}>编辑</Button>
                <Button tone="quiet" className="icon-btn" aria-label={'删除待办 ' + item.title} onClick={() => setRemove(item)}><Trash2 size={15} /></Button>
              </>
            } />)}
          </div>}
    </section>
    {editing && <CreateTodoDialog initial={editing === true ? undefined : editing} jobs={jobs}
      onClose={() => setEditing(undefined)} onSaved={() => { refresh(); report('待办已保存'); }} />}
    {remove && <Confirm title="删除待办？" description={remove.title} onClose={() => setRemove(undefined)}
      onConfirm={async () => { await todo('delete', { id: remove.id }); todoChanged(); refresh(); report('待办已删除'); }} />}
    {rules && <TodoRules onClose={() => setRules(false)} />}
  </section>;
}

function TodoRow({ item, actions, onCandidate, onJob }: {
  item: Todo; actions: React.ReactNode; onCandidate?: (id: number) => void; onJob?: (id: number, applicationId?: number) => void;
}) {
  const time = todoTime(item);
  const overdue = item.status === 'pending' && !!time && time * 1000 < Date.now();
  return <article className={'todo-row todo-' + item.status} aria-label={item.title}>
    <div className="todo-row-body">
      <div className="todo-row-title"><strong>{item.title}</strong><Pill tone={item.priority === 'high' ? 'amber' : 'soft'}>{TODO_PRIORITY[item.priority]}优先级</Pill>
        <Pill tone={item.status === 'completed' ? 'green' : 'indigo'}>{TODO_STATUS[item.status]}</Pill></div>
      {item.description && <p>{item.description}</p>}
      <div className="todo-row-meta">
        <span>{TODO_CATEGORIES[item.category]}</span>
        {time && <span className={overdue ? 'text-error' : undefined}><CalendarClock size={14} />{overdue ? '已逾期 · ' : ''}{date(time, true)}</span>}
        {item.interviewAt && item.interviewAt !== time && <span>面试 {date(item.interviewAt, true)}</span>}
        {item.remindAt && <span className={item.reminderError ? 'text-error' : undefined} title={item.reminderError ?? undefined}>
          <Bell size={14} />{item.notifiedAt ? '已提醒' : item.reminderError ? '提醒未送达' : '提醒 ' + date(item.remindAt, true)}</span>}
        {item.meetingMode && <span>{meetingLabels[item.meetingMode]}{item.location ? ' · ' + item.location : ''}</span>}
        {item.stage && <span>{STAGES[item.stage]}</span>}
      </div>
      {item.meetingLink && <p className="todo-meeting-link">会议链接 {item.meetingLink}</p>}
      {item.notes && <p>面试备注 {item.notes}</p>}
      {((item.candidateId && onCandidate) || (item.jobId && onJob)) && <div className="todo-row-links">
        {!!item.candidateId && onCandidate && <button type="button" className="link-button" onClick={() => onCandidate(item.candidateId!)}>{item.candidateName || '查看候选人'}<ArrowUpRight size={13} /></button>}
        {!!item.jobId && onJob && <button type="button" className="link-button" onClick={() => onJob(item.jobId!, item.applicationId ?? undefined)}>{item.jobTitle || '查看岗位'}<ArrowUpRight size={13} /></button>}
      </div>}
    </div>
    <div className="todo-row-actions">{actions}</div>
  </article>;
}

function TodoRules({ onClose }: { onClose: () => void }) {
  const rules = useResource(() => todo('rules', {}), []);
  const [busy, setBusy] = useState<Stage>();
  const [error, setError] = useState('');
  async function change(stage: Stage, enabled: boolean) {
    setBusy(stage); setError('');
    try { await todo('save_rule', { stage, enabled }); rules.retry(); todoChanged(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(undefined); }
  }
  return <Modal title="阶段规则" description="启用后，候选人进入对应阶段时创建跟进待办。" onClose={onClose}>
    {rules.error && <Notice>{rules.error}</Notice>}
    {error && <Notice>{error}</Notice>}
    {rules.loading && !rules.data ? <Loading /> : <div className="form-stack">
      {(rules.data ?? []).map((rule) => <label className="check-line" key={rule.stage}>
        <input type="checkbox" checked={rule.enabled} disabled={!!busy} onChange={(e) => void change(rule.stage, e.target.checked)} />
        {STAGES[rule.stage]} · {TODO_SUGGESTIONS[rule.stage]?.title ?? '创建跟进待办'}</label>)}
    </div>}
    <div className="form-actions"><Button onClick={onClose}>关闭</Button></div>
  </Modal>;
}

export function TodoWidget({ initialAlwaysOnTop = false }: { initialAlwaysOnTop?: boolean } = {}) {
  const [pinned, setPinned] = useState(initialAlwaysOnTop);
  const [error, setError] = useState('');
  const [working, setWorking] = useState<number>();
  const [quick, setQuick] = useState(false);
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  const resource = useResource(async () => {
    const [pending, completed] = await Promise.all([todo('list', { filter: { status: 'pending' } }), todo('list', { filter: { status: 'completed' } })]);
    return { pending, completed };
  }, []);
  useTodoEvents(resource.retry);
  useEffect(() => { setPinned(initialAlwaysOnTop); }, [initialAlwaysOnTop]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Math.floor(Date.now() / 1000)), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const pending = resource.data?.pending ?? [];
  const completed = resource.data?.completed ?? [];
  const dueToday: Todo[] = [], interviews: Todo[] = [], overdue: Todo[] = [], others: Todo[] = [];
  for (const item of pending) {
    const time = todoTime(item);
    if (time && time < clock) overdue.push(item);
    else if (item.interviewAt && item.interviewAt >= clock) interviews.push(item);
    else if (time && time >= today() && time < tomorrow()) dueToday.push(item);
    else others.push(item);
  }

  async function perform(action: () => Promise<void>) {
    setError('');
    try { await action(); } catch (e) { setError(errorText(e)); }
  }

  async function add() {
    if (!title.trim() || adding) return;
    setAdding(true);
    await perform(async () => {
      await todo('save', { input: { title, category: 'general', priority: 'normal' } });
      setTitle(''); setQuick(false); resource.retry(); todoChanged();
    });
    setAdding(false);
  }

  function renderItem(item: Todo) {
    const time = item.interviewAt ?? todoTime(item);
    return <div className="todo-widget-item" key={item.id}>
      {item.status === 'pending' ? <button type="button" className="todo-check" title="完成待办" aria-label={'完成待办 ' + item.title} disabled={working === item.id} onClick={() => {
        setWorking(item.id);
        void perform(async () => { await todo('set_status', { id: item.id, status: 'completed' }); resource.retry(); todoChanged(); }).finally(() => setWorking(undefined));
      }}><Check size={13} /></button> : <span className="todo-widget-done"><Check size={14} /></span>}
      <button type="button" className="todo-widget-item-link" title={item.title} onClick={() => void perform(() => navigateMain({
        candidateId: item.candidateId, jobId: item.jobId, applicationId: item.applicationId, widget: !item.candidateId && !item.jobId,
      }))}>
        <strong>{item.title}</strong>
        <small>{[item.interviewAt ? '面试' : undefined, time ? date(time, true) : undefined, item.candidateName || item.jobTitle].filter(Boolean).join(' · ') || TODO_CATEGORIES[item.category]}</small>
      </button>
      {item.priority === 'high' && <Pill tone="amber">高</Pill>}
    </div>;
  }

  return <main className="todo-widget">
    <header className="todo-widget-header">
      <div><span className="todo-widget-icon"><ListTodo size={17} /></span><h1>桌面待办</h1></div>
      <div className="inline-actions">
        <Button tone="quiet" className="icon-btn" aria-label="置顶" title="置顶" aria-pressed={pinned}
          onClick={() => void perform(async () => { await setTodoOnTop(!pinned); setPinned(!pinned); })}><Pin size={15} /></Button>
        <Button tone="quiet" className="icon-btn" aria-label="最小化" title="最小化" onClick={() => void perform(minimizeTodoWindow)}><Minus size={15} /></Button>
        <Button tone="quiet" className="icon-btn" aria-label="隐藏桌面待办" title="隐藏" onClick={() => void perform(() => showTodoWindow(false))}><X size={15} /></Button>
      </div>
    </header>
    <div className="todo-widget-toolbar">
      <span>{pending.length} 项待完成</span>
      <Button tone="quiet" onClick={() => setQuick(!quick)} aria-expanded={quick}><Plus size={15} />快速新建待办</Button>
    </div>
    {quick && <form className="todo-widget-quick" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <input aria-label="待办标题" value={title} maxLength={140} autoFocus placeholder="输入待办标题" onChange={(e) => setTitle(e.target.value)} />
      <Button type="submit" tone="primary" busy={adding} disabled={!title.trim()}>添加</Button>
    </form>}
    {error && <Notice>{error}</Notice>}
    <div className="todo-widget-list">
      {resource.error ? <Notice action={<Button onClick={resource.retry}>重试</Button>}>{resource.error}</Notice> : resource.loading && !resource.data ? <Loading /> :
        <>
          {[
            { title: '今日待办', items: dueToday },
            { title: '即将面试', items: interviews },
            { title: '逾期待办', items: overdue },
            ...(others.length ? [{ title: '其他待办', items: others }] : []),
          ].map((section) => <section key={section.title} className="todo-widget-section" aria-label={section.title}>
            <h2 className={section.title === '逾期待办' && section.items.length ? 'text-error' : undefined}>{section.title}<span>{section.items.length}</span></h2>
            {section.items.length ? section.items.map(renderItem) : <small>暂无</small>}
          </section>)}
          <details className="todo-widget-section">
            <summary>已完成 <span>{completed.length}</span></summary>
            {completed.length ? completed.map(renderItem) : <small>暂无已完成待办</small>}
          </details>
        </>}
    </div>
    <footer className="todo-widget-footer"><span>与主窗口同步</span>
      <Button tone="quiet" onClick={() => void perform(() => navigateMain({ widget: true }))}>在主窗口管理<ArrowUpRight size={14} /></Button></footer>
  </main>;
}
