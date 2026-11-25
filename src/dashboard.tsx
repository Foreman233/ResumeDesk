import { useState } from 'react';
import { ArrowRight, BookOpen, BriefcaseBusiness, CalendarClock, ChartNoAxesColumn, ClipboardList, FileText, LayoutDashboard, ListTodo, MessageSquare, Plus, Search, Send, Settings2, Upload, UsersRound } from 'lucide-react';
import { errorText, STAGES, rpc, type Dashboard, type Filter, type Job, type Stage } from './api';
import type { ChatStart } from './chat';
import { WidgetGrid, useWidgetLayout, type WidgetDefinition } from './widget-layout';
import { recentKnowledge, type KnowledgeTarget } from './knowledge-api';
import { QuickControlsPanel, type QuickState } from './quick';
import { todo, todoChanged, type Todo, type TodoCategory } from './todo-api';
import { useTodoEvents } from './todos';
import { Avatar, Button, Empty, Loading, Notice, PageHeading, Pill, date, useResource } from './ui';

type DashboardProps = {
  jobs: Job[]; revision: number; onImport: () => void; onNewJob: () => void;
  library: (filter?: Filter, id?: number) => void; openJob: (id?: number) => void;
  quick: QuickState; openSettings: () => void; openChat: (initial?: ChatStart) => void; openTools: (id?: number, category?: TodoCategory) => void;
  openKnowledge: (target?: KnowledgeTarget) => void; refresh: () => void; report: (text: string, error?: boolean) => void;
};

const WIDGETS = {
  overview: { label: '招聘数据概览', description: '候选人、招聘中岗位与待初筛申请数量。', icon: LayoutDashboard, defaultWidth: 4, defaultHeight: 1 },
  controls: { label: '快捷控制中心', description: 'AI、通知、面试提醒及悬浮窗设置。', icon: Settings2, defaultWidth: 4, defaultHeight: 2, minWidth: 2, minHeight: 2 },
  candidates: { label: '最近候选人', description: '回到最近导入或浏览的候选人。', icon: UsersRound, defaultWidth: 2, defaultHeight: 2 },
  jobs: { label: '招聘岗位', description: '打开招聘中的岗位及其申请。', icon: BriefcaseBusiness, defaultWidth: 2, defaultHeight: 2 },
  progress: { label: '招聘进度', description: '按招聘阶段查看申请数量。', icon: ChartNoAxesColumn, defaultWidth: 2, defaultHeight: 2 },
  todos: { label: '待办事项', description: '查看并完成今日及逾期待办。', icon: ListTodo, defaultWidth: 2, defaultHeight: 2 },
  interviews: { label: '面试提醒', description: '打开近期的面试安排。', icon: CalendarClock, defaultWidth: 2, defaultHeight: 2 },
  assistant: { label: 'HR AI 助手', description: '填写问题并在完整会话中继续。', icon: MessageSquare, defaultWidth: 2, defaultHeight: 1, minWidth: 2 },
  knowledge: { label: '资料库', description: '打开近期文件，按标题或正文检索。', icon: BookOpen, defaultWidth: 2, defaultHeight: 2, minWidth: 2 },
} satisfies Record<string, WidgetDefinition>;
type WidgetId = keyof typeof WIDGETS;
const defaultOrder = Object.keys(WIDGETS) as WidgetId[];

export function DashboardPage(props: DashboardProps) {
  const { jobs, revision, onImport, onNewJob, library, openJob, quick, openSettings, openChat, openTools, openKnowledge, refresh, report } = props;
  const dashboard = useResource(() => rpc('dashboard'), [revision]);
  const layout = useWidgetLayout('dashboard', WIDGETS, defaultOrder, report);

  function render(widget: WidgetId) {
    switch (widget) {
      case 'overview': return <Overview data={dashboard.data} library={library} openJob={openJob} />;
      case 'controls': return <QuickControlsPanel state={quick} openSettings={openSettings} />;
      case 'candidates': return <RecentCandidates data={dashboard.data} loading={dashboard.loading} library={library} onImport={onImport} />;
      case 'jobs': return <ActiveJobs jobs={jobs} openJob={openJob} onNewJob={onNewJob} />;
      case 'progress': return <RecruitingProgress data={dashboard.data} library={library} />;
      case 'todos': return <DashboardTodos revision={revision} open={openTools} refresh={refresh} report={report} />;
      case 'interviews': return <DashboardInterviews revision={revision} open={openTools} />;
      case 'assistant': return <QuickChat open={openChat} />;
      case 'knowledge': return <RecentKnowledge revision={revision} open={openKnowledge} />;
    }
  }

  return <main className="page dashboard-page scroll-page">
    <PageHeading title="招聘工作台" description="查看和跟进招聘工作。">
      <Button aria-pressed={layout.editing} disabled={!layout.ready || layout.editing || layout.saving} onClick={layout.begin}><LayoutDashboard size={16} />自定义工作台</Button>
      <Button onClick={onNewJob}><Plus size={16} />新建岗位</Button>
      <Button tone="primary" onClick={onImport}><Upload size={16} />导入简历</Button>
    </PageHeading>
    {dashboard.error && <Notice action={<Button tone="quiet" onClick={dashboard.retry}>重试</Button>}>{dashboard.error}</Notice>}
    {!!dashboard.data?.stale && <Notice tone="hint" action={<Button tone="quiet" onClick={() => library({ stale: true })}>查看候选人<ArrowRight size={15} /></Button>}>
      有 {dashboard.data.stale} 位候选人超过保留期限。
    </Notice>}
    <WidgetGrid state={layout} render={render} />
  </main>;
}

function Overview({ data, library, openJob }: { data?: Dashboard; library: DashboardProps['library']; openJob: DashboardProps['openJob'] }) {
  return <div className="widget-stats">
    <button className="widget-stat" type="button" onClick={() => library()}>
      <span className="stat-icon stat-indigo"><UsersRound size={15} /></span><span>候选人总数</span><strong>{data?.candidates ?? '—'}</strong>
    </button>
    <button className="widget-stat" type="button" onClick={() => openJob()}>
      <span className="stat-icon stat-teal"><BriefcaseBusiness size={15} /></span><span>招聘中岗位</span><strong>{data?.openJobs ?? '—'}</strong>
    </button>
    <button className="widget-stat" type="button" onClick={() => library({ stage: 'new' })}>
      <span className="stat-icon stat-gold"><ClipboardList size={15} /></span><span>待初筛申请</span><strong>{data?.screening ?? '—'}</strong>
    </button>
  </div>;
}

function RecentCandidates({ data, loading, library, onImport }: {
  data?: Dashboard; loading: boolean; library: DashboardProps['library']; onImport: () => void;
}) {
  const [tab, setTab] = useState<'imported' | 'viewed'>('imported');
  if (loading && !data) return <Loading />;
  const seen = new Set<number>();
  const rows = tab === 'imported' ? (data?.recent ?? []).filter((doc) => {
    if (seen.has(doc.ownerId)) return false;
    seen.add(doc.ownerId); return true;
  }).map((doc) => ({ id: doc.ownerId, name: doc.ownerName, detail: doc.originalName, time: doc.importedAt }))
    : (data?.viewed ?? []).map((candidate) => ({ id: candidate.id, name: candidate.name, detail: candidate.headline, time: candidate.viewedAt }));
  return <>
    <div className="tabs widget-inner-tabs" role="tablist" aria-label="最近候选人类型">
      <button role="tab" aria-selected={tab === 'imported'} onClick={() => setTab('imported')}>最近导入</button>
      <button role="tab" aria-selected={tab === 'viewed'} onClick={() => setTab('viewed')}>最近浏览</button>
    </div>
    {rows.length ? <ul className="widget-list">{rows.map((item) => <li key={item.id}>
      <button className="widget-row" type="button" onClick={() => library(undefined, item.id)}>
        <Avatar id={item.id} name={item.name} /><span className="grow"><strong>{item.name}</strong><small>{item.detail || date(item.time)}</small></span>
        <small>{date(item.time)}</small></button></li>)}</ul> :
      <Empty title={tab === 'imported' ? '还没有导入简历' : '还没有浏览记录'}>
        <Button tone="quiet" onClick={tab === 'imported' ? onImport : () => library()}>{tab === 'imported' ? '导入简历' : '打开候选人库'}</Button>
      </Empty>}
  </>;
}

function ActiveJobs({ jobs, openJob, onNewJob }: { jobs: Job[]; openJob: DashboardProps['openJob']; onNewJob: () => void }) {
  const active = jobs.filter((job) => job.status === 'open').slice(0, 5);
  return active.length ? <ul className="widget-list">{active.map((job) => <li key={job.id}>
    <button className="widget-row" type="button" onClick={() => openJob(job.id)}>
      <span className="widget-icon"><BriefcaseBusiness size={15} /></span><span className="grow"><strong>{job.title}</strong>
        <small>{job.department || '未设置部门'}</small></span><Pill tone="green">{job.applicationCount} 位</Pill>
    </button>
  </li>)}</ul> : <Empty title="没有招聘中的岗位"><Button tone="quiet" onClick={onNewJob}><Plus size={15} />新建岗位</Button></Empty>;
}

function RecruitingProgress({ data, library }: { data?: Dashboard; library: DashboardProps['library'] }) {
  if (!data) return <Loading />;
  const counts = new Map(data.progress.map((item) => [item.stage, item.count]));
  const total = Math.max(1, ...counts.values());
  return <ul className="widget-list widget-progress">{(Object.entries(STAGES) as [Stage, string][]).map(([stage, name]) =>
    <li key={stage}><button type="button" className="widget-row" onClick={() => library({ stage })}>
      <span>{name}</span><progress value={counts.get(stage) ?? 0} max={total} aria-label={name + '数量'} /><strong>{counts.get(stage) ?? 0}</strong>
    </button></li>)}
  </ul>;
}

function usePendingTodos(revision: number) {
  const data = useResource(() => todo('list', { filter: { status: 'pending' } }), [revision]);
  useTodoEvents(data.retry);
  return data;
}

function DashboardTodos({ revision, open, refresh, report }: { revision: number; open: DashboardProps['openTools']; refresh: () => void; report: DashboardProps['report'] }) {
  const data = usePendingTodos(revision);
  const [working, setWorking] = useState<number>();
  const start = Date.now() / 1000;
  const end = new Date(); end.setHours(24, 0, 0, 0);
  const tasks = (data.data ?? []).filter((item) => item.dueAt != null && item.dueAt < end.getTime() / 1000)
    .sort((a, b) => a.dueAt! - b.dueAt!);
  async function complete(item: Todo) {
    setWorking(item.id);
    try {
      await todo('set_status', { id: item.id, status: 'completed' });
      todoChanged(); refresh(); report('待办已完成');
    } catch (e) { report(errorText(e), true); }
    finally { setWorking(undefined); }
  }
  return <>
    {data.error ? <Notice>{data.error}</Notice> : data.loading && !data.data ? <Loading /> : tasks.length ? <ul className="widget-list">
      {tasks.slice(0, 5).map((item) => <li key={item.id} className="widget-row">
        <label className="widget-todo-check"><input aria-label={'完成工作台待办 ' + item.title} type="checkbox" checked={false} disabled={working !== undefined}
          onChange={() => void complete(item)} /></label>
        <button type="button" className="widget-todo-title grow truncate" title={item.title} onClick={() => open(item.id)}>{item.title}</button>
        <Pill tone={item.dueAt! < start ? 'amber' : 'neutral'}>{item.dueAt! < start ? '逾期' : '今日'}</Pill>
      </li>)}
    </ul> : <p className="muted">没有今日或逾期待办。</p>}
    <Button className="widget-foot" tone="quiet" onClick={() => open()}>查看待办<ArrowRight size={15} /></Button>
  </>;
}

function DashboardInterviews({ revision, open }: { revision: number; open: DashboardProps['openTools'] }) {
  const data = usePendingTodos(revision);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const interviews = (data.data ?? []).filter((item) => item.interviewAt != null && item.interviewAt >= start.getTime() / 1000)
    .sort((a, b) => a.interviewAt! - b.interviewAt!);
  return <>
    {data.error ? <Notice>{data.error}</Notice> : data.loading && !data.data ? <Loading /> : interviews.length ? <ul className="widget-list">
      {interviews.slice(0, 5).map((item) => <li key={item.id}><button type="button" className="widget-row" onClick={() => open(item.id)}>
        <span className="widget-icon"><CalendarClock size={15} /></span><span className="grow"><strong>{item.title}</strong><small>{date(item.interviewAt!, true)}</small></span>
        <ArrowRight size={14} /></button></li>)}
    </ul> : <p className="muted">暂无即将到来的面试。</p>}
    <Button className="widget-foot" tone="quiet" onClick={() => open(undefined, 'interview')}>查看面试安排<ArrowRight size={15} /></Button>
  </>;
}

function QuickChat({ open }: { open: DashboardProps['openChat'] }) {
  const [question, setQuestion] = useState('');
  return <>
    <form className="widget-ask" onSubmit={(event) => { event.preventDefault(); if (question.trim()) open({ question: question.trim() }); }}>
      <input aria-label="工作台提问" placeholder="输入想咨询的问题" value={question} maxLength={6000} onChange={(event) => setQuestion(event.target.value)} />
      <Button type="submit" tone="primary" disabled={!question.trim()} title="在聊天中继续"><Send size={15} />继续</Button>
    </form>
    <Button className="widget-foot" tone="quiet" onClick={() => open()}>打开 HR AI 助手<ArrowRight size={15} /></Button>
  </>;
}

function RecentKnowledge({ revision, open }: { revision: number; open: DashboardProps['openKnowledge'] }) {
  const resource = useResource(recentKnowledge, [revision]);
  const [query, setQuery] = useState('');
  return <>
    <form className="widget-knowledge-search" onSubmit={(event) => { event.preventDefault(); open({ query: query.trim() }); }}>
      <input aria-label="工作台搜索资料" placeholder="搜索文件名或正文" value={query} maxLength={180} onChange={(event) => setQuery(event.target.value)} />
      <Button type="submit" className="icon-btn" aria-label="在资料库搜索"><Search size={16} /></Button>
    </form>
    {resource.error ? <Notice>{resource.error}</Notice> : resource.loading && !resource.data ? <Loading /> : resource.data?.length ? <ul className="widget-list">
      {resource.data.map((item) => <li key={item.id}><button className="widget-row" type="button" onClick={() => open({ id: item.id })}>
        <span className="widget-icon"><FileText size={15} /></span><span className="grow"><strong>{item.name}</strong><small>{date(item.uploadedAt)}</small></span>
        </button></li>)}</ul> : <p className="muted">资料库中还没有文件。</p>}
    <Button className="widget-foot" tone="quiet" onClick={() => open()}><BookOpen size={15} />打开资料库</Button>
  </>;
}
