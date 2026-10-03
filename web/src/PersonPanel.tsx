import { useState, type ReactNode } from 'react';
import { Avatar } from './Avatar.tsx';
import { useEditing } from './editing/EditingContext.ts';
import { EventDialog, PencilIcon } from './editing/EventDialog.tsx';
import { PersonForm } from './editing/PersonForm.tsx';
import { DocumentChips, DocumentIcon, DocumentsTab } from './documents/DocumentList.tsx';
import { PhotosTab } from './editing/Photos.tsx';
import { MergeForm } from './editing/Relations.tsx';
import { LinkedText } from './LongText.tsx';
import { Modal } from './Modal.tsx';
import { DangerActions, useDeleteEvent } from './PersonPage.tsx';
import {
  AddRelativeMenu,
  Awards,
  eventDate,
  PersonLink,
  relativeItems,
  Summary,
  timelineItems,
  useUnlink,
  type TimelineItem,
} from './personShared.tsx';
import { Link, personPath } from './router.ts';
import { cardDates, displayName, findEvent, placeFull, shortDate, type Person, type TreeIndex } from './tree/model.ts';

// Боковая панель дерева — как TreeSidebar в familio: без вкладок, секциями сверху вниз,
// длинные списки свёрнуты («Ещё N»), события раскрываются по клику.

const FOLDED = 3;

export function PersonPanel({
  person,
  index,
  kinship,
  onBuild,
  onCollapse,
  onClose,
}: {
  person: Person;
  index: TreeIndex;
  /** «Двоюродный дед — брат дедушки»; у центра дерева — нет. */
  kinship?: ReactNode;
  /** Построить дерево от этого человека; нет — он уже в центре. */
  onBuild?: () => void;
  /** Свернуть в мини-карточку в углу; пока открыт редактор, кнопки нет. */
  onCollapse?: () => void;
  onClose: () => void;
}) {
  const { canEdit } = useEditing();
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const pronoun = person.sex === 'F' ? 'неё' : 'него';

  return (
    <div className="panel">
      <div className="panel-top">
        <Avatar person={person} size={96} />
        <div className="panel-icons">
          {canEdit && !editing && (
            <button className="plain-icon" onClick={() => setEditing(true)} aria-label="Редактировать" title="Редактировать">
              <PencilIcon />
            </button>
          )}
          {onCollapse && !editing && (
            <button className="plain-icon" onClick={onCollapse} aria-label="Свернуть карточку" title="Свернуть в угол">
              <CollapseIcon />
            </button>
          )}
          <button className="plain-icon close" onClick={onClose} aria-label="Закрыть карточку">
            ×
          </button>
        </div>
      </div>

      {editing ? (
        <>
          <PersonForm person={person} onDone={() => setEditing(false)} />
          <DangerActions person={person} onMerge={() => setMerging(true)} />
        </>
      ) : (
        <>
          <h2 className="panel-name">{displayName(person)}</h2>
          {kinship && <p className="panel-kinship">{kinship}</p>}
          <p className="panel-summary">
            <Summary person={person} />
          </p>
          <Awards person={person} />
          <div className="pills">
            {onBuild && (
              <button className="pill grey" onClick={onBuild}>
                Построить от {pronoun}
              </button>
            )}
            {/* Страница — в новой вкладке, чтобы не терять дерево. */}
            <a className="pill" href={personPath(person.id)} target="_blank" rel="noopener">
              Страница
            </a>
            <Link className="pill" to={`/history?person=${person.id}`}>
              История изменений
            </Link>
          </div>
        </>
      )}
      {merging && (
        <Modal title={`Объединить с дублем — ${displayName(person)}`} onClose={() => setMerging(false)}>
          <MergeForm person={person} index={index} onDone={() => setMerging(false)} />
        </Modal>
      )}

      <RelativesSection person={person} index={index} />
      <EventsSection person={person} index={index} />
      <PanelSection title={person.photos.length ? `Фото (${person.photos.length})` : 'Фото'}>
        <PhotosTab person={person} />
      </PanelSection>
      <PanelSection title={person.documents.length ? `Документы (${person.documents.length})` : 'Документы'}>
        <DocumentsTab person={person} index={index} />
      </PanelSection>
      <PanelSection
        title="Биография"
        action={
          canEdit && (
            <button className="link" onClick={() => setEditing(true)}>
              {person.bio ? 'Изменить' : 'Добавить'}
            </button>
          )
        }
      >
        {person.bio ? (
          <p className="bio">
            <LinkedText text={person.bio} />
          </p>
        ) : (
          <p className="muted">Пока не заполнена.</p>
        )}
      </PanelSection>
    </div>
  );
}

/**
 * Свёрнутая карточка — в углу поверх дерева, не сужая его: кто это, кем приходится и «Построить
 * от него». Развернуть — клик по карточке или по стрелке; вид (свёрнута/развёрнута) один на всех.
 */
export function PersonMiniCard({
  person,
  kinship,
  onBuild,
  onExpand,
  onClose,
}: {
  person: Person;
  kinship?: string;
  onBuild?: () => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const dates = cardDates(person);
  return (
    <div className="mini-card" role="dialog" aria-label={displayName(person)}>
      <div className="mini-card-head">
        <button className="mini-card-main" onClick={onExpand} title="Развернуть карточку">
          <Avatar person={person} size={48} />
          <span className="mini-card-text">
            <span className="mini-card-name">{displayName(person)}</span>
            {(kinship || dates) && (
              <span className="muted small">{[kinship, dates].filter(Boolean).join(' · ')}</span>
            )}
          </span>
        </button>
        <div className="panel-icons">
          <button className="plain-icon" onClick={onExpand} aria-label="Развернуть карточку" title="Развернуть">
            <ExpandIcon />
          </button>
          <button className="plain-icon close" onClick={onClose} aria-label="Закрыть карточку">
            ×
          </button>
        </div>
      </div>
      {onBuild && (
        <button className="pill grey" onClick={onBuild}>
          Построить от {person.sex === 'F' ? 'неё' : 'него'}
        </button>
      )}
    </div>
  );
}

// Значки вида карточки: рамка экрана и что в ней занимает карточка. На десктопе развёрнутая —
// колонка справа, свёрнутая — плашка в углу; на телефоне — шторка и полоска снизу.
const Frame = ({ children }: { children: ReactNode }) => (
  <>
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
    {children}
  </>
);

const ExpandIcon = () => (
  <>
    <svg className="icon-wide" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <Frame>
        <rect x="11" y="3.75" width="6.25" height="12.5" rx="1" fill="currentColor" />
      </Frame>
    </svg>
    <svg className="icon-narrow" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <Frame>
        <rect x="2.75" y="8" width="14.5" height="8.25" rx="1" fill="currentColor" />
      </Frame>
    </svg>
  </>
);

const CollapseIcon = () => (
  <>
    <svg className="icon-wide" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <Frame>
        <rect x="10.5" y="10.5" width="5" height="4" rx="0.75" fill="currentColor" />
      </Frame>
    </svg>
    <svg className="icon-narrow" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <Frame>
        <rect x="2.75" y="12.5" width="14.5" height="3.75" rx="1" fill="currentColor" />
      </Frame>
    </svg>
  </>
);

function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel-section">
      <div className="panel-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Первые три, остальное — под «Ещё N». */
function Folded<T>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, FOLDED);
  return (
    <>
      {shown.map(render)}
      {items.length > FOLDED && (
        <button className="link more" onClick={() => setOpen((v) => !v)}>
          {open ? 'Свернуть' : `Ещё ${items.length - FOLDED}`}
        </button>
      )}
    </>
  );
}

function RelativesSection({ person, index }: { person: Person; index: TreeIndex }) {
  const { canEdit } = useEditing();
  const [editingLinks, setEditingLinks] = useState(false);
  const { unlink, error } = useUnlink();
  const { parents, spouses, children, siblings } = relativeItems(person, index);
  const all = [...parents, ...spouses, ...children, ...siblings];

  return (
    <PanelSection
      title="Родственники"
      action={
        canEdit && (
          <div className="section-links">
            {all.length > 0 && (
              <button className="link" onClick={() => setEditingLinks((v) => !v)}>
                {editingLinks ? 'Готово' : 'Изменить'}
              </button>
            )}
            <AddRelativeMenu person={person} index={index} />
          </div>
        )
      }
    >
      {error && <p className="error">{error}</p>}
      {all.length === 0 && <p className="muted">Пока никого.</p>}
      <Folded
        items={all}
        render={(item) => {
          const p = index.persons.get(item.id)!;
          const born = shortDate(findEvent(p.events, 'birth'));
          return (
            <div key={`${item.role}${item.id}`} className="plate">
              <div className="plate-label">{item.role}</div>
              <PersonLink id={p.id}>{displayName(p)}</PersonLink> {born && <span className="muted">{born}</span>}
              {item.note && <div className="muted small">{item.note}</div>}
              {editingLinks && (
                <button className="unlink plate-unlink" onClick={() => unlink(item.unlink)} aria-label={`Убрать связь с ${displayName(p)}`}>
                  ×
                </button>
              )}
            </div>
          );
        }}
      />
    </PanelSection>
  );
}

function EventsSection({ person, index }: { person: Person; index: TreeIndex }) {
  const { canEdit } = useEditing();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ item?: TimelineItem } | null>(null);
  const { remove, error } = useDeleteEvent();
  const items = timelineItems(person, index);

  return (
    <PanelSection
      title="События"
      action={
        canEdit && (
          <button className="link" onClick={() => setDialog({})}>
            Добавить
          </button>
        )
      }
    >
      {error && <p className="error">{error}</p>}
      {items.length === 0 && <p className="muted">Событий пока нет.</p>}
      <Folded
        items={items}
        render={(item) => {
          const open = openKey === item.key;
          return (
            <div key={item.key} className={open ? 'plate accordion open' : 'plate accordion'}>
              <button className="accordion-head" onClick={() => setOpenKey(open ? null : item.key)} aria-expanded={open}>
                <span className="accordion-title">
                  <strong>{item.label}</strong> <span className="muted">{eventDate(item.event)}</span>
                  {item.event.documents?.length ? <DocumentIcon size={14} /> : null}
                  {item.event.details && <span className="accordion-details">{item.event.details}</span>}
                </span>
                <svg className="chevron" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="currentColor" d="M17.46 9.44a.76.76 0 0 1 0 1.07l-4.78 4.78a1 1 0 0 1-1.41 0L6.49 10.5a.76.76 0 1 1 1.07-1.07L12 13.85l4.4-4.41a.76.76 0 0 1 1.07 0Z" />
                </svg>
              </button>
              {open && (
                <div className="accordion-body">
                  {item.participants.map((p) => (
                    <div key={`${p.role}${p.id}`}>
                      <div className="plate-label">{p.role}</div>
                      <PersonLink id={p.id}>{displayName(index.persons.get(p.id)!)}</PersonLink>
                    </div>
                  ))}
                  {item.event.place && (
                    <div>
                      <div className="plate-label">Место</div>
                      {placeFull(item.event.place.name)}
                    </div>
                  )}
                  {item.event.note && (
                    <div>
                      <div className="plate-label">Комментарий</div>
                      <div className="long-text">
                        <LinkedText text={item.event.note} />
                      </div>
                    </div>
                  )}
                  {item.event.documents?.length ? (
                    <div>
                      <div className="plate-label">Подтверждают документы</div>
                      <DocumentChips ids={item.event.documents} named />
                    </div>
                  ) : null}
                  {canEdit && (
                    <div className="accordion-footer">
                      <button className="link" onClick={() => setDialog({ item })}>
                        {item.placeholder ? 'Указать дату и место' : 'Редактировать'}
                      </button>
                      {item.deletable && (
                        <button className="link danger-link" onClick={() => remove(item)}>
                          Удалить
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        }}
      />
      {dialog && (
        <EventDialog
          person={person}
          index={index}
          event={dialog.item?.placeholder ? undefined : dialog.item?.event}
          owner={dialog.item?.placeholder ? undefined : dialog.item?.owner}
          presetType={dialog.item?.placeholder ? dialog.item.event.type : undefined}
          presetFamilyId={dialog.item?.placeholder ? dialog.item.familyId : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </PanelSection>
  );
}
