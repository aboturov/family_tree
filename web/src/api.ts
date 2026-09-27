import type { AvatarCrop, Tree } from './tree/model.ts';

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
};

export const photoUrl = (id: number, size: 'full' | 'thumb') => `/api/media/${id}/${size}`;

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
  date: { modifier: string; value: string; valueTo?: string } | null;
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
