import { scanUrl, type DocumentView } from '../api.ts';
import { useEditing } from '../editing/EditingContext.ts';
import { displayName, type Person, type TreeIndex } from '../tree/model.ts';
import { useDocuments } from './DocumentsContext.ts';
import { byDate, documentDate, shelfmark } from './format.ts';
import { DOCUMENT_ROLES, documentName } from './labels.ts';

// Списки документов: во вкладке человека и на странице «Документы». У документа подписи важнее
// картинки, поэтому список строками, а не сеткой: миниатюра, название, дата, шифр, люди.

export function DocumentList({ documents, index, personId }: { documents: DocumentView[]; index: TreeIndex; personId?: number }) {
  const { open } = useDocuments();
  return (
    <ul className="doc-list">
      {documents.map((d) => {
        const role = personId !== undefined ? d.persons.find((p) => p.id === personId)?.role : undefined;
        const people = personId === undefined ? d.persons.map((p) => index.persons.get(p.id)).filter((p): p is Person => !!p) : [];
        const facts = [documentDate(d), shelfmark(d) || d.archive, d.files.length > 1 && `сканов ${d.files.length}`];
        return (
          <li key={d.id}>
            <button className="doc-row" onClick={() => open(d.id)}>
              {d.files[0] ? (
                <img className="doc-thumb" src={scanUrl(d.files[0].id, 'thumb')} alt="" loading="lazy" />
              ) : (
                <span className="doc-thumb doc-thumb-empty" title="Скана пока нет">
                  <DocumentIcon size={22} />
                </span>
              )}
              <span className="doc-row-text">
                <strong>{documentName(d)}</strong>
                <span className="muted small">{facts.filter(Boolean).join(' · ')}</span>
                {role && <span className="small">{DOCUMENT_ROLES[role]}</span>}
                {people.length > 0 && <span className="small">{people.map(displayName).join(', ')}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Вкладка «Документы» у человека: где он упомянут, по дате документа. */
export function DocumentsTab({ person, index }: { person: Person; index: TreeIndex }) {
  const { canEdit } = useEditing();
  const { byId, error, create } = useDocuments();
  const documents = person.documents
    .map((id) => byId?.get(id))
    .filter((d): d is DocumentView => !!d)
    .sort(byDate);
  return (
    <div className="documents">
      {canEdit && (
        <button className="add-wide" onClick={() => create({ persons: [{ id: person.id, role: 'subject' }] })}>
          Добавить документ
        </button>
      )}
      {error && <p className="error">{error}</p>}
      {!byId && !error && person.documents.length > 0 && <p className="muted">Загружаем документы…</p>}
      {person.documents.length === 0 && <p className="muted">Документов пока нет.</p>}
      <DocumentList documents={documents} index={index} personId={person.id} />
    </div>
  );
}

/**
 * Значки документов у события в ленте: событие подтверждено — по клику открывается документ.
 * named — с названиями (в развёрнутом событии панели, где места хватает).
 */
export function DocumentChips({ ids, named = false }: { ids: number[] | undefined; named?: boolean }) {
  const { byId, open } = useDocuments();
  if (!ids?.length) return null;
  return (
    <span className="doc-chips">
      {ids.map((id) => {
        const d = byId?.get(id);
        const name = d ? documentName(d) : 'Документ';
        return (
          <button
            key={id}
            type="button"
            className={named ? 'doc-chip named' : 'doc-chip'}
            onClick={() => open(id)}
            title={name}
            aria-label={named ? undefined : `Документ: ${name}`}
          >
            <DocumentIcon size={14} />
            {named && name}
          </button>
        );
      })}
    </span>
  );
}

export function DocumentIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 1.5h5.3c.4 0 .8.2 1 .4l2.8 2.8c.3.3.4.7.4 1v8.3c0 .8-.7 1.5-1.5 1.5H4c-.8 0-1.5-.7-1.5-1.5V3c0-.8.7-1.5 1.5-1.5Zm5 1.2V5c0 .6.4 1 1 1h2.3L9 2.7ZM5 8.2a.6.6 0 0 0 0 1.2h6a.6.6 0 0 0 0-1.2H5Zm0 2.5a.6.6 0 0 0 0 1.2h4a.6.6 0 0 0 0-1.2H5Z"
      />
    </svg>
  );
}
