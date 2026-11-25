import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BriefcaseBusiness, ChevronRight, FileStack, LayoutGrid, ListTodo, LockKeyhole, MessageSquare, Settings2, UsersRound, X } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { version as appVersion } from '../package.json';
import { rpc, type Filter, type Job } from './api';
import { ChatPage, type ChatStart } from './chat';
import { DashboardPage } from './dashboard';
import { ImportDialog } from './imports';
import type { InterviewTarget } from './interview-api';
import { Jobs } from './jobs';
import type { KnowledgeTarget } from './knowledge-api';
import { Library } from './library';
import { JobForm } from './recruit-forms';
import { SettingsPage, type AiSection, type SettingsSection } from './settings';
import { TodoWidget } from './todos';
import type { TodoCategory, TodoNavigation } from './todo-api';
import { useQuickState } from './quick';
import { Button, Notice, useResource } from './ui';
import { WidgetHub, type ToolDestination } from './widget-hub';
import './styles.css';

type Page = 'home' | 'library' | 'jobs' | 'assistant' | 'tools' | 'settings';
type Route = {
  page: Page; id?: number; application?: number; filter?: Filter; section?: SettingsSection; aiSection?: AiSection;
  tool?: ToolDestination; chat?: ChatStart; stamp: number;
};
const nav = [
  { key: 'home', label: '工作台', icon: LayoutGrid },
  { key: 'library', label: '候选人库', icon: UsersRound },
  { key: 'jobs', label: '岗位管理', icon: BriefcaseBusiness },
  { key: 'assistant', label: 'HR AI 助手', icon: MessageSquare },
  { key: 'tools', label: '小工具', icon: ListTodo },
  { key: 'settings', label: '设置', icon: Settings2 },
] as const;

function App() {
  const [route, setRoute] = useState<Route>({ page: 'home', stamp: 0 });
  const [tools, setTools] = useState<Route>();
  const routeStamp = useRef(0);
  const [revision, setRevision] = useState(0);
  const [importing, setImporting] = useState<{ files?: File[] }>();
  const [jobForm, setJobForm] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean }>();
  const jobs = useResource(() => rpc('jobs'), [revision]);
  const quick = useQuickState(revision);
  const items = jobs.data ?? [];
  const refresh = () => setRevision((n) => n + 1);
  function go(page: Page, options: Omit<Partial<Route>, 'page' | 'stamp'> = {}) {
    const next = { page, stamp: ++routeStamp.current, ...options };
    setRoute(next);
    if (page === 'tools') setTools(next);
  }
  const goLibrary = (filter?: Filter, id?: number) => go('library', { filter, id });
  const goJobs = (id?: number, application?: number) => go('jobs', { id, application });
  const goSettings = (section?: SettingsSection, aiSection?: AiSection) => go('settings', { section, aiSection });
  const goKnowledge = (target?: KnowledgeTarget) => go('tools', { tool: { id: 'knowledge', target } });
  const goChat = (chat?: ChatStart) => go('assistant', { chat });
  const goTools = (id?: number, category?: TodoCategory) => go('tools', { tool: { id: 'todos', target: { id, category } } });
  const goInterview = (target: InterviewTarget) => go('tools', { tool: { id: 'interview', target } });
  const report = (text: string, error = false) => setToast({ text, error });
  const importNew = () => setImporting({});
  const newJob = () => setJobForm(true);
  const label = nav.find((item) => item.key === route.page)!.label;
  const [dropActive, setDropActive] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const navigation = listen<TodoNavigation>('resumedesk-navigate', ({ payload }) => {
      if (payload.jobId) go('jobs', { id: payload.jobId, application: payload.applicationId ?? undefined });
      else if (payload.candidateId) go('library', { id: payload.candidateId });
      else if (payload.widget) go('tools', { tool: { id: 'todos' } });
    });
    const reminders = listen<number>('resumedesk-reminder', ({ payload }) => report(payload + ' 项面试提醒已到时间，可在小工具中查看。'));
    return () => { for (const subscription of [navigation, reminders]) void subscription.then((off) => off()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), toast.error ? 7500 : 3900);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return <div className="app-shell" onDragOver={(event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    if (!importing && (route.page === 'home' || route.page === 'library') && !document.querySelector('[role="dialog"]')) setDropActive(true);
  }} onDragLeave={(event) => {
    if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false);
  }} onDrop={(event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); setDropActive(false);
    if (!importing && (route.page === 'home' || route.page === 'library') && event.dataTransfer.files.length && !document.querySelector('[role="dialog"]')) {
      setImporting({ files: Array.from(event.dataTransfer.files).slice(0, 60) });
    }
  }}>
    <aside className="sidebar">
      <button type="button" className="brand" aria-label="ResumeDesk 工作台" onClick={() => go('home')}>
        <span className="brand-logo"><FileStack size={23} strokeWidth={1.8} /></span>
        <span className="brand-copy"><strong>ResumeDesk</strong><small>简历与招聘</small></span>
      </button>
      <div className="side-section-label">工作空间</div>
      <nav className="main-nav" aria-label="工作空间">
        {nav.filter(({ key }) => key !== 'settings').map(({ key, label, icon: Icon }) => <button type="button" key={key} aria-label={label} title={label}
          aria-current={route.page === key ? 'page' : undefined}
          onClick={() => go(key)}><Icon size={18} /><span>{label}</span></button>)}
      </nav>
      <JobNav items={items} route={route} goJobs={goJobs} />
      <div className="sidebar-bottom">
        <nav className="main-nav" aria-label="应用设置"><button type="button" aria-label="设置" title="设置" aria-current={route.page === 'settings' ? 'page' : undefined}
          onClick={() => goSettings()}><Settings2 size={18} /><span>设置</span></button></nav>
        <div className="local-status"><span className="status-dot" /><div><strong>本地工作区</strong><small>ResumeDesk {appVersion}</small></div><LockKeyhole size={15} /></div>
      </div>
    </aside>
    <div className="app-body">
      <header className="topbar">
        <div className="breadcrumb"><span>工作空间</span><ChevronRight size={14} /><strong>{label}</strong></div>
        <div className="top-local"><LockKeyhole size={14} />本机存储</div>
      </header>
      <div className="page-slot" key={route.stamp} hidden={route.page === 'tools'}>
        {route.page === 'home' && <DashboardPage jobs={items} revision={revision} onImport={importNew} onNewJob={newJob}
          library={goLibrary} openJob={goJobs} quick={quick}
          openSettings={() => goSettings('quick')} openChat={goChat} openTools={goTools}
          openKnowledge={goKnowledge} refresh={refresh} report={report} />}
        {route.page === 'library' && <Library revision={revision} jobs={items} initialId={route.id} preset={route.filter}
          refresh={refresh} report={report} importNew={importNew} openJobs={goJobs} openInterview={goInterview} />}
        {route.page === 'jobs' && <Jobs items={items} loading={jobs.loading} error={jobs.error} initialId={route.id}
          initialApplication={route.application} revision={revision} onNewJob={newJob} refresh={refresh} report={report}
          openCandidate={(id) => goLibrary(undefined, id)} />}
        {route.page === 'assistant' && <ChatPage revision={revision} aiEnabled={quick.data?.settings.aiEnabled ?? true} initial={route.chat}
          openAiSettings={(section) => goSettings('ai', section)} openKnowledge={goKnowledge} />}
        {route.page === 'settings' && <SettingsPage initialSection={route.section} initialAiSection={route.aiSection} revision={revision} refresh={refresh}
          report={report} library={goLibrary} quick={quick} restored={() => { setTools(undefined); refresh(); go('home'); }} />}
      </div>
      {tools && <div className="page-slot" key="tools" hidden={route.page !== 'tools'}>
        <WidgetHub jobs={items} initial={tools.tool} navigation={tools.stamp} visible={route.page === 'tools'} report={report}
          aiEnabled={quick.data?.settings.aiEnabled ?? true} openAiSettings={() => goSettings('ai')}
          ask={(knowledgeId) => goChat({ knowledgeId })} openCandidate={(id) => goLibrary(undefined, id)} openJobs={goJobs} />
      </div>}
    </div>
    {dropActive && !importing && <div className="drop-hint" role="status">松开鼠标，将简历添加到候选人库</div>}
    {importing && <ImportDialog target={{ kind: 'new' }} initial={importing.files} jobs={items}
      onClose={() => setImporting(undefined)} onDone={(rows) => {
        const added = rows.find((row) => row.state === 'imported');
        if (added) { refresh(); goLibrary(undefined, added.ownerId); }
      }} />}
    {jobForm && <JobForm onClose={() => setJobForm(false)} onSaved={(id) => {
      refresh(); goJobs(id); report('岗位已创建');
    }} />}
    {toast && <div className="toast"><Notice tone={toast.error ? 'error' : 'success'}
      action={<Button className="icon-btn" tone="quiet" aria-label="关闭提示" onClick={() => setToast(undefined)}><X size={16} /></Button>}>{toast.text}</Notice></div>}
  </div>;
}

function JobNav({ items, route, goJobs }: { items: Job[]; route: Route; goJobs: (id?: number) => void }) {
  const current = items.filter((item) => item.status === 'open').slice(0, 7);
  return <div className="side-jobs">
    <div className="side-section-label">招聘岗位</div>
    {current.length ? current.map((item) => <button key={item.id} type="button" title={item.title}
      data-active={route.page === 'jobs' && route.id === item.id} onClick={() => goJobs(item.id)}>
      <span className="job-dot" /><span className="truncate">{item.title}</span><small>{item.applicationCount}</small>
    </button>) : <span className="side-empty">暂无进行中的岗位</span>}
  </div>;
}

function WidgetRoot() {
  const quick = useQuickState();
  if (quick.loading && !quick.data) return null;
  return <TodoWidget initialAlwaysOnTop={quick.data?.settings.alwaysOnTop ?? false} />;
}

const widgetWindow = isTauri() && getCurrentWindow().label === 'todo';
createRoot(document.getElementById('root')!).render(widgetWindow ? <WidgetRoot /> : <App />);
