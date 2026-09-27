import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';
import { useEditing } from './EditingContext.ts';
import { dateProblem, emptyDate, type PartialDate } from './dateFields.tsx';
import { birthInput, NewPersonFields } from './Relations.tsx';

/**
 * Пустое дерево: редактор добавляет первого человека, остальных — родственниками из его карточки.
 * Без этого начать можно было только с импорта GEDCOM.
 */
export function EmptyTree({ onCreated }: { onCreated: (id: number) => void }) {
  const { canEdit, reload } = useEditing();
  const [surname, setSurname] = useState('');
  const [givenName, setGivenName] = useState('');
  const [patronymic, setPatronymic] = useState('');
  const [birthSurname, setBirthSurname] = useState('');
  const [sex, setSex] = useState<'M' | 'F' | 'U'>('U');
  const [birth, setBirth] = useState<PartialDate>(emptyDate);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  if (!canEdit) {
    return (
      <p className="placeholder">
        Дерево пока пустое. Первого человека добавит редактор, или администратор импортирует выгрузку GEDCOM.
      </p>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = dateProblem(birth, 'Дата рождения');
    if (problem) return setError(problem);
    setPending(true);
    setError(undefined);
    try {
      const { id } = await api.addFirstPerson({
        person: { surname, givenName, patronymic, birthSurname, sex },
        birth: birthInput(birth),
      });
      await reload();
      onCreated(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Сервер недоступен, попробуйте позже');
      setPending(false);
    }
  };

  return (
    <div className="empty-tree">
      <h1>Дерево пока пустое</h1>
      <p className="muted">
        Начните с себя или с любого человека — остальных добавите из его карточки: родителей, супругов, детей. Есть
        выгрузка GEDCOM из другого сервиса — её импортирует администратор командой <code>tree-admin import</code>.
      </p>
      <form className="edit-form" onSubmit={submit}>
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
        {error && <p className="error">{error}</p>}
        <div className="form-buttons">
          <button className="button" disabled={pending}>
            Добавить
          </button>
        </div>
      </form>
    </div>
  );
}
