// Счётчики неудачных входов. Живут в памяти процесса и обнуляются при перезапуске —
// для одного сервера этого достаточно.

type Bucket = { count: number; resetAt: number };

export class FailureCounter {
  readonly #buckets = new Map<string, Bucket>();

  readonly max: number;
  readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  blocked(key: string, now = Date.now()): boolean {
    const bucket = this.#buckets.get(key);
    return !!bucket && bucket.resetAt > now && bucket.count >= this.max;
  }

  fail(key: string, now = Date.now()) {
    // Перебор с множества адресов не должен раздувать память: выметаем истёкшие окна.
    if (this.#buckets.size > 10_000) {
      for (const [k, b] of this.#buckets) if (b.resetAt <= now) this.#buckets.delete(k);
    }
    const bucket = this.#buckets.get(key);
    if (bucket && bucket.resetAt > now) bucket.count++;
    else this.#buckets.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  clear(key: string) {
    this.#buckets.delete(key);
  }
}

const MINUTE = 60 * 1000;

/**
 * Три счётчика: пара «IP + логин» ловит обычный подбор пароля, один IP по многим логинам —
 * перебор логинов, один логин со многих IP — распределённый подбор. Последний порог выше,
 * чтобы посторонний не мог надолго запереть человека, просто вводя его логин.
 */
export function createLoginLimits() {
  const pair = new FailureCounter(10, 15 * MINUTE);
  const ip = new FailureCounter(30, 15 * MINUTE);
  const login = new FailureCounter(100, 60 * MINUTE);
  const keys = (address: string, name: string) => ({ pair: `${address}:${name}`, ip: address, login: name });

  return {
    blocked(address: string, name: string) {
      const k = keys(address, name);
      return pair.blocked(k.pair) || ip.blocked(k.ip) || login.blocked(k.login);
    },
    failed(address: string, name: string) {
      const k = keys(address, name);
      pair.fail(k.pair);
      ip.fail(k.ip);
      login.fail(k.login);
    },
    succeeded(address: string, name: string) {
      pair.clear(keys(address, name).pair);
    },
  };
}
