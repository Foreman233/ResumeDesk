import { useEffect, useRef, useState, type ComponentType } from 'react';
import { ArrowLeft, BookOpen, Check, ChevronRight, ClipboardList, ExternalLink, FileText, Folder, LayoutDashboard, ListTodo, Maximize2, MessageSquare, Plus, RotateCcw, Search, Upload } from 'lucide-react';
import { errorText, type Job } from './api';
import { KNOWLEDGE_ACCEPT, knowledge, type KnowledgeTarget } from './knowledge-api';
import { useKnowledgeUpload } from './knowledge-upload';
import { KnowledgeWorkspace } from './knowledge';
import { showTodoWindow, todo, todoChanged, type TodoSummaryGroup, type TodoTarget } from './todo-api';
import { CreateTodoDialog, TodoWorkspace, useTodoEvents } from './todos';
import { Button, Loading, Notice, PageHeading, date, useDebounced, useResource } from './ui';
import { WidgetGrid, useWidgetLayout, type WidgetDefinition } from './widget-layout';
import { InterviewCard, InterviewWorkspace } from './interview';
import type { InterviewTarget } from './interview-api';
import './widget-hub.css';

type ToolTarget = TodoTarget & KnowledgeTarget & InterviewTarget;
type ToolServices = {
  jobs: Job[];
  report: (message: string, error?: boolean) => void;
  openCandidate: (id: number) => void;
  openJobs: (id: number, applicationId?: number) => void;
  ask: (id: number) => void;
  aiEnabled: boolean;
  openAiSettings: () => void;
};
type ToolCardProps = ToolServices & {
  active: boolean; revision: number; refresh: () => void; open: (target?: ToolTarget) => void;
};
type WorkspaceProps = ToolCardProps & { initial?: ToolTarget; intentKey: number };
type ToolDefinition = WidgetDefinition & { Card: ComponentType<ToolCardProps>; Expanded: ComponentType<WorkspaceProps> };

const REGISTRY = {
  todos: {
    label: '待办事项', description: '新建任务、查看到期事项、管理面试提醒。', icon: ListTodo, category: '效率工具',
    defaultWidth: 2, defaultHeight: 3, minWidth: 2, minHeight: 2,
    supportsResize: true, supportsFloatingWindow: true, Card: TodoToolCard, Expanded: TodoWorkspace,
  },
  knowledge: {
    label: '资料库', description: '上传文件、搜索正文、在 HR AI 助手中询问资料。', icon: BookOpen, category: '文件与知识',
    defaultWidth: 2, defaultHeight: 3, minWidth: 2, minHeight: 2,
    supportsResize: true, supportsFloatingWindow: false, Card: KnowledgeToolCard, Expanded: KnowledgeWorkspace,
  },
  interview: {
    label: '面试准备', description: '从指定简历和岗位准备、编辑及导出面试提纲。', icon: ClipboardList, category: '招聘工具',
    defaultWidth: 2, defaultHeight: 3, minWidth: 2, minHeight: 2,
    supportsResize: true, supportsFloatingWindow: false, Card: InterviewCard, Expanded: InterviewWorkspace,
  },
} satisfies Record<string, ToolDefinition>;
type ToolId = keyof typeof REGISTRY;
const TOOL_ORDER = Object.keys(REGISTRY) as ToolId[];
export type ToolDestination = { id: ToolId; target?: ToolTarget };

export function WidgetHub({ initial, navigation, visible, ...services }: ToolServices & {
  initial?: ToolDestination; navigation: number; visible: boolean;
}) {
  const layout = useWidgetLayout('tools', REGISTRY, TOOL_ORDER, services.report);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ToolId>();
  const [destinations, setDestinations] = useState<Partial<Record<ToolId, { target?: ToolTarget; key: number }>>>({});
  const [revisions, setRevisions] = useState<Partial<Record<ToolId, number>>>({});
  const sequence = useRef(0);
  const page = useRef<HTMLElement>(null);
  const gridScroll = useRef(0);

  function open(id: ToolId, target?: ToolTarget) {
    if (!expanded) gridScroll.current = page.current?.scrollTop ?? 0;
    const key = ++sequence.current;
    setDestinations((old) => ({ ...old, [id]: { target, key } }));
    setExpanded(id);
  }
  function toolProps(id: ToolId, active: boolean): ToolCardProps {
    return {
      ...services, active: visible && active, revision: revisions[id] ?? 0, open: (target) => open(id, target),
      refresh: () => setRevisions((old) => ({ ...old, [id]: (old[id] ?? 0) + 1 })),
    };
  }

  useEffect(() => {
    if (initial && Object.hasOwn(REGISTRY, initial.id)) open(initial.id, initial.target);
    else setExpanded(undefined);
  }, [navigation]);
  useEffect(() => {
    if (page.current) page.current.scrollTop = expanded ? 0 : gridScroll.current;
  }, [expanded]);

  return <main ref={page} className="page scroll-page widget-hub">
    <PageHeading title="小工具" description={expanded ? undefined : '安排待办与面试，查找工作资料。'}>
      {expanded ? <Button onClick={() => setExpanded(undefined)}><ArrowLeft size={16} />返回小工具中心</Button> : <>
        <Button onClick={layout.manage} disabled={!layout.ready || layout.saving}>管理小工具</Button>
        <Button onClick={layout.begin} disabled={!layout.ready || layout.editing || layout.saving}><LayoutDashboard size={16} />自定义布局</Button>
        {!layout.editing && <Button onClick={layout.defaults} disabled={!layout.ready || layout.saving}><RotateCcw size={15} />恢复默认布局</Button>}
      </>}
    </PageHeading>
    <div className="hub-grid-shell" hidden={!!expanded}>
      {!layout.editing && <div className="hub-search"><label className="search-input"><Search size={16} />
        <input aria-label="搜索小工具" value={query} maxLength={100} placeholder="按工具名称或分类搜索" onChange={(e) => setQuery(e.target.value)} />
      </label></div>}
      <WidgetGrid state={layout} query={query} active={!expanded} tools keepHidden
        headingAction={(id) => <Button className="hub-expand" tone="quiet" aria-label={'展开 ' + REGISTRY[id].label}
          onClick={() => open(id)}><Maximize2 size={14} />展开</Button>}
        render={(id, active) => {
          const { Card } = REGISTRY[id];
          return <Card {...toolProps(id, active)} />;
        }} />
    </div>
    {TOOL_ORDER.map((id) => {
      const destination = destinations[id];
      if (!destination) return null;
      const { label, icon: Icon, Expanded } = REGISTRY[id];
      return <section className="hub-expanded" hidden={expanded !== id} key={id} aria-label={label + '展开视图'}>
        <div className="hub-expanded-heading"><span className="widget-icon"><Icon size={17} /></span><h2>{label}</h2></div>
        <Expanded {...toolProps(id, expanded === id)} initial={destination.target} intentKey={destination.key} />
      </section>;
    })}
  </main>;
}

const groups = [
  { id: 'today', label: '今日待办' }, { id: 'upcoming', label: '即将到期' }, { id: 'overdue', label: '已逾期' },
] satisfies { id: TodoSummaryGroup; label: string }[];

function TodoToolCard({ active, jobs, revision, refresh, report, open }: ToolCardProps) {
  const [adding, setAdding] = useState(false);
  const [working, setWorking] = useState<number>();
  const resource = useResource(() => {
    const end = new Date();
    end.setHours(24, 0, 0, 0);
    return todo('summary', { dayEnd: Math.floor(end.getTime() / 1000) });
  }, [revision], active);
  useTodoEvents(resource.retry, active);

  async function complete(id: number) {
    setWorking(id);
    try {
      await todo('set_status', { id, status: 'completed' });
      todoChanged(); refresh(); report('待办已完成');
    } catch (e) { report(errorText(e), true); }
    finally { setWorking(undefined); }
  }

  return <>
    <div className="wrap hub-card-actions">
      <Button tone="primary" onClick={() => setAdding(true)}><Plus size={15} />新建待办</Button>
      <Button onClick={() => void showTodoWindow().catch((e: unknown) => report(errorText(e), true))}><ExternalLink size={14} />打开桌面待办</Button>
    </div>
    {resource.error ? <Notice action={<Button tone="quiet" onClick={resource.retry}>重试</Button>}>{resource.error}</Notice>
      : resource.loading && !resource.data ? <Loading /> : <div className="hub-task-groups">
        {groups.map((group) => {
          const tasks = resource.data?.filter((item) => item.group === group.id) ?? [];
          return <section key={group.id} className="hub-task-group">
            <h3>{group.label}</h3>
            {tasks.length ? <ul className="hub-task-list">{tasks.map((item) => <li key={item.id}>
              <Button tone="quiet" className="icon-btn" aria-label={'完成待办 ' + item.title} disabled={working !== undefined}
                busy={working === item.id} onClick={() => void complete(item.id)}><Check size={15} /></Button>
              <button type="button" className="hub-task-open" onClick={() => open({ id: item.id })}>
                <strong>{item.title}</strong><small className={group.id === 'overdue' ? 'text-error' : 'muted'}>{date(item.scheduledAt, true)}</small>
              </button>
            </li>)}</ul> : <small className="muted">暂无</small>}
          </section>;
        })}
      </div>}
    {adding && <CreateTodoDialog jobs={jobs} onClose={() => setAdding(false)} onSaved={() => { refresh(); report('待办已保存'); }} />}
  </>;
}

function KnowledgeToolCard({ active, revision, refresh, report, ask, open }: ToolCardProps) {
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<'uploaded' | 'viewed'>('uploaded');
  const input = useRef<HTMLInputElement>(null);
  const term = useDebounced(query.trim());
  const summary = useResource(() => knowledge('summary'), [revision], active);
  const search = useResource(() => knowledge('list', { filter: { query: term, limit: 5 } }), [term, revision], active && !!term);
  const upload = useKnowledgeUpload({ refresh, report });
  const files = term ? search.data?.items.map((file) => ({
    id: file.id, name: file.name, format: file.format, time: file.uploadedAt,
    canAsk: file.aiAllowed && (file.parseStatus === 'complete' || file.parseStatus === 'partial'),
  })) : summary.data?.[recent].map((file) => ({
    ...file, time: recent === 'viewed' ? file.viewedAt ?? file.uploadedAt : file.uploadedAt,
  }));
  const failure = term ? search.error : summary.error;
  const loading = term ? search.loading : summary.loading;

  return <>
    <div className="wrap hub-card-actions">
      <Button tone="primary" onClick={() => input.current?.click()} disabled={!!upload.uploading}><Upload size={15} />上传资料</Button>
    </div>
    <input ref={input} type="file" multiple accept={KNOWLEDGE_ACCEPT} className="sr-only" tabIndex={-1} aria-label="从卡片选择资料文件"
      onChange={(event) => {
        const selected = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = ''; void upload.run(selected);
      }} />
    {upload.uploading && <Loading>正在处理 {upload.uploading}</Loading>}
    {!!upload.errors.length && <Notice><ul className="knowledge-errors">{upload.errors.map((message, index) => <li key={index}>{message}</li>)}</ul></Notice>}
    <form className="hub-knowledge-search" onSubmit={(event) => { event.preventDefault(); open({ query: query.trim() }); }}>
      <label className="search-input"><Search size={16} /><input aria-label="卡片搜索资料" placeholder="搜索文件名或正文" value={query} maxLength={180}
        onChange={(e) => setQuery(e.target.value)} /></label>
      <Button type="submit" className="icon-btn" aria-label="展开资料搜索结果" title="查看全部搜索结果"><ChevronRight size={16} /></Button>
    </form>
    {!term && <div className="hub-knowledge-categories">
      <h3>文件分类</h3>
      {summary.data?.categories.length ? <div className="wrap">
        {summary.data.categories.map((category) => <Button tone="quiet" key={category.id} onClick={() => open({ categoryId: category.id })}>
          <Folder size={14} />{category.name} <small>{category.count}</small></Button>)}
      </div> : <small className="muted">暂无分类</small>}
    </div>}
    {!term && <div className="tabs hub-recent-tabs" role="tablist" aria-label="资料卡片最近文件">
      <button role="tab" aria-selected={recent === 'uploaded'} onClick={() => setRecent('uploaded')}>最近上传</button>
      <button role="tab" aria-selected={recent === 'viewed'} onClick={() => setRecent('viewed')}>最近使用</button>
    </div>}
    {failure ? <Notice action={<Button tone="quiet" onClick={term ? search.retry : summary.retry}>重试</Button>}>{failure}</Notice>
      : loading && !files ? <Loading />
        : files?.length ? <ul className="hub-file-list">{files.map((file) => <li key={file.id}>
          <button className="hub-file-open" type="button" onClick={() => open({ id: file.id })} title={file.name}>
            <FileText size={16} /><strong>{file.name}</strong><small>{file.format.toUpperCase()} · {date(file.time)}</small>
          </button>
          {file.canAsk && <Button tone="quiet" className="icon-btn" aria-label={'询问 ' + file.name} title="在 HR AI 助手中询问" onClick={() => ask(file.id)}><MessageSquare size={15} /></Button>}
        </li>)}</ul> : <small className="muted">{term ? '没有匹配的资料。' : recent === 'uploaded' ? '还没有上传文件。' : '暂无使用记录。'}</small>}
    {!!term && (search.data?.total ?? 0) > 5 && <Button tone="quiet" onClick={() => open({ query: term })}>查看全部结果<ChevronRight size={15} /></Button>}
  </>;
}
