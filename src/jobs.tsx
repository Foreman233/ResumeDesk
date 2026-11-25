import { useEffect, useState } from 'react';
import { ArrowRight, BriefcaseBusiness, Pencil, Plus, Trash2, UserRound, UsersRound } from 'lucide-react';
import { JOB_STATUS, rpc, STAGES, type Application, type Job, type Stage } from './api';
import { ApplicationForm, JobForm, LinkCandidate } from './recruit-forms';
import { CreateTodoDialog } from './todos';
import { Avatar, Button, Confirm, Empty, Loading, Notice, PageHeading, Pill, date, useResource } from './ui';

export function Jobs({ items, loading, error, initialId, initialApplication, revision, onNewJob, refresh,
  report, openCandidate }: {
  items: Job[]; loading: boolean; error: string; initialId?: number; initialApplication?: number; revision: number;
  onNewJob: () => void; refresh: () => void; report: (message: string) => void;
  openCandidate: (id: number) => void;
}) {
  const [selected, setSelected] = useState(initialId);
  const [initialRecord, setInitialRecord] = useState(initialApplication);
  const job = items.find((job) => job.id === selected) ?? items[0];
  return <main className="page scroll-page jobs-page">
    <PageHeading title="岗位管理" description="按岗位维护招聘描述、候选人和申请进度。">
      <Button tone="primary" onClick={onNewJob}><Plus size={16} />新建岗位</Button>
    </PageHeading>
    {error && <Notice>{error}</Notice>}
    {loading && !items.length ? <Loading /> : !job ? <section className="panel"><Empty icon={<BriefcaseBusiness size={28} />}
      title="还没有岗位" description="建立岗位后，可以关联候选人并单独记录招聘阶段。">
      <Button tone="primary" onClick={onNewJob}><Plus size={16} />创建第一个岗位</Button></Empty></section> :
      <div className="jobs-grid">
        <section className="panel job-index" aria-label="岗位列表">
          <div className="list-count">{items.length} 个岗位</div>
          {items.map((item) => <button className={'job-row' + (item.id === job.id ? ' selected' : '')} type="button" key={item.id}
            onClick={() => { setSelected(item.id); setInitialRecord(undefined); }} aria-pressed={item.id === job.id}>
            <span className="job-icon"><BriefcaseBusiness size={17} /></span>
            <span className="job-row-copy"><strong>{item.title}</strong><small>{item.department || '未设置部门'} · {item.applicationCount} 位</small></span>
            <Pill tone={item.status === 'open' ? 'green' : item.status === 'paused' ? 'amber' : 'neutral'}>{JOB_STATUS[item.status]}</Pill>
          </button>)}
        </section>
        <JobPane key={job.id} job={job} initialApplication={job.id === initialId ? initialRecord : undefined}
          revision={revision} refresh={refresh} report={report} openCandidate={openCandidate}
          consumeInitial={() => setInitialRecord(undefined)} />
      </div>}
  </main>;
}

function JobPane({ job, initialApplication, revision, refresh, report, openCandidate, consumeInitial }: {
  job: Job; initialApplication?: number; revision: number; refresh: () => void; report: (message: string) => void;
  openCandidate: (id: number) => void; consumeInitial: () => void;
}) {
  const applications = useResource(() => rpc('applications', { jobId: job.id }), [job.id, revision]);
  const [stage, setStage] = useState<Stage>();
  const [modal, setModal] = useState<'edit' | 'link' | 'remove' | 'todo'>();
  const [editing, setEditing] = useState<number>();
  const people = applications.data ?? [];
  useEffect(() => {
    if (initialApplication && applications.data?.some((item) => item.id === initialApplication)) {
      setEditing(initialApplication); consumeInitial();
    }
  }, [initialApplication, applications.data, consumeInitial]);
  const selected = people.find((item) => item.id === editing);
  const filtered = stage ? people.filter((item) => item.stage === stage) : people;
  return <div className="job-pane">
    <section className="panel job-overview">
      <div className="job-detail-head">
        <span className="job-icon"><BriefcaseBusiness size={22} /></span>
        <div><h2>{job.title}</h2><span>{job.department || '未设置部门'}</span></div>
        <Pill tone={job.status === 'open' ? 'green' : 'neutral'}>{JOB_STATUS[job.status]}</Pill>
        <div className="inline-actions ml-auto">
          <Button onClick={() => setModal('todo')}><Plus size={15} />新建待办</Button>
          <Button onClick={() => setModal('edit')}><Pencil size={15} />编辑岗位</Button>
        </div>
      </div>
      <div className="job-description"><h3>岗位描述（JD）</h3>
        {job.jd ? <p>{job.jd}</p> : <span className="muted">还未填写岗位描述。</span>}</div>
    </section>
    <section className="panel">
      <div className="panel-head"><div><h2>岗位申请</h2><p>在这个岗位中更新候选人的招聘阶段和备注。</p></div>
        <Button onClick={() => setModal('link')}><Plus size={16} />关联候选人</Button></div>
      <div className="pipeline" aria-label="按阶段查看申请">
        <button type="button" aria-pressed={!stage} onClick={() => setStage(undefined)}>所有阶段 <strong>{people.length}</strong></button>
        {Object.entries(STAGES).map(([key, title]) => <button type="button" key={key} aria-pressed={stage === key}
          onClick={() => setStage(stage === key ? undefined : key as Stage)}>{title} <strong>{people.filter((item) => item.stage === key).length}</strong></button>)}
      </div>
      {applications.error ? <Notice action={<Button tone="quiet" onClick={applications.retry}>重试</Button>}>{applications.error}</Notice>
        : applications.loading && !applications.data ? <Loading /> :
          filtered.length ? <div className="application-table">{filtered.map((item) => <ApplicationRow key={item.id} item={item}
            openCandidate={() => openCandidate(item.candidateId)} onEdit={() => setEditing(item.id)} />)}</div>
            : <Empty icon={stage ? <UserRound size={24} /> : <UsersRound size={24} />} title={stage ? '此阶段暂无申请' : '此岗位还没有候选人'} />}
    </section>
    <Button tone="quiet" className="text-error self-start" onClick={() => setModal('remove')}><Trash2 size={15} />删除岗位</Button>
    {modal === 'edit' && <JobForm initial={job} onClose={() => setModal(undefined)} onSaved={() => { refresh(); report('岗位已保存'); }} />}
    {modal === 'todo' && <CreateTodoDialog jobs={[job]} initial={{
      title: '跟进岗位 · ' + job.title, category: 'follow_up', priority: 'normal', jobId: job.id, jobTitle: job.title,
    }} onClose={() => setModal(undefined)} onSaved={() => { refresh(); report('待办已保存'); }} />}
    {modal === 'link' && <LinkCandidate jobId={job.id} excluded={people.map((item) => item.candidateId)} onClose={() => setModal(undefined)}
      onSaved={() => { refresh(); report('候选人已关联'); }} />}
    {modal === 'remove' && <Confirm title={'删除 ' + job.title + '？'} description="删除此岗位、它的申请和岗位专属资料。"
      onClose={() => setModal(undefined)} onConfirm={async () => {
        const cleaned = await rpc('delete_job', { id: job.id }); refresh();
        report(cleaned ? '岗位已删除' : '岗位已删除，应用将在下次启动时清理尚被占用的附件。');
      }} />}
    {selected && <ApplicationForm key={selected.id} item={selected} onClose={() => setEditing(undefined)}
      onSaved={() => { refresh(); report('申请记录已更新'); }} onTodoSaved={() => { refresh(); report('待办已保存'); }} />}
  </div>;
}

function ApplicationRow({ item, openCandidate, onEdit }: { item: Application; openCandidate: () => void; onEdit: () => void }) {
  const tone = item.stage === 'hired' ? 'green' : item.stage === 'rejected' || item.stage === 'withdrawn' ? 'neutral' : 'indigo';
  return <div className="application-row">
    <button type="button" className="person-link" onClick={openCandidate}><Avatar name={item.candidateName} id={item.candidateId} /><strong>{item.candidateName}</strong></button>
    <Pill tone={tone}>{STAGES[item.stage]}</Pill><span className="muted application-date">{date(item.updatedAt)}</span>
    <Button tone="quiet" onClick={onEdit}>编辑申请<ArrowRight size={14} /></Button>
  </div>;
}
