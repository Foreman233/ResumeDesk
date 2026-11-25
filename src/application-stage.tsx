import { useEffect, useState } from 'react';
import { errorText, rpc, STAGES, type ApplicationState, type Stage } from './api';

export function ApplicationStageControl({ applications, label, refresh, report, onSelect }: {
  applications: ApplicationState[]; label: string; refresh: () => void;
  report: (message: string, error?: boolean) => void;
  onSelect?: (id: number | undefined) => void;
}) {
  const [chosen, setChosen] = useState<number>();
  const [optimistic, setOptimistic] = useState<{ previous: ApplicationState; stage: Stage }>();
  const [busy, setBusy] = useState(false);
  const active = applications.length === 1 ? applications[0] : applications.find((item) => item.id === chosen);

  useEffect(() => {
    if (optimistic && optimistic.previous !== active) setOptimistic(undefined);
  }, [active, optimistic]);

  async function update(stage: Stage) {
    if (!active || active.stage === stage || busy) return;
    setOptimistic({ previous: active, stage }); setBusy(true);
    try {
      await rpc('set_application_stage', { id: active.id, stage });
      refresh(); report(active.jobTitle + ' · ' + STAGES[stage]);
    } catch (e) {
      setOptimistic(undefined); refresh(); report(errorText(e), true);
    } finally { setBusy(false); }
  }

  if (!applications.length) return <small className="muted">未关联岗位</small>;
  return <div className="stage-control" aria-busy={busy}>
    {applications.length > 1 && <select aria-label={label + ' · 选择申请岗位'} title="选择要更新的岗位申请"
      disabled={busy} value={active?.id ?? ''} onChange={(event) => {
        const id = Number(event.target.value) || undefined;
        setChosen(id); onSelect?.(id);
      }}>
      <option value="">选择岗位</option>
      {applications.map((item) => <option key={item.id} value={item.id}>{item.jobTitle} · {STAGES[item.stage]}</option>)}
    </select>}
    {active && <select aria-label={label + ' · 招聘状态'} title={active.jobTitle + ' · 修改招聘状态'}
      value={optimistic?.previous === active ? optimistic.stage : active.stage} disabled={busy}
      onChange={(event) => void update(event.target.value as Stage)}>
      {Object.entries(STAGES).map(([stage, text]) => <option key={stage} value={stage}>{text}</option>)}
    </select>}
  </div>;
}
