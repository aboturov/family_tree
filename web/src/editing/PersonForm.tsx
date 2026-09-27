import { useState, type FormEvent } from 'react';
import { api, ApiError, type PersonInput } from '../api.ts';
import type { Person } from '../tree/model.ts';
import { useEditing } from './EditingContext.ts';

export function PersonForm({ person, onDone }: { person: Person; onDone: () => void }) {
  const { reload } = useEditing();
  const [fields, setFields] = useState<PersonInput>({
    givenName: person.givenName,
    patronymic: person.patronymic,
    surname: person.surname,
    birthSurname: person.birthSurname,
    sex: person.sex,
    isDeceased: person.isDeceased,
    isUncertain: person.isUncertain,
    bio: person.bio,
  });
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const set = <K extends keyof PersonInput>(key: K, value: PersonInput[K]) =>
    setFields((f) => ({ ...f, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await api.updatePerson(person.id, { ...fields, version: person.version });
      await reload();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Сервер недоступен, попробуйте позже');
      setConflict(err instanceof ApiError && err.status === 409);
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="edit-form" onSubmit={submit}>
      <label>
        Фамилия
        <input value={fields.surname} onChange={(e) => set('surname', e.target.value)} maxLength={100} />
      </label>
      <label>
        Имя
        <input value={fields.givenName} onChange={(e) => set('givenName', e.target.value)} maxLength={100} autoFocus />
      </label>
      <label>
        Отчество
        <input value={fields.patronymic} onChange={(e) => set('patronymic', e.target.value)} maxLength={100} />
      </label>
      <label>
        Фамилия при рождении
        <input
          value={fields.birthSurname}
          onChange={(e) => set('birthSurname', e.target.value)}
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
          ).map(([value, label]) => (
            <label key={value} className="choice">
              <input type="radio" name="sex" checked={fields.sex === value} onChange={() => set('sex', value)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="choice">
        <input type="checkbox" checked={fields.isDeceased} onChange={(e) => set('isDeceased', e.target.checked)} />
        Умер{fields.sex === 'F' ? 'ла' : ''} (даже если дата неизвестна)
      </label>
      <label className="choice">
        <input type="checkbox" checked={fields.isUncertain} onChange={(e) => set('isUncertain', e.target.checked)} />
        Данные под вопросом
      </label>
      <label>
        Биография
        <textarea value={fields.bio} onChange={(e) => set('bio', e.target.value)} rows={6} maxLength={20000} />
      </label>

      {error && (
        <p className="error">
          {error}
          {conflict && (
            <>
              {' '}
              <button type="button" className="link" onClick={() => reload().then(onDone)}>
                Обновить
              </button>
            </>
          )}
        </p>
      )}
      <div className="form-buttons">
        <button className="button" disabled={pending}>
          Сохранить
        </button>
        <button type="button" className="button secondary" onClick={onDone} disabled={pending}>
          Отмена
        </button>
      </div>
    </form>
  );
}
