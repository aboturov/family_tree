import { useMemo, useState } from 'react';
import type { DocumentView } from '../api.ts';
import { useEditing } from '../editing/EditingContext.ts';
import { displayName, type TreeIndex } from '../tree/model.ts';
import { DocumentList } from './DocumentList.tsx';
import { useDocuments } from './DocumentsContext.ts';
import { byDate, searchText } from './format.ts';
import { DOCUMENT_TYPES } from './labels.ts';

// Все документы — и те, что пока ни к кому не привязаны: найдены, но родство не подтверждено.
// Фильтры заодно служат списком работы: без людей, без скана, без расшифровки.

const FILTERS = {
  all: ['Все', () => true],
  unlinked: ['Без людей', (d: DocumentView) => d.persons.length === 0],
  noScan: ['Без скана', (d: DocumentView) => d.files.length === 0],
  noText: ['Без расшифровки', (d: DocumentView) => !d.transcription],
} as const;
type Filter = keyof typeof FILTERS;

export function DocumentsPage({ index }: { index: TreeIndex }) {
  const { canEdit } = useEditing();
  const { byId, error, create } = useDocuments();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const all = useMemo(() => [...(byId?.values() ?? [])], [byId]);

  const documents = useMemo(() => {
    const words = query.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    return all
      .filter((d) => !type || d.type === type)
      .filter(FILTERS[filter][1])
      .filter((d) => {
        if (!words.length) return true;
        const names = d.persons.map((p) => index.persons.get(p.id)).flatMap((p) => (p ? [displayName(p), p.birthSurname] : []));
        const haystack = searchText(d, names);
        return words.every((w) => haystack.includes(w));
      })
      .sort(byDate);
  }, [all, index, query, type, filter]);
  const types = useMemo(() => [...new Set(all.map((d) => d.type))].sort((a, b) => DOCUMENT_TYPES[a].localeCompare(DOCUMENT_TYPES[b], 'ru')), [all]);

  return (
    <main className="page documents-page">
      <div className="page-title">
        <h1>Документы</h1>
        {canEdit && (
          <button className="button" onClick={() => create()}>
            Добавить документ
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {!byId && !error && <p className="muted">Загружаем документы…</p>}
      {byId && (
        <>
          <div className="people-filters">
            <input
              type="search"
              placeholder="Название, шифр, текст или фамилия"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Поиск"
            />
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Тип документа">
              <option value="">Все типы</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPES[t]}
                </option>
              ))}
            </select>
            <div className="segmented small" role="radiogroup" aria-label="Какие документы показывать">
              {(Object.keys(FILTERS) as Filter[]).map((key) => (
                <button key={key} role="radio" aria-checked={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
                  {FILTERS[key][0]}
                </button>
              ))}
            </div>
          </div>
          <p className="muted">
            Найдено: {documents.length} из {all.length}
          </p>
          <DocumentList documents={documents} index={index} />
        </>
      )}
    </main>
  );
}
