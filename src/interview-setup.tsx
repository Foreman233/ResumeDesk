import { useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { PARSE_LABELS, rpc, STAGES, type CandidateDetail, type Job } from './api';
import { CATEGORIES, DIFFICULTIES, LANGUAGES, MAX_QUESTIONS, distribute, type Category, type InterviewConfig, type InterviewSelection, type Language, type Difficulty } from './interview-api';
import { Button, Field, Loading, Notice, Pill, date, useDebounced, useResource } from './ui';

const CANDIDATE_PAGE = 60;

export function CandidateChooser({ current, onPick, active, compact = false }: {
  current: number | null; onPick: (id: number) => void; active: boolean; compact?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const term = useDebounced(query.trim());
  const list = useResource(() => rpc('candidate_list', { filter: { query: term, offset } }), [term, offset], active);
  return <div className="interview-candidate-picker">
    <label className="search-input"><Search size={15} /><input aria-label={compact ? '快捷搜索候选人' : '搜索面试候选人'}
      placeholder="搜索候选人姓名" maxLength={180} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></label>
    {list.error ? <Notice action={<Button tone="quiet" onClick={list.retry}>重试</Button>}>{list.error}</Notice> :
      list.loading && !list.data ? <Loading /> : <select aria-label={compact ? '快速选择候选人' : '选择面试候选人'} value={current ?? ''}
        onChange={(event) => { if (event.target.value) onPick(Number(event.target.value)); }}>
        <option value="">{list.data?.items.length ? '选择候选人' : '没有匹配的候选人'}</option>
        {current !== null && !list.data?.items.some((item) => item.id === current) && <option value={current}>当前候选人</option>}
        {list.data?.items.map((person) => <option key={person.id} value={person.id}>{person.name}{person.headline ? ' · ' + person.headline : ''}</option>)}
      </select>}
    {!!list.data && list.data.total > CANDIDATE_PAGE && <div className="wrap interview-pagination">
      <Button tone="quiet" aria-label="候选人上一页" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - CANDIDATE_PAGE))}><ChevronLeft size={15} /></Button>
      <small>{offset + 1}–{Math.min(offset + CANDIDATE_PAGE, list.data.total)} / {list.data.total}</small>
      <Button tone="quiet" aria-label="候选人下一页" disabled={offset + CANDIDATE_PAGE >= list.data.total} onClick={() => setOffset((value) => value + CANDIDATE_PAGE)}><ChevronRight size={15} /></Button>
    </div>}
  </div>;
}

export function InterviewSelectionPanel({ selection, candidate, candidateError, jobs, active, pick, update }: {
  selection: InterviewSelection; candidate?: CandidateDetail; candidateError: string; jobs: Job[]; active: boolean;
  pick: (id: number) => void; update: (selection: InterviewSelection) => void;
}) {
  const resume = candidate?.resumes.find((item) => item.id === selection.resumeId);
  const job = jobs.find((item) => item.id === selection.jobId);
  const applications = candidate?.applications ?? [];
  const linked = new Set(applications.map((item) => item.jobId));
  const jobValue = selection.applicationId ? 'a:' + selection.applicationId : selection.jobId ? 'j:' + selection.jobId : 'temp';
  const otherJobs = jobs.filter((item) => !linked.has(item.id) || (item.id === selection.jobId && selection.applicationId === null));

  function selectJob(value: string) {
    const next = { ...selection, applicationId: null, jobId: null, jobTitle: '', temporaryJd: '' };
    if (value.startsWith('a:')) {
      const application = applications.find((item) => item.id === Number(value.slice(2)));
      if (application) update({ ...next, applicationId: application.id, jobId: application.jobId, jobTitle: application.jobTitle });
    } else if (value.startsWith('j:')) {
      const existing = jobs.find((item) => item.id === Number(value.slice(2)));
      if (existing) update({ ...next, jobId: existing.id, jobTitle: existing.title });
    } else update(next);
  }

  return <div className="form-stack">
    <CandidateChooser current={selection.candidateId} onPick={pick} active={active} />
    {candidateError && <Notice>{candidateError}</Notice>}
    {candidate && <div className="interview-candidate-overview">
      <strong>{candidate.name}</strong>
      {candidate.headline && <small>{candidate.headline}</small>}
      {!!candidate.tags.length && <div className="wrap">{candidate.tags.slice(0, 6).map((tag) => <Pill key={tag}>{tag}</Pill>)}</div>}
      <small>{applications.length ? '已申请 ' + applications.map((item) => item.jobTitle).join('、') : '暂无岗位申请'}</small>
    </div>}
    {selection.candidateId !== null && <Field label="简历版本" hint={resume ? (PARSE_LABELS[resume.parseStatus] + ' · ' + date(resume.importedAt)) : '生成题目需要已提取文字的简历。'}>
      <select value={selection.resumeId ?? ''} onChange={(event) => update({ ...selection, resumeId: event.target.value ? Number(event.target.value) : null })}>
        <option value="">{candidate?.resumes.length ? '暂不选择简历' : '无可选简历'}</option>
        {candidate?.resumes.map((item) => <option key={item.id} value={item.id}>{item.originalName} · {PARSE_LABELS[item.parseStatus]}</option>)}
      </select>
    </Field>}
    <Field label="面试岗位与申请">
      <select value={jobValue} onChange={(event) => selectJob(event.target.value)}>
        <option value="temp">录入临时岗位</option>
        {!!applications.length && <optgroup label="候选人已申请岗位">{applications.map((item) =>
          <option key={item.id} value={'a:' + item.id}>{item.jobTitle} · {STAGES[item.stage]}</option>)}</optgroup>}
        {!!otherJobs.length && <optgroup label="其他现有岗位">{otherJobs.map((item) =>
          <option key={item.id} value={'j:' + item.id}>{item.title}{item.department ? ' · ' + item.department : ''}</option>)}</optgroup>}
      </select>
    </Field>
    {selection.jobId === null ? <>
      <Field label="临时岗位名称"><input maxLength={120} value={selection.jobTitle} onChange={(event) => update({ ...selection, jobTitle: event.target.value })} /></Field>
      <Field label="临时岗位 JD"><textarea rows={5} maxLength={18000} value={selection.temporaryJd}
        onChange={(event) => update({ ...selection, temporaryJd: event.target.value })} placeholder="填写职责、必备技能或面试范围" /></Field>
    </> : <details className="interview-jd"><summary>查看已保存的岗位 JD</summary>
      <p>{job?.jd || '该岗位未填写 JD，生成时将参考岗位名称和简历。'}</p>
    </details>}
  </div>;
}

export function validConfig(config: InterviewConfig) {
  return Number.isInteger(config.total) && config.total >= 1 && config.total <= MAX_QUESTIONS && config.allocations.length > 0
    && config.allocations.every(({ count }) => Number.isInteger(count) && count > 0)
    && config.allocations.reduce((sum, item) => sum + item.count, 0) === config.total
    && (config.minutes === null || (Number.isInteger(config.minutes) && config.minutes >= 5 && config.minutes <= 480));
}

export function InterviewConfiguration({ config, update }: { config: InterviewConfig; update: (config: InterviewConfig) => void }) {
  const selected = config.allocations.map((item) => item.category);
  const [manual, setManual] = useState(false);
  const totalIsValid = config.total >= 1 && config.total <= MAX_QUESTIONS;

  const count = (total: number) => update({ ...config, total, allocations: manual ? config.allocations : distribute(total, selected) });
  const toggle = (category: Category, checked: boolean) => update({ ...config,
    allocations: manual
      ? checked ? [...config.allocations, { category, count: 1 }] : config.allocations.filter((item) => item.category !== category)
      : distribute(config.total, checked ? [...selected, category] : selected.filter((item) => item !== category)),
  });

  return <div className="form-stack">
    <Field label="目标题数" hint="1–50 题"><input type="number" min={1} max={MAX_QUESTIONS} value={config.total || ''} onChange={(event) => count(Number(event.target.value))} /></Field>
    <div className="wrap interview-presets">{[5, 10, 15, 20].map((size) => <Button key={size} className="interview-preset" tone={config.total === size ? 'primary' : 'secondary'}
      aria-pressed={config.total === size} onClick={() => count(size)}>{size} 题</Button>)}</div>
    <div className="form-stack interview-allocations">
      <div className="wrap between"><strong>问题类型</strong><Pill>{config.allocations.reduce((sum, value) => sum + value.count, 0)} / {config.total || 0}</Pill></div>
      <Field label="题数分配"><select value={manual ? 'manual' : 'average'} onChange={(event) => {
        const next = event.target.value === 'manual'; setManual(next);
        if (!next) update({ ...config, allocations: distribute(config.total, selected) });
      }}><option value="average">平均分配</option><option value="manual">自定义各类题数</option></select></Field>
      {Object.entries(CATEGORIES).map(([item, label]) => {
        const category = item as Category;
        const allocation = config.allocations.find((value) => value.category === category);
        return <div className="interview-allocation" key={category}>
          <label className="interview-check"><input type="checkbox" checked={allocation !== undefined} onChange={(event) => toggle(category, event.target.checked)} />{label}</label>
          {allocation && (manual ? <input aria-label={label + '题数'} type="number" min={1} max={MAX_QUESTIONS} value={allocation.count || ''}
            onChange={(event) => update({ ...config, allocations: config.allocations.map((value) => value.category === category ? { category, count: Number(event.target.value) } : value) })} /> : <small>{allocation.count} 题</small>)}
        </div>;
      })}
      {totalIsValid && !validConfig(config) && <small className="text-error">各选中类别至少 1 题，分配总数须等于目标题数。</small>}
    </div>
    <div className="interview-pair">
      <Field label="问题难度"><select value={config.difficulty} onChange={(event) => update({ ...config, difficulty: event.target.value as Difficulty })}>
        {Object.entries(DIFFICULTIES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></Field>
      <Field label="面试语言"><select value={config.language} onChange={(event) => update({ ...config, language: event.target.value as Language })}>
        {Object.entries(LANGUAGES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></Field>
    </div>
    <Field label="参考时长（分钟）" hint="时长用于设计题目，可留空。"><input type="number" list="interview-durations" min={5} max={480}
      value={config.minutes ?? ''} onChange={(event) => update({ ...config, minutes: event.target.value ? Number(event.target.value) : null })} /></Field>
    <datalist id="interview-durations">{[15, 30, 45, 60].map((option) => <option key={option} value={option} />)}</datalist>
    <Field label="关注重点"><textarea rows={3} maxLength={1200} value={config.focus} onChange={(event) => update({ ...config, focus: event.target.value })} /></Field>
    {([['followUp', '生成追问'], ['evaluationPoints', '生成考察要点'], ['referenceAnswer', '生成参考回答思路']] as const).map(([field, label]) =>
      <label key={field} className="interview-check"><input type="checkbox" checked={config[field]} onChange={(event) => update({ ...config, [field]: event.target.checked })} />{label}</label>)}
  </div>;
}
