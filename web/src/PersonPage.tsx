import { useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { Avatar } from './Avatar.tsx';
import { DocumentChips, DocumentsTab } from './documents/DocumentList.tsx';
import { useEditing } from './editing/EditingContext.ts';
import { EventDialog, PencilIcon, TrashIcon } from './editing/EventDialog.tsx';
import { PersonForm } from './editing/PersonForm.tsx';
import { PhotosTab } from './editing/Photos.tsx';
import { MergeForm } from './editing/Relations.tsx';
import { ClampedText, LinkedText } from './LongText.tsx';
import { Modal } from './Modal.tsx';
import {
  AddRelativeDialog,
  AddRelativeMenu,
  addOptions,
  errorText,
  eventDate,
  PersonLink,
  relativeItems,
  Summary,
  timelineItems,
  useUnlink,
  type AddOption,
  type RelativeItem,
  type TimelineItem,
} from './personShared.tsx';
import { Link, treePath } from './router.ts';
import { displayName, findEvent, formatDate, placeFull, shortDate, type Person, type TreeIndex } from './tree/model.ts';

type Props = { personId: number; index: TreeIndex; meId: number | null };
type Tab = 'events' | 'relatives' | 'photos' | 'documents' | 'bio';

export function PersonPage({ personId, index, meId }: Props) {
  const person = index.persons.get(personId);
  if (!person) {
    return (
      <main className="page">
        <p>Такого человека в дереве нет.</p>
        <Link to="/">К дереву</Link>
      </main>
    );
  }
  const pronoun = person.sex === 'F' ? 'неё' : 'него';
  const center = person.id === meId ? undefined : person.id;
  return (
    <main className="page person-page">
      <PersonCard
        key={person.id}
        person={person}
        index={index}
        actions={
          <div className="person-actions">
            <Link className="button" to={treePath({ center })}>
              Дерево от {pronoun}
            </Link>
            <Link className="button secondary" to={treePath({ view: 'relatives', center })}>
              Родня
            </Link>
          </div>
        }
      />
    </main>
  );
}

/** Страница человека — как в familio: шапка с колонками родни, вкладки, таблица событий. */
function PersonCard({ person, index, actions }: { person: Person; index: TreeIndex; actions: ReactNode }) {
  const [tab, setTab] = useState<Tab>('events');
  const [editing, setEditing] = useState(false);
  const [editingLinks, setEditingLinks] = useState(false);
  const [merging, setMerging] = useState(false);
  const [adding, setAdding] = useState<AddOption | null>(null);
  const { canEdit } = useEditing();
  const { unlink, error: linkError } = useUnlink();
  const { parents, spouses, children } = relativeItems(person, index);
  const options = addOptions(person, index);
  const option = (label: string) => (canEdit ? options.find((o) => o.label === label) : undefined);
  const fathers = parents.filter((p) => p.role !== 'Мать');
  const mothers = parents.filter((p) => p.role === 'Мать');
  const hasLinks = parents.length + spouses.length + children.length > 0;

  const column = (title: string, items: RelativeItem[], adds: (AddOption | undefined)[]) => (
    <RelativesColumn
      title={title}
      items={items}
      index={index}
      onUnlink={editingLinks ? unlink : undefined}
      adds={adds.filter((a): a is AddOption => a !== undefined)}
      onAdd={setAdding}
    />
  );

  return (
    <>
      <div className="card-head">
        <Avatar person={person} size={180} />
        <div className="card-main">
          {editing ? (
            <>
              <PersonForm person={person} onDone={() => setEditing(false)} />
              <DangerActions person={person} onMerge={() => setMerging(true)} />
            </>
          ) : (
            <>
              <div className="card-title">
                <h1>{displayName(person)}</h1>
                {actions}
              </div>
              <p className="person-summary">
                <Summary person={person} />
              </p>
              {person.isUncertain && <p className="badge-line">Данные под вопросом</p>}
              {canEdit && (
                <p className="edit-links">
                  <button className="link" onClick={() => setEditing(true)}>
                    ✎ Редактировать
                  </button>
                  <Link to={`/history?person=${person.id}`}>История правок</Link>
                  {hasLinks && (
                    <button className="link" onClick={() => setEditingLinks((v) => !v)}>
                      {editingLinks ? 'Готово' : 'Убрать связь…'}
                    </button>
                  )}
                </p>
              )}
              <div className="card-columns">
                <div>
                  {column('Отец', fathers, [option('Отец')])}
                  {column('Мать', mothers, [option('Мать')])}
                </div>
                {column('Супруги', spouses, [option('Жена') ?? option('Муж') ?? option('Супруг(а)')])}
                {column('Дети', children, [option('Сын'), option('Дочь')])}
              </div>
              {editingLinks && (
                <p className="muted small">Нажмите × у человека, чтобы убрать связь. Сам человек останется в дереве.</p>
              )}
              {linkError && <p className="error">{linkError}</p>}
            </>
          )}
        </div>
      </div>

      {adding && (
        <AddRelativeDialog person={person} index={index} option={adding} onClose={() => setAdding(null)} />
      )}
      {merging && (
        <Modal title={`Объединить с дублем — ${displayName(person)}`} onClose={() => setMerging(false)}>
          <MergeForm person={person} index={index} onDone={() => setMerging(false)} />
        </Modal>
      )}

      <div className="tabs" role="tablist">
        {(
          [
            ['events', 'События'],
            ['relatives', 'Родственники'],
            ['photos', person.photos.length ? `Фото (${person.photos.length})` : 'Фото'],
            ['documents', person.documents.length ? `Документы (${person.documents.length})` : 'Документы'],
            ['bio', 'Биография'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'events' && <EventsTable person={person} index={index} />}
      {tab === 'relatives' && <Relatives person={person} index={index} />}
      {tab === 'photos' && <PhotosTab person={person} />}
      {tab === 'documents' && <DocumentsTab person={person} index={index} />}
      {tab === 'bio' &&
        (person.bio ? (
          <p className="bio">
            <LinkedText text={person.bio} />
          </p>
        ) : (
          <p className="muted">Биография пока не заполнена.</p>
        ))}
    </>
  );
}

function RelativesColumn({
  title,
  items,
  index,
  onUnlink,
  adds,
  onAdd,
}: {
  title: string;
  items: RelativeItem[];
  index: TreeIndex;
  onUnlink?: (u: RelativeItem['unlink']) => void;
  adds: AddOption[];
  onAdd: (o: AddOption) => void;
}) {
  if (items.length === 0 && adds.length === 0) return null;
  return (
    <section className="card-column">
      <h3>{title}</h3>
      <ul className="plain">
        {items.map((item) => {
          const p = index.persons.get(item.id)!;
          const born = shortDate(findEvent(p.events, 'birth'));
          return (
            <li key={item.id}>
              <PersonLink id={item.id}>{displayName(p)}</PersonLink>
              {onUnlink && (
                <button className="unlink" onClick={() => onUnlink(item.unlink)} aria-label={`Убрать связь с ${displayName(p)}`}>
                  ×
                </button>
              )}
              {born && <div className="small">{born} г.р.</div>}
              {item.note && <div className="muted small">{item.note}</div>}
            </li>
          );
        })}
      </ul>
      {adds.length > 0 && (
        <p className="quick-adds">
          {adds.map((o) => (
            <button key={o.label} className="link" onClick={() => onAdd(o)}>
              + {o.label}
            </button>
          ))}
        </p>
      )}
    </section>
  );
}

/** В режиме правки карточки: объединить с дублем и удалить человека. */
export function DangerActions({ person, onMerge }: { person: Person; onMerge: () => void }) {
  const { reload } = useEditing();
  const [error, setError] = useState<string>();
  const remove = async () => {
    const question =
      `Удалить ${displayName(person)} из дерева вместе с событиями и фото? ` +
      'Связи с родственниками пропадут. Отменить можно в «Истории».';
    if (!confirm(question)) return;
    try {
      await api.deletePerson(person.id, person.version);
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="danger-actions">
      <button className="link" onClick={onMerge}>
        Объединить с дублем…
      </button>
      <button className="link danger-link" onClick={remove}>
        Удалить человека
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Удаление события прямо из ленты, с подтверждением. */
export function useDeleteEvent() {
  const { reload } = useEditing();
  const [error, setError] = useState<string>();
  const remove = async (item: TimelineItem) => {
    if (!confirm(`Удалить событие «${item.label}»?`)) return;
    setError(undefined);
    try {
      await api.deleteEvent(item.event.id, item.owner.version);
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return { remove, error };
}

/** События таблицей, как в familio; в узкой колонке — карточками одна под другой. */
function EventsTable({ person, index }: { person: Person; index: TreeIndex }) {
  const { canEdit } = useEditing();
  const [dialog, setDialog] = useState<{ item?: TimelineItem } | null>(null);
  const { remove, error } = useDeleteEvent();
  const items = timelineItems(person, index);

  return (
    <div className="events">
      {canEdit && (
        <button className="add-wide" onClick={() => setDialog({})}>
          Добавить
        </button>
      )}
      {error && <p className="error">{error}</p>}
      {items.length === 0 ? (
        <p className="muted">Событий пока нет.</p>
      ) : (
        <div className="events-table">
          <div className="events-head" aria-hidden="true">
            <span>Событие</span>
            <span>Дата</span>
            <span>Участники</span>
            <span>Место</span>
          </div>
          {items.map((item) => (
            <div className="event-row" key={item.key}>
              <div className="ev-head">
                <span className="ev-type">
                  {item.label} <DocumentChips ids={item.event.documents} />
                </span>
                <em className="ev-date">{eventDate(item.event)}</em>
              </div>
              {item.participants.length > 0 && (
                <div className="ev-cell ev-participants">
                  <span className="ev-label">Участники</span>
                  {item.participants.map((p) => (
                    <div key={`${p.role}${p.id}`}>
                      {p.role}: <PersonLink id={p.id}>{displayName(index.persons.get(p.id)!)}</PersonLink>
                    </div>
                  ))}
                </div>
              )}
              {item.event.place && (
                <div className="ev-cell ev-place">
                  <span className="ev-label">Место</span>
                  {placeFull(item.event.place.name)}
                </div>
              )}
              {/* Комментарий — не колонкой, а под участниками и местом на их ширину: длинный
                  текст в узкой колонке вытягивал строку на экран. */}
              {item.event.note && (
                <div className="ev-cell ev-note">
                  <span className="ev-label">Комментарий</span>
                  <ClampedText text={item.event.note} />
                </div>
              )}
              {canEdit && (
                <div className="ev-actions">
                  <button className="square-button" onClick={() => setDialog({ item })} aria-label="Изменить событие">
                    <PencilIcon />
                  </button>
                  {item.deletable && (
                    <button className="square-button" onClick={() => remove(item)} aria-label="Удалить событие">
                      <TrashIcon />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
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
    </div>
  );
}

function Relatives({ person, index }: { person: Person; index: TreeIndex }) {
  const { canEdit } = useEditing();
  const { parents, spouses, children, siblings } = relativeItems(person, index);
  const families = index.familiesAsPartner.get(person.id) ?? [];
  // Второго родителя подписываем, только когда браков несколько и дети от разных.
  const secondParent = (childId: number) => {
    if (families.length < 2) return undefined;
    const family = families.find((f) => f.children.some((c) => c.id === childId))!;
    const partner = family.partners.find((p) => p !== null && p !== person.id);
    if (partner == null) return undefined;
    const p = index.persons.get(partner)!;
    return `${p.sex === 'M' ? 'Отец' : p.sex === 'F' ? 'Мать' : 'Второй родитель'} ребёнка: ${displayName(p)}`;
  };

  const sections = [
    { title: 'Родители', items: parents },
    { title: 'Супруги', items: spouses },
    { title: 'Дети', items: children.map((c) => ({ ...c, note: secondParent(c.id) })) },
    { title: 'Братья и сёстры', items: siblings },
  ];

  return (
    <div className="relatives">
      {canEdit && (
        <div className="section-actions">
          <AddRelativeMenu person={person} index={index} />
        </div>
      )}
      {sections
        .filter((s) => s.items.length)
        .map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            {section.items.map((entry) => {
              const p = index.persons.get(entry.id)!;
              const birth = findEvent(p.events, 'birth');
              const death = findEvent(p.events, 'death');
              return (
                <div key={entry.id} className="relative">
                  <div className="field-label">{entry.role}</div>
                  <PersonLink id={p.id}>{displayName(p)}</PersonLink>
                  {entry.note && <div className="muted small">{entry.note}</div>}
                  <dl>
                    {birth?.date && (
                      <>
                        <dt>Дата рождения</dt>
                        <dd>{formatDate(birth)}</dd>
                      </>
                    )}
                    {birth?.place && (
                      <>
                        <dt>Место рождения</dt>
                        <dd>{placeFull(birth.place.name)}</dd>
                      </>
                    )}
                    {(death?.date || p.isDeceased) && (
                      <>
                        <dt>Дата смерти</dt>
                        <dd>{death?.date ? formatDate(death) : 'Неизвестно'}</dd>
                      </>
                    )}
                  </dl>
                </div>
              );
            })}
          </section>
        ))}
    </div>
  );
}
