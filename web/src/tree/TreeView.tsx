import { select } from 'd3-selection';
import 'd3-transition';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AvatarContent } from '../Avatar.tsx';
import { familyName } from '../surname.ts';
import type { Kinship } from './kinship.ts';
import { generationBands, generationLabel } from './generations.ts';
import {
  AVATAR,
  CARD,
  REF_CARD,
  UNKNOWN_CARD,
  type Layout,
  type LayoutAlgorithm,
  type MarriageStyle,
  type PlacedRef,
  type RowSpacing,
} from './geometry.ts';
import { layoutInBackground } from './layoutClient.ts';
import { familyHues, isLineageEdge, lineage } from './lines.ts';
import {
  cardDates,
  displayName,
  findEvent,
  initialsName,
  placeShort,
  type Person,
  type Tree,
  type TreeIndex,
} from './model.ts';
import { layoutSignature } from './signature.ts';
import type { ViewMode } from './views.ts';

type Props = {
  tree: Tree;
  /** Какой вид открыт — сервер ведёт счёт открытий и заранее считает популярные (precompute.ts). */
  mode: ViewMode;
  depth: number;
  algorithm: LayoutAlgorithm;
  spacing: RowSpacing;
  /** Распутывать пары, к которым линии от родителей идут крест-накрест («Всё дерево»). */
  untangle: boolean;
  /** Разные оттенки линий у соседних браков — там, где линии в промежутках наслаиваются. */
  lineHues: boolean;
  /** Подсветка рода выбранного человека — там, где его не видно без неё («Всё дерево», «По родам»). */
  lineageHighlight: boolean;
  marriageStyle: MarriageStyle;
  index: TreeIndex;
  kinship: Map<number, Kinship>;
  centerId: number | null;
  meId: number | null;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** Подвести дерево к человеку: center — в середину, reveal — только если он не виден. */
  focus: FocusRequest | null;
};

export type FocusRequest = { id: number; mode: 'center' | 'reveal'; nonce: number };

export function TreeView({
  tree,
  mode,
  depth,
  algorithm,
  spacing,
  untangle,
  lineHues,
  lineageHighlight,
  marriageStyle,
  index,
  kinship,
  centerId,
  meId,
  selectedId,
  onSelect,
  focus,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown>>(null);
  const [layout, setLayout] = useState<Layout>();
  const layoutRef = useRef<Layout>(undefined);
  layoutRef.current = layout;
  // После любой правки дерево приходит заново целиком. Пересчитываем раскладку, только если
  // изменилось то, от чего она зависит: правка имени или биографии схему не дёргает.
  const signature = useMemo(() => layoutSignature(tree), [tree]);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  // Какому виду (алгоритм, промежутки, центр, стиль браков, состав людей) соответствует раскладка: если после правки
  // данных вид тот же — оставляем масштаб и положение, а не прыгаем к центру дерева.
  const layoutKey = useRef<string>('');
  const shownKey = useRef<string>('');
  const [transform, setTransform] = useState(zoomIdentity);
  // Идёт ли раскладка. Плашку показываем не сразу: готовая раскладка приходит с сервера за
  // мгновение и не должна мигать, а новая («Всё дерево» от другого человека) считается секунды.
  const [computing, setComputing] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  // «По родам»: «↑ родители» подводит к ссылке в семье родителей, ссылка — к самой карточке;
  // куда пришли, то на миг подсвечивается. Человек при этом не выбирается — панель не открывается.
  const [flash, setFlash] = useState<{ target: 'ref' | 'person'; personId: number; nonce: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Перешли к другому виду или человеку, пока считалось, — зёрна прежнего запроса не нужны.
    const abort = new AbortController();
    const tree = treeRef.current;
    const key = `${algorithm}|${spacing}|${untangle}|${centerId}|${marriageStyle}|${tree.persons.map((p) => p.id).join(',')}`;
    setComputing(true);
    const reveal = setTimeout(() => !cancelled && setShowProgress(true), 250);
    // Прежние позиции — только для того же вида (алгоритм, центр и стиль): после правки дерево не
    // перетасовывается, а при переходе к другому центру раскладка честно строится заново.
    const sameView = layoutKey.current.split('|').slice(0, 5).join('|') === key.split('|').slice(0, 5).join('|');
    const previous = sameView ? layoutRef.current?.persons.map((p) => [p.id, p.x] as [number, number]) : undefined;
    layoutInBackground(
      { tree, algorithm, spacing, untangle, style: marriageStyle, centerId, previous, view: { mode, depth } },
      abort.signal,
    )
      .then((l) => {
        if (cancelled) return;
        layoutKey.current = key;
        setLayout(l);
      })
      .catch((error) => !cancelled && console.error(error))
      .finally(() => {
        if (cancelled) return;
        clearTimeout(reveal);
        setComputing(false);
        setShowProgress(false);
      });
    return () => {
      cancelled = true;
      abort.abort();
      clearTimeout(reveal);
    };
  }, [signature, algorithm, spacing, untangle, marriageStyle, centerId]);

  const positions = useMemo(() => new Map(layout?.persons.map((p) => [p.id, p])), [layout]);
  const bands = useMemo(() => (layout ? generationBands(layout) : []), [layout]);
  // Поколения считаем от ряда центра: он без заливки, соседние — через один.
  const centerRow = useMemo(() => {
    const position = centerId !== null ? positions.get(centerId) : undefined;
    return position ? bands.findIndex((band) => band.y === Math.round(position.y)) : -1;
  }, [bands, positions, centerId]);
  const center = centerId !== null ? index.persons.get(centerId) : undefined;
  const ownGeneration = !center ? '' : centerId === meId ? 'Моё поколение' : `Поколение: ${initialsName(center)}`;
  const narrow = useNarrowScreen();
  const hues = useMemo(
    () => (layout && lineHues ? familyHues(layout) : new Map<number, number>()),
    [layout, lineHues],
  );
  // Род выбранного — предки вверх и потомки вниз — ярче, остальное приглушено: линии сильно,
  // карточки слабее, чтобы имена читались.
  const highlight = useMemo(
    () => (lineageHighlight && selectedId !== null ? lineage(index, selectedId) : null),
    [lineageHighlight, index, selectedId],
  );
  const related = (yes: boolean | null | undefined) => (highlight && yes ? ' related' : '');
  const hue = (familyId: number) => (hues.has(familyId) ? ` hue-${hues.get(familyId)}` : '');

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg || !layout) return;
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 2.5])
      .on('zoom', (event) => setTransform(event.transform));
    zoomRef.current = behavior;
    const selection = select(svg).call(behavior).on('dblclick.zoom', null);

    if (shownKey.current === layoutKey.current) {
      selection.call(behavior.transform, transform);
    } else {
      // Новый вид (режим, центр) открывается на центре дерева.
      const start = centerId !== null ? positions.get(centerId) : undefined;
      selection.call(behavior.transform, start ? centerOn(svg, start, 0.85) : fitAll(svg, layout));
    }
    shownKey.current = layoutKey.current;
    return () => {
      selection.on('.zoom', null);
    };
  }, [layout]);

  useEffect(() => {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    const position = focus ? positions.get(focus.id) : undefined;
    if (!svg || !behavior || !focus || !position) return;
    if (focus.mode === 'reveal') {
      // Панель карточки сужает дерево: если выбранная карточка ушла за край — подводим к ней.
      const { width, height } = svg.getBoundingClientRect();
      const left = transform.applyX(position.x);
      const top = transform.applyY(position.y);
      const inside =
        left >= 0 && top >= 0 && left + CARD.width * transform.k <= width && top + CARD.height * transform.k <= height;
      if (inside) return;
    }
    select(svg)
      .transition()
      .duration(450)
      .call(behavior.transform, centerOn(svg, position, Math.max(transform.k, 0.6)));
    // Реагируем только на новый запрос, а не на каждое изменение масштаба.
  }, [focus?.nonce, positions]);

  const animate = (apply: (svg: SVGSVGElement, behavior: ZoomBehavior<SVGSVGElement, unknown>) => void) => {
    if (svgRef.current && zoomRef.current) apply(svgRef.current, zoomRef.current);
  };
  const zoomBy = (factor: number) =>
    animate((svg, behavior) => select(svg).transition().duration(250).call(behavior.scaleBy, factor));
  const showAll = () =>
    animate(
      (svg, behavior) => layout && select(svg).transition().duration(450).call(behavior.transform, fitAll(svg, layout)),
    );
  const showCenter = () =>
    animate((svg, behavior) => {
      const position = centerId !== null ? positions.get(centerId) : undefined;
      if (position)
        select(svg)
          .transition()
          .duration(450)
          .call(behavior.transform, centerOn(svg, position, 0.85));
    });
  // К ссылке на человека в семье его родителей: родители — рядом над ней.
  const showParents = (personId: number) => {
    const ref = layout?.refs.find((r) => r.personId === personId);
    if (!ref) return;
    animate((svg, behavior) =>
      select(svg)
        .transition()
        .duration(450)
        .call(behavior.transform, centerAt(svg, ref.x + REF_CARD.width / 2, ref.y, Math.max(transform.k, 0.6))),
    );
    setFlash({ target: 'ref', personId, nonce: Date.now() });
  };
  const showPerson = (personId: number) => {
    const position = positions.get(personId);
    if (!position) return;
    animate((svg, behavior) =>
      select(svg)
        .transition()
        .duration(450)
        .call(behavior.transform, centerOn(svg, position, Math.max(transform.k, 0.6))),
    );
    setFlash({ target: 'person', personId, nonce: Date.now() });
  };
  const flashKey = (target: 'ref' | 'person', personId: number) =>
    flash?.target === target && flash.personId === personId ? `-${flash.nonce}` : '';

  return (
    <div className={computing && showProgress && layout ? 'tree-canvas busy' : 'tree-canvas'}>
      {computing && showProgress && (
        <div className="layout-progress" role="status" aria-live="polite">
          <span>Раскладываем дерево…</span>
          <span className="layout-progress-bar">
            <span />
          </span>
        </div>
      )}
      <svg ref={svgRef} className="tree" onClick={() => onSelect(null)} role="img" aria-label="Семейное древо">
        <defs>
          <clipPath id="avatar-clip">
            <circle cx={CARD.width / 2} cy={AVATAR.cy} r={AVATAR.radius - 1} />
          </clipPath>
        </defs>
        {/* Зебра поколений — во всю ширину экрана, двигается с деревом только по вертикали. */}
        {bands.map((band, i) => (
          <rect
            key={band.y}
            className={(centerRow < 0 ? i : i - centerRow) % 2 ? 'generation-band odd' : 'generation-band'}
            x={0}
            width="100%"
            y={transform.applyY(band.top)}
            height={(band.bottom - band.top) * transform.k}
          />
        ))}
        {layout ? (
          <g transform={transform.toString()} className={highlight ? 'focused' : undefined}>
            <g className={lineHues ? 'lines hued' : 'lines'}>
              {layout.edges.map((edge) => (
                <path
                  key={edge.id}
                  className={`edge${hue(edge.familyId)}${related(highlight && isLineageEdge(highlight, edge))}`}
                  d={roundedPath(edge.points, 14)}
                />
              ))}
              {layout.unions.map((union) => {
                // Пока считается новая раскладка, старая может ссылаться на удалённых людей и семьи.
                const family = index.families.get(union.familyId);
                const divorced = family?.events.some((e) => e.type === 'divorce') ?? false;
                const onPath = related(highlight?.families.has(union.familyId));
                return (
                  <g key={union.familyId}>
                    {/* Линия между супругами — того же оттенка, что и линии к их детям: семья одним цветом. */}
                    <path
                      className={`marriage${hue(union.familyId)}${divorced ? ' divorced' : ''}${onPath}`}
                      d={roundedPath(union.path, 8)}
                    />
                    {union.stem && (
                      <line
                        className={`edge${hue(union.familyId)}${onPath}`}
                        x1={union.stem.x}
                        x2={union.stem.x}
                        y1={union.stem.from}
                        y2={union.stem.to}
                      />
                    )}
                  </g>
                );
              })}
            </g>
            {/* «По родам»: над верхней парой каждого рода — чей это род. */}
            {layout.clans.map((clan) => {
              const person = index.persons.get(clan.personId);
              const name = person && familyName(person.birthSurname || person.surname);
              return (
                name && (
                  <text key={`clan${clan.personId}`} className="clan-label" x={clan.x} y={clan.y - 14} textAnchor="middle">
                    {name}
                  </text>
                )
              );
            })}
            {layout.unknowns.map((u) => (
              <g
                key={`u${u.familyId}`}
                transform={`translate(${u.x},${u.y})`}
                className={`tnode unknown${related(highlight?.families.has(u.familyId))}`}
              >
                <title>Партнёр неизвестен</title>
                <circle cx={UNKNOWN_CARD.width / 2} cy={AVATAR.cy} r={AVATAR.radius} className="avatar-bg" />
                <text x={UNKNOWN_CARD.width / 2} y={AVATAR.cy + 9} textAnchor="middle" className="unknown-mark">
                  ?
                </text>
                <text x={UNKNOWN_CARD.width / 2} y={128} textAnchor="middle" className="meta">
                  Неизвестен
                </text>
              </g>
            ))}
            {layout.refs.map((placed) => {
              const person = index.persons.get(placed.personId);
              const flashed = flashKey('ref', placed.personId);
              return (
                person && (
                  <RefNode
                    // Новый ключ перезапускает подсветку, если к той же ссылке перешли ещё раз.
                    key={`r${placed.familyId}-${placed.personId}${flashed}`}
                    placed={placed}
                    person={person}
                    via={index.persons.get(placed.via)}
                    flashing={flashed !== ''}
                    related={Boolean(highlight && isLineageEdge(highlight, { familyId: placed.familyId, childId: placed.personId }))}
                    onOpen={showPerson}
                  />
                )
              );
            })}
            {layout.portals.map((portal) => {
              const person = index.persons.get(portal.personId);
              const label = person ? `Родители: ${displayName(person)}` : 'Родители';
              return (
                <g
                  key={`portal${portal.personId}`}
                  className={`portal${related(highlight?.blood.has(portal.personId))}`}
                  transform={`translate(${portal.x},${portal.y - PORTAL.height - 6})`}
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  onClick={(e) => {
                    e.stopPropagation();
                    showParents(portal.personId);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && showParents(portal.personId)}
                >
                  <title>{`${label} — в другом роду, показать`}</title>
                  <rect x={-PORTAL.width / 2} width={PORTAL.width} height={PORTAL.height} rx={PORTAL.height / 2} />
                  <text y={14} textAnchor="middle">
                    ↑ родители
                  </text>
                </g>
              );
            })}
            {layout.persons.map((p) => {
              const person = index.persons.get(p.id);
              const flashed = flashKey('person', p.id);
              return person && (
              <PersonNode
                key={`${p.id}${flashed}`}
                person={person}
                kinship={kinship.get(p.id)}
                isMe={p.id === meId}
                isCenter={p.id === centerId}
                x={p.x}
                y={p.y}
                selected={p.id === selectedId}
                flashing={flashed !== ''}
                related={Boolean(highlight?.people.has(p.id))}
                onSelect={onSelect}
              />
              );
            })}
          </g>
        ) : null}
        {/* Подписи поколений — у левого края экрана, чтобы не листать до центра. */}
        {centerRow >= 0 && (
          <g className="generation-labels" aria-hidden="true">
            {bands.map((band, i) => {
              const top = transform.applyY(band.top);
              const bottom = transform.applyY(band.bottom);
              const label = generationLabel(i - centerRow, ownGeneration);
              const own = i === centerRow ? 'generation-label own' : 'generation-label';
              if (narrow) {
                // На телефоне — узкий вертикальный ярлык у самого края: карточки не закрывает.
                const length = textWidth(label, LABEL_FONT_NARROW) + 16;
                const from = Math.max(top, NARROW_LABEL_TOP);
                if (bottom - from < length + 8) return null;
                const cy = Math.min(Math.max((top + bottom) / 2, from + length / 2 + 4), bottom - length / 2 - 4);
                return (
                  <g key={band.y} className={`${own} vertical`} transform={`translate(4,${cy}) rotate(-90)`}>
                    <rect x={-length / 2} width={length} height={NARROW_LABEL_WIDTH} rx={NARROW_LABEL_WIDTH / 2} />
                    <text y={12.5} textAnchor="middle">
                      {label}
                    </text>
                  </g>
                );
              }
              if (bottom - top < LABEL_HEIGHT + 12) return null;
              const width = textWidth(label, LABEL_FONT) + 20;
              // Пока полоса видна, подпись держится в ней и не заходит под панель инструментов.
              const y = Math.min(Math.max(top + 6, LABEL_TOP), bottom - LABEL_HEIGHT - 6);
              return (
                <g key={band.y} className={own} transform={`translate(12,${y})`}>
                  <rect width={width} height={LABEL_HEIGHT} rx={LABEL_HEIGHT / 2} />
                  <text x={width / 2} y={15} textAnchor="middle">
                    {label}
                  </text>
                </g>
              );
            })}
          </g>
        )}
      </svg>
      <div className="tree-controls">
        {/* На телефоне масштаб — щипком, кнопки «+» и «−» там скрыты. */}
        <button className="zoom-step" onClick={() => zoomBy(1.4)} aria-label="Приблизить" title="Приблизить">
          +
        </button>
        <button className="zoom-step" onClick={() => zoomBy(1 / 1.4)} aria-label="Отдалить" title="Отдалить">
          −
        </button>
        <button onClick={showCenter} aria-label="К центру дерева" title="К центру дерева">
          ◎
        </button>
        <button onClick={showAll} aria-label="Показать всё" title="Показать всё">
          ⤢
        </button>
      </div>
    </div>
  );
}

function PersonNode({
  person,
  kinship,
  isMe,
  isCenter,
  x,
  y,
  selected,
  flashing,
  related,
  onSelect,
}: {
  person: Person;
  kinship: Kinship | undefined;
  isMe: boolean;
  isCenter: boolean;
  x: number;
  y: number;
  selected: boolean;
  flashing: boolean;
  /** Из рода выбранного (или супруг на его пути) — не приглушается при подсветке. */
  related: boolean;
  onSelect: (id: number) => void;
}) {
  const cx = CARD.width / 2;
  const nameLines = wrap(displayName(person), CARD.width - 6, 2);
  const birthPlace = findEvent(person.events, 'birth')?.place?.name;
  const place = birthPlace ? placeShort(birthPlace) : '';
  const dates = cardDates(person);
  const badge = isCenter && isMe ? { label: 'Я', tone: 'center' as const } : kinship;
  const badgeWidth = badge ? textWidth(badge.label, BADGE_FONT) + 18 : 0;
  const meChip = isMe && !isCenter;

  const classes = [
    'tnode',
    person.isDeceased && 'deceased',
    (selected || isCenter) && 'ringed',
    selected && 'selected',
    flashing && 'flash',
    related && 'related',
  ]
    .filter(Boolean)
    .join(' ');
  let line = 128;
  const nextLine = () => {
    const current = line;
    line += 16;
    return current;
  };

  return (
    <g
      className={classes}
      transform={`translate(${x},${y})`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(person.id);
      }}
      role="button"
      tabIndex={0}
      aria-label={displayName(person)}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(person.id)}
    >
      <title>{displayName(person)}</title>
      <rect className="hit" width={CARD.width} height={CARD.height} />
      <circle className="avatar-bg" cx={cx} cy={AVATAR.cy} r={AVATAR.radius} />
      <g clipPath="url(#avatar-clip)">
        <g transform={`translate(${cx - 50},0)`}>
          <AvatarContent person={person} />
        </g>
      </g>
      <circle className="avatar-ring" cx={cx} cy={AVATAR.cy} r={AVATAR.radius + 2} />

      {badge && (
        <g
          className={`badge tone-${badge.tone}`}
          transform={`translate(${cx - badgeWidth / 2 - (meChip ? 12 : 0)},${90})`}
        >
          {'hint' in badge && badge.hint && <title>{`${badge.label} — ${badge.hint}`}</title>}
          <rect width={badgeWidth} height={20} rx={10} />
          <text x={badgeWidth / 2} y={14} textAnchor="middle">
            {badge.label}
          </text>
          {meChip && (
            <g className="badge tone-center" transform={`translate(${badgeWidth + 4},0)`}>
              <rect width={20} height={20} rx={10} />
              <text x={10} y={14} textAnchor="middle">
                Я
              </text>
            </g>
          )}
        </g>
      )}

      {nameLines.map((text) => (
        <text key={text} x={cx} y={nextLine()} textAnchor="middle" className="name">
          {text}
          {person.isUncertain && text === nameLines.at(-1) && <tspan className="uncertain"> ?</tspan>}
        </text>
      ))}
      {place && (
        <text x={cx} y={nextLine()} textAnchor="middle" className="meta">
          {place}
        </text>
      )}
      {dates && (
        <text x={cx} y={nextLine()} textAnchor="middle" className="meta">
          {dates}
        </text>
      )}
    </g>
  );
}

/** Ссылка на ребёнка, которого рисуют в роду супруга: клик — к его карточке (без выбора). */
function RefNode({
  placed,
  person,
  via,
  flashing,
  related,
  onOpen,
}: {
  placed: PlacedRef;
  person: Person;
  via: Person | undefined;
  flashing: boolean;
  /** На пути рода выбранного: мостик к его продолжению в другом роду. */
  related: boolean;
  onOpen: (id: number) => void;
}) {
  const where =
    via && via.id !== person.id
      ? `в семье ${via.sex === 'M' ? 'мужа' : via.sex === 'F' ? 'жены' : 'супруга'}`
      : 'у других родителей';
  // Имя — как на карточках: «Орлова (Волкова) Вера Павловна», в две строки.
  const nameLines = wrap(displayName(person), REF_CARD.width - 12, 2);
  return (
    <g
      className={['tref', flashing && 'flash', related && 'related'].filter(Boolean).join(' ')}
      transform={`translate(${placed.x},${placed.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${displayName(person)} — ${where}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(person.id);
      }}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(person.id)}
    >
      <title>{`${displayName(person)} — ${where}. Показать карточку`}</title>
      <rect width={REF_CARD.width} height={REF_CARD.height} rx={12} />
      {nameLines.map((text, i) => (
        <text key={text} x={REF_CARD.width / 2} y={22 + i * 16} textAnchor="middle" className="name">
          {text}
        </text>
      ))}
      <text x={REF_CARD.width / 2} y={REF_CARD.height - 12} textAnchor="middle" className="meta">
        {where} ↗
      </text>
    </g>
  );
}

const PORTAL = { width: 92, height: 20 };
const LABEL_HEIGHT = 22;
/** Ниже панели инструментов в левом верхнем углу. */
const LABEL_TOP = 64;

const NAME_FONT = '12.5px "PT Serif", serif';
const BADGE_FONT = '12px "PT Serif", serif';
const LABEL_FONT = '12px "PT Serif", serif';
const LABEL_FONT_NARROW = '11px "PT Serif", serif';
const NARROW_LABEL_WIDTH = 18;
/** Ниже панели инструментов на телефоне (две строки). */
const NARROW_LABEL_TOP = 96;
/** Та же граница, что и у мобильной вёрстки в styles.css. */
const NARROW_QUERY = '(max-width: 720px)';

function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(NARROW_QUERY);
    if (!query) return;
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

let measureContext: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, font: string): number {
  if (measureContext === undefined) measureContext = document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * 6.5;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/** Разбивает текст по словам на строки не шире maxWidth; лишнее — с многоточием. */
function wrap(text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = '';
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const candidate = current ? `${current} ${words[i]}` : words[i];
    if (textWidth(candidate, NAME_FONT) <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = words[i];
    if (lines.length === maxLines - 1) {
      current = words.slice(i).join(' ');
      break;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => ellipsize(line, maxWidth));
}

function ellipsize(line: string, maxWidth: number): string {
  if (textWidth(line, NAME_FONT) <= maxWidth) return line;
  let cut = line;
  while (cut.length > 1 && textWidth(`${cut}…`, NAME_FONT) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Ортогональная ломаная со скруглёнными углами, как линии в familio. */
function roundedPath(points: { x: number; y: number }[], radius: number): string {
  if (points.length < 3) return points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [prev, corner, next] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(radius, dist(prev, corner) / 2, dist(corner, next) / 2);
    const a = toward(corner, prev, r);
    const b = toward(corner, next, r);
    d += ` L${a.x},${a.y} Q${corner.x},${corner.y} ${b.x},${b.y}`;
  }
  const last = points.at(-1)!;
  return `${d} L${last.x},${last.y}`;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const toward = (from: { x: number; y: number }, to: { x: number; y: number }, r: number) => {
  const length = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) / length) * r, y: from.y + ((to.y - from.y) / length) * r };
};

function centerAt(svg: SVGSVGElement, x: number, y: number, scale: number) {
  const { width, height } = svg.getBoundingClientRect();
  return zoomIdentity.translate(width / 2 - x * scale, height / 2 - y * scale).scale(scale);
}

function centerOn(svg: SVGSVGElement, position: { x: number; y: number }, scale: number) {
  return centerAt(svg, position.x + CARD.width / 2, position.y + CARD.height / 2, scale);
}

function fitAll(svg: SVGSVGElement, layout: Layout) {
  const { width, height } = svg.getBoundingClientRect();
  const scale = Math.min(width / layout.width, height / layout.height, 1);
  return zoomIdentity.translate((width - layout.width * scale) / 2, (height - layout.height * scale) / 2).scale(scale);
}
