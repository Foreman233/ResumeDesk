import { useEffect, useState } from 'react';
import { Archive, Database, Download, Globe, KeyRound, LockKeyhole, ShieldCheck, SlidersHorizontal, Upload } from 'lucide-react';
import { QuickControlsPanel, type QuickState } from './quick';
import {
  AI_SCOPES, cancelAI, errorText, manageBackup, rpc, testAI, type AIStatus, type ConsentCapability, type Filter, type Privacy, type WebSearchSettings,
} from './api';
import { Button, Confirm, Field, Loading, Modal, Notice, PageHeading, Pill, date, useResource } from './ui';

export type SettingsSection = 'ai' | 'data' | 'quick';
export type AiSection = 'model' | 'consent' | 'search';

export function SettingsPage({ initialSection, initialAiSection, revision, refresh, restored, report, library, quick }: {
  initialSection?: SettingsSection; initialAiSection?: AiSection; revision: number; refresh: () => void; restored: () => void;
  report: (text: string, error?: boolean) => void; library: (filter: Filter) => void; quick: QuickState;
}) {
  const [section, setSection] = useState(initialSection ?? 'data');
  const [aiSection, setAiSection] = useState<AiSection>(initialAiSection ?? 'model');
  const settings = useResource(() => rpc('settings'), [revision]);
  const data = settings.data;
  return <main className="page scroll-page settings-page">
    <PageHeading title="设置" description="管理本机资料和可选 AI 服务。" />
    <div className="tabs settings-tabs" role="tablist" aria-label="设置分类">
      <button role="tab" aria-selected={section === 'data'} onClick={() => setSection('data')}><Database size={16} />本地数据</button>
      <button role="tab" aria-selected={section === 'ai'} onClick={() => setSection('ai')}><KeyRound size={16} />AI 服务</button>
      <button role="tab" aria-selected={section === 'quick'} onClick={() => setSection('quick')}><SlidersHorizontal size={16} />快捷控制</button>
    </div>
    {settings.error && <Notice action={<Button onClick={settings.retry} tone="quiet">重试</Button>}>{settings.error}</Notice>}
    {section === 'quick' ? <QuickControlsPanel state={quick} full /> :
      !data ? settings.loading && <Loading /> :
        section === 'ai' ? <>
          <div className="tabs ai-subtabs" role="tablist" aria-label="AI 服务设置">
            <button role="tab" aria-selected={aiSection === 'model'} onClick={() => setAiSection('model')}><KeyRound size={15} />模型连接</button>
            <button role="tab" aria-selected={aiSection === 'consent'} onClick={() => setAiSection('consent')}><ShieldCheck size={15} />隐私与授权</button>
            <button role="tab" aria-selected={aiSection === 'search'} onClick={() => setAiSection('search')}><Globe size={15} />联网搜索</button>
          </div>
          {aiSection === 'model' ? <AIForm initial={data.ai} refresh={refresh} report={report} aiEnabled={quick.data?.settings.aiEnabled ?? true} />
            : aiSection === 'consent' ? <ConsentPanel revision={revision} report={report} alwaysConfirm={quick.data?.settings.confirmAiSend ?? true} />
              : <SearchSettings revision={revision} refresh={refresh} report={report} />}
        </> :
          <DataSettings path={data.dataPath} initial={data.privacy} refresh={refresh} report={report} restored={restored} library={library} />}
  </main>;
}

function AIForm({ initial, refresh, report, aiEnabled }: { initial: AIStatus; refresh: () => void; report: (text: string) => void; aiEnabled: boolean }) {
  const [status, setStatus] = useState(initial);
  const [value, setValue] = useState(initial.settings);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [testId, setTestId] = useState<string>();
  const [remove, setRemove] = useState(false);
  useEffect(() => { setStatus(initial); }, [initial]);
  const changed = JSON.stringify(value) !== JSON.stringify(status.settings) || !!key.trim();
  async function save(removeKey = false) {
    setBusy('save'); setError('');
    try {
      const updated = await rpc('save_ai', { input: { settings: value, apiKey: key || undefined, removeKey } });
      setStatus(updated); setValue(updated.settings); setKey(''); refresh();
      report(removeKey ? 'API Key 已移除' : 'AI 配置已保存');
    } catch (e) { setError(errorText(e)); if (removeKey) throw e; }
    finally { setBusy(''); }
  }
  async function test() {
    const id = crypto.randomUUID();
    setTestId(id); setBusy('test'); setError('');
    try { setStatus(await testAI(id)); refresh(); report('AI 连接测试成功'); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(''); setTestId(undefined); }
  }
  return <section className="panel settings-panel">
    <div className="panel-head"><div><h2>OpenAI 兼容服务</h2><p>用于 HR AI 助手。</p></div>
      <Pill tone={status.verified ? 'green' : 'neutral'}>{status.verified ? '连接已验证' : status.hasKey ? '等待测试' : '未配置'}</Pill></div>
    <form className="panel-body form-stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="API Base URL" hint="填写服务商给出的地址，例如 https://service.example/v1。"><input value={value.baseUrl}
        maxLength={600} placeholder="https://service.example/v1" onChange={(e) => setValue({ ...value, baseUrl: e.target.value })} /></Field>
      <div className="form-grid">
        <Field label="模型名称"><input value={value.model} maxLength={180} placeholder="填写服务商提供的模型标识"
          onChange={(e) => setValue({ ...value, model: e.target.value })} /></Field>
        <Field label="超时（秒）" hint="可设 5 至 600 秒，默认为 120 秒。">
          <input type="number" value={value.timeoutSeconds || ''} min={5} max={600} step={1} required
            onChange={(e) => setValue({ ...value, timeoutSeconds: Number(e.target.value) })} /></Field>
      </div>
      <Field label="API Key" hint="使用当前 Windows 账户的 DPAPI 加密保存。更换服务地址后请重新输入。">
        <input type="password" value={key} maxLength={2048} autoComplete="off" spellCheck={false}
          placeholder={status.hasKey ? '已保存，留空保留' : '输入服务商的 API Key'} onChange={(e) => setKey(e.target.value)} /></Field>
      {status.credentialError && <Notice tone="hint">无法读取之前的 Windows 凭据，请重新输入并保存。</Notice>}
      {!aiEnabled && <Notice tone="hint">AI 功能已关闭。可在快捷控制中重新启用后测试连接。</Notice>}
      {error && <Notice>{error}</Notice>}
      {status.verified && <small className="muted">连接测试会发送一条简短探测消息。</small>}
      <div className="settings-actions wrap">
        <Button type="submit" tone="primary" busy={busy === 'save'} disabled={!!busy || !changed}>保存 AI 配置</Button>
        {testId ? <Button onClick={() => void cancelAI(testId).catch((e: unknown) => setError(errorText(e)))}>取消测试</Button> :
          <Button disabled={!aiEnabled || !!busy || changed || !status.hasKey || !value.model.trim()} onClick={() => void test()}>测试连接</Button>}
        {busy === 'test' && <Loading>正在测试连接…</Loading>}
        {(status.hasKey || status.credentialError) && <Button tone="quiet" className="text-error" disabled={!!busy || changed}
          onClick={() => setRemove(true)}>移除 API Key</Button>}
      </div>
    </form>
    {remove && <Confirm title="移除 API Key？" description="清除存储的凭据。需要重新填写并测试后才可使用 AI。" label="移除凭据"
      onClose={() => setRemove(false)} onConfirm={() => save(true)} />}
  </section>;
}

function ConsentPanel({ revision, report, alwaysConfirm }: {
  revision: number; report: (message: string, error?: boolean) => void; alwaysConfirm: boolean;
}) {
  const prefs = useResource(() => rpc('ai_consents'), [revision]);
  const [changing, setChanging] = useState<ConsentCapability | 'all'>();
  const [error, setError] = useState('');
  async function reset(scope?: ConsentCapability) {
    setChanging(scope ?? 'all'); setError('');
    try {
      await rpc('reset_ai_consents', { capability: scope });
      prefs.retry(); report('已清除记住的授权。下次发送前将重新确认。');
    } catch (e) { setError(errorText(e)); }
    finally { setChanging(undefined); }
  }
  return <section className="panel settings-panel">
    <div className="panel-head"><div><h2>隐私与授权</h2><p>查看各类外发授权，或恢复发送前弹窗。</p></div><ShieldCheck size={20} className="muted" /></div>
    <div className="panel-body form-stack">
      {prefs.loading && !prefs.data && <Loading />}
      {(error || prefs.error) && <Notice>{error || prefs.error}</Notice>}
      {prefs.data && <>
        <div className="outbound-target"><strong>模型服务</strong><span>{prefs.data.modelProvider ?? '尚未配置'}</span>
          <strong>搜索服务</strong><span>{prefs.data.searchProvider ?? '尚未配置'}</span>
          <strong>确认方式</strong><span>{alwaysConfirm ? '逐次确认' : '按已授权范围确认'}</span></div>
        {(Object.entries(AI_SCOPES) as [ConsentCapability, string][]).map(([scope, label]) => {
          const rows = prefs.data!.remembered.filter((entry) => entry.capability === scope);
          return <section key={scope} className="consent-scope" aria-label={label}>
            <div className="subheading wrap"><div className="wrap"><h3>{label}</h3>
              <Pill tone={rows.length ? 'green' : 'neutral'}>{rows.length ? '已记住 ' + rows.length + ' 项' : '等待确认'}</Pill>
              </div><Button tone="quiet" disabled={!rows.length || !!changing} busy={changing === scope}
                onClick={() => void reset(scope)}>重新启用确认弹窗</Button></div>
            {!!rows.length && <ul>{rows.map((grant) => <li key={grant.provider + grant.scopeKey}>
              <strong>{grant.description}</strong><small>{grant.provider} · {date(grant.grantedAt, true)}</small></li>)}</ul>}
          </section>;
        })}
        <small className="muted">候选人或其他高风险数据仍需逐次核对。重置授权会保留聊天记录和 API 配置。</small>
        <div><Button disabled={!!changing || !prefs.data.remembered.length} busy={changing === 'all'} onClick={() => void reset()}>重置所有 AI 授权</Button></div>
      </>}
    </div>
  </section>;
}

function SearchSettings({ revision, refresh, report }: { revision: number; refresh: () => void; report: (message: string) => void }) {
  const settings = useResource(() => rpc('web_search_settings'), [revision]);
  if (!settings.data) return settings.error ? <Notice>{settings.error}</Notice> : <Loading />;
  return <SearchSettingsForm initial={settings.data} refresh={refresh} report={report} />;
}

function SearchSettingsForm({ initial, refresh, report }: { initial: WebSearchSettings; refresh: () => void; report: (message: string) => void }) {
  const [status, setStatus] = useState(initial);
  const [endpoint, setEndpoint] = useState(initial.endpoint ?? initial.defaultEndpoint);
  const [timeoutSeconds, setTimeoutSeconds] = useState(initial.timeoutSeconds);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState(false);
  const [error, setError] = useState('');
  const changed = endpoint !== (status.endpoint ?? status.defaultEndpoint) || timeoutSeconds !== status.timeoutSeconds || !!key.trim();

  async function save(removeKey = false) {
    setBusy(true); setError('');
    try {
      const next = await rpc('save_web_search', { input: { endpoint, timeoutSeconds, apiKey: key || undefined, removeKey } });
      setStatus(next); setEndpoint(next.endpoint ?? next.defaultEndpoint); setTimeoutSeconds(next.timeoutSeconds); setKey('');
      refresh(); report(removeKey ? '搜索凭据已移除' : '联网搜索配置已保存');
    } catch (e) {
      setError(errorText(e));
      if (removeKey) throw e;
    } finally { setBusy(false); }
  }
  return <section className="panel settings-panel">
    <div className="panel-head"><div><h2>联网搜索服务</h2><p>配置 Brave Web Search 或使用相同协议的搜索端点。</p></div>
      <Pill tone={status.hasKey ? 'green' : 'neutral'}>{status.hasKey ? '已保存配置' : '未配置'}</Pill></div>
    <form className="panel-body form-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Field label="搜索 API 端点" hint="默认使用 Brave Web Search。搜索服务和模型服务使用独立凭据。">
        <input value={endpoint} placeholder={status.defaultEndpoint} maxLength={600} onChange={(event) => setEndpoint(event.target.value)} />
      </Field>
      <Field label="搜索 API Key" hint="使用 Windows DPAPI 加密。保留原凭据时留空。">
        <input type="password" value={key} maxLength={2048} autoComplete="off" spellCheck={false}
          placeholder={status.hasKey ? '已保存，留空保留' : '填写搜索服务的密钥'} onChange={(event) => setKey(event.target.value)} />
      </Field>
      <Field label="搜索超时（秒）"><input type="number" value={timeoutSeconds || ''} min={5} max={60} required
        onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></Field>
      {status.credentialError && <Notice tone="hint">无法读取搜索凭据，请重新输入密钥。</Notice>}
      {error && <Notice>{error}</Notice>}
      <div className="wrap"><Button type="submit" tone="primary" busy={busy} disabled={!changed}>保存搜索配置</Button>
        {(status.hasKey || status.credentialError) && <Button tone="quiet" className="text-error" disabled={busy || changed}
          onClick={() => setRemove(true)}>移除搜索 API Key</Button>}</div>
    </form>
    {remove && <Confirm title="移除搜索 API Key？" description="下次联网检索前需重新配置搜索凭据。" label="移除搜索凭据"
      onClose={() => setRemove(false)} onConfirm={() => save(true)} />}
  </section>;
}

function DataSettings({ path, initial, refresh, report, restored, library }: {
  path: string; initial: Privacy; refresh: () => void; report: (text: string) => void; restored: () => void; library: (filter: Filter) => void;
}) {
  const [value, setValue] = useState(initial);
  const [operation, setOperation] = useState<'export' | 'restore'>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const summary = useResource(() => rpc('dashboard'), [initial.retentionDays]);
  async function save() {
    setBusy(true); setError('');
    try { await rpc('save_privacy', { privacy: value }); refresh(); report('数据设置已保存'); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <div className="settings-grid">
    <section className="panel settings-panel">
      <div className="panel-head"><div><h2>数据目录与备份</h2><p>数据库和原件保存在本机。</p></div><LockKeyhole size={20} className="muted" /></div>
      <div className="panel-body form-stack">
        <Field label="本地数据目录"><input value={path} readOnly aria-label="本地数据目录" /></Field>
        <div className="backup-card"><span className="backup-icon"><Archive size={22} /></span><div><h3>加密备份</h3>
          <p>导出数据库及原件。恢复时需要备份口令，API Key 始终留在 Windows 凭据中。</p></div></div>
        <div className="wrap"><Button tone="primary" onClick={() => setOperation('export')}><Download size={16} />创建备份</Button>
          <Button onClick={() => setOperation('restore')}><Upload size={16} />恢复备份</Button></div>
      </div>
    </section>
    <section className="panel settings-panel">
      <div className="panel-head"><div><h2>数据保留与发送确认</h2><p>设定清理提醒和 AI 发送预览偏好。</p></div><ShieldCheck size={20} className="muted" /></div>
      <form className="panel-body form-stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="候选人保留期限（天）" hint="根据档案最后更新时间提示清理，设为 0 则不提示。">
          <input type="number" min={0} max={3650} required value={value.retentionDays}
            onChange={(e) => setValue({ ...value, retentionDays: Number(e.target.value) })} /></Field>
        {!!summary.data?.stale && <Notice tone="hint" action={<Button tone="quiet" onClick={() => library({ stale: true })}>查看</Button>}>
          {summary.data.stale} 位候选人超过保留期限</Notice>}
        <label className="check-line"><input type="checkbox" checked={value.redactByDefault}
          onChange={(e) => setValue({ ...value, redactByDefault: e.target.checked })} />发送预览默认尝试脱敏</label>
        {error && <Notice>{error}</Notice>}
        <div><Button type="submit" tone="primary" busy={busy} disabled={JSON.stringify(value) === JSON.stringify(initial)}>保存数据设置</Button></div>
      </form>
    </section>
    {operation && <BackupDialog restore={operation === 'restore'} onClose={() => setOperation(undefined)}
      onDone={(message) => { report(message); if (operation === 'restore') restored(); }} />}
  </div>;
}

function BackupDialog({ restore, onClose, onDone }: { restore: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run() {
    setError('');
    if (!restore && password !== confirmPassword) { setError('两次输入的口令不一致。'); return; }
    setBusy(true);
    try {
      const result = await manageBackup(restore, password, consent);
      if (result) {
        setPassword(''); setConfirmPassword('');
        onClose();
        onDone((restore ? '资料库已恢复' : '加密备份已保存') + '，包含 ' + result.attachments + ' 份原件。' +
          (result.cleanupPending ? '上一份资料库文件仍被占用，将在下次启动时清理。' : ''));
      }
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <Modal title={restore ? '恢复加密备份' : '创建加密备份'} onClose={onClose} busy={busy}
    description={restore ? '校验成功后，备份中的数据将替换当前资料库。' : '为备份设置独立口令，恢复时需要此口令。'}>
    <form className="form-stack" onSubmit={(e) => { e.preventDefault(); void run(); }}>
      <Field label="备份口令"><input required minLength={10} maxLength={200} type="password" autoComplete="off" value={password}
        onChange={(e) => setPassword(e.target.value)} /></Field>
      {!restore ? <Field label="再次输入口令"><input required type="password" autoComplete="off" value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)} /></Field> :
        <label className="check-line"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          我确认用备份替换当前资料库。</label>}
      {error && <Notice>{error}</Notice>}
      <div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" tone="primary" busy={busy} disabled={restore && !consent}>{restore ? '选择备份并恢复' : '选择保存位置'}</Button></div>
    </form>
  </Modal>;
}
