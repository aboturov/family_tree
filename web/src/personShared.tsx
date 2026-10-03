import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type RelationKind } from './api.ts';
import { MedalIcon } from './Avatar.tsx';
import { useEditing } from './editing/EditingContext.ts';
import type { EventOwner } from './editing/EventDialog.tsx';
import { RelativeForm } from './editing/Relations.tsx';
import { Modal } from './Modal.tsx';
import { Link, personPath } from './router.ts';
import { sortTimeline } from './timelineOrder.ts';
import { parentsOf, siblingsOf } from './tree/kinship.ts';
import {
  awardsOf,
  awardTitle,
  displayName,
  eventLabel,
  findEvent,
  formatDate,
  oldStyle,
  otherPartner,
  placeFull,
  type Family,
  type Person,
  type TreeEvent,
  type TreeIndex,
} from './tree/model.ts';

// Общее для карточки на странице и в боковой панели дерева: ссылки на людей, лента событий,
// связи с отвязкой и меню «Добавить» родственника.

/**
 * Как открывать человека по ссылке внутри карточки. На странице — переход на его страницу;
 * в боковой панели дерева — выбрать его в дереве, не уходя со схемы.
 */
const PersonOpenContext = createContext<((id: number) => void) | null>(null);
export const PersonOpenProvider = PersonOpenContext.Provider;

export function PersonLink({ id, children }: { id: number; children: ReactNode }) {
  const open = useContext(PersonOpenContext);
  if (!open) return <Link to={personPath(id)}>{children}</Link>;
  return (
    <a
      href={personPath(id)}
      onClick={(e) => {
        // Ctrl/⌘-клик — как у обычной ссылки, страница человека в новой вкладке.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        open(id);
      }}
    >
      {children}
    </a>
  );
}

export const roleOf = (p: Person, male: string, female: string, unknown: string) =>
  p.sex === 'M' ? male : p.sex === 'F' ? female : unknown;

export const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Сервер недоступен, попробуйте позже';

/** «мужской, родился 14.05.1976, Тверь, Тверская область; умер …». */
export function Summary({ person }: { person: Person }) {
  const female = person.sex === 'F';
  const birth = findEvent(person.events, 'birth');
  const death = findEvent(person.events, 'death');
  const parts: string[] = [];
  const where = (e: TreeEvent | undefined) => (e?.place ? `, ${placeFull(e.place.name)}` : '');
  if (birth?.date || birth?.place)
    parts.push(`${female ? 'родилась' : 'родился'} ${birth.date ? formatDate(birth) : ''}${where(birth)}`);
  if (death?.date || death?.place)
    parts.push(`${female ? 'умерла' : 'умер'} ${death.date ? formatDate(death) : ''}${where(death)}`);
  else if (person.isDeceased) parts.push(female ? 'умерла' : 'умер');
  const sex = person.sex === 'M' ? 'мужской' : person.sex === 'F' ? 'женский' : '';
  return (
    <>
      {sex && <strong>{sex}</strong>}
      {sex && parts.length > 0 && ', '}
      {parts.join('; ')}
    </>
  );
}

/** Награды под строкой о рождении: медаль вместо слова «Награды», дальше названия и годы. */
export function Awards({ person }: { person: Person }) {
  const awards = awardsOf(person);
  if (!awards.length) return null;
  return (
    <p className="awards-line">
      <MedalIcon />
      {awards.map(awardTitle).join(', ')}
    </p>
  );
}

/** «брак 1973 · развод 1990»: бывших супругов видно сразу, без ленты событий. */
export function marriageNote(family: Family): string | undefined {
  const year = (type: string) => findEvent(family.events, type)?.date?.value.slice(0, 4);
  const married = findEvent(family.events, 'marriage');
  const divorced = findEvent(family.events, 'divorce');
  const parts = [
    married && `брак${year('marriage') ? ` ${year('marriage')}` : ''}`,
    divorced && `развод${year('divorce') ? ` ${year('divorce')}` : ''}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

const numeric = (value: string) => {
  const [y, m, d] = value.split('-');
  return [d, m, String(Number(y))].filter(Boolean).join('.');
};

/** Дата события для ленты, как в familio: «14.05.1955», «около 1955», без даты — «Неизвестно». */
export function eventDate(event: TreeEvent): string {
  const { date } = event;
  if (!date) return event.dateText || 'Неизвестно';
  return eventDateValue(date) + oldStyle(event);
}

function eventDateValue(date: NonNullable<TreeEvent['date']>): string {
  const value = numeric(date.value);
  switch (date.modifier) {
    case 'about':
    case 'estimated':
    case 'calculated':
      return `около ${value}`;
    case 'before':
      return `до ${value}`;
    case 'after':
      return `после ${value}`;
    case 'between':
      return `${value}–${numeric(date.valueTo!)}`;
    default:
      return value;
  }
}

// --- Лента событий ---

export type TimelineItem = {
  key: string;
  event: TreeEvent;
  label: string;
  participants: { role: string; id: number }[];
  /** Чьё событие — для правки. У «Рождения ребёнка» это сам ребёнок. */
  owner: EventOwner;
  /** Удалять можно только своё событие, а не производное вроде «Рождения ребёнка». */
  deletable: boolean;
  familyId?: number;
  /** Заготовка: рождения или бракосочетания ещё нет — строка «Неизвестно», по карандашу событие создаётся. */
  placeholder?: boolean;
};

const emptyEvent = (type: string): TreeEvent => ({
  id: 0,
  type,
  customType: '',
  details: '',
  date: null,
  dateText: '',
  place: null,
  note: '',
});

/** Свои события, события браков и рождения детей — как в familio. */
export function timelineItems(person: Person, index: TreeIndex): TimelineItem[] {
  const items: TimelineItem[] = [];
  const parents = parentsOf(index, person.id);
  const self: EventOwner = { kind: 'person', id: person.id, version: person.version };

  for (const event of person.events) {
    const participants =
      event.type === 'birth'
        ? parents.map((id) => ({ role: roleOf(index.persons.get(id)!, 'Отец', 'Мать', 'Родитель'), id }))
        : [];
    // Как в familio: рождение из ленты не удаляют (только из окна события).
    items.push({ key: `e${event.id}`, event, label: eventLabel(event), participants, owner: self, deletable: event.type !== 'birth' });
  }
  // Как в familio: рождение в ленте есть всегда, чтобы было ясно, куда вписать дату.
  const parentRoles = parents.map((id) => ({ role: roleOf(index.persons.get(id)!, 'Отец', 'Мать', 'Родитель'), id }));
  if (!findEvent(person.events, 'birth')) {
    items.push({
      key: 'birth-placeholder',
      event: emptyEvent('birth'),
      label: 'Рождение',
      participants: parentRoles,
      owner: self,
      deletable: false,
      placeholder: true,
    });
  }
  for (const family of index.familiesAsPartner.get(person.id) ?? []) {
    const partner = otherPartner(family, person.id);
    const spouse = partner !== null ? index.persons.get(partner)! : undefined;
    // Как и рождение: у брака с известным супругом бракосочетание в ленте есть всегда.
    if (spouse && !findEvent(family.events, 'marriage')) {
      items.push({
        key: `marriage-placeholder-${family.id}`,
        event: emptyEvent('marriage'),
        label: 'Бракосочетание',
        participants: [{ role: roleOf(spouse, 'Муж', 'Жена', 'Супруг(а)'), id: spouse.id }],
        owner: { kind: 'family', id: family.id, version: family.version },
        deletable: false,
        familyId: family.id,
        placeholder: true,
      });
    }
    for (const event of family.events) {
      items.push({
        key: `f${event.id}`,
        event,
        label: event.type === 'marriage' ? 'Бракосочетание' : eventLabel(event),
        participants: spouse ? [{ role: roleOf(spouse, 'Муж', 'Жена', 'Супруг(а)'), id: spouse.id }] : [],
        owner: { kind: 'family', id: family.id, version: family.version },
        deletable: true,
        familyId: family.id,
      });
    }
    for (const child of family.children) {
      const kid = index.persons.get(child.id)!;
      const birth = findEvent(kid.events, 'birth');
      if (!birth) continue;
      items.push({
        key: `c${birth.id}`,
        event: birth,
        label: 'Рождение ребёнка',
        familyId: family.id,
        participants: [
          { role: roleOf(kid, 'Сын', 'Дочь', 'Ребёнок'), id: kid.id },
          ...(spouse
            ? [{ role: roleOf(spouse, 'Отец ребёнка', 'Мать ребёнка', 'Второй родитель'), id: spouse.id }]
            : []),
        ],
        owner: { kind: 'person', id: kid.id, version: kid.version },
        deletable: false,
      });
    }
  }
  return sortTimeline(items);
}

// --- Связи ---

export type RelativeItem = {
  id: number;
  role: string;
  note?: string;
  /** Вопрос перед отвязкой и сама отвязка; сам человек остаётся в дереве. */
  unlink: { question: string; run: () => Promise<unknown> };
};

/** Родители, супруги, дети и братья-сёстры с готовой отвязкой. */
export function relativeItems(person: Person, index: TreeIndex) {
  const name = (id: number) => displayName(index.persons.get(id)!);
  const families = index.familiesAsPartner.get(person.id) ?? [];

  const parents: RelativeItem[] = parentsOf(index, person.id).map((id) => {
    const family = (index.familyAsChild.get(person.id) ?? []).find((f) => f.partners.includes(id))!;
    const others = family.children.filter((c) => c.id !== person.id).map((c) => name(c.id));
    const alsoSiblings = others.length ? ` Родителем перестанет быть и у: ${others.join(', ')}.` : '';
    return {
      id,
      role: roleOf(index.persons.get(id)!, 'Отец', 'Мать', 'Родитель'),
      unlink: {
        question: `Убрать ${name(id)} из родителей ${name(person.id)}?${alsoSiblings}`,
        run: () => api.removePartner(family.id, id, family.version),
      },
    };
  });

  const spouses: RelativeItem[] = families.flatMap((f) => {
    const id = otherPartner(f, person.id);
    if (id === null) return [];
    const kids = f.children.length ? ' Общие дети останутся у второго родителя.' : '';
    return [
      {
        id,
        role: roleOf(index.persons.get(id)!, 'Муж', 'Жена', 'Супруг(а)'),
        note: marriageNote(f),
        unlink: {
          question: `Убрать связь «супруги» между ${name(person.id)} и ${name(id)}?${kids}`,
          run: () => api.removePartner(f.id, id, f.version),
        },
      },
    ];
  });

  // Один ребёнок может оказаться в двух семьях — показываем один раз.
  const seen = new Set<number>();
  const children: RelativeItem[] = families.flatMap((f) =>
    f.children
      .filter((c) => !seen.has(c.id) && seen.add(c.id))
      .map((c) => ({
        id: c.id,
        role: roleOf(index.persons.get(c.id)!, 'Сын', 'Дочь', 'Ребёнок'),
        unlink: {
          question: `Убрать ${name(c.id)} из детей ${f.partners
            .filter((p): p is number => p !== null)
            .map(name)
            .join(' и ')}? Все останутся в дереве.`,
          run: () => api.removeChild(f.id, c.id, f.version),
        },
      })),
  );

  const siblings: RelativeItem[] = [...siblingsOf(index, person.id)].map((id) => {
    const family = (index.familyAsChild.get(person.id) ?? []).find((f) => f.children.some((c) => c.id === id))!;
    return {
      id,
      role: roleOf(index.persons.get(id)!, 'Брат', 'Сестра', 'Брат или сестра'),
      unlink: {
        question: `Убрать ${name(id)} из детей этих родителей? Все останутся в дереве.`,
        run: () => api.removeChild(family.id, id, family.version),
      },
    };
  });

  return { parents, spouses, children, siblings };
}

/** Отвязка с подтверждением и перезагрузкой дерева. */
export function useUnlink() {
  const { reload } = useEditing();
  const [error, setError] = useState<string>();
  const unlink = async ({ question, run }: RelativeItem['unlink']) => {
    if (!confirm(question)) return;
    setError(undefined);
    try {
      await run();
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return { unlink, error };
}

// --- Добавление родственника ---

export type AddOption = { label: string; relation: RelationKind; sex?: 'M' | 'F' };

/** Только подходящие варианты: «+ Отец», если отца нет, и т.п. */
export function addOptions(person: Person, index: TreeIndex): AddOption[] {
  const parentSexes = parentsOf(index, person.id).map((id) => index.persons.get(id)!.sex);
  const options: AddOption[] = [];
  if (parentSexes.length < 2) {
    if (!parentSexes.includes('M')) options.push({ label: 'Отец', relation: 'parent', sex: 'M' });
    if (!parentSexes.includes('F')) options.push({ label: 'Мать', relation: 'parent', sex: 'F' });
  }
  options.push(
    person.sex === 'M'
      ? { label: 'Жена', relation: 'spouse', sex: 'F' }
      : person.sex === 'F'
        ? { label: 'Муж', relation: 'spouse', sex: 'M' }
        : { label: 'Супруг(а)', relation: 'spouse' },
  );
  options.push({ label: 'Сын', relation: 'child', sex: 'M' }, { label: 'Дочь', relation: 'child', sex: 'F' });
  if ((index.familyAsChild.get(person.id) ?? []).length > 0) {
    options.push({ label: 'Брат', relation: 'sibling', sex: 'M' }, { label: 'Сестра', relation: 'sibling', sex: 'F' });
  }
  return options;
}

/** Форма нового родственника в окне. */
export function AddRelativeDialog({
  person,
  index,
  option,
  onClose,
}: {
  person: Person;
  index: TreeIndex;
  option: AddOption;
  onClose: () => void;
}) {
  return (
    <Modal title={`${option.label} — ${displayName(person)}`} onClose={onClose}>
      <RelativeForm person={person} index={index} relation={option.relation} presetSex={option.sex} onDone={onClose} />
    </Modal>
  );
}

/** Ссылка «Добавить» с меню подходящих родственников, как в familio. */
export function AddRelativeMenu({ person, index }: { person: Person; index: TreeIndex }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<AddOption | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="add-menu" ref={ref}>
      <button className="link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Добавить
      </button>
      {open && (
        <ul className="add-menu-list" role="menu">
          {addOptions(person, index).map((o) => (
            <li key={o.label}>
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setChosen(o);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {chosen && <AddRelativeDialog person={person} index={index} option={chosen} onClose={() => setChosen(null)} />}
    </div>
  );
}
