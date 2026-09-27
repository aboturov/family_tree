import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type HistoryItem, type PersonRef, type User } from './api.ts';
import { useEditing } from './editing/EditingContext.ts';
import { Link, personPath } from './router.ts';
import { eventLabel, type TreeEvent, type TreeIndex } from './tree/model.ts';

const RELATION_WORDS: Record<string, [string, string, string]> = {
  parent: ['отец', 'мать', 'родитель'],
  spouse: ['муж', 'жена', 'супруг(а)'],
  child: ['сын', 'дочь', 'ребёнок'],
  sibling: ['брат', 'сестра', 'брат или сестра'],
};
const bySex = (sex: PersonRef['sex'], [m, f, u]: [string, string, string]) => (sex === 'M' ? m : sex === 'F' ? f : u);
// «удалён» / «удалена» / «удалён(а)».
const ending = (sex: PersonRef['sex'], base: string) => (sex === 'M' ? base : sex === 'F' ? `${base}а` : `${base}(а)`);

const LEGACY_ENTITIES: Record<string, string> = {
  person: 'карточка человека',
  family: 'семья',
  event: 'событие',
  place: 'место',
  media: 'фото',
};

function Who({ person, index }: { person: PersonRef; index: TreeIndex }) {
  // Удалённого человека показываем просто именем.
  return index.persons.has(person.id) ? <Link to={personPath(person.id)}>{person.name}</Link> : <span>{person.name}</span>;
}

function People({ people, index }: { people: PersonRef[]; index: TreeIndex }) {
  return (
    <>
      {people.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ' и '}
          <Who person={p} index={index} />
        </span>
      ))}
    </>
  );
}

/** Что сделано, по-человечески: «Орлов Максим: добавлен сын Орлов Фёдор». */
export function describe(action: string, d: Record<string, unknown>, index: TreeIndex): ReactNode {
  const person = d.person as PersonRef;
  const event = () => eventLabel({ type: d.type, customType: d.customType } as TreeEvent);
  switch (action) {
    case 'person.add':
      return (
        <>
          <Who person={person} index={index} />: {ending(person.sex, 'добавлен')} в дерево
        </>
      );
    case 'person.update':
      return (
        <>
          <Who person={person} index={index} />: изменена карточка
        </>
      );
    case 'person.delete':
      return (
        <>
          <Who person={person} index={index} />: {ending(person.sex, 'удалён')} из дерева
        </>
      );
    case 'person.merge':
      return (
        <>
          <Who person={person} index={index} />: {ending(person.sex, 'объединён')} с дублем «{(d.duplicate as PersonRef).name}»
        </>
      );
    case 'relative.add': {
      const relative = d.relative as PersonRef;
      const word = bySex(relative.sex, RELATION_WORDS[d.relation as string] ?? ['родственник', 'родственница', 'родственник']);
      return (
        <>
          <Who person={d.anchor as PersonRef} index={index} />: {d.created ? ending(relative.sex, 'добавлен') : 'указан(а) как'}{' '}
          {word} <Who person={relative} index={index} />
        </>
      );
    }
    case 'link.remove':
      return d.kind === 'child' ? (
        <>
          <Who person={person} index={index} />: убрана связь с родителями{' '}
          <People people={d.others as PersonRef[]} index={index} />
        </>
      ) : (
        <>
          <Who person={person} index={index} />: убрана связь «супруги»
          {(d.others as PersonRef[]).length > 0 && (
            <>
              {' '}с <People people={d.others as PersonRef[]} index={index} />
            </>
          )}
        </>
      );
    case 'event.add':
    case 'event.update':
    case 'event.delete': {
      const verb = action === 'event.add' ? 'добавлено' : action === 'event.update' ? 'изменено' : 'удалено';
      return (
        <>
          <People people={d.people as PersonRef[]} index={index} />: {verb} событие «{event()}»
        </>
      );
    }
    case 'media.add':
      return (
        <>
          <Who person={person} index={index} />: добавлено фото
        </>
      );
    case 'media.update':
      return (
        <>
          <Who person={person} index={index} />: изменена подпись к фото
        </>
      );
    case 'media.delete':
      return (
        <>
          <Who person={person} index={index} />: удалено фото
        </>
      );
    case 'avatar.set':
      return (
        <>
          <Who person={person} index={index} />: {d.mediaId === null ? 'убрана аватарка' : 'выбрана аватарка'}
        </>
      );
    case 'undo':
      return <>Отменено — {describe(d.action as string, d.details as Record<string, unknown>, index)}</>;
    case 'legacy':
      return <>Правка до появления истории: {LEGACY_ENTITIES[d.entity as string] ?? d.entity}</>;
    default:
      return action;
  }
}

// SQLite хранит время в UTC без пояса: «2026-09-24 13:19:50».
const when = (at: string) =>
  new Date(`${at.replace(' ', 'T')}Z`).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

type Row = { item: HistoryItem; legacyCount: number };

// Правки до появления истории — отдельные строки журнала; подряд идущие одного человека сворачиваем.
function groupLegacy(items: HistoryItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    const last = rows.at(-1);
    if (item.action === 'legacy' && last?.item.action === 'legacy' && last.item.user === item.user) last.legacyCount++;
    else rows.push({ item, legacyCount: item.action === 'legacy' ? 1 : 0 });
  }
  return rows;
}

export function HistoryPage({ index, user, personId }: { index: TreeIndex; user: User; personId?: number }) {
  const { canEdit, reload } = useEditing();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const person = personId !== undefined ? index.persons.get(personId) : undefined;

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      try {
        const page = await api.history({ before, person: personId });
        setItems((current) => (before ? [...current, ...page.items] : page.items));
        setHasMore(page.hasMore);
      } catch {
        setError('Не удалось загрузить историю');
      } finally {
        setLoading(false);
      }
    },
    [personId],
  );
  useEffect(() => {
    load();
  }, [load]);

  const undo = async (item: HistoryItem) => {
    if (!confirm('Отменить эту правку? Дерево вернётся к тому, что было до неё.')) return;
    setError(undefined);
    try {
      await api.undo(item.id);
      await Promise.all([reload(), load()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Сервер недоступен, попробуйте позже');
    }
  };
  const mayUndo = (item: HistoryItem) =>
    canEdit && item.undoable && (user.role === 'admin' || item.userId === user.id);

  return (
    <main className="page history-page">
      <h1>История правок</h1>
      {person && (
        <p>
          Только правки, где упоминается <Link to={personPath(person.id)}>{person.givenName || 'этот человек'}</Link>.{' '}
          <Link to="/history">Вся история</Link>
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {!loading && items.length === 0 && <p className="muted">Правок пока не было.</p>}
      <ul className="history">
        {groupLegacy(items).map(({ item, legacyCount }) => (
          <li key={item.id} className={item.undoneBy ? 'undone' : undefined}>
            <div className="history-meta muted small">
              {when(item.at)} · {item.user ?? 'удалённый пользователь'}
            </div>
            <div className="history-text">
              {legacyCount > 1
                ? `Правки до появления истории: ${legacyCount} записей журнала`
                : describe(item.action, item.details, index)}
            </div>
            {item.undoneBy && (
              <div className="muted small">
                Отменено {when(item.undoneBy.at)} · {item.undoneBy.user ?? 'удалённый пользователь'}
              </div>
            )}
            {mayUndo(item) && (
              <button className="button secondary small" onClick={() => undo(item)}>
                Отменить
              </button>
            )}
          </li>
        ))}
      </ul>
      {hasMore && (
        <button className="button secondary" disabled={loading} onClick={() => load(items.at(-1)!.id)}>
          Показать ещё
        </button>
      )}
    </main>
  );
}
