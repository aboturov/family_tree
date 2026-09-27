import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api, ApiError, photoUrl } from '../api.ts';
import { avatarImageBox, clampCrop } from '../avatarGeometry.ts';
import { Modal } from '../Modal.tsx';
import type { AvatarCrop, Person, Photo } from '../tree/model.ts';
import { useEditing } from './EditingContext.ts';
import { preparePhoto } from './preparePhoto.ts';

const errorText = (err: unknown) =>
  err instanceof ApiError || err instanceof Error ? err.message : 'Сервер недоступен, попробуйте позже';

/** Вкладка «Фото»: галерея, просмотр, а для редакторов — загрузка, подписи, удаление и аватарка. */
export function PhotosTab({ person }: { person: Person }) {
  const { canEdit, reload } = useEditing();
  const [viewing, setViewing] = useState<number | null>(null);
  const [cropping, setCropping] = useState<Photo | null>(null);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(undefined);
    try {
      let done = 0;
      for (const file of files) {
        setStatus(`Загружаем ${done + 1} из ${files.length}…`);
        await api.uploadPhoto(person.id, await preparePhoto(file), '');
        done++;
      }
      await reload();
    } catch (err) {
      setError(errorText(err));
      await reload();
    } finally {
      setStatus(undefined);
      if (input.current) input.current.value = '';
    }
  };

  const index = viewing === null ? -1 : person.photos.findIndex((p) => p.id === viewing);
  const current = index >= 0 ? person.photos[index] : undefined;

  return (
    <div className="photos">
      {canEdit && (
        <div className="photos-actions">
          <button className="button secondary" onClick={() => input.current?.click()} disabled={!!status}>
            + Добавить фото
          </button>
          <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => upload(e.target.files)} />
          {status && <span className="muted small">{status}</span>}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {person.photos.length === 0 && !status && <p className="muted">Фото пока нет.</p>}

      <ul className="photo-grid">
        {person.photos.map((photo) => (
          <li key={photo.id}>
            <button className="photo-thumb" onClick={() => setViewing(photo.id)} aria-label={photo.caption || 'Фото'}>
              <img src={photoUrl(photo.id, 'thumb')} alt={photo.caption} loading="lazy" />
              {person.avatar?.mediaId === photo.id && <span className="photo-flag">аватарка</span>}
            </button>
            {photo.caption && <span className="small muted">{photo.caption}</span>}
          </li>
        ))}
      </ul>

      {current && !cropping && (
        <Modal title={current.caption || 'Фото'} onClose={() => setViewing(null)} wide>
          <PhotoViewer
            person={person}
            photo={current}
            onPrev={index > 0 ? () => setViewing(person.photos[index - 1].id) : undefined}
            onNext={index < person.photos.length - 1 ? () => setViewing(person.photos[index + 1].id) : undefined}
            onMakeAvatar={() => setCropping(current)}
            onDeleted={() => setViewing(null)}
          />
        </Modal>
      )}
      {cropping && (
        <Modal title="Аватарка" onClose={() => setCropping(null)}>
          <AvatarCropper person={person} photo={cropping} onDone={() => setCropping(null)} />
        </Modal>
      )}
    </div>
  );
}

function PhotoViewer({
  person,
  photo,
  onPrev,
  onNext,
  onMakeAvatar,
  onDeleted,
}: {
  person: Person;
  photo: Photo;
  onPrev?: () => void;
  onNext?: () => void;
  onMakeAvatar: () => void;
  onDeleted: () => void;
}) {
  const { canEdit, reload } = useEditing();
  const [caption, setCaption] = useState(photo.caption);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const act = async (work: () => Promise<unknown>, after?: () => void) => {
    setPending(true);
    setError(undefined);
    try {
      await work();
      await reload();
      after?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="photo-viewer">
      <div className="photo-stage">
        <img key={photo.id} src={photoUrl(photo.id, 'full')} alt={photo.caption} />
        {onPrev && (
          <button className="photo-nav prev" onClick={onPrev} aria-label="Предыдущее фото">
            ‹
          </button>
        )}
        {onNext && (
          <button className="photo-nav next" onClick={onNext} aria-label="Следующее фото">
            ›
          </button>
        )}
      </div>
      {canEdit && (
        <div className="photo-edit">
          <input
            key={photo.id}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Подпись: кто, где, когда"
            maxLength={500}
          />
          <div className="form-buttons">
            <button
              className="button secondary"
              disabled={pending || caption === photo.caption}
              onClick={() => act(() => api.updatePhotoCaption(photo.id, caption))}
            >
              Сохранить подпись
            </button>
            <button className="button secondary" disabled={pending} onClick={onMakeAvatar}>
              {person.avatar?.mediaId === photo.id ? 'Изменить кадр аватарки' : 'Сделать аватаркой'}
            </button>
            <button
              className="button danger"
              disabled={pending}
              onClick={() => confirm('Удалить это фото?') && act(() => api.deletePhoto(photo.id), onDeleted)}
            >
              Удалить
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}

const VIEWPORT = 280;

/** Выбор куска кадра для круглой аватарки: перетаскивание и приближение. */
function AvatarCropper({ person, photo, onDone }: { person: Person; photo: Photo; onDone: () => void }) {
  const { reload } = useEditing();
  const initial = person.avatar?.mediaId === photo.id ? person.avatar.crop : { x: 0.5, y: 0.5, zoom: 1 };
  const [crop, setCrop] = useState<AvatarCrop>(clampCrop(initial, photo));
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const drag = useRef<{ x: number; y: number; crop: AvatarCrop } | null>(null);
  const box = avatarImageBox(crop, photo, VIEWPORT);

  const onPointerDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, crop };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const start = drag.current;
    if (!start) return;
    // Тянем фото: круг стоит на месте, значит центр кадра сдвигается в обратную сторону.
    const next = {
      ...start.crop,
      x: start.crop.x - (e.clientX - start.x) / box.width,
      y: start.crop.y - (e.clientY - start.y) / box.height,
    };
    setCrop(clampCrop(next, photo));
  };

  const save = async (mediaId: number | null) => {
    setPending(true);
    setError(undefined);
    try {
      await api.setAvatar(person.id, { version: person.version, mediaId, ...(mediaId !== null ? { crop } : {}) });
      await reload();
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="cropper">
      <div
        className="cropper-stage"
        style={{ width: VIEWPORT, height: VIEWPORT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <img
          src={photoUrl(photo.id, 'full')}
          alt=""
          draggable={false}
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        />
        <div className="cropper-mask" />
      </div>
      <label>
        Приближение
        <input
          type="range"
          min={0.15}
          max={1}
          step={0.01}
          // Ползунок вправо — ближе, то есть круг меньше в долях кадра.
          value={1.15 - crop.zoom}
          onChange={(e) => setCrop(clampCrop({ ...crop, zoom: 1.15 - Number(e.target.value) }, photo))}
        />
      </label>
      <p className="muted small">Перетащите фото, чтобы лицо оказалось в круге.</p>
      {error && <p className="error">{error}</p>}
      <div className="form-buttons">
        <button className="button" onClick={() => save(photo.id)} disabled={pending}>
          Сохранить аватарку
        </button>
        {person.avatar?.mediaId === photo.id && (
          <button className="button secondary" onClick={() => save(null)} disabled={pending}>
            Убрать аватарку
          </button>
        )}
      </div>
    </div>
  );
}
