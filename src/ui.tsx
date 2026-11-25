import { useEffect, useState, type ButtonHTMLAttributes, type DependencyList, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { errorText } from './api';

export function useResource<T>(load: () => Promise<T>, dependencies: DependencyList, enabled = true) {
  const [state, setState] = useState<{ data?: T; loading: boolean; error: string }>({ loading: true, error: '' });
  const [revision, retry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setState((previous) => ({ ...previous, loading: true, error: '' }));
    load().then(
      (data) => { if (current) setState({ data, loading: false, error: '' }); },
      (error: unknown) => { if (current) setState({ loading: false, error: errorText(error) }); },
    );
    return () => { current = false; };
  }, [...dependencies, revision, enabled]);
  return { ...state, retry: () => retry((number) => number + 1) };
}

export function useDebounced(value: string, delay = 180) {
  const [result, setResult] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setResult(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return result;
}

export function Button({ tone = 'secondary', busy, className = '', children, disabled, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'quiet' | 'danger'; busy?: boolean }) {
  return <button type="button" {...props} className={'btn btn-' + tone + ' ' + className} disabled={disabled || busy}>
    {busy && <LoaderCircle size={15} className="spinner" />}{children}
  </button>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Empty({ icon, title, description, children }: { icon?: ReactNode; title: string; description?: string; children?: ReactNode }) {
  return <div className="empty-state">{icon && <div className="empty-icon">{icon}</div>}
    <strong>{title}</strong>{description && <p>{description}</p>}{children && <div className="empty-actions">{children}</div>}</div>;
}

export function Loading({ children = '正在读取…' }: { children?: ReactNode }) {
  return <div role="status" className="loading"><LoaderCircle size={17} className="spinner" />{children}</div>;
}

export function Notice({ tone = 'error', children, action }: { tone?: 'error' | 'success' | 'hint'; children: ReactNode; action?: ReactNode }) {
  return <div className={'notice notice-' + tone} role={tone === 'error' ? 'alert' : 'status'}>
    {tone === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
    <div>{children}</div>{action}</div>;
}

export function Modal({ title, description, onClose, children, busy, wide }: {
  title: string; description?: string; onClose: () => void; children: ReactNode; busy?: boolean; wide?: boolean;
}) {
  return <Dialog.Root open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay" />
      <Dialog.Content className={'modal' + (wide ? ' modal-wide' : '')}
        onPointerDownOutside={(event) => event.preventDefault()} {...(description ? {} : { 'aria-describedby': undefined })}>
        <header className="modal-header">
          <div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div>
          <Button aria-label="关闭" tone="quiet" className="icon-btn" onClick={onClose} disabled={busy}><X size={19} /></Button>
        </header>
        <div className="modal-body">{children}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function Confirm({ title, description, label = '确认删除', onClose, onConfirm }: {
  title: string; description: string; label?: string; onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function confirm() {
    setBusy(true);
    try { await onConfirm(); onClose(); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <Modal title={title} description={description} onClose={onClose} busy={busy}>
    {error && <Notice>{error}</Notice>}
    <div className="form-actions"><Button onClick={onClose} disabled={busy}>取消</Button>
      <Button tone="danger" busy={busy} onClick={() => void confirm()}>{label}</Button></div>
  </Modal>;
}

export function PageHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {children && <div className="heading-actions">{children}</div>}</div>;
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={'pill pill-' + tone}>{children}</span>;
}

export function Avatar({ name, id }: { name: string; id: number }) {
  const initials = /[\p{Script=Han}]/u.test(name) ? Array.from(name).slice(-2).join('') :
    name.split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]?.toUpperCase()).join('');
  return <span className={'avatar avatar-' + (id % 4)} aria-hidden="true">{initials || '简'}</span>;
}

const dates = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
const times = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function date(value: number, withTime = false) { return (withTime ? times : dates).format(new Date(value * 1000)); }
export function fileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
export function splitTags(value: string) { return [...new Set(value.split(/[,，;；\r\n]+/).map((item) => item.trim()).filter(Boolean))]; }
