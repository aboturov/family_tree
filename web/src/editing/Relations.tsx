import { useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, type RelationKind, type RelativeInput } from '../api.ts';
import { parentsOf } from '../tree/kinship.ts';
import { displayName, lifeYears, otherPartner, type Family, type Person, type TreeIndex } from '../tree/model.ts';
import { patronymicFor, patronymicFrom } from '../patronymic.ts';
import { surnameFor } from '../surname.ts';
import { useEditing } from './EditingContext.ts';
import { dateProblem, DateFields, emptyDate, joinDate, yearlessText, type PartialDate } from './dateFields.tsx';

export const RELATION_TITLES: Record<RelationKind, string> = {
  parent: 'Родитель',
  spouse: 'Супруг(а)',
  child: 'Ребёнок',
  sibling: 'Брат или сестра',
};

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Сервер недоступен, попробуйте позже');

/** Почему такую связь сейчас добавить нельзя (или null — можно). */
export function relationBlocker(index: TreeIndex, person: Person, relation: RelationKind): string | null {
  if (relation === 'parent' && parentsOf(index, person.id).length >= 2) return 'Оба родителя уже указаны';
  if (relation === 'sibling' && (index.familyAsChild.get(person.id) ?? []).length === 0) {
    return 'Сначала добавьте хотя бы одного родителя: брат или сестра связываются через общих родителей';
  }
  return null;
}

type FamilyChoice = { id: number | null; label: string };

const childrenNames = (index: TreeIndex, family: Family) =>
  family.children.map((c) => index.persons.get(c.id)?.givenName || 'без имени').join(', ');

/** Куда поставить ребёнка: в семью с одним из супругов или в новую, без второго родителя. */
function childFamilies(index: TreeIndex, person: Person): FamilyChoice[] {
  const choices: FamilyChoice[] = [];
  for (const family of index.familiesAsPartner.get(person.id) ?? []) {
    const partner = otherPartner(family, person.id);
    if (partner !== null) choices.push({ id: family.id, label: `с ${displayName(index.persons.get(partner)!)}` });
    else if (family.children.length > 0)
      choices.push({ id: family.id, label: `второй родитель неизвестен (к детям: ${childrenNames(index, family)})` });
  }
  choices.push({ id: null, label: 'второй родитель неизвестен' });
  return choices;
}

/** Супругу можно отдать детей, у которых второй родитель пока неизвестен. */
function spouseFamilies(index: TreeIndex, person: Person): FamilyChoice[] {
  const choices: FamilyChoice[] = [{ id: null, label: 'новая семья' }];
  for (const family of index.familiesAsPartner.get(person.id) ?? []) {
    if (otherPartner(family, person.id) === null && family.children.length > 0) {
      choices.push({ id: family.id, label: `родитель детей: ${childrenNames(index, family)}` });
    }
  }
  return choices;
}

function defaultSex(index: TreeIndex, person: Person, relation: RelationKind): 'M' | 'F' | 'U' {
  if (relation === 'spouse') return person.sex === 'M' ? 'F' : person.sex === 'F' ? 'M' : 'U';
  if (relation === 'parent') {
    const known = parentsOf(index, person.id).map((id) => index.persons.get(id)!.sex);
    if (known.includes('M')) return 'F';
    if (known.includes('F')) return 'M';
  }
  return 'U';
}

/** Фамилия по умолчанию: у детей мужчины и у братьев-сестёр — та же, что у человека; у жены — мужнина. */
function defaultSurname(person: Person, relation: RelationKind) {
  if (relation === 'sibling' || (relation === 'child' && person.sex === 'M')) return person.birthSurname || person.surname;
  if (relation === 'spouse' && person.sex === 'M') return person.surname;
  return '';
}

export function RelativeForm({
  person,
  index,
  relation,
  presetSex,
  onDone,
}: {
  person: Person;
  index: TreeIndex;
  relation: RelationKind;
  /** «+ Сын», «+ Жена» и т.п. — пол уже известен. */
  presetSex?: 'M' | 'F';
  onDone: (createdId: number | null) => void;
}) {
  const { reload } = useEditing();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  // Пока фамилию не правили руками, она подстраивается под выбранный пол: Орлов — Орлова.
  const [typedSurname, setSurname] = useState<string | null>(null);
  const [givenName, setGivenName] = useState('');
  const [typedPatronymic, setPatronymic] = useState<string | null>(null);
  const [typedBirthSurname, setBirthSurname] = useState<string | null>(null);
  const [sex, setSex] = useState<'M' | 'F' | 'U'>(presetSex ?? defaultSex(index, person, relation));
  const base = defaultSurname(person, relation);
  const surname = typedSurname ?? (base ? surnameFor(base, sex) : '');
  // Дочери и сестре фамилия отца — прежде всего фамилия при рождении: текущая может быть по мужу.
  const bornWith = (relation === 'child' || relation === 'sibling') && sex === 'F' && base ? surnameFor(base, sex) : '';
  const birthSurname = typedBirthSurname ?? bornWith;
  const [birth, setBirth] = useState<PartialDate>(emptyDate);
  const [existing, setExisting] = useState<number | null>(null);
  const families = relation === 'child' ? childFamilies(index, person) : relation === 'spouse' ? spouseFamilies(index, person) : [];
  const [familyId, setFamilyId] = useState<number | null>(families[0]?.id ?? null);
  // Отчество по умолчанию: ребёнку — по имени отца, брату или сестре — как у человека.
  const father = (() => {
    if (relation !== 'child') return undefined;
    if (person.sex === 'M') return person;
    const family = (index.familiesAsPartner.get(person.id) ?? []).find((f) => f.id === familyId);
    const partner = family ? otherPartner(family, person.id) : null;
    const p = partner !== null ? index.persons.get(partner) : undefined;
    return p?.sex === 'M' ? p : undefined;
  })();
  const defaultPatronymic =
    relation === 'child' && father
      ? patronymicFrom(father.givenName, sex)
      : relation === 'sibling' && person.patronymic
        ? patronymicFor(person.patronymic, sex)
        : '';
  const patronymic = typedPatronymic ?? defaultPatronymic;
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const blocker = relationBlocker(index, person, relation);
  if (blocker) return <p className="muted">{blocker}</p>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = mode === 'new' ? dateProblem(birth, 'Дата рождения') : null;
    if (problem) return setError(problem);
    const body: RelativeInput =
      mode === 'existing'
        ? { relation, existingId: existing, person: null, birth: null, familyId }
        : {
            relation,
            existingId: null,
            person: { surname, givenName, patronymic, birthSurname, sex },
            birth: birthInput(birth),
            familyId,
          };
    if (mode === 'existing' && existing === null) return setError('Выберите человека из списка');
    setPending(true);
    setError(undefined);
    try {
      const { id } = await api.addRelative(person.id, { ...body, version: person.version });
      await reload();
      onDone(id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="edit-form relative-form" onSubmit={submit}>
      <div className="segmented small" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'new'} className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>
          Новый человек
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'existing'}
          className={mode === 'existing' ? 'active' : ''}
          onClick={() => setMode('existing')}
        >
          Уже есть в дереве
        </button>
      </div>

      {mode === 'new' ? (
        <NewPersonFields
          value={{ surname, givenName, patronymic, birthSurname, sex, birth }}
          onChange={{
            surname: setSurname,
            givenName: setGivenName,
            patronymic: setPatronymic,
            birthSurname: setBirthSurname,
            sex: setSex,
            birth: setBirth,
          }}
        />
      ) : (
        <PersonPicker index={index} exclude={person.id} value={existing} onChange={setExisting} />
      )}

      {families.length > 1 && (
        <label>
          {relation === 'child' ? 'Второй родитель' : 'Семья'}
          <select value={familyId ?? ''} onChange={(e) => setFamilyId(e.target.value ? Number(e.target.value) : null)}>
            {families.map((f) => (
              <option key={f.id ?? 'new'} value={f.id ?? ''}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {relation === 'parent' && (index.familyAsChild.get(person.id)?.[0]?.children.length ?? 0) > 1 && (
        <p className="muted small">Родитель добавится и братьям-сёстрам из этой же семьи.</p>
      )}

      {error && <p className="error">{error}</p>}
      <div className="form-buttons">
        <button className="button" disabled={pending}>
          Добавить
        </button>
        <button type="button" className="button secondary" onClick={() => onDone(null)}>
          Отмена
        </button>
      </div>
    </form>
  );
}

type NewPerson = {
  surname: string;
  givenName: string;
  patronymic: string;
  birthSurname: string;
  sex: 'M' | 'F' | 'U';
  birth: PartialDate;
};

/** Дата рождения для API: точная или частичная дата, «12 марта» без года или ничего. */
export function birthInput(birth: PartialDate): RelativeInput['birth'] {
  const value = joinDate(birth);
  const text = yearlessText(birth);
  return value ? { modifier: 'exact', value } : text ? { dateText: text } : null;
}

/** Поля нового человека — для родственника и для первого человека в пустом дереве. */
export function NewPersonFields({
  value,
  onChange,
}: {
  value: NewPerson;
  onChange: { [K in keyof NewPerson]: (v: NewPerson[K]) => void };
}) {
  return (
    <>
      <label>
        Фамилия
        <input value={value.surname} onChange={(e) => onChange.surname(e.target.value)} maxLength={100} />
      </label>
      <label>
        Имя
        <input value={value.givenName} onChange={(e) => onChange.givenName(e.target.value)} maxLength={100} autoFocus />
      </label>
      <label>
        Отчество
        <input value={value.patronymic} onChange={(e) => onChange.patronymic(e.target.value)} maxLength={100} />
      </label>
      <label>
        Фамилия при рождении
        <input
          value={value.birthSurname}
          onChange={(e) => onChange.birthSurname(e.target.value)}
          maxLength={100}
          placeholder="если отличается — например, девичья"
        />
      </label>
      <fieldset>
        <legend>Пол</legend>
        <div className="choice-row">
          {(
            [
              ['M', 'мужской'],
              ['F', 'женский'],
              ['U', 'не указан'],
            ] as const
          ).map(([sex, label]) => (
            <label key={sex} className="choice">
              <input type="radio" name="relative-sex" checked={value.sex === sex} onChange={() => onChange.sex(sex)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Дата рождения, если известна</legend>
        <div className="date-row">
          <DateFields value={value.birth} onChange={onChange.birth} />
        </div>
      </fieldset>
    </>
  );
}

/** Поиск человека в дереве по имени. */
export function PersonPicker({
  index,
  exclude,
  value,
  onChange,
}: {
  index: TreeIndex;
  exclude: number;
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return [...index.persons.values()]
      .filter((p) => p.id !== exclude)
      .filter((p) => {
        const name = [p.surname, p.birthSurname, p.givenName, p.patronymic].join(' ').toLowerCase();
        return words.every((w) => name.includes(w));
      })
      .slice(0, 8);
  }, [index, exclude, query]);
  const chosen = value !== null ? index.persons.get(value) : undefined;

  return (
    <div className="person-picker">
      <label>
        Кто это
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(null);
          }}
          placeholder="Начните вводить фамилию или имя"
          autoFocus
        />
      </label>
      {chosen ? (
        <p className="picked">
          Выбран: <strong>{displayName(chosen)}</strong> {lifeYears(chosen)}
        </p>
      ) : (
        <ul className="plain picker-list">
          {matches.map((p) => (
            <li key={p.id}>
              <button type="button" className="link" onClick={() => onChange(p.id)}>
                {displayName(p)}
              </button>{' '}
              <span className="muted small">{lifeYears(p)}</span>
            </li>
          ))}
          {query && matches.length === 0 && <li className="muted">Никого не нашлось</li>}
        </ul>
      )}
    </div>
  );
}

/** Объединение дубля с этим человеком. */
export function MergeForm({ person, index, onDone }: { person: Person; index: TreeIndex; onDone: () => void }) {
  const { reload } = useEditing();
  const [duplicate, setDuplicate] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const dup = duplicate !== null ? index.persons.get(duplicate) : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (duplicate === null) return setError('Выберите дубль');
    setPending(true);
    setError(undefined);
    try {
      await api.mergePerson(person.id, duplicate, person.version);
      await reload();
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="edit-form" onSubmit={submit}>
      <p className="muted small">
        Если один и тот же человек попал в дерево дважды. Останется эта карточка; у дубля заберём недостающие поля,
        события, связи и фото, а саму его карточку удалим.
      </p>
      <PersonPicker index={index} exclude={person.id} value={duplicate} onChange={setDuplicate} />
      {dup && (
        <p>
          <strong>{displayName(dup)}</strong> станет частью карточки <strong>{displayName(person)}</strong>.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="form-buttons">
        <button className="button" disabled={pending || duplicate === null}>
          Объединить
        </button>
        <button type="button" className="button secondary" onClick={onDone}>
          Отмена
        </button>
      </div>
    </form>
  );
}
