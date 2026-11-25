import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, Bot, BriefcaseBusiness, ChevronLeft, ChevronRight, Clipboard, Eraser, ExternalLink, FileText, Globe, MessageSquare, Pencil, Plus, Search, Send, ShieldCheck, Sparkles, Square, Trash2, Users, X } from 'lucide-react';
import { AI_SCOPES, errorText, rpc } from './api';
import { cancelChat, chatRpc, sendChat, type ChatConversation, type ChatMessage, type ChatMode, type ChatPreview } from './chat-api';
import { ChatMarkdown } from './chat-markdown';
import { knowledge, openSourceLink, type KnowledgeTarget } from './knowledge-api';
import type { AiSection } from './settings';
import { Button, Confirm, Empty, Field, Loading, Modal, Notice, PageHeading, Pill, date, useDebounced, useResource } from './ui';
import './chat.css';

type Selected = { id: number; label: string; kind: 'candidate' | 'job' };
export type ChatStart = { knowledgeId?: number; question?: string };
const modeLabels = { general: '通用 AI', workspace: '招聘资料问答' };
const starters = {
  general: ['设计一组行为面试问题', '写一封温和的面试邀请邮件', '梳理一套招聘流程'],
  workspace: ['根据资料梳理岗位要求', '列出值得在面试中核实的问题', '提取资料中的事实和未确认信息'],
};
const permission = '我已核对发送内容，并确认拥有适当的数据处理权限。';

export function ChatPage({ revision, openAiSettings, aiEnabled, initial, openKnowledge }: {
  revision: number; openAiSettings: (section?: AiSection) => void; aiEnabled: boolean; initial?: ChatStart;
  openKnowledge: (target: KnowledgeTarget) => void;
}) {
  const [mode, setMode] = useState<ChatMode>('general');
  const [selected, select] = useState<number>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [handoff, setHandoff] = useState<number>();
  const conversations = useResource(() => chatRpc('list'), [revision]);
  const status = useResource(() => rpc('ai_status'), [revision]);
  const rows = conversations.data?.filter((item) => item.mode === mode) ?? [];
  const active = selected === undefined ? rows[0] : rows.find((item) => item.id === selected);

  async function create(seed = false) {
    setCreating(true); setError('');
    try {
      const created = await chatRpc('create', { mode });
      select(created.id);
      if (seed) setHandoff(created.id);
      conversations.retry();
    } catch (e) { setError(errorText(e)); }
    finally { setCreating(false); }
  }
  useEffect(() => { if (initial) void create(true); }, []);

  const locked = !aiEnabled
    ? 'AI 功能已关闭。'
    : status.loading && !status.data ? '正在读取 AI 配置…'
      : status.error || (status.data?.verified === true ? '' : '请先保存 API Key 并测试连接。');

  return <main className="page scroll-page chat-page">
    <PageHeading title="HR AI 助手" description="用 AI 整理招聘工作，按需引用经你确认的本地资料。">
      <Button tone="quiet" onClick={() => openAiSettings()}><ShieldCheck size={16} />AI 设置</Button>
    </PageHeading>
    <div className="chat-layout">
      <aside className="panel chat-sidebar">
        <div className="panel-body form-stack">
          <div className="mode-choice" aria-label="对话模式">
            <button type="button" aria-pressed={mode === 'general'} onClick={() => { setMode('general'); select(undefined); }}><Sparkles size={16} />{modeLabels.general}</button>
            <button type="button" aria-pressed={mode === 'workspace'} onClick={() => { setMode('workspace'); select(undefined); }}><Users size={16} />{modeLabels.workspace}</button>
          </div>
          <Button tone="primary" busy={creating} onClick={() => void create()}><Plus size={16} />新建对话</Button>
          {(error || conversations.error) && <Notice>{error || conversations.error}</Notice>}
          {conversations.loading && !conversations.data ? <Loading>正在读取对话…</Loading> : <nav className="chat-list" aria-label="对话历史">
            {rows.map((item) => <button type="button" key={item.id} aria-current={active?.id === item.id ? 'page' : undefined} onClick={() => select(item.id)}>
              <MessageSquare size={15} /><span className="truncate">{item.title}</span>
            </button>)}
            {!rows.length && <p className="muted">还没有对话</p>}
          </nav>}
        </div>
      </aside>
      {active ? <ChatThread key={active.id} conversation={active} revision={revision} locked={locked} openAiSettings={openAiSettings}
        initial={handoff === active.id ? initial : undefined} openKnowledge={openKnowledge}
        refreshList={conversations.retry} onDelete={() => { select(undefined); conversations.retry(); }} /> :
        <section className="panel chat-start">
          <Empty icon={<Bot size={30} />} title={modeLabels[mode]}
            description={mode === 'general' ? '起草招聘沟通、讨论工作流程或准备面试问题。' : '选择候选人或岗位，核对这次需要发送的资料。'}>
            <Button tone="primary" busy={creating} onClick={() => void create()}><Plus size={16} />开始对话</Button>
          </Empty>
        </section>}
    </div>
  </main>;
}

function ChatThread({ conversation, revision, locked, openAiSettings, refreshList, onDelete, initial, openKnowledge }: {
  conversation: ChatConversation; revision: number; locked: string; openAiSettings: (section?: AiSection) => void;
  refreshList: () => void; onDelete: () => void; initial?: ChatStart; openKnowledge: (target: KnowledgeTarget) => void;
}) {
  const messages = useResource(() => chatRpc('open', { id: conversation.id }), [conversation.id, revision]);
  const [saved, setSaved] = useState<ChatMessage[]>();
  const [question, setQuestion] = useState(initial?.question ?? '');
  const [selected, setSelected] = useState<Selected[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [useRecruiting, setUseRecruiting] = useState(conversation.mode === 'workspace');
  const [knowledgeIds, setKnowledgeIds] = useState<number[] | undefined>(initial?.knowledgeId ? [initial.knowledgeId] : undefined);
  const [chooseFiles, setChooseFiles] = useState(false);
  const [searchWeb, setSearchWeb] = useState(false);
  const [publicQuery, setPublicQuery] = useState('');
  const searchService = useResource(() => rpc('web_search_settings'), [revision]);
  const searchAvailable = searchService.data?.hasKey === true;
  const [redact, setRedact] = useState(true);
  const privacy = useResource(() => rpc('settings'), [revision]);
  const [redactOverride, setRedactOverride] = useState(false);
  const [includeHistory, setIncludeHistory] = useState(conversation.mode === 'general');
  const [preview, setPreview] = useState<ChatPreview>();
  const [preparing, setPreparing] = useState(false);
  const [sending, setSending] = useState(false);
  const [requestQuestion, setRequestQuestion] = useState('');
  const [stream, setStream] = useState('');
  const [error, setError] = useState('');
  const [changing, setChanging] = useState<'rename' | 'delete' | 'clear'>();
  const [copyStatus, setCopyStatus] = useState('');
  const [follows, setFollows] = useState(true);
  const running = useRef<string | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const compose = useRef<HTMLTextAreaElement>(null);
  const visible = saved ?? messages.data ?? [];
  const busy = sending || preparing;
  const canSend = !locked && !!question.trim() && (!useRecruiting || !!selected.length)
    && (!searchWeb || searchAvailable && !!publicQuery.trim());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (running.current) void cancelChat(running.current).catch(() => {});
      if (pending.current) void chatRpc('dismiss', { id: pending.current }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!redactOverride && privacy.data) setRedact(privacy.data.privacy.redactByDefault);
  }, [redactOverride, privacy.data]);

  useEffect(() => {
    if (follows) end.current?.scrollIntoView({ block: 'end' });
  }, [saved, messages.data, requestQuestion, stream, follows]);

  function closePreview() {
    if (preview) void chatRpc('dismiss', { id: preview.id }).catch(() => {});
    pending.current = undefined;
    setPreview(undefined);
  }

  async function reply(next: ChatPreview, editedQuestion: string, excerpts: string[], confirmed: boolean, remember = false) {
    if (running.current) return;
    running.current = next.id;
    pending.current = undefined;
    setPreview(undefined); setSending(true); setError(''); setStream('');
    setFollows(true); setRequestQuestion(editedQuestion);
    try {
      const result = await sendChat(next.id, editedQuestion, excerpts, confirmed, remember, (delta) => {
        if (mounted.current && running.current === next.id) setStream((previous) => previous + delta);
      });
      if (mounted.current) { setSaved(result); setQuestion(''); setPublicQuery(''); refreshList(); }
    } catch (e) {
      if (mounted.current) { setQuestion(editedQuestion); setError(errorText(e)); }
    } finally {
      running.current = undefined;
      if (mounted.current) { setSending(false); setRequestQuestion(''); setStream(''); }
    }
  }

  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (!canSend || busy) return;
    setPreparing(true); setError('');
    try {
      const next = await chatRpc('preview', { draft: {
        conversation: conversation.id, question,
        candidateIds: useRecruiting ? selected.filter((item) => item.kind === 'candidate').map((item) => item.id) : [],
        jobIds: useRecruiting ? selected.filter((item) => item.kind === 'job').map((item) => item.id) : [],
        includeHistory, redact, knowledgeIds, webQuery: searchWeb ? publicQuery : undefined,
      } });
      if (!mounted.current) { void chatRpc('dismiss', { id: next.id }).catch(() => {}); return; }
      pending.current = next.id;
      if (next.confirmationRequired) setPreview(next);
      else await reply(next, next.question, next.excerpts.map((item) => item.text), false);
    } catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { if (mounted.current) setPreparing(false); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopyStatus('已复制回复。'); }
    catch { setCopyStatus('无法访问剪贴板，请选中回复文字后复制。'); }
  }

  return <section className="panel chat-thread">
    <div className="panel-head">
      <div><h2 className="truncate">{conversation.title}</h2><p>{modeLabels[conversation.mode]}</p></div>
      <div className="wrap">
        <Button tone="quiet" aria-label="清空聊天记录" title="清空聊天记录" disabled={sending || preparing || !visible.length} onClick={() => setChanging('clear')}><Eraser size={16} /></Button>
        <Button tone="quiet" aria-label="重命名对话" title="重命名对话" disabled={sending || preparing} onClick={() => setChanging('rename')}><Pencil size={16} /></Button>
        <Button tone="quiet" aria-label="删除对话" title="删除对话" disabled={sending || preparing} onClick={() => setChanging('delete')}><Trash2 size={16} /></Button>
      </div>
    </div>
    <div className="chat-messages" aria-label="聊天记录" onScroll={(e) => {
      const pane = e.currentTarget;
      setFollows(pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80);
    }}>
      {(messages.error && !saved) ? <Notice>{messages.error}</Notice> : messages.loading && !saved ? <Loading>正在读取消息…</Loading> :
        !visible.length && !requestQuestion ? <div className="chat-empty">
          <div className="chat-hero-icon"><Bot size={28} /></div>
          <h3>今天想完成什么招聘工作？</h3>
          <div className="wrap">{(knowledgeIds?.length === 1 ? ['请总结这份资料', '这份资料的适用范围和生效日期是什么？'] : starters[conversation.mode]).map((text) => <Button key={text} onClick={() => {
            setQuestion(text); compose.current?.focus();
          }}>{text}</Button>)}</div>
        </div> : visible.map((message) => <article key={message.id} className={'chat-message chat-' + message.role}>
          <div className="chat-message-caption"><strong>{message.role === 'assistant' ? 'HR AI 助手' : '你'}</strong>
            {message.role === 'assistant' && <Button tone="quiet" aria-label="复制回复" onClick={() => void copy(message.text)}><Clipboard size={14} /></Button>}
          </div>
          {message.role === 'assistant' ? <ChatMarkdown text={message.text} /> : <p className="chat-plain">{message.text}</p>}
          {!!message.sources.length && <MessageSources message={message} openKnowledge={openKnowledge} onError={setError} />}
        </article>)}
      {requestQuestion && <article className="chat-message chat-user"><strong>你</strong><p className="chat-plain">{requestQuestion}</p></article>}
      {sending && <article className="chat-message chat-assistant">
        <strong>HR AI 助手</strong>{stream ? <p className="chat-plain">{stream}</p> : <Loading>正在等待回复…</Loading>}
      </article>}
      <div ref={end} />
    </div>
    <form className="chat-compose" onSubmit={(e) => void prepare(e)}>
      {locked && <Notice tone="hint" action={<Button tone="quiet" onClick={() => openAiSettings()}>设置</Button>}>{locked}</Notice>}
      {error && <Notice>{error}</Notice>}
      {copyStatus && <small role="status" className="muted">{copyStatus}</small>}
      <div className="wrap chat-source-toggles" aria-label="信息来源">
        <Button role="switch" aria-checked={searchWeb} className={searchWeb ? 'source-on' : ''} disabled={busy} onClick={() => setSearchWeb(!searchWeb)}><Globe size={15} />联网搜索</Button>
        <Button role="switch" aria-checked={knowledgeIds !== undefined} className={knowledgeIds !== undefined ? 'source-on' : ''} disabled={busy}
          onClick={() => setKnowledgeIds(knowledgeIds === undefined ? [] : undefined)}><BookOpen size={15} />本地资料库</Button>
        <Button role="switch" aria-checked={useRecruiting} className={useRecruiting ? 'source-on' : ''} disabled={busy}
          onClick={() => setUseRecruiting(!useRecruiting)}><Users size={15} />候选人数据</Button>
      </div>
      {useRecruiting && <div className="wrap chat-scope">
        <Button onClick={() => setSelecting(true)} disabled={sending || preparing}><FileText size={16} />选择招聘资料</Button>
        {selected.map((item) => <Pill key={item.kind + item.id}>{item.label}
          <button className="chat-remove-source" type="button" aria-label={'移除 ' + item.label} disabled={sending || preparing}
            onClick={() => setSelected((rows) => rows.filter((row) => row.kind !== item.kind || row.id !== item.id))}><X size={13} /></button>
        </Pill>)}
      </div>}
      {knowledgeIds !== undefined && <div className="wrap chat-scope">
        <Button onClick={() => setChooseFiles(true)} disabled={busy}><BookOpen size={15} />选择资料库文件</Button>
        <Pill tone="indigo">{knowledgeIds.length ? '已指定 ' + knowledgeIds.length + ' 份资料' : '检索所有允许 AI 引用的资料'}</Pill>
      </div>}
      {searchWeb ? searchService.loading && !searchService.data ? <small className="muted">正在读取联网搜索配置…</small> :
        !searchAvailable ? <Notice tone="hint" action={<Button tone="quiet" onClick={() => openAiSettings('search')}>配置搜索服务</Button>}>
          {searchService.error || '联网搜索不可用或尚未配置。'}</Notice> :
          <Field label="公开搜索词" hint="搜索服务接收这条搜索词。仅填写地区和公开主题。">
            <input placeholder="例如 北京市 社会保险 缴费基数 最新政策" value={publicQuery} disabled={busy} maxLength={180}
              onChange={(event) => setPublicQuery(event.target.value)} /></Field>
        : <small className="muted">未启用联网搜索，回答可能不包含最新互联网信息。AI API 仍通过网络调用。</small>}
      <textarea ref={compose} aria-label="输入消息" placeholder="输入消息…" rows={3} maxLength={6000}
        value={question} onChange={(e) => setQuestion(e.target.value)} disabled={sending || preparing}
        onKeyDown={(e) => {
          if (!e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault(); e.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className="chat-compose-actions">
        <label className="check-line"><input type="checkbox" checked={includeHistory} disabled={sending || preparing}
          onChange={(e) => setIncludeHistory(e.target.checked)} />携带同范围的近期对话</label>
        {sending ? <Button onClick={() => {
          if (running.current) void cancelChat(running.current).catch((e: unknown) => setError(errorText(e)));
        }}><Square size={15} />停止回复</Button> : <Button type="submit" tone="primary" busy={preparing}
          disabled={!canSend}><Send size={16} />{useRecruiting ? '预览发送' : '发送'}</Button>}
      </div>
    </form>
    {selecting && <ScopePicker initial={selected} redact={redact} onClose={() => setSelecting(false)}
      onSave={(sources, redactSelection) => { setSelected(sources); setRedact(redactSelection); setRedactOverride(true); setSelecting(false); }} />}
    {chooseFiles && <KnowledgePicker initial={knowledgeIds ?? []} onClose={() => setChooseFiles(false)}
      onSave={(ids) => { setKnowledgeIds(ids); setChooseFiles(false); }} />}
    {preview && <SendPreview preview={preview} onClose={closePreview} send={(text, excerpts, remember) => void reply(preview, text, excerpts, true, remember)} />}
    {changing === 'rename' && <RenameDialog item={conversation} onClose={() => setChanging(undefined)} onSave={refreshList} />}
    {changing === 'clear' && <Confirm title="清空聊天记录？" label="确认清空" description="删除当前对话的消息和资料引用，保留对话名称与模式。"
      onClose={() => setChanging(undefined)} onConfirm={async () => {
        await chatRpc('clear', { id: conversation.id }); setSaved([]); setCopyStatus(''); setError(''); messages.retry();
      }} />}
    {changing === 'delete' && <Confirm title="删除这段对话？" description="这段对话的消息和资料引用将从本机移除。"
      onClose={() => setChanging(undefined)} onConfirm={async () => { await chatRpc('delete', { id: conversation.id }); onDelete(); }} />}
  </section>;
}

function ScopePicker({ initial, redact, onClose, onSave }: {
  initial: Selected[]; redact: boolean; onClose: () => void; onSave: (selection: Selected[], redact: boolean) => void;
}) {
  const [selected, setSelected] = useState(initial);
  const [deidentify, setDeidentify] = useState(redact);
  const [kind, setKind] = useState<Selected['kind']>('candidate');
  const [query, setQuery] = useState('');
  const search = useDebounced(query);
  const items = useResource(async (): Promise<Selected[]> => kind === 'candidate'
    ? (await rpc('candidate_list', { filter: { query: search } })).items.map((item) => ({ kind, id: item.id, label: item.name }))
    : (await rpc('jobs')).filter((item) => (item.title + ' ' + item.department).toLowerCase().includes(search.toLowerCase()))
      .map((item) => ({ kind, id: item.id, label: item.title })), [search, kind]);
  return <Modal title="选择招聘资料" description="可选 4 项。预览会列出岗位 JD、候选人档案及最多两份近期简历的文字片段。" onClose={onClose} wide>
    <div className="form-stack">
      <div className="mode-choice"><button type="button" aria-pressed={kind === 'candidate'} onClick={() => { setKind('candidate'); setQuery(''); }}><Users size={16} />候选人</button>
        <button type="button" aria-pressed={kind === 'job'} onClick={() => { setKind('job'); setQuery(''); }}><BriefcaseBusiness size={16} />岗位</button></div>
      <label className="search-input"><Search size={16} /><input aria-label="搜索招聘资料" value={query} maxLength={100}
        onChange={(e) => setQuery(e.target.value)} placeholder={kind === 'candidate' ? '搜索候选人姓名' : '搜索岗位名称'} /></label>
      <div className="picker-results">
        {items.error ? <Notice>{items.error}</Notice> : items.loading ? <Loading /> : !items.data?.length ? <Empty title="没有匹配的资料" /> :
          items.data.map((item) => {
            const has = selected.some((row) => row.kind === item.kind && row.id === item.id);
            return <label className="pick-row" key={item.id}><input type="checkbox" checked={has} disabled={!has && selected.length >= 4}
              onChange={() => setSelected((rows) => has ? rows.filter((row) => row.kind !== item.kind || row.id !== item.id) : [...rows, item])} /><strong>{item.label}</strong></label>;
          })}
      </div>
      <label className="check-line"><input type="checkbox" checked={deidentify} onChange={(e) => setDeidentify(e.target.checked)} />尝试脱敏，移除姓名和联系方式</label>
      <div className="form-actions"><Button onClick={onClose}>取消</Button><Button tone="primary" onClick={() => onSave(selected, deidentify)}>应用选择（{selected.length}）</Button></div>
    </div>
  </Modal>;
}

function KnowledgePicker({ initial, onClose, onSave }: { initial: number[]; onClose: () => void; onSave: (ids: number[]) => void }) {
  const [all, setAll] = useState(!initial.length);
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const search = useDebounced(query);
  const docs = useResource(() => knowledge('list', { filter: { query: search, aiOnly: true, offset } }), [search, offset]);
  return <Modal title="选择资料库文件" description="仅可选择已授权 AI 引用且有正文索引的文件。" onClose={onClose} wide>
    <div className="form-stack">
      <label className="check-line"><input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />检索所有允许 AI 引用的文件</label>
      {!all && <>
        <label className="search-input"><Search size={16} /><input aria-label="筛选可引用文件" placeholder="搜索已授权文件" value={query} maxLength={180}
          onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></label>
        <div className="picker-results">
          {docs.error ? <Notice>{docs.error}</Notice> : docs.loading ? <Loading /> : !docs.data?.items.length ? <Empty title="没有符合条件的已授权文件" /> :
            docs.data.items.map((doc) => {
              const enabled = selected.includes(doc.id);
              return <label className="pick-row" key={doc.id}><input type="checkbox" checked={enabled} disabled={!enabled && selected.length >= 24}
                onChange={() => setSelected((ids) => enabled ? ids.filter((id) => id !== doc.id) : [...ids, doc.id])} />
                <strong>{doc.name}</strong></label>;
            })}
        </div>
        {(docs.data?.total ?? 0) > 60 && <div className="pagination"><span>{docs.data!.total} 份可引用文件</span>
          <Button aria-label="上一批可引用文件" tone="quiet" className="icon-btn" disabled={!offset} onClick={() => setOffset(offset - 60)}><ChevronLeft size={15} /></Button>
          <Button aria-label="下一批可引用文件" tone="quiet" className="icon-btn" disabled={offset + 60 >= docs.data!.total} onClick={() => setOffset(offset + 60)}><ChevronRight size={15} /></Button>
        </div>}
      </>}
      <div className="form-actions"><Button onClick={onClose}>取消</Button>
        <Button tone="primary" disabled={!all && !selected.length} onClick={() => onSave(all ? [] : selected)}>
          {all ? '使用全部已授权文件' : '使用选中的 ' + selected.length + ' 份文件'}</Button></div>
    </div>
  </Modal>;
}

function MessageSources({ message, openKnowledge, onError }: {
  message: ChatMessage; openKnowledge: (target: KnowledgeTarget) => void; onError: (message: string) => void;
}) {
  return <details className="source-details chat-references">
    <summary>本次发送的资料与引用（{message.sources.length} 项）</summary>
    <ul>{message.sources.map((source) => <li key={source.ordinal}>
      <div className="wrap">
        <strong>[{source.ordinal}] {source.label}</strong>
        <Pill tone={source.url ? 'green' : 'indigo'}>{source.url ? '网页' : source.documentId ? '资料库' : '招聘资料'}</Pill>
        {source.page && <small>第 {source.page} 页</small>}
        {source.documentId && <Button tone="quiet" onClick={() => openKnowledge({
          id: source.documentId!, page: source.page ?? undefined, chunk: source.chunkOrdinal ?? undefined,
        })}><FileText size={14} />查看来源文件</Button>}
      </div>
      {source.url && <div className="chat-reference-link">
        <button type="button" className="text-button" onClick={() => void openSourceLink({
          kind: 'reference', messageId: message.id, ordinal: source.ordinal,
        }).catch((e: unknown) => onError(errorText(e)))}>{source.url} <ExternalLink size={13} /></button>
        {source.retrievedAt && <small className="muted">检索时间 {date(source.retrievedAt, true)}</small>}
      </div>}
      {source.evidence && <blockquote>{source.evidence}</blockquote>}
    </li>)}</ul>
  </details>;
}

function SendPreview({ preview, onClose, send }: { preview: ChatPreview; onClose: () => void; send: (question: string, excerpts: string[], remember: boolean) => void }) {
  const [question, setQuestion] = useState(preview.question);
  const [excerpts, setExcerpts] = useState(preview.excerpts.map((excerpt) => excerpt.text));
  const [confirmed, setConfirmed] = useState(false);
  const [remember, setRemember] = useState(false);
  const onlyRecruiting = !!preview.excerpts.length && !preview.knowledgeRequested && !preview.search;
  return <Modal title="核对 AI 发送内容" description="消息会发送到你配置的第三方 AI 服务。请核对本轮携带的历史消息和选定资料片段。"
    onClose={onClose} wide>
    <div className="form-stack">
      <div className="outbound-target"><strong>发送至</strong><span>{preview.endpoint}</span><strong>模型</strong><span>{preview.model}</span>
        <strong>请求时限</strong><span>{preview.timeoutSeconds} 秒</span></div>
      <div className="wrap" aria-label="本次授权范围">
        {preview.scopes.map((scope) => <Pill key={scope.capability}>{AI_SCOPES[scope.capability]} · {scope.description}</Pill>)}
      </div>
      {preview.search && <div className="outbound-target">
        <strong>搜索服务</strong><span>{preview.search.endpoint}</span>
        <strong>公开搜索词</strong><span>{preview.search.query}</span>
        <strong>搜索结果</strong><span>相关网页摘要与链接会一并发送给 AI 服务。</span></div>}
      {preview.knowledgeRequested && !preview.excerpts.some((item) => item.source.documentId) &&
        <Notice tone="hint">资料库未找到与此问题相关的索引片段。</Notice>}
      <Field label="问题"><textarea rows={3} maxLength={6000} value={question} onChange={(e) => { setQuestion(e.target.value); setConfirmed(false); }} /></Field>
      {preview.excerpts.map(({ source, truncated, policyMetadata }, i) => {
        const policy = policyMetadata ? [policyMetadata.region && '地区 ' + policyMetadata.region, policyMetadata.issuer && '发布 ' + policyMetadata.issuer,
          policyMetadata.publishedOn && '发布日 ' + policyMetadata.publishedOn, policyMetadata.effectiveOn && '生效 ' + policyMetadata.effectiveOn,
          policyMetadata.expiresOn && '失效 ' + policyMetadata.expiresOn].filter(Boolean).join(' · ') : '';
        return <Field key={source.ordinal} label={'资料 [' + source.ordinal + '] ' + source.label + (source.page ? ' · 第 ' + source.page + ' 页' : '')}
          hint={(truncated ? '已截取。' : '') + '清空此片段可排除它。' + (policy ? ' 随附元数据 · ' + policy : '')}>
          <textarea rows={4} maxLength={4000} value={excerpts[i]} onChange={(e) => {
            const text = e.target.value;
            setExcerpts((entries) => entries.map((entry, index) => index === i ? text : entry)); setConfirmed(false);
          }} />
        </Field>;
      })}
      {!!preview.history.length && <details className="source-details"><summary>本次携带的对话（{preview.history.length} 条）</summary>
        {preview.history.map((item, index) => <p className="chat-history-item" key={index}><strong>{item.role === 'assistant' ? 'AI ' : '你 '}</strong>{item.text}</p>)}
      </details>}
      {preview.highRisk && <label className="check-line"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />{permission}</label>}
      <label className="check-line"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />不再提示</label>
      <small className="muted">已记住的授权仅用于相同服务和资料范围。候选人资料及其他高风险内容仍需核对，可在 AI 设置中重置。</small>
      <div className="form-actions"><Button onClick={onClose}>取消</Button>
        <Button tone="primary" disabled={preview.highRisk && !confirmed || !question.trim() || onlyRecruiting && excerpts.every((text) => !text.trim())}
          onClick={() => send(question, excerpts, remember)}><Send size={16} />确认并发送</Button></div>
    </div>
  </Modal>;
}

function RenameDialog({ item, onClose, onSave }: { item: ChatConversation; onClose: () => void; onSave: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await chatRpc('rename', { id: item.id, title }); onSave(); onClose(); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <Modal title="重命名对话" busy={busy} onClose={onClose}><form className="form-stack" onSubmit={(e) => void save(e)}>
    <Field label="对话名称"><input value={title} maxLength={120} required onChange={(e) => setTitle(e.target.value)} /></Field>
    {error && <Notice>{error}</Notice>}
    <div className="form-actions"><Button onClick={onClose} disabled={busy}>取消</Button><Button type="submit" tone="primary" busy={busy}>保存名称</Button></div>
  </form></Modal>;
}
