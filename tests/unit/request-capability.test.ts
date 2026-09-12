// The shared capability-runtime helper must keep the owner-scoped config
// accessor working while leaving the public options snapshot clean.
import { afterEach, describe, expect, it } from 'vitest';
import { registerCapability, resetCapabilityRegistry, setCapabilityActivation } from '@/lib/capability';
import { createRequestCapabilityRuntime } from '@/lib/request-capability';
import { resolveCapability } from 'typecho/plugin-sdk';

interface DemoService {
  own: Record<string, unknown>;
}

describe('createRequestCapabilityRuntime', () => {
  afterEach(() => {
    resetCapabilityRegistry();
  });

  it('hands the owning plugin its own config without leaking it to consumers', () => {
    resetCapabilityRegistry();
    registerCapability('demo-owner', {
      capability: 'demo.read',
      version: 1,
      factory: runtime => ({ own: runtime.getOwnPluginConfig() }),
    });
    setCapabilityActivation(new Set(['demo-owner']), 1);

    const runtime = createRequestCapabilityRuntime({
      request: new Request('https://example.com/admin/plugin-config?id=demo-owner'),
      db: {} as never,
      options: { 'plugin:demo-owner': JSON.stringify({ token: 'secret-value' }) } as never,
      activatedPlugins: new Set(['demo-owner']),
      activationGeneration: 1,
    });

    const resolved = resolveCapability<DemoService>(runtime, {
      capability: 'demo.read',
      ownerPluginId: 'demo-owner',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.own).toEqual({ token: 'secret-value' });
    expect(runtime.options['plugin:demo-owner']).toBeUndefined();
  });
});
