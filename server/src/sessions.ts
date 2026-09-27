import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import type { Role, User } from './users.ts';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(db: Db, userId: number, ttlDays: number): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    userId,
    expiresAt.toISOString(),
  );
  return { token, expiresAt };
}

export function findSessionUser(db: Db, token: string): User | undefined {
  const row = db
    .prepare(
      `SELECT u.id, u.login, u.role, u.must_change_password, u.person_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), new Date().toISOString()) as
    | { id: number; login: string; role: Role; must_change_password: number; person_id: number | null }
    | undefined;
  return (
    row && {
      id: row.id,
      login: row.login,
      role: row.role,
      mustChangePassword: row.must_change_password === 1,
      personId: row.person_id,
    }
  );
}

export function deleteSession(db: Db, token: string) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}

// Сброс или смена пароля выкидывает пользователя со всех устройств (кроме текущей сессии, если она передана).
export function deleteUserSessions(db: Db, userId: number, exceptToken?: string) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptToken ? hashToken(exceptToken) : '');
}

export function deleteExpiredSessions(db: Db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}
