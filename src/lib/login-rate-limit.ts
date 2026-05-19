/**
 * In-memory failure tracker for the admin login form.
 *
 * Cloudflare Workers run a single-thread event loop per isolate, so a
 * module-scope `Map` is safe. Counters survive across requests within an
 * isolate's lifetime; new isolates start fresh, which is acceptable
 * trade-off for a brute-force defence (attackers cannot reset the counter
 * by issuing a single failed request).
 *
 * Locked is keyed by client IP only — locking by username creates a
 * trivial DoS where any attacker can lock out a known administrator. IPs
 * trade off a small amount of false positives behind shared NATs for a
 * meaningful guard against credential stuffing.
 */

export interface LoginRateLimitConfig {
  enabled: boolean;
  /** Sliding window in seconds during which failures accumulate. */
  windowSeconds: number;
  /** Failures before the IP is locked. */
  maxFailures: number;
  /** Lock duration in seconds. */
  banSeconds: number;
}

interface FailureState {
  failures: number;
  windowStartedAt: number;
  bannedUntil: number;
}

const failureStates = new Map<string, FailureState>();

export const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimitConfig = {
  enabled: true,
  windowSeconds: 300,
  maxFailures: 5,
  banSeconds: 900,
};

/**
 * Read login rate-limit configuration from the merged options object.
 * Falls back to defaults for any missing/invalid value so the worker can
 * never fail open due to a typo in the admin form.
 */
export function readLoginRateLimitConfig(options: Record<string, unknown>): LoginRateLimitConfig {
  const num = (key: string, fallback: number, min: number, max: number) => {
    const raw = options[key];
    const parsed = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  };

  return {
    enabled: options.loginFailBanEnabled === undefined
      ? DEFAULT_LOGIN_RATE_LIMIT.enabled
      : (options.loginFailBanEnabled !== 0 && options.loginFailBanEnabled !== '0' && options.loginFailBanEnabled !== false),
    windowSeconds: num('loginFailBanWindowSeconds', DEFAULT_LOGIN_RATE_LIMIT.windowSeconds, 10, 86_400),
    maxFailures: num('loginFailBanMaxFailures', DEFAULT_LOGIN_RATE_LIMIT.maxFailures, 1, 100),
    banSeconds: num('loginFailBanSeconds', DEFAULT_LOGIN_RATE_LIMIT.banSeconds, 10, 86_400),
  };
}

/** Returns the lock expiry in milliseconds, or 0 if not locked. */
export function loginLockedUntil(ip: string, config: LoginRateLimitConfig, now = Date.now()): number {
  if (!config.enabled || !ip) return 0;
  const state = failureStates.get(ip);
  if (!state) return 0;
  if (state.bannedUntil > now) return state.bannedUntil;
  if (state.bannedUntil > 0) failureStates.delete(ip);
  return 0;
}

export function recordLoginFailure(ip: string, config: LoginRateLimitConfig, now = Date.now()): void {
  if (!config.enabled || !ip) return;
  const windowMs = config.windowSeconds * 1000;
  const banMs = config.banSeconds * 1000;
  const current = failureStates.get(ip);
  const state: FailureState = !current || now - current.windowStartedAt > windowMs
    ? { failures: 0, windowStartedAt: now, bannedUntil: 0 }
    : current;

  state.failures += 1;
  if (state.failures >= config.maxFailures) {
    state.bannedUntil = now + banMs;
  }
  failureStates.set(ip, state);
}

export function clearLoginFailures(ip: string): void {
  if (!ip) return;
  failureStates.delete(ip);
}

/** For tests only. */
export function resetLoginRateLimit(): void {
  failureStates.clear();
}

// ─── Per-actor sliding-window rate limiter ─────────────────────────────────
// Reused by the upload endpoint (G5-4) to cap per-user request rate.

interface SlidingWindowState {
  count: number;
  windowStartedAt: number;
}

const slidingWindows = new Map<string, SlidingWindowState>();

export interface SlidingWindowConfig {
  windowSeconds: number;
  maxRequests: number;
}

/**
 * Returns true if the request is allowed under the sliding window for
 * the given key, false if rate-limited. Intentionally light — no Retry
 * timestamps; callers should report 429 with a `Retry-After: <window>`
 * header.
 */
export function trackSlidingWindow(
  key: string,
  config: SlidingWindowConfig,
  now = Date.now(),
): boolean {
  const windowMs = config.windowSeconds * 1000;
  const state = slidingWindows.get(key);
  if (!state || now - state.windowStartedAt > windowMs) {
    slidingWindows.set(key, { count: 1, windowStartedAt: now });
    return true;
  }
  if (state.count >= config.maxRequests) return false;
  state.count += 1;
  return true;
}

/** For tests only. */
export function resetSlidingWindow(): void {
  slidingWindows.clear();
}
