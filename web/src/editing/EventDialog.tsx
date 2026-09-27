import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type EventInput } from '../api.ts';
import { Modal } from '../Modal.tsx';
import {
  displayName,
  eventLabel,
  findEvent,
  otherPartner,
  type Family,
  type Person,
  type TreeEvent,
  type TreeIndex,
} from '../tree/model.ts';
import { dateProblem, DateFields, joinDate, parseYearless, splitDate, usePlaceSuggestions, yearlessText } from './dateFields.tsx';
import { useEditing } from './EditingContext.ts';
import { eventTypeGroups, FAMILY_EVENT_OPTIONS, OTHER, optionFor, PERSON_EVENT_OPTIONS } from './eventTypes.ts';

// Окно события — как в familio: сначала тип, для брака и развода — супруг (вместо вопроса
// «чьё событие»), дальше «Когда», дата, комментарий и место под ссылкой.

export type EventOwner = { kind: 'person' | 'family'; id: number; version: number };

const WHEN = [
  ['exact', 'Дата'],
  ['about', 'Около'],
  ['before', 'До'],
  ['after', 'После'],
  ['between', 'Между'],
] as const;

const FAMILY_VALUES = new Set(FAMILY_EVENT_OPTIONS.map((o) => o.value));

/** Поле с подписью внутри рамки. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ffield">
      <span>{label}</span>
      {children}
    </label>
  );
}

function spouseLabel(person: Person) {
  return person.sex === 'M' ? 'Жена' : person.sex === 'F' ? 'Муж' : 'Супруг(а)';
}

function marriageYears(family: Family) {
  const year = (type: string) => findEvent(family.events, type)?.date?.value.slice(0, 4);
  const parts = [year('marriage') && `брак ${year('marriage')}`, findEvent(family.events, 'divorce') && 'развод'];
  return parts.filter(Boolean).join(', ');
}

/** Браки человека: кого выбрать в поле «Жена»/«Муж». */
function marriageOptions(person: Person, index: TreeIndex) {
  return (index.familiesAsPartner.get(person.id) ?? []).map((f) => {
    const partner = otherPartner(f, person.id);
    const name = partner !== null ? displayName(index.persons.get(partner)!) : 'не указан(а)';
    const years = marriageYears(f);
    return { family: f, label: years ? `${name} (${years})` : name };
  });
}

export function EventDialog({
  person,
  index,
  event,
  owner,
  presetType,
  presetFamilyId,
  onClose,
}: {
  /** Чья карточка открыта. */
  person: Person;
  index: TreeIndex;
  /** Правка — событие и его владелец; без них — новое событие. */
  event?: TreeEvent;
  owner?: EventOwner;
  /** Новое событие известного типа (из заготовки «Рождение — Неизвестно»): тип не спрашиваем. */
  presetType?: string;
  /** Для заготовки «Бракосочетание — Неизвестно»: какой это брак. */
  presetFamilyId?: number;
  onClose: () => void;
}) {
  const { reload } = useEditing();
  const editing = event !== undefined && owner !== undefined;
  const allOptions = [...FAMILY_EVENT_OPTIONS, ...PERSON_EVENT_OPTIONS];
  const marriages = marriageOptions(person, index);

  const [typeValue, setTypeValue] = useState(
    editing
      ? optionFor(owner.kind === 'family' ? FAMILY_EVENT_OPTIONS : PERSON_EVENT_OPTIONS, event.type, event.customType)
      : (presetType ?? ''),
  );
  const [customName, setCustomName] = useState(event?.type === 'custom' ? event.customType : '');
  const initialWhen =
    event?.date?.modifier === 'estimated' || event?.date?.modifier === 'calculated' ? 'about' : event?.date?.modifier;
  const [when, setWhen] = useState<string>(initialWhen ?? 'exact');
  // Дата без года хранится текстом — разбираем обратно, чтобы правка её не затёрла.
  const yearless = !event?.date && event?.dateText ? parseYearless(event.dateText) : null;
  const [from, setFrom] = useState(yearless ?? splitDate(event?.date?.value));
  const [to, setTo] = useState(splitDate(event?.date?.valueTo));
  const [familyId, setFamilyId] = useState<number | null>(
    owner?.kind === 'family' ? owner.id : (presetFamilyId ?? marriages[0]?.family.id ?? null),
  );
  const [note, setNote] = useState(event?.note ?? '');
  const [place, setPlace] = useState(event?.place?.name ?? '');
  const [placeOpen, setPlaceOpen] = useState(Boolean(event?.place));
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const places = usePlaceSuggestions(placeOpen ? place : '');
  const listId = useId();

  const isFamily = editing ? owner.kind === 'family' : FAMILY_VALUES.has(typeValue);
  const isOther = typeValue === OTHER;
  const chosen = allOptions.find((o) => o.value === typeValue);
  const typeName = (e: TreeEvent) => (e.type === 'marriage' ? 'Бракосочетание' : eventLabel(e));
  const title = editing
    ? isOther
      ? customName || 'Событие'
      : typeName(event)
    : presetType
      ? (chosen?.label ?? 'Событие')
      : 'Новое событие';

  const fail = (err: unknown) => {
    setError(err instanceof ApiError ? err.message : 'Сервер недоступен, попробуйте позже');
    setConflict(err instanceof ApiError && err.status === 409);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!typeValue) return setError('Выберите тип события');
    if (isFamily && familyId === null) return setError(`Сначала добавьте супруга: ${spouseLabel(person).toLowerCase()} выбирается из браков`);
    const problem = dateProblem(from) ?? (when === 'between' ? dateProblem(to, 'Вторая дата') : null);
    if (problem) return setError(problem);
    const value = joinDate(from);
    const valueTo = when === 'between' ? joinDate(to) : null;
    const dateText = yearlessText(from);
    if (dateText && when !== 'exact') return setError('Дата: для «около», «до», «после» и «между» нужен год');
    if (when === 'between' && value && !valueTo) return setError('Укажите вторую дату периода');
    const input: EventInput = {
      type: isOther ? 'custom' : chosen!.type,
      customType: isOther ? customName : chosen!.customType,
      date: value ? { modifier: when, value, ...(valueTo ? { valueTo } : {}) } : null,
      dateText: dateText ?? '',
      place: placeOpen ? place : '',
      note,
    };
    setPending(true);
    setError(undefined);
    try {
      if (editing) {
        const moving = owner.kind === 'family' && familyId !== null && familyId !== owner.id;
        await api.updateEvent(event.id, { ...input, version: owner.version, ...(moving ? { moveToFamily: familyId } : {}) });
      } else if (isFamily) {
        const family = marriages.find((m) => m.family.id === familyId)!.family;
        await api.addEvent({ kind: 'family', id: family.id }, { ...input, version: family.version });
      } else {
        await api.addEvent({ kind: 'person', id: person.id }, { ...input, version: person.version });
      }
      await reload();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!editing || !confirm('Удалить это событие?')) return;
    setPending(true);
    try {
      await api.deleteEvent(event.id, owner.version);
      await reload();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      heading={
        editing || presetType ? (
          <div>
            <div className="modal-caption">Событие</div>
            <strong>{title}</strong>
          </div>
        ) : undefined
      }
    >
      <form className="event-dialog" onSubmit={submit}>
        {!editing && !presetType && (
          <Field label="Тип события">
            <select value={typeValue} onChange={(e) => setTypeValue(e.target.value)} autoFocus>
              <option value="" disabled>
                Выберите
              </option>
              {eventTypeGroups(new Set(person.events.map((e) => e.type))).map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value={OTHER}>Другое…</option>
            </select>
          </Field>
        )}

        {(typeValue || editing) && (
          <>
            {isOther && (
              <Field label="Название события">
                <input value={customName} onChange={(e) => setCustomName(e.target.value)} required maxLength={100} />
              </Field>
            )}

            <Field label="Когда">
              <select value={when} onChange={(e) => setWhen(e.target.value)}>
                {WHEN.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="date-parts">
              <DateFields value={from} onChange={setFrom} />
            </div>
            {when === 'between' && (
              <div className="date-parts">
                <DateFields value={to} onChange={setTo} />
              </div>
            )}
            {event?.dateText && !yearless && <p className="muted small">В выгрузке было: «{event.dateText}»</p>}

            {isFamily &&
              (marriages.length ? (
                <Field label={spouseLabel(person)}>
                  <select value={familyId ?? ''} onChange={(e) => setFamilyId(Number(e.target.value))}>
                    {marriages.map((m) => (
                      <option key={m.family.id} value={m.family.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <p className="muted small">
                  Брака пока нет — сначала добавьте {person.sex === 'F' ? 'мужа' : person.sex === 'M' ? 'жену' : 'супруга'}{' '}
                  в «Родственниках».
                </p>
              ))}

            <textarea
              className="ffield-area"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Комментарий"
              rows={3}
              maxLength={5000}
            />

            {placeOpen ? (
              <Field label="Место">
                <input
                  value={place}
                  onChange={(e) => setPlace(e.target.value)}
                  list={listId}
                  maxLength={300}
                  placeholder="Тверская область, город Тверь"
                  autoFocus={!event?.place}
                />
                <datalist id={listId}>
                  {places.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </Field>
            ) : (
              <button type="button" className="link small-link" onClick={() => setPlaceOpen(true)}>
                Указать место события
              </button>
            )}
          </>
        )}

        {error && (
          <p className="error">
            {error}
            {conflict && (
              <>
                {' '}
                <button type="button" className="link" onClick={() => reload().then(onClose)}>
                  Обновить
                </button>
              </>
            )}
          </p>
        )}
        <div className="dialog-buttons">
          {editing && (
            <button type="button" className="square-button" onClick={remove} disabled={pending} aria-label="Удалить событие">
              <TrashIcon />
            </button>
          )}
          <button type="button" className="button secondary" onClick={onClose} disabled={pending}>
            Отмена
          </button>
          <button className="button" disabled={pending}>
            {editing ? 'Сохранить' : 'Добавить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10.5 2.6a2 2 0 0 1 2.9 0 2 2 0 0 1 0 2.9l-.3.3-2.9-2.9.3-.3ZM9.5 3.6l2.9 2.9-6.7 6.7-3.3.6a.4.4 0 0 1-.5-.5l.6-3.3 7-6.4Z"
      />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 1.5h4a1 1 0 0 1 1 1V3h2.5a.75.75 0 0 1 0 1.5H13l-.7 8.6a1.5 1.5 0 0 1-1.5 1.4H5.2a1.5 1.5 0 0 1-1.5-1.4L3 4.5h-.5a.75.75 0 0 1 0-1.5H5v-.5a1 1 0 0 1 1-1Zm.5 4.5v6h1V6h-1Zm2 0v6h1V6h-1Z"
      />
    </svg>
  );
}
