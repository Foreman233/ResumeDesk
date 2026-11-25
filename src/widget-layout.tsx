import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { GripVertical, LayoutDashboard, Plus, Scaling, Search, X, type LucideIcon } from 'lucide-react';
import { errorText, rpc, type DashboardLayout, type DashboardWidget, type LayoutSurface, type WidgetHeight, type WidgetWidth } from './api';
import { Button, Loading, Modal, Notice, Pill, useResource } from './ui';
import './dashboard.css';

export type WidgetDefinition = {
  label: string; description: string; icon: LucideIcon; category?: string;
  defaultWidth: WidgetWidth; defaultHeight: WidgetHeight; minWidth?: WidgetWidth; minHeight?: WidgetHeight;
  supportsResize?: boolean; supportsFloatingWindow?: boolean;
};
type Registry<K extends string> = Record<K, WidgetDefinition>;
type Widget<K extends string> = DashboardWidget & { id: K };
const widths = { 1: '小型 · 四分之一', 2: '中型 · 半行', 4: '大型 · 整行' } as const;
const heights = { 1: '紧凑', 2: '标准', 3: '加高' } as const;
const widgetFor = <K extends string>(id: K, definition: WidgetDefinition): Widget<K> =>
  ({ id, width: definition.defaultWidth, height: definition.defaultHeight, visible: true });

function normalize<K extends string>(registry: Registry<K>, order: K[], layout?: DashboardLayout | null): Widget<K>[] {
  if (!layout || layout.version !== 1) return order.map((id) => widgetFor(id, registry[id]));
  const ids = new Set<string>();
  return layout.widgets.filter((item): item is Widget<K> => {
    if (!Object.hasOwn(registry, item.id) || ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  }).map((item) => ({
    ...item,
    width: Math.max(item.width, registry[item.id].minWidth ?? 1) as WidgetWidth,
    height: Math.max(item.height, registry[item.id].minHeight ?? 1) as WidgetHeight,
  }));
}

export function matchesWidget(definition: WidgetDefinition, query: string) {
  const text = [definition.label, definition.description, definition.category].join(' ').toLowerCase();
  return text.includes(query.trim().toLowerCase());
}

export function useWidgetLayout<K extends string>(surface: LayoutSurface, registry: Registry<K>, defaultOrder: K[], report: (text: string) => void) {
  const layout = useResource(() => rpc('dashboard_layout', { surface }), [surface]);
  const [stored, setStored] = useState<DashboardLayout>();
  const [draft, setDraft] = useState<Widget<K>[]>();
  const [catalog, setCatalog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editing = draft !== undefined;
  const ready = !layout.loading && !layout.error;
  const widgets = draft ?? normalize(registry, defaultOrder, stored ?? layout.data);
  const ids = Object.keys(registry) as K[];

  function begin() {
    if (!ready || saving || editing) return;
    setDraft(widgets); setError('');
  }
  function manage() {
    if (!ready || saving) return;
    begin(); setCatalog(true);
  }
  function cancel() { setDraft(undefined); setCatalog(false); setError(''); }
  async function save(next = draft) {
    if (!next || !ready || saving) return;
    setSaving(true); setError('');
    const layout = { version: 1, widgets: next };
    try {
      await rpc('save_dashboard_layout', { surface, layout });
      setStored(layout); cancel(); report(surface === 'dashboard' ? '工作台布局已保存' : '小工具布局已保存');
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  }
  function defaults() {
    const next = defaultOrder.map((id) => widgetFor(id, registry[id]));
    if (editing) setDraft(next);
    else void save(next);
  }
  function change(id: K, modification: Partial<Omit<Widget<K>, 'id'>>) {
    setDraft((prior) => prior?.map((item) => item.id === id ? { ...item, ...modification } : item));
  }
  function show(id: K) {
    setDraft((prior) => {
      if (!prior) return prior;
      return prior.some((item) => item.id === id) ? prior.map((item) => item.id === id ? { ...item, visible: true } : item)
        : [...prior, widgetFor(id, registry[id])];
    });
  }
  function reorder(source: K, target: K, after: boolean) {
    if (source === target) return;
    setDraft((prior) => {
      const moved = prior?.find((item) => item.id === source);
      if (!prior || !moved) return prior;
      const next = prior.filter((item) => item.id !== source);
      const index = next.findIndex((item) => item.id === target);
      if (index < 0) return prior;
      next.splice(index + Number(after), 0, moved);
      return next;
    });
  }
  return {
    registry, ids, widgets, ready, editing, saving, catalog, loading: layout.loading, error: error || layout.error, retry: layout.retry,
    begin, manage, cancel, save, defaults, change, show, reorder, closeCatalog: () => setCatalog(false),
  };
}

type LayoutState<K extends string> = ReturnType<typeof useWidgetLayout<K>>;

export function WidgetGrid<K extends string>({ state, render, headingAction, query = '', active = true, keepHidden = false, tools = false }: {
  state: LayoutState<K>; render: (id: K, visible: boolean) => ReactNode; headingAction?: (id: K) => ReactNode;
  query?: string; active?: boolean; keepHidden?: boolean; tools?: boolean;
}) {
  const { registry, editing, saving } = state;
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState<K>();
  const [drop, setDrop] = useState<{ id: K; after: boolean }>();
  const grid = useRef<HTMLDivElement>(null);
  const resize = useRef<{ id: K; x: number; y: number; width: WidgetWidth; height: WidgetHeight; unit: number } | undefined>(undefined);
  const visible = (item: Widget<K>) => item.visible && (editing || matchesWidget(registry[item.id], query));
  const showing = state.widgets.filter(visible);
  const rendered = keepHidden ? state.widgets : showing;

  function endDrag() { setDragging(undefined); setDrop(undefined); }
  function reorder(source: K, target: K, after: boolean) {
    state.reorder(source, target, after);
    setAnnouncement(registry[source].label + '已移动');
  }
  function move(id: K, offset: -1 | 1) {
    const index = showing.findIndex((item) => item.id === id);
    const target = showing[index + offset];
    if (target) reorder(id, target.id, offset === 1);
  }
  function resizeTo(event: PointerEvent<HTMLButtonElement>) {
    const initial = resize.current;
    if (!initial) return;
    const definition = registry[initial.id];
    const estimate = initial.width + (event.clientX - initial.x) / initial.unit;
    const possible = ([1, 2, 4] as const).filter((width) => width >= (definition.minWidth ?? 1));
    const width = possible.reduce((best, next) => Math.abs(next - estimate) < Math.abs(best - estimate) ? next : best);
    const height = Math.max(definition.minHeight ?? 1, Math.min(3, initial.height + Math.round((event.clientY - initial.y) / 98))) as WidgetHeight;
    state.change(initial.id, { width, height });
  }

  return <div className={'dashboard-layout-frame' + (editing ? ' editing' : '')}>
    {state.error && <Notice action={!state.ready ? <Button tone="quiet" onClick={state.retry}>重试</Button> : undefined}>{state.error}</Notice>}
    {state.loading ? <Loading>正在读取布局…</Loading> : <>
      {editing && <div className="dashboard-editor-toolbar">
        <div><strong>编辑布局</strong><small>拖动模块手柄或按方向键移动。用角落手柄调整宽度和高度。</small></div>
        <div className="wrap">
          <Button disabled={saving} onClick={state.manage}><Plus size={16} />添加模块</Button>
          <Button disabled={saving} onClick={state.defaults}>恢复默认布局</Button>
          <Button disabled={saving} onClick={() => { state.cancel(); endDrag(); }}>取消编辑</Button>
          <Button tone="primary" busy={saving} onClick={() => void state.save()}>保存布局</Button>
        </div>
      </div>}
      <span className="sr-only" aria-live="polite">{announcement}</span>
      <div className="dashboard-widgets" ref={grid} aria-label={tools ? '小工具模块' : '工作台模块'}>
        {rendered.map((item) => {
          const definition = registry[item.id];
          const { label, icon: Icon } = definition;
          const target = drop?.id === item.id ? (drop.after ? 'after' : 'before') : undefined;
          const show = visible(item);
          return <section key={item.id} hidden={!show} data-widget={show ? item.id : undefined} data-width={item.width} data-height={item.height}
            data-target={target} data-dragging={dragging === item.id} className={'dashboard-widget panel widget-span-' + item.width}
            aria-label={label}
            onDragOver={(event) => {
              if (!dragging || dragging === item.id) return;
              event.preventDefault(); event.dataTransfer.dropEffect = 'move';
              const box = event.currentTarget.getBoundingClientRect();
              const y = event.clientY - box.top;
              const after = y > box.height * .65 || y > box.height * .35 && event.clientX - box.left > box.width / 2;
              if (drop?.id !== item.id || drop.after !== after) setDrop({ id: item.id, after });
            }} onDrop={(event) => {
              if (!dragging) return;
              event.preventDefault();
              reorder(dragging, item.id, drop?.id === item.id && drop.after); endDrag();
            }}>
            {editing && show && <div className="widget-editor">
              <Button tone="quiet" className="icon-btn drag-handle" draggable={!saving} disabled={saving}
                aria-label={'移动 ' + label} title="拖动模块，或按方向键改变顺序"
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                  event.preventDefault(); move(item.id, event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1);
                }}
                onDragStart={(event) => {
                  setDragging(item.id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', item.id);
                  event.dataTransfer.setDragImage(event.currentTarget.closest('.dashboard-widget') as HTMLElement, 12, 12);
                }} onDragEnd={endDrag}><GripVertical size={16} /></Button>
              {definition.supportsResize !== false && <>
                <select aria-label={label + '宽度'} title="模块宽度" value={item.width} disabled={saving}
                  onChange={(event) => state.change(item.id, { width: Number(event.target.value) as WidgetWidth })}>
                  {([1, 2, 4] as const).filter((width) => width >= (definition.minWidth ?? 1)).map((width) =>
                    <option key={width} value={width}>{widths[width]}</option>)}
                </select>
                <select aria-label={label + '高度'} title="模块高度" value={item.height} disabled={saving}
                  onChange={(event) => state.change(item.id, { height: Number(event.target.value) as WidgetHeight })}>
                  {([1, 2, 3] as const).filter((height) => height >= (definition.minHeight ?? 1)).map((height) =>
                    <option key={height} value={height}>{heights[height]}</option>)}
                </select>
              </>}
              <Button tone="quiet" className="icon-btn ml-auto" aria-label={'隐藏 ' + label}
                title="隐藏模块" disabled={saving} onClick={() => state.change(item.id, { visible: false })}><X size={16} /></Button>
            </div>}
            {item.id !== 'controls' && <header className="widget-heading">
              <span className="widget-icon"><Icon size={16} /></span><h2>{label}</h2>
              {!editing && headingAction?.(item.id)}
            </header>}
            <div className="widget-content" inert={editing || undefined}>{render(item.id, active && show && !editing)}</div>
            {editing && show && definition.supportsResize !== false && <Button tone="quiet" className="icon-btn widget-resize"
              aria-label={'调整 ' + label + ' 尺寸'} title="拖动调整模块尺寸。也可使用宽度和高度下拉菜单。"
              disabled={saving} onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                resize.current = { id: item.id, x: event.clientX, y: event.clientY, width: item.width, height: item.height,
                  unit: Math.max(70, (grid.current?.clientWidth ?? 960) / 4) };
                event.currentTarget.setPointerCapture(event.pointerId);
              }} onPointerMove={resizeTo} onPointerUp={(event) => { resizeTo(event); resize.current = undefined; }}
              onLostPointerCapture={() => { resize.current = undefined; }}><Scaling size={15} /></Button>}
          </section>;
        })}
      </div>
      {!showing.length && <div className="panel dashboard-no-widgets">
        <LayoutDashboard size={22} />{query && !editing ? '没有匹配的可见模块。' : '暂无可见模块。'}
        <Button disabled={!state.ready} onClick={state.manage}>{tools ? '管理小工具' : '添加模块'}</Button>
      </div>}
    </>}
    {state.catalog && <Catalog state={state} tools={tools} />}
  </div>;
}

function Catalog<K extends string>({ state, tools }: { state: LayoutState<K>; tools: boolean }) {
  const [query, setQuery] = useState('');
  const filtered = state.ids.filter((id) => matchesWidget(state.registry[id], query));
  return <Modal title={tools ? '管理小工具' : '添加工作台模块'} onClose={state.closeCatalog} wide>
    {tools && <label className="search-input widget-catalog-search"><Search size={15} />
      <input aria-label="搜索可用小工具" placeholder="按名称或分类搜索" value={query} onChange={(event) => setQuery(event.target.value)} />
    </label>}
    {filtered.length ? <div className="widget-catalog">
      {filtered.map((id) => {
        const definition = state.registry[id];
        const visible = state.widgets.some((item) => item.id === id && item.visible);
        const { icon: Icon, label } = definition;
        return <div key={id} className="widget-catalog-item">
          <span className="widget-icon"><Icon size={19} /></span><div><strong>{label}</strong>
            <p>{definition.description}</p>
            <small>{[definition.category, widths[definition.defaultWidth], heights[definition.defaultHeight],
              definition.supportsFloatingWindow && '支持桌面窗口'].filter(Boolean).join(' · ')}</small></div>
          {visible ? tools
            ? <Button tone="quiet" aria-label={'隐藏工具 ' + label} onClick={() => state.change(id, { visible: false })}>隐藏</Button>
            : <Pill>已添加</Pill>
            : <Button aria-label={'添加 ' + label} onClick={() => state.show(id)}><Plus size={15} />添加</Button>}
        </div>;
      })}
    </div> : <p className="muted">没有符合条件的小工具。</p>}
    <div className="form-actions">
      {tools && <Button tone="quiet" onClick={state.defaults}>恢复默认显示</Button>}
      <Button tone="primary" onClick={state.closeCatalog}>完成</Button>
    </div>
  </Modal>;
}
