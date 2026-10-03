import type { AvatarCrop, Tree, TreeEvent } from './tree/model.ts';

export type User = {
  id: number;
  login: string;
  role: 'admin' | 'editor' | 'viewer';
  mustChangePassword: boolean;
  /** Кто из дерева этот пользователь (tree-admin user:link). */
  personId: number | null;
};

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Ошибка ${res.status}`);
  return data as T;
}

export const api = {
  me: () => request<{ user: User }>('/auth/me'),
  login: (login: string, password: string) => request<{ user: User }>('/auth/login', { login, password }),
  logout: () => request<{ ok: true }>('/auth/logout', {}),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ user: User }>('/auth/change-password', { currentPassword, newPassword }),
  tree: () => request<Tree>('/tree'),
  places: (q: string) => request<{ places: { name: string; uses: number }[] }>(`/places?q=${encodeURIComponent(q)}`),
  updatePerson: (id: number, body: PersonInput & { version: number }) => request<{ ok: true }>(`/persons/${id}`, body, 'PATCH'),
  addEvent: (owner: { kind: 'person' | 'family'; id: number }, body: EventInput & { version: number }) =>
    request<{ id: number }>(`/${owner.kind === 'person' ? 'persons' : 'families'}/${owner.id}/events`, body),
  updateEvent: (id: number, body: EventInput & { version: number; moveToFamily?: number }) => request<{ ok: true }>(`/events/${id}`, body, 'PATCH'),
  deleteEvent: (id: number, version: number) => request<{ ok: true }>(`/events/${id}`, { version }, 'DELETE'),
  uploadPhoto: async (personId: number, photo: PreparedPhoto, caption: string) => {
    const form = new FormData();
    form.set('full', photo.full, 'photo.jpg');
    form.set('thumb', photo.thumb, 'thumb.jpg');
    form.set('width', String(photo.width));
    form.set('height', String(photo.height));
    form.set('caption', caption);
    const res = await fetch(`/api/persons/${personId}/media`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Ошибка ${res.status}`);
    return data as { id: number };
  },
  /** Первый человек пустого дерева; остальные — через addRelative. */
  addFirstPerson: (body: { person: NonNullable<RelativeInput['person']>; birth: RelativeInput['birth'] }) =>
    request<{ id: number }>('/persons', body),
  addRelative: (personId: number, body: RelativeInput & { version: number }) =>
    request<{ id: number }>(`/persons/${personId}/relatives`, body),
  removeChild: (familyId: number, childId: number, version: number) =>
    request<{ ok: true }>(`/families/${familyId}/children/${childId}`, { version }, 'DELETE'),
  removePartner: (familyId: number, personId: number, version: number) =>
    request<{ ok: true }>(`/families/${familyId}/partners/${personId}`, { version }, 'DELETE'),
  deletePerson: (id: number, version: number) => request<{ ok: true }>(`/persons/${id}`, { version }, 'DELETE'),
  mergePerson: (id: number, duplicateId: number, version: number) =>
    request<{ ok: true }>(`/persons/${id}/merge`, { version, duplicateId }),
  history: (params: { before?: number; person?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.before) search.set('before', String(params.before));
    if (params.person) search.set('person', String(params.person));
    return request<{ items: HistoryItem[]; hasMore: boolean }>(`/history?${search}`);
  },
  undo: (changeId: number) => request<{ ok: true }>(`/history/${changeId}/undo`, {}),
  updatePhotoCaption: (id: number, caption: string) => request<{ ok: true }>(`/media/${id}`, { caption }, 'PATCH'),
  deletePhoto: (id: number) => request<{ ok: true }>(`/media/${id}`, {}, 'DELETE'),
  setAvatar: (personId: number, body: { version: number; mediaId: number | null; crop?: AvatarCrop }) =>
    request<{ ok: true }>(`/persons/${personId}/avatar`, body, 'PUT'),
  documents: () => request<{ documents: DocumentView[] }>('/documents'),
  addDocument: (body: DocumentInput) => request<{ id: number }>('/documents', body),
  updateDocument: (id: number, body: DocumentInput & { version: number }) =>
    request<{ ok: true }>(`/documents/${id}`, body, 'PATCH'),
  deleteDocument: (id: number, version: number) => request<{ ok: true }>(`/documents/${id}`, { version }, 'DELETE'),
  uploadScan: async (documentId: number, scan: PreparedScan, frame: number | null) => {
    const form = new FormData();
    form.set('file', scan.file, 'scan.jpg');
    form.set('thumb', scan.thumb, 'thumb.jpg');
    if (frame !== null) form.set('frame', String(frame));
    const res = await fetch(`/api/documents/${documentId}/files`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Ошибка ${res.status}`);
    return data as { id: number; sameScans: { documentId: number; title: string; type: string }[] };
  },
  updateScan: (id: number, frame: number | null) => request<{ ok: true }>(`/document-files/${id}`, { frame }, 'PATCH'),
  deleteScan: (id: number) => request<{ ok: true }>(`/document-files/${id}`, {}, 'DELETE'),
};

export const scanUrl = (id: number, size: 'original' | 'thumb') => `/api/document-files/${id}/${size}`;

/** Документ целиком — GET /api/documents (server/src/documents.ts). */
export type DocumentView = {
  id: number;
  version: number;
  type: string;
  title: string;
  /** Дата составления документа. */
  date: TreeEvent['date'];
  archive: string;
  fond: string;
  opis: string;
  delo: string;
  sheets: string;
  url: string;
  transcription: string;
  note: string;
  files: { id: number; frame: number | null; width: number; height: number; bytes: number }[];
  persons: { id: number; role: string }[];
  events: number[];
  createdAt: string;
};

export type DocumentInput = Pick<
  DocumentView,
  'type' | 'title' | 'archive' | 'fond' | 'opis' | 'delo' | 'sheets' | 'url' | 'transcription' | 'note' | 'persons' | 'events'
> & { date: EventInput['date'] };

/** Скан к загрузке: оригинал (или повёрнутая копия) и миниатюра — см. documents/prepareScan.ts. */
export type PreparedScan = { file: Blob; thumb: Blob };

// Сервер кеширует фото по адресу на год. Пока id фото переиспользовались, под одним адресом
// успевало побывать другое фото; ?v=2 сбрасывает такие кеши — адреса с ним всегда верные.
export const photoUrl = (id: number, size: 'full' | 'thumb') => `/api/media/${id}/${size}?v=2`;

export type PreparedPhoto = { full: Blob; thumb: Blob; width: number; height: number };

export type PersonInput = {
  givenName: string;
  patronymic: string;
  surname: string;
  birthSurname: string;
  sex: 'M' | 'F' | 'U';
  isDeceased: boolean;
  isUncertain: boolean;
  bio: string;
};

export type EventInput = {
  type: string;
  customType: string;
  /** `calendar: 'julian'` — по старому стилю. */
  date: { modifier: string; value: string; valueTo?: string; calendar?: 'julian' } | null;
  /** Дата без года («12 марта») — когда `date` пуста. */
  dateText: string;
  place: string;
  note: string;
};

export type RelationKind = 'parent' | 'spouse' | 'child' | 'sibling';

export type RelativeInput = {
  relation: RelationKind;
  existingId: number | null;
  person: Pick<PersonInput, 'givenName' | 'patronymic' | 'surname' | 'birthSurname' | 'sex'> | null;
  birth: { modifier: 'exact'; value: string } | { dateText: string } | null;
  familyId: number | null;
};

export type PersonRef = { id: number; name: string; sex: 'M' | 'F' | 'U' };

export type HistoryItem = {
  id: number;
  at: string;
  user: string | null;
  userId: number | null;
  action: string;
  personId: number | null;
  details: Record<string, unknown>;
  undoneBy: { id: number; at: string; user: string | null } | null;
  undoable: boolean;
};
