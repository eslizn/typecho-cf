/**
 * Unit tests for src/lib/login-rate-limit.ts.
 * Covers sliding-window failure tracking and the lock/unlock lifecycle
 * used by /api/users/login (G1-3).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_LOGIN_RATE_LIMIT,
  clearLoginFailures,
  loginLockedUntil,
  readLoginRateLimitConfig,
  recordLoginFailure,
  resetLoginRateLimit,
  type LoginRateLimitConfig,
} from '@/lib/login-rate-limit';

const cfg: LoginRateLimitConfig = {
  enabled: true,
  windowSeconds: 60,
  maxFailures: 3,
  banSeconds: 30,
};

describe('login-rate-limit', () => {
  beforeEach(() => {
    resetLoginRateLimit();
  });

  it('does nothing when disabled', () => {
    const disabled: LoginRateLimitConfig = { ...cfg, enabled: false };
    for (let i = 0; i < 100; i++) recordLoginFailure('1.2.3.4', disabled);
    expect(loginLockedUntil('1.2.3.4', disabled)).toBe(0);
  });

  it('does nothing for empty IP', () => {
    recordLoginFailure('', cfg);
    expect(loginLockedUntil('', cfg)).toBe(0);
  });

  it('does not lock until maxFailures is reached', () => {
    recordLoginFailure('1.2.3.4', cfg);
    recordLoginFailure('1.2.3.4', cfg);
    expect(loginLockedUntil('1.2.3.4', cfg)).toBe(0);
  });

  it('locks after the configured number of failures', () => {
    const now = Date.now();
    for (let i = 0; i < cfg.maxFailures; i++) recordLoginFailure('1.2.3.4', cfg, now);
    const until = loginLockedUntil('1.2.3.4', cfg, now);
    expect(until).toBeGreaterThan(now);
    expect(until).toBeLessThanOrEqual(now + cfg.banSeconds * 1000 + 5);
  });

  it('lock expires after banSeconds', () => {
    const start = Date.now();
    for (let i = 0; i < cfg.maxFailures; i++) recordLoginFailure('1.2.3.4', cfg, start);
    expect(loginLockedUntil('1.2.3.4', cfg, start)).toBeGreaterThan(start);
    // Probe past the ban window — IP should be unlocked again.
    expect(loginLockedUntil('1.2.3.4', cfg, start + cfg.banSeconds * 1000 + 1)).toBe(0);
  });

  it('window resets after windowSeconds with intermittent failures', () => {
    const t0 = Date.now();
    recordLoginFailure('1.2.3.4', cfg, t0);
    recordLoginFailure('1.2.3.4', cfg, t0 + 1000);
    // Failure beyond window — counter starts over.
    recordLoginFailure('1.2.3.4', cfg, t0 + cfg.windowSeconds * 1000 + 1);
    expect(loginLockedUntil('1.2.3.4', cfg, t0 + cfg.windowSeconds * 1000 + 2)).toBe(0);
  });

  it('clearLoginFailures resets the counter', () => {
    recordLoginFailure('1.2.3.4', cfg);
    recordLoginFailure('1.2.3.4', cfg);
    clearLoginFailures('1.2.3.4');
    // Should now require maxFailures fresh failures to lock.
    recordLoginFailure('1.2.3.4', cfg);
    expect(loginLockedUntil('1.2.3.4', cfg)).toBe(0);
  });

  it('different IPs have independent counters', () => {
    for (let i = 0; i < cfg.maxFailures; i++) recordLoginFailure('1.1.1.1', cfg);
    expect(loginLockedUntil('1.1.1.1', cfg)).toBeGreaterThan(0);
    expect(loginLockedUntil('2.2.2.2', cfg)).toBe(0);
  });
});

describe('readLoginRateLimitConfig', () => {
  it('falls back to defaults when options are empty', () => {
    expect(readLoginRateLimitConfig({})).toEqual(DEFAULT_LOGIN_RATE_LIMIT);
  });

  it('honours numeric overrides within range', () => {
    const out = readLoginRateLimitConfig({
      loginFailBanWindowSeconds: 600,
      loginFailBanMaxFailures: 10,
      loginFailBanSeconds: 1800,
    });
    expect(out.windowSeconds).toBe(600);
    expect(out.maxFailures).toBe(10);
    expect(out.banSeconds).toBe(1800);
  });

  it('clamps out-of-range values', () => {
    const out = readLoginRateLimitConfig({
      loginFailBanMaxFailures: 9999,
      loginFailBanWindowSeconds: 0,
      loginFailBanSeconds: 99999,
    });
    expect(out.maxFailures).toBeLessThanOrEqual(100);
    expect(out.windowSeconds).toBeGreaterThanOrEqual(10);
    expect(out.banSeconds).toBeLessThanOrEqual(86400);
  });

  it('parses string numerics from form input', () => {
    const out = readLoginRateLimitConfig({
      loginFailBanMaxFailures: '7',
      loginFailBanWindowSeconds: '120',
      loginFailBanSeconds: '600',
    });
    expect(out.maxFailures).toBe(7);
    expect(out.windowSeconds).toBe(120);
    expect(out.banSeconds).toBe(600);
  });

  it('treats falsy enabled values as disabled', () => {
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: 0 }).enabled).toBe(false);
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: '0' }).enabled).toBe(false);
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: false }).enabled).toBe(false);
  });

  it('treats truthy enabled values as enabled', () => {
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: 1 }).enabled).toBe(true);
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: '1' }).enabled).toBe(true);
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: true }).enabled).toBe(true);
  });
});
