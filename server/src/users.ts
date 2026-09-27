import type { Db } from './db.ts';
import { hashPassword } from './passwords.ts';

export const ROLES = ['admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export type User = {
  id: number;
  login: string;
  role: Role;
  mustChangePassword: boolean;
  personId: number | null;
};

type UserRow = {
  id: number;
  login: string;
  role: Role;
  must_change_password: number;
  password_hash: string;
  person_id: number | null;
};

const toUser = (row: UserRow): User => ({
  id: row.id,
  login: row.login,
  role: row.role,
  mustChangePassword: row.must_change_password === 1,
  personId: row.person_id,
});

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function findUserByLogin(db: Db, login: string): (User & { passwordHash: string }) | undefined {
  const row = db.prepare('SELECT * FROM users WHERE login = ?').get(login) as UserRow | undefined;
  return row && { ...toUser(row), passwordHash: row.password_hash };
}

export function listUsers(db: Db): User[] {
  return (db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[]).map(toUser);
}

// Пароль, выданный администратором, считается временным: при входе его просят сменить.
export async function createUser(db: Db, login: string, role: Role, password: string): Promise<User> {
  const hash = await hashPassword(password);
  const row = db
    .prepare('INSERT INTO users (login, password_hash, role, must_change_password) VALUES (?, ?, ?, 1) RETURNING *')
    .get(login, hash, role) as UserRow;
  return toUser(row);
}

export async function setPassword(db: Db, userId: number, password: string, { temporary }: { temporary: boolean }) {
  const hash = await hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(
    hash,
    temporary ? 1 : 0,
    userId,
  );
}

export function setRole(db: Db, userId: number, role: Role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

export function setUserPerson(db: Db, userId: number, personId: number | null) {
  db.prepare('UPDATE users SET person_id = ? WHERE id = ?').run(personId, userId);
}

export function deleteUser(db: Db, userId: number) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}
