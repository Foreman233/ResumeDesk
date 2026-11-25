import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { errorText } from './api';
import { showTodoWindow } from './todo-api';
import { Button, Loading, Notice, Pill, useResource } from './ui';

export interface QuickPrefs {
  aiEnabled: boolean; confirmAiSend: boolean;
  desktopNotifications: boolean; interviewReminders: boolean; todoVisible: boolean; alwaysOnTop: boolean; keepInTray: boolean;
}
type QuickSnapshot = {
  settings: QuickPrefs; aiHealth: 'disabled' | 'error' | 'missing' | 'tested' | 'untested';
  widgetVisible: boolean; trayAvailable: boolean; notificationFailed: boolean;
};
type Change = { [K in keyof Omit<QuickPrefs, 'todoVisible' | 'alwaysOnTop'>]: { key: K; value: QuickPrefs[K] } }[keyof Omit<QuickPrefs, 'todoVisible' | 'alwaysOnTop'>];

export function useQuickState(revision = 0) {
  const resource = useResource(() => invoke<QuickSnapshot>('get_quick_controls'), [revision]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    let active = true;
    const subscription = listen('resumedesk-quick-changed', () => { if (active) resource.retry(); });
    return () => { active = false; void subscription.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setFailure('');
    try { await action(); }
    catch (e) { setFailure(errorText(e)); }
    finally { resource.retry(); setBusy(false); }
  };
  return {
    ...resource, busy, failure,
    update: (change: Change) => void run(() => invoke('set_quick_control', { change })),
    setWidget: (visible: boolean) => void run(() => showTodoWindow(visible)),
  };
}

export type QuickState = ReturnType<typeof useQuickState>;
const healthLabels = {
  disabled: '已关闭', error: '上次请求异常', missing: '未配置', tested: '已验证连接', untested: '待测试连接',
};

function Switch({ label, value, disabled, onChange }: {
  label: string; value: boolean; disabled: boolean; onChange: (value: boolean) => void;
}) {
  return <button type="button" className="quick-switch" role="switch" aria-checked={value} aria-label={label} disabled={disabled}
    onClick={() => onChange(!value)}><span>{label}</span><span className="switch-track" aria-hidden="true"><span /></span></button>;
}

export function QuickControlsPanel({ state, openSettings, full = false }: { state: QuickState; openSettings?: () => void; full?: boolean }) {
  const { data, error, failure, loading, busy, update, setWidget } = state;
  const prefs = data?.settings;
  return <details className="panel quick-controls" open>
    <summary><SlidersHorizontal size={18} /><h2>{full ? '工作区与桌面' : '快捷控制中心'}</h2>
      {data && <span className="quick-statuses"><Pill tone={data.aiHealth === 'error' ? 'amber' : 'neutral'}>AI {healthLabels[data.aiHealth]}</Pill>
        <Pill>提醒 {prefs?.interviewReminders ? (prefs.desktopNotifications ? '已启用' : '仅应用内') : '已关闭'}</Pill>
        <Pill>待办 {data.widgetVisible ? '显示中' : '已隐藏'}</Pill></span>}
      <ChevronDown size={17} className="quick-chevron" /></summary>
    {(error || failure) && <Notice>{failure || error}</Notice>}
    {loading && !data && <Loading />}
    {prefs && <div className="quick-body">
      <div className="quick-options">
        <Switch label="AI 功能" value={prefs.aiEnabled} disabled={busy} onChange={(value) => update({ key: 'aiEnabled', value })} />
        <Switch label="AI 发送前始终确认" value={prefs.confirmAiSend} disabled={busy} onChange={(value) => update({ key: 'confirmAiSend', value })} />
        <Switch label="桌面通知" value={prefs.desktopNotifications} disabled={busy} onChange={(value) => update({ key: 'desktopNotifications', value })} />
        <Switch label="面试提醒" value={prefs.interviewReminders} disabled={busy} onChange={(value) => update({ key: 'interviewReminders', value })} />
        <Switch label="待办悬浮窗" value={data.widgetVisible} disabled={busy} onChange={setWidget} />
        {full && <Switch label="关闭主窗口后在托盘运行" value={prefs.keepInTray} disabled={busy || !data.trayAvailable}
          onChange={(value) => update({ key: 'keepInTray', value })} />}
      </div>
      <div className="quick-foot">
        <small>{full ? '开启逐次确认会清除已记住的授权。提醒仅在应用运行时检查。' : '新授权范围和候选人资料仍需人工确认。'}</small>
        {!full && openSettings && <Button tone="quiet" onClick={openSettings}>完整设置</Button>}
      </div>
      {full && !data.trayAvailable && <Notice tone="hint">当前环境的系统托盘不可用。关闭主窗口会退出。</Notice>}
      {data.notificationFailed && <Notice tone="hint">Windows 通知未成功发送。请通过待办查看到期事项。</Notice>}
    </div>}
  </details>;
}
