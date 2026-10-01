import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { MarriageStyle } from './geometry.ts';
import { EmptyTree } from '../editing/FirstPerson.tsx';
import { PersonMiniCard, PersonPanel } from '../PersonPanel.tsx';
import { applyTheme, readTheme, type Theme } from '../theme.ts';
import { PersonOpenProvider } from '../personShared.tsx';
import { Link, navigate, personPath, treePath, useLocation } from '../router.ts';
import { computeKinship } from './kinship.ts';
import { displayName, initialsName, type Tree, type TreeIndex } from './model.ts';
import { TreeView, type FocusRequest } from './TreeView.tsx';
import { RELATIVES_DEPTHS, selectView, type ViewMode } from './views.ts';

type Props = { tree: Tree; index: TreeIndex; meId: number | null };

const MODES: { mode: ViewMode; label: string; hint: string }[] = [
  { mode: 'family', label: 'Семья', hint: 'Прямые предки, братья и сёстры, супруги и потомки' },
  {
    mode: 'relatives',
    label: 'Родня',
    hint: 'Все потомки предков до выбранного колена — с дядями, тётями и двоюродными',
  },
  {
    mode: 'clans',
    label: 'По родам',
    hint: 'Все люди в базе: каждый род — отдельным деревом, связи между родами — ссылками',
  },
  { mode: 'all', label: 'Всё дерево', hint: 'Все люди в базе одной схемой' },
];

export default function TreePage({ tree, index, meId }: Props) {
  const location = useLocation();
  const params = location.searchParams;
  const mode = (MODES.some((m) => m.mode === params.get('view')) ? params.get('view') : 'family') as ViewMode;
  const depthParam = Number(params.get('depth'));
  const depth = RELATIVES_DEPTHS.some((d) => d.depth === depthParam) ? depthParam : 2;
  const fallbackCenter = meId ?? tree.persons[0]?.id ?? null;
  const centerParam = Number(params.get('center'));
  const centerId = index.persons.has(centerParam) ? centerParam : fallbackCenter;

  const personParam = Number(params.get('person'));
  const selectedId = index.persons.has(personParam) ? personParam : null;
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [marriageStyle, setMarriageStyle] = useState<MarriageStyle>(readMarriageStyle);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [legendOpen, setLegendOpen] = useState(false);
  // Настройки и справка закрываются кликом мимо панели инструментов (по дереву) и Escape.
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!settingsOpen && !legendOpen) return;
    const close = () => {
      setSettingsOpen(false);
      setLegendOpen(false);
    };
    const onPointer = (e: PointerEvent) => !toolbarRef.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen, legendOpen]);
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  // Карточка человека: свёрнута в угол поверх дерева (по умолчанию) или развёрнута справа. Вид один
  // на всех людей и запоминается: переход к другому человеку его не меняет.
  const [panelExpanded, setPanelExpanded] = useState(readPanelExpanded);
  const expandPanel = (expanded: boolean) => {
    setPanelExpanded(expanded);
    try {
      localStorage.setItem(PANEL_EXPANDED_KEY, expanded ? '1' : '0');
    } catch {
      // Без хранилища вид просто не запомнится.
    }
    // Развёрнутая панель сужает дерево — если выбранный ушёл под неё, подводим к нему.
    if (expanded && selectedId !== null) setFocus({ id: selectedId, mode: 'reveal', nonce: Date.now() });
  };
  const changeMarriageStyle = (style: MarriageStyle) => {
    setMarriageStyle(style);
    try {
      localStorage.setItem(MARRIAGE_STYLE_KEY, style);
    } catch {
      // Приватный режим и т.п. — настройка просто не запомнится.
    }
  };

  const view = useMemo(
    () => (centerId === null ? tree : selectView(tree, index, mode, centerId, depth)),
    [tree, index, mode, centerId, depth],
  );
  const kinship = useMemo(() => (centerId === null ? new Map() : computeKinship(index, centerId)), [index, centerId]);

  const go = (next: { mode?: ViewMode; center?: number; depth?: number; person?: number | null }, replace = false) => {
    const nextMode = next.mode ?? mode;
    const nextCenter = next.center ?? centerId;
    const nextDepth = next.depth ?? depth;
    const nextPerson = next.person === undefined ? selectedId : next.person;
    navigate(
      treePath({
        view: nextMode === 'family' ? undefined : nextMode,
        center: nextCenter === null || nextCenter === meId ? undefined : nextCenter,
        depth: nextMode === 'relatives' && nextDepth !== 2 ? nextDepth : undefined,
        person: nextPerson ?? undefined,
      }),
      { replace },
    );
  };
  // Выбор человека — без новой записи в истории, чтобы «назад» не листал клики по карточкам.
  const select = (id: number | null, focusMode?: FocusRequest['mode']) => {
    go({ person: id }, true);
    if (id !== null && focusMode) setFocus({ id, mode: focusMode, nonce: Date.now() });
  };

  const center = centerId !== null ? index.persons.get(centerId) : undefined;
  // Легенда — только неочевидные термины, которые есть на текущем дереве.
  // Для легенды берём общее значение термина, а не расшифровку конкретного человека.
  const legend = useMemo(() => {
    const entries = new Map<string, { meaning?: string; viaSpouse: boolean }>();
    for (const p of view.persons) {
      const k = kinship.get(p.id);
      if (!k?.hint) continue;
      const entry = entries.get(k.label) ?? { viaSpouse: false };
      if (k.viaSpouse) {
        entry.viaSpouse = true;
        entry.meaning ??= k.termHint;
      } else {
        entry.meaning = k.hint;
      }
      entries.set(k.label, entry);
    }
    return [...entries]
      .filter(([, e]) => e.meaning)
      .map(([label, e]) => [label, e.viaSpouse ? `${e.meaning}; так же зовут их мужей и жён` : e.meaning!] as const)
      .sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  }, [view, kinship]);
  const selected = selectedId !== null ? index.persons.get(selectedId) : undefined;
  const selectedKinship = selected && selected.id !== centerId ? kinship.get(selected.id) : undefined;

  if (tree.persons.length === 0) return <EmptyTree onCreated={(id) => select(id)} />;

  return (
    <div className="tree-page">
      <div className={selected && !panelExpanded ? 'tree-main with-card' : 'tree-main'}>
        <div className="tree-toolbar" ref={toolbarRef}>
          <div className="toolbar-row">
            <div className="segmented" role="tablist" aria-label="Режим дерева">
              {MODES.map((m) => (
                <button
                  key={m.mode}
                  role="tab"
                  aria-selected={mode === m.mode}
                  className={mode === m.mode ? 'active' : ''}
                  title={m.hint}
                  onClick={() => go({ mode: m.mode })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button
              className={settingsOpen ? 'icon-button active' : 'icon-button'}
              onClick={() => {
                setSettingsOpen((open) => !open);
                setLegendOpen(false);
              }}
              aria-expanded={settingsOpen}
              aria-label="Настройки дерева"
              title="Настройки дерева"
            >
              ⚙
            </button>
            <button
              className={legendOpen ? 'icon-button active' : 'icon-button'}
              onClick={() => {
                setLegendOpen((open) => !open);
                setSettingsOpen(false);
              }}
              aria-expanded={legendOpen}
              aria-label="Кто есть кто"
              title="Кто есть кто: расшифровка названий родства"
            >
              ?
            </button>
          </div>
          {legendOpen && (
            <div className="tree-settings legend" role="dialog" aria-label="Кто есть кто">
              <strong>Кто есть кто</strong>
              {legend.length ? (
                <dl>
                  {legend.map(([label, hint]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{hint}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="muted small">На этом дереве все названия обычные.</p>
              )}
            </div>
          )}
          {settingsOpen && (
            <div className="tree-settings" role="dialog" aria-label="Настройки дерева">
              <label>
                Родня — до какого колена
                <select
                  value={String(depth)}
                  onChange={(e) => go({ mode: 'relatives', depth: Number(e.target.value) })}
                >
                  {RELATIVES_DEPTHS.map((d) => (
                    <option key={String(d.depth)} value={String(d.depth)}>
                      {d.label} — {d.hint}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">{RELATIVES_DEPTHS.find((d) => d.depth === depth)!.detail}</p>
              <label>
                Повторные браки
                <select value={marriageStyle} onChange={(e) => changeMarriageStyle(e.target.value as MarriageStyle)}>
                  <option value="compact">рядом — человек между супругами</option>
                  <option value="bridges">в ряд — муж слева, жёны справа, как в familio</option>
                </select>
              </label>
              <p className="muted small">Три брака с детьми и больше всегда рисуются в ряд.</p>
              <label>
                Оформление
                <select
                  value={theme}
                  onChange={(e) => {
                    const next = e.target.value as Theme;
                    setTheme(next);
                    applyTheme(next);
                  }}
                >
                  <option value="auto">как в системе</option>
                  <option value="light">светлое</option>
                  <option value="dark">тёмное</option>
                </select>
              </label>
            </div>
          )}
          <p className="tree-summary">
            {view.persons.length} из {tree.persons.length}
            {mode === 'relatives' && ` · ${RELATIVES_DEPTHS.find((d) => d.depth === depth)!.label}`}
            {center && (
              <>
                {' · '}
                <Link to={personPath(center.id)} title={displayName(center)}>
                  {initialsName(center)}
                </Link>
                {meId !== null && centerId !== meId && (
                  <>
                    {' · '}
                    <button className="link" onClick={() => go({ center: meId })}>
                      ко мне
                    </button>
                  </>
                )}
              </>
            )}
          </p>
        </div>

        <TreeView
          tree={view}
          mode={mode}
          depth={depth}
          algorithm={mode === 'clans' ? 'clans' : 'layered'}
          // Во «Всём дереве» между рядами десятки линий: шире промежутки и разные оттенки у соседних
          // браков. В остальных режимах линии не наслаиваются, и цвет только отвлекает.
          spacing={mode === 'all' ? 'wide' : 'compact'}
          untangle={mode === 'all'}
          lineHues={mode === 'all'}
          // Род выбранного подсвечивается там, где его не видно без подсветки: во «Всём дереве» он
          // теряется среди линий, в «По родам» разбросан по родам. В «Семье» и «Родне» и так всё видно.
          lineageHighlight={mode === 'all' || mode === 'clans'}
          marriageStyle={marriageStyle}
          index={index}
          kinship={kinship}
          centerId={centerId}
          meId={meId}
          selectedId={selectedId}
          onSelect={(id) => select(id, 'reveal')}
          focus={focus}
        />
        {selected && !panelExpanded && (
          <PersonMiniCard
            key={selected.id}
            person={selected}
            kinship={selectedKinship?.label}
            onBuild={selected.id !== centerId ? () => go({ center: selected.id }) : undefined}
            onExpand={() => expandPanel(true)}
            onClose={() => select(null)}
          />
        )}
      </div>

      {selected && panelExpanded && (
        <PanelResizer width={panelWidth} onChange={setPanelWidth} />
      )}
      {selected && panelExpanded && (
        <aside
          className="side-panel"
          aria-label={displayName(selected)}
          style={{ '--panel-width': `${panelWidth}px` } as CSSProperties}
        >
          <PersonOpenProvider value={(id) => select(id, 'center')}>
            <PersonPanel
              key={selected.id}
              person={selected}
              index={index}
              kinship={
                selectedKinship && (
                  <>
                    {selectedKinship.label}
                    {selectedKinship.hint && <span className="muted"> — {selectedKinship.hint}</span>}
                  </>
                )
              }
              onBuild={selected.id !== centerId ? () => go({ center: selected.id }) : undefined}
              onCollapse={() => expandPanel(false)}
              onClose={() => select(null)}
            />
          </PersonOpenProvider>
        </aside>
      )}
    </div>
  );
}

const MARRIAGE_STYLE_KEY = 'tree.marriageStyle';

const PANEL_WIDTH_KEY = 'tree.panelWidth';
const PANEL_DEFAULT = 420;
const PANEL_MIN = 320;
const panelMax = () => Math.max(PANEL_MIN, Math.round(window.innerWidth * 0.7));

const PANEL_EXPANDED_KEY = 'tree.panelExpanded';

function readPanelExpanded(): boolean {
  try {
    return localStorage.getItem(PANEL_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

function readPanelWidth(): number {
  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return saved >= PANEL_MIN ? Math.min(saved, panelMax()) : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

/** Полоска между деревом и карточкой: тянуть — менять ширину, двойной клик — вернуть как было. */
function PanelResizer({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const save = (value: number) => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(value));
    } catch {
      // Без хранилища ширина просто не запомнится.
    }
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    let current = width;
    const target = e.currentTarget;
    const move = (ev: PointerEvent) => {
      current = Math.round(Math.min(panelMax(), Math.max(PANEL_MIN, startWidth + startX - ev.clientX)));
      onChange(current);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      save(current);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Ширина карточки"
      title="Потяните, чтобы изменить ширину; двойной клик — по умолчанию"
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        onChange(PANEL_DEFAULT);
        save(PANEL_DEFAULT);
      }}
    />
  );
}

function readMarriageStyle(): MarriageStyle {
  try {
    const saved = localStorage.getItem(MARRIAGE_STYLE_KEY);
    // «lines» — прежнее название того же стиля.
    return saved === 'bridges' || saved === 'lines' ? 'bridges' : 'compact';
  } catch {
    return 'compact';
  }
}
