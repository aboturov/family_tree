import { useMemo, useState } from 'react';
import { Avatar } from './Avatar.tsx';
import { Link, personPath } from './router.ts';
import { cardDates, displayName, findEvent, placeShort, type Person, type Tree } from './tree/model.ts';

type Filter = 'all' | 'living' | 'deceased';

export function PeoplePage({ tree }: { tree: Tree }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const people = useMemo(() => {
    const words = query.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    return tree.persons
      .filter((p) => filter === 'all' || (filter === 'deceased') === p.isDeceased)
      .filter((p) => {
        const haystack = searchText(p);
        return words.every((w) => haystack.includes(w));
      })
      .sort((a, b) => displayName(a).localeCompare(displayName(b), 'ru'));
  }, [tree, query, filter]);

  return (
    <main className="page people-page">
      <h1>Люди</h1>
      <div className="people-filters">
        <input
          type="search"
          placeholder="Фамилия, имя или отчество"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Поиск"
        />
        <div className="segmented small" role="radiogroup" aria-label="Кого показывать">
          {(
            [
              ['all', 'Все'],
              ['living', 'Живые'],
              ['deceased', 'Умершие'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} role="radio" aria-checked={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted">
        Найдено: {people.length} из {tree.persons.length}
      </p>
      <ul className="people-grid">
        {people.map((p) => {
          const birthPlace = findEvent(p.events, 'birth')?.place?.name;
          return (
            <li key={p.id}>
              <Link to={personPath(p.id)} className="person-tile">
                <Avatar person={p} size={88} />
                <span className="tile-name">{displayName(p)}</span>
                <span className="muted small">
                  {[cardDates(p), birthPlace && placeShort(birthPlace)].filter(Boolean).join(', ')}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

// Ищем и по девичьей фамилии, и без учёта «ё».
const searchText = (p: Person) =>
  [p.surname, p.birthSurname, p.givenName, p.patronymic].join(' ').toLowerCase().replace(/ё/g, 'е');
