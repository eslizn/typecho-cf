import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCapabilityRuntimeContext,
  registerCapability,
  resetCapabilityRegistry,
  resolveCapability,
  setCapabilityActivation,
} from '@/lib/capability';

function runtime(owners: string[], generation = 1, config: Record<string, unknown> = {}) {
  return createCapabilityRuntimeContext({
    request: new Request('https://example.com/'),
    db: {} as any,
    env: { DB: 'binding' },
    options: { siteUrl: 'https://example.com', secret: 'must-not-leak', 'plugin:secret': 'must-not-leak' },
    activatedPlugins: new Set(owners),
    activationGeneration: generation,
    getPluginConfig: () => config,
  });
}

describe('generic capability registry', () => {
  beforeEach(() => resetCapabilityRegistry());

  it('resolves one active implementation and provides owner-only config to its factory', () => {
    const factory = vi.fn(({ getOwnPluginConfig, options }) => ({
      secret: getOwnPluginConfig().secret,
      hasPluginOption: Object.hasOwn(options, 'plugin:secret'),
    }));
    registerCapability('provider', { capability: 'example.service', version: 1, factory });
    setCapabilityActivation(new Set(['provider']), 1);

    const result = resolveCapability(runtime(['provider'], 1, { secret: 'owner-secret' }), {
      capability: 'example.service',
      minVersion: 1,
    });

    expect(result).toMatchObject({ ok: true, ownerPluginId: 'provider', version: 1 });
    expect((result as any).value).toEqual({ secret: 'owner-secret', hasPluginOption: false });
    expect(factory).toHaveBeenCalledOnce();
  });

  it('omits plugin options and the signing secret from the shared runtime options', () => {
    registerCapability('provider', { capability: 'example.service', version: 1, factory: ({ options }) => options });
    setCapabilityActivation(new Set(['provider']), 1);

    const result = resolveCapability(runtime(['provider']), { capability: 'example.service' }) as any;
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ siteUrl: 'https://example.com' });
  });

  it('fails closed when multiple owners match without an explicit owner', () => {
    registerCapability('provider-a', { capability: 'example.service', version: 1, factory: () => 'a' });
    registerCapability('provider-b', { capability: 'example.service', version: 2, factory: () => 'b' });
    setCapabilityActivation(new Set(['provider-a', 'provider-b']), 1);

    const ambiguous = resolveCapability(runtime(['provider-a', 'provider-b']), { capability: 'example.service' });
    expect(ambiguous).toMatchObject({ ok: false, reason: 'ambiguous' });

    const selected = resolveCapability(runtime(['provider-a', 'provider-b']), {
      capability: 'example.service',
      ownerPluginId: 'provider-b',
      minVersion: 2,
    });
    expect(selected).toMatchObject({ ok: true, ownerPluginId: 'provider-b', version: 2 });
  });

  it('reports unavailable and version mismatch distinctly', () => {
    registerCapability('provider', { capability: 'example.service', version: 1, factory: () => 'ok' });
    setCapabilityActivation(new Set(['provider']), 1);

    expect(resolveCapability(runtime(['other']), { capability: 'example.service' }))
      .toMatchObject({ ok: false, reason: 'unavailable' });
    expect(resolveCapability(runtime(['provider']), { capability: 'example.service', minVersion: 2 }))
      .toMatchObject({ ok: false, reason: 'version-mismatch' });
  });

  it('rejects stale activation generations and unregisters owners', () => {
    registerCapability('provider', { capability: 'example.service', version: 1, factory: () => 'ok' });
    setCapabilityActivation(new Set(['provider']), 3);
    expect(resolveCapability(runtime(['provider'], 2), { capability: 'example.service' }))
      .toMatchObject({ ok: false, reason: 'unavailable' });

    // The public resolver cannot see a deactivated owner after the host
    // updates the activation set.
    setCapabilityActivation(new Set(), 4);
    expect(resolveCapability(runtime([], 4), { capability: 'example.service' }))
      .toMatchObject({ ok: false, reason: 'unavailable' });

    setCapabilityActivation(new Set(['provider']), 5);
    expect(resolveCapability(runtime(['provider'], 5), { capability: 'example.service' }))
      .toMatchObject({ ok: true, ownerPluginId: 'provider' });
  });
});
