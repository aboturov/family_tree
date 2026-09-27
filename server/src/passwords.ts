import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
// scrypt с N=2^15, r=8 требует ровно 32 МБ — это дефолтный предел maxmem, поэтому даём запас.
const MAX_MEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;

// Самые частые пароли нужной длины: их подбирают первыми, и никакой лимит попыток не спасёт.
const COMMON = new Set([
  '1234567890', '0987654321', '12345678910', '123456789a', 'a123456789', '1q2w3e4r5t', '1q2w3e4r5t6y',
  'qwertyuiop', 'qwerty1234', 'qwerty12345', 'qwerty123456', 'asdfghjkl1', 'zxcvbnm123', '1qaz2wsx3edc',
  'password12', 'password123', 'password1234', 'passw0rd123', 'iloveyou12', 'abcdefghij', 'abc1234567',
  'йцукенгшщз', 'йцукенгшщзхъ', 'фывапролдж', 'пароль1234', 'пароль12345', 'qazwsxedcr', 'q1w2e3r4t5',
]);

/** Почему пароль не годится, или null. */
export function passwordProblem(password: string, login: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`;
  const lower = password.toLowerCase();
  if (lower.includes(login.toLowerCase())) return 'Пароль не должен содержать логин';
  if (new Set(lower).size < 4) return 'В пароле слишком мало разных символов';
  if (COMMON.has(lower)) return 'Это один из самых частых паролей, придумайте другой';
  return null;
}

// Формат: scrypt$N$r$p$salt$hash (base64). Параметры храним в хеше,
// чтобы их можно было усилить позже, не ломая старые пароли.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = PARAMS;
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEM });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEM,
  });
  return timingSafeEqual(key, expected);
}

// Без похожих символов (0/O, 1/l/I), чтобы временный пароль легко продиктовать.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePassword(length = 12): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
