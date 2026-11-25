import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, GripVertical, RefreshCw, Trash2 } from 'lucide-react';
import { errorText } from './api';
import { CATEGORIES, LEVELS, SOURCES, type Category, type GuideInput, type InterviewQuestion, type Level } from './interview-api';
import { type ExportFormat, exportInterview } from './interview-export';
import { Button, Field, Modal, Notice, Pill } from './ui';

export type QuestionRow = { key: string; value: InterviewQuestion };
export const questionRow = (value: InterviewQuestion): QuestionRow => ({ key: crypto.randomUUID(), value });

export function QuestionList({ rows, readOnly, canGenerate, edited, remove, reorder, regenerate }: {
  rows: QuestionRow[]; readOnly: boolean; canGenerate: boolean;
  edited: (key: string, patch: Partial<InterviewQuestion>) => void;
  remove: (key: string) => void; reorder: (key: string, to: number) => void;
  regenerate: (key: string) => void;
}) {
  const dragged = useRef<string | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<string>();
  return <ol className="interview-questions" aria-label="面试问题">
    {rows.map(({ key, value: item }, index) => <li className={'panel interview-question' + (dropTarget === key ? ' interview-drop-target' : '')} key={key}
      onDragOver={(event) => {
        if (!readOnly && dragged.current && dragged.current !== key) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(key); }
      }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined); }}
      onDrop={(event) => {
        if (!dragged.current || readOnly) return;
        event.preventDefault(); reorder(dragged.current, index); dragged.current = undefined; setDropTarget(undefined);
      }}>
      <div className="interview-question-head wrap">
        <div className="wrap grow"><span draggable={!readOnly} className="interview-grip" title="拖动调整题目顺序"
          onDragStart={(event) => { dragged.current = key; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'ResumeDesk interview question'); }}
          onDragEnd={() => { dragged.current = undefined; setDropTarget(undefined); }}><GripVertical size={17} /></span>
          <strong>第 {index + 1} 题</strong><Pill tone="indigo">{SOURCES[item.source.kind]}</Pill></div>
        <div className="wrap">
          <Button tone="quiet" className="icon-btn" title="上移" aria-label={'上移第 ' + (index + 1) + ' 题'} disabled={readOnly || index === 0} onClick={() => reorder(key, index - 1)}><ArrowUp size={15} /></Button>
          <Button tone="quiet" className="icon-btn" title="下移" aria-label={'下移第 ' + (index + 1) + ' 题'} disabled={readOnly || index === rows.length - 1} onClick={() => reorder(key, index + 1)}><ArrowDown size={15} /></Button>
          <Button tone="quiet" className="icon-btn" title="重新生成此题" aria-label={'重新生成第 ' + (index + 1) + ' 题'} disabled={readOnly || !canGenerate} onClick={() => regenerate(key)}><RefreshCw size={15} /></Button>
          <Button tone="quiet" className="icon-btn" title="删除此题" aria-label={'删除第 ' + (index + 1) + ' 题'} disabled={readOnly} onClick={() => remove(key)}><Trash2 size={15} /></Button>
        </div>
      </div>
      <fieldset disabled={readOnly} className="interview-fieldset form-stack">
        <div className="interview-pair">
          <Field label="问题类别"><select value={item.category} onChange={(ev) => edited(key, { category: ev.target.value as Category })}>
            {Object.entries(CATEGORIES).map(([id, title]) => <option value={id} key={id}>{title}</option>)}
          </select></Field>
          <Field label="问题难度"><select value={item.difficulty} onChange={(ev) => edited(key, { difficulty: ev.target.value as Level })}>
            {Object.entries(LEVELS).map(([id, title]) => <option value={id} key={id}>{title}</option>)}
          </select></Field>
        </div>
        <Field label={'面试问题 ' + (index + 1)}><textarea rows={3} value={item.question} maxLength={1600} placeholder="输入要问候选人的问题"
          onChange={(ev) => edited(key, { question: ev.target.value })} /></Field>
        {!!item.source.evidence && <blockquote className="interview-evidence">{item.source.evidence}</blockquote>}
        <details className="interview-question-details">
          <summary>考察能力、追问和参考思路</summary>
          <div className="form-stack">
            <Field label="考察能力"><input value={item.competency} maxLength={420} onChange={(ev) => edited(key, { competency: ev.target.value })} /></Field>
            <Field label="考察要点"><textarea rows={2} value={item.evaluationPoints} maxLength={1200} onChange={(ev) => edited(key, { evaluationPoints: ev.target.value })} /></Field>
            <Field label="追问"><textarea rows={2} value={item.followUp} maxLength={1000} onChange={(ev) => edited(key, { followUp: ev.target.value })} /></Field>
            <Field label="参考回答思路"><textarea rows={2} value={item.referenceAnswer} maxLength={1600} onChange={(ev) => edited(key, { referenceAnswer: ev.target.value })} /></Field>
          </div>
        </details>
        <details className="interview-question-details">
          <summary>面试记录{item.answerSummary || item.interviewerNotes || item.verification ? ' · 已填写' : ''}</summary>
          <div className="form-stack">
            <Field label="回答摘要"><textarea rows={2} value={item.answerSummary} maxLength={3600} onChange={(ev) => edited(key, { answerSummary: ev.target.value })} /></Field>
            <Field label="面试官备注"><textarea rows={2} value={item.interviewerNotes} maxLength={2400} onChange={(ev) => edited(key, { interviewerNotes: ev.target.value })} /></Field>
            <Field label="待核实事项"><textarea rows={2} value={item.verification} maxLength={2000} onChange={(ev) => edited(key, { verification: ev.target.value })} /></Field>
          </div>
        </details>
      </fieldset>
    </li>)}
  </ol>;
}

export function InterviewExportDialog({ input, candidateName, close, report }: {
  input: GuideInput; candidateName?: string; close: () => void; report: (message: string, error?: boolean) => void;
}) {
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [detailed, setDetailed] = useState(true);
  const [showCandidate, setShowCandidate] = useState(false);
  const [showDate, setShowDate] = useState(!!input.interviewDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true); setError('');
    try {
      const name = await exportInterview(input, { format, detailed, showCandidate, showDate, candidateName });
      if (name) { report('已导出 ' + name); close(); }
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }
  return <Modal title="导出面试提纲" onClose={close} busy={busy}>
    <div className="form-stack">
      {error && <Notice>{error}</Notice>}
      <div className="interview-pair">
        <Field label="文件格式"><select value={format} disabled={busy} onChange={(ev) => setFormat(ev.target.value as ExportFormat)}>
          <option value="pdf">PDF</option><option value="docx">Word（DOCX）</option><option value="txt">纯文本（TXT）</option>
        </select></Field>
        <Field label="导出模式"><select value={detailed ? 'detailed' : 'simple'} disabled={busy} onChange={(ev) => setDetailed(ev.target.value === 'detailed')}>
          <option value="detailed">面试官详细版</option><option value="simple">简洁面试版</option>
        </select></Field>
      </div>
      {candidateName && <label className="interview-check"><input type="checkbox" checked={showCandidate} disabled={busy} onChange={(ev) => setShowCandidate(ev.target.checked)} />显示候选人姓名</label>}
      {input.interviewDate && <label className="interview-check"><input type="checkbox" checked={showDate} disabled={busy} onChange={(ev) => setShowDate(ev.target.checked)} />显示面试日期</label>}
      <div className="form-actions"><Button disabled={busy} onClick={close}>取消</Button><Button tone="primary" busy={busy} onClick={() => void save()}><Download size={15} />保存文件</Button></div>
    </div>
  </Modal>;
}
