import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoginLimits, FailureCounter } from '../src/loginLimits.ts';

describe('лимиты входа', () => {
  it('окно счётчика истекает', () => {
    const counter = new FailureCounter(2, 1000);
    counter.fail('k', 0);
    counter.fail('k', 10);
    assert.equal(counter.blocked('k', 20), true);
    assert.equal(counter.blocked('k', 1001), false);
    counter.fail('k', 1001);
    assert.equal(counter.blocked('k', 1002), false);
  });

  it('перебор логинов с одного IP упирается в лимит адреса', () => {
    const limits = createLoginLimits();
    for (let i = 0; i < 30; i++) limits.failed('203.0.113.9', `user${i}`);
    assert.equal(limits.blocked('203.0.113.9', 'olga'), true);
    assert.equal(limits.blocked('198.51.100.7', 'olga'), false);
  });

  it('подбор одного логина со многих IP упирается в лимит логина', () => {
    const limits = createLoginLimits();
    for (let i = 0; i < 99; i++) limits.failed(`10.0.${i >> 8}.${i & 255}`, 'olga');
    assert.equal(limits.blocked('198.51.100.7', 'olga'), false);
    limits.failed('10.9.9.9', 'olga');
    assert.equal(limits.blocked('198.51.100.7', 'olga'), true);
    assert.equal(limits.blocked('198.51.100.7', 'max'), false);
  });
});
