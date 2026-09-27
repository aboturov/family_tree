import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { Db } from './db.ts';
import { createLoginLimits } from './loginLimits.ts';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.ts';
import { createSession, deleteSession, deleteUserSessions, findSessionUser } from './sessions.ts';
import {
  addEvent,
  deleteEvent,
  EditError,
  eventOwnerKind,
  parseEventFields,
  parsePersonFields,
  suggestPlaces,
  updateEvent,
  updatePerson,
} from './editing.ts';
import { addMedia, deleteMedia, mediaPath, parseCrop, setAvatar, trashMediaFiles, updateCaption } from './media.ts';
import { addRelative, deletePerson, mergeDuplicate, parseNewRelative, removeChild, removePartner } from './relations.ts';
import { listChanges, undoChange } from './history.ts';
import { parseLayoutParams, type LayoutService } from './layouts.ts';
import { parseOpenedView, type ViewStats } from './viewStats.ts';
import { personRef, recordChange, type ChangeAction } from './journal.ts';
import { getTree } from './tree.ts';
import { findUserByLogin, setPassword, type User } from './users.ts';

export const SESSION_COOKIE = 'tree_session';

type Options = {
  db: Db;
  mediaDir: string;
  secureCookies: boolean;
  sessionTtlDays: number;
  /** Раскладки дерева; без них /api/layout отвечает 503 (тесты, где раскладка не нужна). */
  layouts?: LayoutService;
  /** Дерево поправили — фоновый пересчёт раскладок (precompute.ts). */
  onChange?: () => void;
  /** Счёт открытий видов: популярные считаются заранее (precompute.ts). */
  stats?: ViewStats;
};

type Env = { Variables: { user: User | undefined } };

export function createApp({ db, mediaDir, secureCookies, sessionTtlDays, layouts, onChange, stats }: Options) {
  const app = new Hono<Env>();
  const limits = createLoginLimits();
  // Хеш-пустышка: вход с несуществующим логином занимает столько же времени, сколько с существующим.
  const dummyHash = hashPassword('dummy-password');

  // Заголовки безопасности на всё: и API, и фронтенд.
  app.use(async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
    if (secureCookies) c.header('Strict-Transport-Security', 'max-age=31536000');
  });

  const api = new Hono<Env>();

  api.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof EditError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
  });

  api.use(csrf());

  api.use(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    c.set('user', token ? findSessionUser(db, token) : undefined);
    await next();
  });

  api.get('/health', (c) => c.json({ ok: true }));

  api.post('/auth/login', async (c) => {
    const { login, password } = await readJson<{ login?: unknown; password?: unknown }>(c.req.raw);
    if (typeof login !== 'string' || typeof password !== 'string') {
      return c.json({ error: 'Укажите логин и пароль' }, 400);
    }

    // IP кладёт nginx (за Cloudflare — из CF-Connecting-IP, см. deploy/nginx); контейнер
    // слушает только loopback, так что заголовку можно верить.
    const address = c.req.header('x-real-ip') ?? 'local';
    const name = login.toLowerCase();
    if (limits.blocked(address, name)) {
      return c.json({ error: 'Слишком много попыток, попробуйте позже' }, 429);
    }

    const user = findUserByLogin(db, login);
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
    if (!user || !ok) {
      limits.failed(address, name);
      return c.json({ error: 'Неверный логин или пароль' }, 401);
    }

    limits.succeeded(address, name);
    const { token, expiresAt } = createSession(db, user.id, sessionTtlDays);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'Lax',
      path: '/',
      expires: expiresAt,
    });
    const { passwordHash: _, ...publicUser } = user;
    return c.json({ user: publicUser });
  });

  api.post('/auth/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // Всё ниже требует входа.
  api.use(async (c, next) => {
    if (!c.get('user')) return c.json({ error: 'Требуется вход' }, 401);
    await next();
  });

  api.get('/auth/me', (c) => c.json({ user: c.get('user') }));

  api.post('/auth/change-password', async (c) => {
    const user = c.get('user')!;
    const { currentPassword, newPassword } = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(
      c.req.raw,
    );
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return c.json({ error: 'Укажите текущий и новый пароль' }, 400);
    }
    const problem = passwordProblem(newPassword, user.login);
    if (problem) return c.json({ error: problem }, 400);
    const stored = findUserByLogin(db, user.login)!;
    if (!(await verifyPassword(currentPassword, stored.passwordHash))) {
      return c.json({ error: 'Текущий пароль указан неверно' }, 400);
    }
    await setPassword(db, user.id, newPassword, { temporary: false });
    deleteUserSessions(db, user.id, getCookie(c, SESSION_COOKIE));
    return c.json({ user: { ...user, mustChangePassword: false } });
  });

  // Пока временный пароль не сменён, остальной API закрыт.
  api.use(async (c, next) => {
    if (c.get('user')!.mustChangePassword) return c.json({ error: 'Сначала смените временный пароль' }, 403);
    await next();
  });

  // Правка прошла, если ответ не ошибка; дальше — только правки дерева и раскладка, которая
  // дерево не меняет. Лишний вызов безвреден: пересчёт найдёт всё в кэше.
  api.use(async (c, next) => {
    await next();
    if (c.req.method !== 'GET' && c.res.status < 400 && c.req.path !== '/api/layout') onChange?.();
  });

  api.get('/tree', (c) => c.json(getTree(db)));
  // Раскладка вида дерева: клиент присылает сам вид (views.ts) и настройки схемы — POST, потому
  // что дерево в запросе. Считает и помнит её сервер, см. layouts.ts.
  api.post('/layout', async (c) => {
    if (!layouts) return c.json({ error: 'Раскладка недоступна' }, 503);
    const body = await readJson<Record<string, unknown>>(c.req.raw);
    const params = parseLayoutParams(body);
    // Открыли вид — считаем; раскладка после правки — тот же вид, не новое открытие.
    const opened = parseOpenedView(body.view, params);
    if (opened && !params.previous?.length) stats?.opened(opened);
    return c.json({ layout: await layouts.layout(params) });
  });
  api.get('/places', (c) => c.json({ places: suggestPlaces(db, c.req.query('q') ?? '') }));

  // Правка дерева — только редакторам и администраторам.
  const editor = createMiddleware<Env>(async (c, next) => {
    const role = c.get('user')!.role;
    if (role !== 'admin' && role !== 'editor') return c.json({ error: 'Недостаточно прав для правки' }, 403);
    await next();
  });
  const idParam = (value: string) => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new EditError(404, 'Не найдено');
    return id;
  };
  type Body = Record<string, unknown>;

  // Каждое действие — одна правка в истории; details — имена на момент правки.
  const change = <T,>(
    c: { get: (key: 'user') => User | undefined },
    action: ChangeAction,
    personId: number | null,
    work: () => T,
    details: (result: T) => Record<string, unknown> = () => ({}),
  ) => recordChange(db, c.get('user')!.id, action, personId, work, details);
  const who = (id: number) => personRef(db, id);
  /** О ком событие: человек или пара (для семейных событий). */
  const eventSubject = (owner: { kind: 'person' | 'family'; id: number }) => {
    if (owner.kind === 'person') return { personId: owner.id, people: [who(owner.id)] };
    const f = db.prepare('SELECT partner1_id, partner2_id FROM families WHERE id = ?').get(owner.id) as
      | { partner1_id: number | null; partner2_id: number | null }
      | undefined;
    const ids = [f?.partner1_id, f?.partner2_id].filter((p): p is number => p != null);
    return { personId: ids[0] ?? null, people: ids.map(who) };
  };
  const eventOwner = (eventId: number) => {
    const row = db.prepare('SELECT person_id, family_id, type, custom_type FROM events WHERE id = ?').get(eventId) as
      | { person_id: number | null; family_id: number | null; type: string; custom_type: string }
      | undefined;
    if (!row) throw new EditError(404, 'Событие не найдено');
    const owner = row.person_id !== null ? { kind: 'person' as const, id: row.person_id } : { kind: 'family' as const, id: row.family_id! };
    return { ...eventSubject(owner), type: row.type, customType: row.custom_type };
  };
  const mediaOwner = (mediaId: number) => {
    const row = db.prepare('SELECT person_id FROM media WHERE id = ?').get(mediaId) as { person_id: number } | undefined;
    if (!row) throw new EditError(404, 'Фото не найдено');
    return row.person_id;
  };

  api.patch('/persons/:id', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const id = idParam(c.req.param('id'));
    const fields = parsePersonFields(body);
    change(c, 'person.update', id, () => updatePerson(db, c.get('user')!.id, id, body.version, fields), () => ({
      person: who(id),
    }));
    return c.json({ ok: true });
  });

  api.post('/persons/:id/events', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const owner = { kind: 'person' as const, id: idParam(c.req.param('id')) };
    const fields = parseEventFields(body, 'person');
    const subject = eventSubject(owner);
    const id = change(c, 'event.add', subject.personId, () => addEvent(db, c.get('user')!.id, owner, body.version, fields), () => ({
      people: subject.people,
      type: fields.type,
      customType: fields.customType,
    }));
    return c.json({ id }, 201);
  });

  api.post('/families/:id/events', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const owner = { kind: 'family' as const, id: idParam(c.req.param('id')) };
    const fields = parseEventFields(body, 'family');
    const subject = eventSubject(owner);
    const id = change(c, 'event.add', subject.personId, () => addEvent(db, c.get('user')!.id, owner, body.version, fields), () => ({
      people: subject.people,
      type: fields.type,
      customType: fields.customType,
    }));
    return c.json({ id }, 201);
  });

  api.patch('/events/:id', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const id = idParam(c.req.param('id'));
    const fields = parseEventFields(body, eventOwnerKind(db, id));
    const subject = eventOwner(id);
    const moveTo = typeof body.moveToFamily === 'number' ? body.moveToFamily : null;
    change(c, 'event.update', subject.personId, () => updateEvent(db, c.get('user')!.id, id, body.version, fields, moveTo), () => ({
      people: subject.people,
      type: fields.type,
      customType: fields.customType,
    }));
    return c.json({ ok: true });
  });

  api.delete('/events/:id', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const id = idParam(c.req.param('id'));
    const subject = eventOwner(id);
    change(c, 'event.delete', subject.personId, () => deleteEvent(db, c.get('user')!.id, id, body.version), () => ({
      people: subject.people,
      type: subject.type,
      customType: subject.customType,
    }));
    return c.json({ ok: true });
  });

  // --- Связи ---

  api.post('/persons/:id/relatives', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const input = parseNewRelative(body, parsePersonFields);
    const anchor = idParam(c.req.param('id'));
    const id = change(c, 'relative.add', anchor, () => addRelative(db, c.get('user')!.id, anchor, body.version, input), (relative) => ({
      relation: input.relation,
      anchor: who(anchor),
      relative: who(relative),
      created: input.existingId === null,
    }));
    return c.json({ id }, 201);
  });

  api.delete('/families/:id/children/:childId', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const familyId = idParam(c.req.param('id'));
    const childId = idParam(c.req.param('childId'));
    const parents = eventSubject({ kind: 'family', id: familyId }).people;
    change(c, 'link.remove', childId, () => removeChild(db, c.get('user')!.id, familyId, childId, body.version), () => ({
      kind: 'child',
      person: who(childId),
      others: parents,
    }));
    return c.json({ ok: true });
  });

  api.delete('/families/:id/partners/:personId', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const familyId = idParam(c.req.param('id'));
    const personId = idParam(c.req.param('personId'));
    const family = db.prepare('SELECT partner1_id, partner2_id FROM families WHERE id = ?').get(familyId) as
      | { partner1_id: number | null; partner2_id: number | null }
      | undefined;
    const partner = [family?.partner1_id, family?.partner2_id].find((p): p is number => p != null && p !== personId);
    const children = (db.prepare('SELECT child_id FROM family_children WHERE family_id = ?').all(familyId) as {
      child_id: number;
    }[]).map((r) => who(r.child_id));
    change(c, 'link.remove', personId, () => removePartner(db, c.get('user')!.id, familyId, personId, body.version), () => ({
      kind: 'partner',
      person: who(personId),
      others: partner !== undefined ? [who(partner)] : [],
      children,
    }));
    return c.json({ ok: true });
  });

  api.delete('/persons/:id', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const id = idParam(c.req.param('id'));
    const person = who(id);
    const media = change(c, 'person.delete', id, () => deletePerson(db, c.get('user')!.id, id, body.version), () => ({
      person,
    }));
    for (const mediaId of media) trashMediaFiles(mediaDir, mediaId);
    return c.json({ ok: true });
  });

  api.post('/persons/:id/merge', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    if (typeof body.duplicateId !== 'number') throw new EditError(400, 'Не указан дубль');
    const keep = idParam(c.req.param('id'));
    const duplicate = body.duplicateId;
    const dropped = who(duplicate);
    change(c, 'person.merge', keep, () => mergeDuplicate(db, c.get('user')!.id, keep, duplicate, body.version), () => ({
      person: who(keep),
      duplicate: dropped,
    }));
    return c.json({ ok: true });
  });

  // --- Фото ---

  api.get('/media/:id/:size', (c) => {
    const size = c.req.param('size');
    if (size !== 'full' && size !== 'thumb') return c.json({ error: 'Not found' }, 404);
    const file = mediaPath(mediaDir, idParam(c.req.param('id')), size);
    if (!fs.existsSync(file)) return c.json({ error: 'Фото не найдено' }, 404);
    // Файл по id не меняется — кешируем надолго, но только в браузере вошедшего пользователя.
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' },
    });
  });

  api.post('/persons/:id/media', editor, async (c) => {
    const body = await c.req.parseBody();
    const full = body.full;
    const thumb = body.thumb;
    if (!(full instanceof File) || !(thumb instanceof File)) throw new EditError(400, 'Нет файла фото');
    const personId = idParam(c.req.param('id'));
    const input = {
      full: new Uint8Array(await full.arrayBuffer()),
      thumb: new Uint8Array(await thumb.arrayBuffer()),
      width: Number(body.width),
      height: Number(body.height),
      caption: typeof body.caption === 'string' ? body.caption : '',
    };
    const id = change(c, 'media.add', personId, () => addMedia(db, mediaDir, c.get('user')!.id, personId, input), (mediaId) => ({
      person: who(personId),
      mediaId,
    }));
    return c.json({ id }, 201);
  });

  api.patch('/media/:id', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const id = idParam(c.req.param('id'));
    const personId = mediaOwner(id);
    change(c, 'media.update', personId, () => updateCaption(db, c.get('user')!.id, id, body.caption), () => ({
      person: who(personId),
      mediaId: id,
      caption: body.caption,
    }));
    return c.json({ ok: true });
  });

  api.delete('/media/:id', editor, (c) => {
    const id = idParam(c.req.param('id'));
    const personId = mediaOwner(id);
    change(c, 'media.delete', personId, () => deleteMedia(db, mediaDir, c.get('user')!.id, id), () => ({
      person: who(personId),
      mediaId: id,
    }));
    return c.json({ ok: true });
  });

  api.put('/persons/:id/avatar', editor, async (c) => {
    const body = await readJson<Body>(c.req.raw);
    const mediaId = body.mediaId === null ? null : body.mediaId;
    const crop = mediaId === null ? null : parseCrop(body.crop);
    const personId = idParam(c.req.param('id'));
    change(c, 'avatar.set', personId, () => setAvatar(db, c.get('user')!.id, personId, body.version, mediaId, crop), () => ({
      person: who(personId),
      mediaId,
    }));
    return c.json({ ok: true });
  });

  // --- История ---

  api.get('/history', (c) => {
    const before = Number(c.req.query('before')) || undefined;
    const personId = Number(c.req.query('person')) || undefined;
    return c.json(listChanges(db, { before, personId }));
  });

  api.post('/history/:id/undo', editor, (c) => {
    const user = c.get('user')!;
    undoChange(db, mediaDir, user, idParam(c.req.param('id')));
    return c.json({ ok: true });
  });

  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  return app;
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HTTPException(400, { message: 'Ожидался JSON' });
  }
}
