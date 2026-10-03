import { useId, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, type DocumentInput, type DocumentView } from '../api.ts';
import { DateFields, dateProblem, isOldStyleEra, joinDate, splitDate, WHEN } from '../editing/dateFields.tsx';
import { useEditing } from '../editing/EditingContext.ts';
import { eventDate } from '../personShared.tsx';
import { displayName, eventTitle, lifeYears, type TreeEvent, type TreeIndex } from '../tree/model.ts';
import { DOCUMENT_ROLES, DOCUMENT_TYPES } from './labels.ts';

// Карточка документа. Обязателен только тип: документ заводят и по одному шифру, а скан, людей
// и расшифровку добавляют, когда они появятся.

const TYPE_GROUPS: [string, string[]][] = [
  ['Метрические книги', ['metric_birth', 'metric_marriage', 'metric_death']],
  ['ЗАГС', ['civil_birth', 'civil_marriage', 'civil_death', 'civil_index']],
  ['Переписи и учёт', ['census', 'confession', 'revision', 'household']],
  ['Репрессии', ['investigation', 'rehabilitation']],
  ['Военные документы', ['award', 'service_record', 'loss_report', 'death_notice', 'military_id']],
  ['Семейные бумаги', ['certificate', 'personal', 'letter']],
  ['Другое', ['database', 'other']],
];

type Link = { id: number; role: string };

export function DocumentForm({
  document,
  preset,
  index,
  all,
  onSaved,
  onCancel,
}: {
  /** Правка; без него — новый документ. */
  document?: DocumentView;
  preset?: Partial<DocumentInput>;
  index: TreeIndex;
  /** Все документы — подсказки архивов. */
  all: DocumentView[];
  onSaved: (id: number) => void;
  onCancel: () => void;
}) {
  const { reload } = useEditing();
  const start = { ...preset, ...document };
  const [type, setType] = useState(start.type ?? '');
  const [title, setTitle] = useState(start.title ?? '');
  const initialWhen = start.date?.modifier === 'estimated' || start.date?.modifier === 'calculated' ? 'about' : start.date?.modifier;
  const [when, setWhen] = useState<string>(initialWhen ?? 'exact');
  const [from, setFrom] = useState(splitDate(start.date?.value));
  const [to, setTo] = useState(splitDate(start.date?.valueTo));
  const [julian, setJulian] = useState(start.date?.calendar === 'julian');
  const [archive, setArchive] = useState(start.archive ?? '');
  const [fond, setFond] = useState(start.fond ?? '');
  const [opis, setOpis] = useState(start.opis ?? '');
  const [delo, setDelo] = useState(start.delo ?? '');
  const [sheets, setSheets] = useState(start.sheets ?? '');
  const [url, setUrl] = useState(start.url ?? '');
  const [transcription, setTranscription] = useState(start.transcription ?? '');
  const [note, setNote] = useState(start.note ?? '');
  const [persons, setPersons] = useState<Link[]>(start.persons ?? []);
  const [events, setEvents] = useState<Set<number>>(new Set(start.events ?? []));
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const archivesId = useId();
  const archives = useMemo(() => [...new Set(all.map((d) => d.archive).filter(Boolean))].sort(), [all]);
  const eventOptions = useMemo(() => eventsOf(persons.map((p) => p.id), index), [persons, index]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!type) return setError('Выберите тип документа');
    const problem = dateProblem(from, 'Дата документа') ?? (when === 'between' ? dateProblem(to, 'Вторая дата') : null);
    if (problem) return setError(problem);
    if ((from.month || from.day) && !from.year) return setError('Дата документа: укажите год');
    const value = joinDate(from);
    const valueTo = when === 'between' ? joinDate(to) : null;
    if (when === 'between' && value && !valueTo) return setError('Укажите вторую дату периода');
    const input: DocumentInput = {
      type,
      title,
      date: value ? { modifier: when, value, ...(valueTo ? { valueTo } : {}), ...(julian ? { calendar: 'julian' as const } : {}) } : null,
      archive,
      fond,
      opis,
      delo,
      sheets,
      url,
      transcription,
      note,
      persons,
      // Только события людей, что остались в документе.
      events: eventOptions.filter((o) => events.has(o.event.id)).map((o) => o.event.id),
    };
    setPending(true);
    setError(undefined);
    try {
      const id = document ? (await api.updateDocument(document.id, { ...input, version: document.version }), document.id) : (await api.addDocument(input)).id;
      await reload();
      onSaved(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Сервер недоступен, попробуйте позже');
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="doc-form" onSubmit={submit}>
      <div className="doc-form-row">
        <label>
          Тип
          <select value={type} onChange={(e) => setType(e.target.value)} required autoFocus={!document}>
            <option value="" disabled>
              Выберите
            </option>
            {TYPE_GROUPS.map(([group, types]) => (
              <optgroup key={group} label={group}>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {DOCUMENT_TYPES[t]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          Название
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            placeholder={DOCUMENT_TYPES[type] ? `${DOCUMENT_TYPES[type]} — если нужно точнее` : 'Если нужно точнее типа'}
          />
        </label>
      </div>

      <fieldset className="doc-form-date">
        <legend>Дата документа — когда составлен, а не когда было событие</legend>
        <div className="doc-form-when">
          <select value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Точность даты">
            {WHEN.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <div className="date-parts">
            <DateFields value={from} onChange={setFrom} />
          </div>
        </div>
        {when === 'between' && (
          <div className="date-parts doc-form-to">
            <DateFields value={to} onChange={setTo} />
          </div>
        )}
        {(julian || isOldStyleEra(from.year)) && (
          <label className="choice">
            <input type="checkbox" checked={julian} onChange={(e) => setJulian(e.target.checked)} />
            По старому стилю
          </label>
        )}
      </fieldset>

      <fieldset>
        <legend>Где хранится оригинал</legend>
        <label>
          Архив
          <input value={archive} onChange={(e) => setArchive(e.target.value)} list={archivesId} maxLength={300} placeholder="Архив или «семейный архив, у кого»" />
          <datalist id={archivesId}>
            {archives.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </label>
        <div className="doc-form-shelfmark">
          <label>
            Фонд
            <input value={fond} onChange={(e) => setFond(e.target.value)} maxLength={50} placeholder="Р-100" />
          </label>
          <label>
            Опись
            <input value={opis} onChange={(e) => setOpis(e.target.value)} maxLength={50} placeholder="2а" />
          </label>
          <label>
            Дело
            <input value={delo} onChange={(e) => setDelo(e.target.value)} maxLength={50} placeholder="15А" />
          </label>
          <label>
            Лист
            <input value={sheets} onChange={(e) => setSheets(e.target.value)} maxLength={100} placeholder="12об.–13" />
          </label>
        </div>
        <label>
          Ссылка на дело в онлайн-архиве
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={1000} placeholder="https://" />
        </label>
      </fieldset>

      <fieldset>
        <legend>Люди в документе</legend>
        {persons.length === 0 && <p className="muted small">Можно оставить пустым, пока родство не подтверждено.</p>}
        <ul className="plain doc-form-people">
          {persons.map((link) => {
            const p = index.persons.get(link.id);
            return (
              <li key={link.id}>
                <span className="doc-form-name">{p ? displayName(p) : `№${link.id}`}</span>
                <select
                  value={link.role}
                  onChange={(e) => setPersons(persons.map((x) => (x.id === link.id ? { ...x, role: e.target.value } : x)))}
                  aria-label="Роль в документе"
                >
                  {Object.entries(DOCUMENT_ROLES).map(([role, label]) => (
                    <option key={role} value={role}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => setPersons(persons.filter((x) => x.id !== link.id))}
                  aria-label={`Убрать ${p ? displayName(p) : ''} из документа`}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
        <AddPerson
          index={index}
          exclude={persons.map((p) => p.id)}
          onAdd={(id) => setPersons([...persons, { id, role: persons.length ? 'mentioned' : 'subject' }])}
        />
      </fieldset>

      {eventOptions.length > 0 && (
        <fieldset>
          <legend>Что документ подтверждает</legend>
          {eventOptions.map(({ event, label }) => (
            <label key={event.id} className="choice">
              <input
                type="checkbox"
                checked={events.has(event.id)}
                onChange={(e) => {
                  const next = new Set(events);
                  if (e.target.checked) next.add(event.id);
                  else next.delete(event.id);
                  setEvents(next);
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}

      <label>
        Расшифровка
        <textarea value={transcription} onChange={(e) => setTranscription(e.target.value)} rows={8} maxLength={50000} placeholder="Текст документа как есть" />
      </label>
      <label>
        Заметки
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={10000}
          placeholder="Что не сходится, что проверить, откуда документ"
        />
      </label>

      {error && <p className="error">{error}</p>}
      <div className="form-buttons">
        <button className="button" disabled={pending}>
          {document ? 'Сохранить' : 'Добавить'}
        </button>
        <button type="button" className="button secondary" onClick={onCancel} disabled={pending}>
          Отмена
        </button>
      </div>
    </form>
  );
}

/** События людей документа и их браков — чем документ может быть подтверждением. */
function eventsOf(ids: number[], index: TreeIndex): { event: TreeEvent; label: string }[] {
  const options = new Map<number, { event: TreeEvent; label: string }>();
  for (const id of ids) {
    const person = index.persons.get(id);
    if (!person) continue;
    for (const event of person.events) {
      options.set(event.id, { event, label: `${eventTitle(event)}, ${eventDate(event)} — ${displayName(person)}` });
    }
    for (const family of index.familiesAsPartner.get(id) ?? []) {
      const names = family.partners
        .map((p) => (p !== null ? index.persons.get(p) : undefined))
        .filter((p) => p !== undefined)
        .map(displayName)
        .join(' и ');
      for (const event of family.events) {
        const what = event.type === 'marriage' ? 'Бракосочетание' : eventTitle(event);
        options.set(event.id, { event, label: `${what}, ${eventDate(event)} — ${names}` });
      }
    }
  }
  return [...options.values()];
}

function AddPerson({ index, exclude, onAdd }: { index: TreeIndex; exclude: number[]; onAdd: (id: number) => void }) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const words = query.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return [...index.persons.values()]
      .filter((p) => !exclude.includes(p.id))
      .filter((p) => {
        const name = [p.surname, p.birthSurname, p.givenName, p.patronymic].join(' ').toLowerCase().replace(/ё/g, 'е');
        return words.every((w) => name.includes(w));
      })
      .slice(0, 8);
  }, [index, exclude, query]);

  return (
    <div className="doc-form-add">
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Добавить человека: фамилия или имя" aria-label="Добавить человека" />
      {query && (
        <ul className="plain picker-list">
          {matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="link"
                onClick={() => {
                  onAdd(p.id);
                  setQuery('');
                }}
              >
                {displayName(p)}
              </button>{' '}
              <span className="muted small">{lifeYears(p)}</span>
            </li>
          ))}
          {matches.length === 0 && <li className="muted">Никого не нашлось</li>}
        </ul>
      )}
    </div>
  );
}
