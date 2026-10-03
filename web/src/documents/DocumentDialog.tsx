import { useRef, useState } from 'react';
import { api, ApiError, scanUrl, type DocumentInput, type DocumentView } from '../api.ts';
import { useEditing } from '../editing/EditingContext.ts';
import { Modal } from '../Modal.tsx';
import { eventDate } from '../personShared.tsx';
import { Link, personPath } from '../router.ts';
import { displayName, eventLabel, type TreeEvent, type TreeIndex } from '../tree/model.ts';
import { DocumentForm } from './DocumentForm.tsx';
import { documentDate, whereKept } from './format.ts';
import { DOCUMENT_ROLES, DOCUMENT_TYPES, documentName } from './labels.ts';
import { prepareScan } from './prepareScan.ts';
import { ScanViewer } from './ScanViewer.tsx';

const errorText = (err: unknown) =>
  err instanceof ApiError || err instanceof Error ? err.message : 'Сервер недоступен, попробуйте позже';

/** Окно документа: скан с приближением, сведения, люди и расшифровка; для редакторов — правка. */
export function DocumentDialog({
  document,
  preset,
  index,
  all,
  onClose,
  onCreated,
}: {
  /** Открытый документ; без него — новый (preset — заготовка, например человек с карточки). */
  document?: DocumentView;
  preset?: Partial<DocumentInput>;
  index: TreeIndex;
  all: DocumentView[];
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [editing, setEditing] = useState(!document);
  if (!document || editing) {
    return (
      <Modal title={document ? `Документ — ${documentName(document)}` : 'Новый документ'} onClose={onClose} wide>
        <DocumentForm
          document={document}
          preset={preset}
          index={index}
          all={all}
          onSaved={(id) => (document ? setEditing(false) : onCreated(id))}
          onCancel={() => (document ? setEditing(false) : onClose())}
        />
      </Modal>
    );
  }
  const name = documentName(document);
  return (
    <Modal
      title={name}
      onClose={onClose}
      wide
      heading={
        <div className="doc-heading">
          {document.title && <div className="modal-caption">{DOCUMENT_TYPES[document.type]}</div>}
          <strong>{name}</strong>
        </div>
      }
    >
      <DocumentView document={document} index={index} onEdit={() => setEditing(true)} onClose={onClose} />
    </Modal>
  );
}

function DocumentView({
  document: d,
  index,
  onEdit,
  onClose,
}: {
  document: DocumentView;
  index: TreeIndex;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { canEdit, reload } = useEditing();
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const scan = d.files[Math.min(page, d.files.length - 1)];

  const act = async (work: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await work();
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(undefined);
    setNotice(undefined);
    const same: string[] = [];
    try {
      let done = 0;
      for (const file of files) {
        setStatus(`Загружаем ${done + 1} из ${files.length}…`);
        const { sameScans } = await api.uploadScan(d.id, await prepareScan(file), null);
        for (const s of sameScans) same.push(`«${file.name}» уже есть в документе «${documentName(s)}»`);
        done++;
      }
      await reload();
      setPage(d.files.length); // первый из новых
      if (same.length) setNotice(`${same.join('; ')}. Если это не нужно — удалите лишний скан.`);
    } catch (err) {
      setError(errorText(err));
      await reload();
    } finally {
      setStatus(undefined);
      if (input.current) input.current.value = '';
    }
  };

  const people = d.persons.filter((p) => index.persons.has(p.id));
  const events = d.events.map((id) => findEvent(index, id)).filter((e) => e !== undefined);

  return (
    <div className="doc-view">
      <div className="doc-scans">
        {scan ? (
          <>
            <ScanViewer scan={scan} alt={`${documentName(d)}, скан ${page + 1}`} />
            {d.files.length > 1 && (
              <div className="doc-pages" role="tablist" aria-label="Сканы">
                {d.files.map((f, i) => (
                  <button
                    key={f.id}
                    role="tab"
                    aria-selected={f.id === scan.id}
                    className={f.id === scan.id ? 'doc-page active' : 'doc-page'}
                    onClick={() => setPage(i)}
                    aria-label={`Скан ${i + 1}`}
                  >
                    <img src={scanUrl(f.id, 'thumb')} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
            <ScanTools key={scan.id} scan={scan} url={d.url} canEdit={canEdit} act={act} />
          </>
        ) : (
          <p className="muted doc-no-scan">Скана пока нет{d.url ? ' — дело можно открыть в онлайн-архиве' : ''}.</p>
        )}
        {canEdit && (
          <div className="doc-upload">
            <button className="button secondary" onClick={() => input.current?.click()} disabled={!!status}>
              + Добавить скан
            </button>
            <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => upload(e.target.files)} />
            {status && <span className="muted small">{status}</span>}
          </div>
        )}
        {notice && <p className="muted small">{notice}</p>}
      </div>

      <div className="doc-info">
        <dl className="doc-facts">
          {d.date && (
            <>
              <dt>Дата документа</dt>
              <dd>{documentDate(d)}</dd>
            </>
          )}
          {whereKept(d) && (
            <>
              <dt>Где хранится</dt>
              <dd>{whereKept(d)}</dd>
            </>
          )}
          {d.url && (
            <>
              <dt>Онлайн</dt>
              <dd>
                <a href={d.url} target="_blank" rel="noopener noreferrer">
                  Дело в онлайн-архиве ↗
                </a>
              </dd>
            </>
          )}
        </dl>

        {people.length > 0 && (
          <section>
            <h3>Люди</h3>
            <ul className="plain">
              {people.map((p) => (
                <li key={p.id}>
                  <span className="muted">{DOCUMENT_ROLES[p.role]}:</span>{' '}
                  <Link to={personPath(p.id)} onClick={onClose}>
                    {displayName(index.persons.get(p.id)!)}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {events.length > 0 && (
          <section>
            <h3>Подтверждает</h3>
            <ul className="plain">
              {events.map(({ event, who }) => (
                <li key={event.id}>
                  {event.type === 'marriage' ? 'Бракосочетание' : eventLabel(event)}, {eventDate(event)} — {who}
                </li>
              ))}
            </ul>
          </section>
        )}
        {d.transcription && (
          <section>
            <h3>Расшифровка</h3>
            <p className="doc-text">{d.transcription}</p>
          </section>
        )}
        {d.note && (
          <section>
            <h3>Заметки</h3>
            <p className="doc-text">{d.note}</p>
          </section>
        )}
        {!people.length && !d.transcription && <p className="muted small">Людей и расшифровки пока нет.</p>}

        {error && <p className="error">{error}</p>}
        {canEdit && (
          <div className="form-buttons">
            <button className="button" onClick={onEdit}>
              Изменить
            </button>
            <button
              className="button danger"
              onClick={() =>
                confirm(`Удалить документ «${documentName(d)}» вместе со сканами?`) &&
                act(async () => {
                  await api.deleteDocument(d.id, d.version);
                  onClose();
                })
              }
            >
              Удалить
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Номер кадра у скана (он не совпадает с номером листа) и удаление скана. */
function ScanTools({
  scan,
  url,
  canEdit,
  act,
}: {
  scan: DocumentView['files'][number];
  url: string;
  canEdit: boolean;
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [frame, setFrame] = useState(scan.frame === null ? '' : String(scan.frame));
  const saved = scan.frame === null ? '' : String(scan.frame);
  if (!canEdit) return scan.frame !== null && url ? <p className="muted small">Кадр {scan.frame} в онлайн-архиве</p> : null;
  return (
    <div className="doc-scan-tools">
      <label className="doc-frame">
        Кадр в онлайн-архиве
        <input inputMode="numeric" value={frame} onChange={(e) => setFrame(e.target.value.replace(/\D/g, '').slice(0, 7))} />
      </label>
      {frame !== saved && (
        <button className="button secondary" onClick={() => act(() => api.updateScan(scan.id, frame ? Number(frame) : null))}>
          Сохранить
        </button>
      )}
      <button className="link danger-link small" onClick={() => confirm('Удалить этот скан?') && act(() => api.deleteScan(scan.id))}>
        Удалить скан
      </button>
    </div>
  );
}

/** Событие по id — у человека или у брака; кто его участники. */
function findEvent(index: TreeIndex, id: number): { event: TreeEvent; who: string } | undefined {
  for (const person of index.persons.values()) {
    const event = person.events.find((e) => e.id === id);
    if (event) return { event, who: displayName(person) };
  }
  for (const families of index.familiesAsPartner.values()) {
    for (const family of families) {
      const event = family.events.find((e) => e.id === id);
      if (event) {
        const who = family.partners
          .map((p) => (p !== null ? index.persons.get(p) : undefined))
          .filter((p) => p !== undefined)
          .map(displayName)
          .join(' и ');
        return { event, who };
      }
    }
  }
  return undefined;
}
