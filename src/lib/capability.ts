/**
 * Generic capability registry.
 *
 * Capabilities are deliberately independent from HookPoints, plugin manifests
 * and package dependencies. A plugin registers an implementation during init;
 * a consumer resolves one against a request-scoped runtime context.
 */
import type { Database } from '@/db';

export interface CapabilityDescriptor {
  capability: string;
  minVersion?: number;
  /** Optional explicit owner. Without it, more than one match is ambiguous. */
  ownerPluginId?: string;
}

export interface CapabilityRuntimeContext {
  readonly request: Request;
  readonly signal: AbortSignal;
  /**
   * Site options with all `plugin:*` entries and the signing `secret`
   * removed: the runtime context is meant to be safe to hand to consumers.
   */
  readonly options: Readonly<Record<string, unknown>>;
  readonly db: Database;
  readonly env: Readonly<Record<string, unknown>>;
  readonly activatedPlugins: ReadonlySet<string>;
  readonly activationGeneration: number;
}

/** Context visible only to a provider factory, not to capability consumers. */
export interface CapabilityFactoryContext extends CapabilityRuntimeContext {
  /** Read the registering plugin's own configuration, including secrets. */
  readonly getOwnPluginConfig: () => Readonly<Record<string, unknown>>;
}

export type CapabilityFactory<T> = (context: CapabilityFactoryContext) => T;

export interface CapabilityRegistration<T = unknown> {
  capability: string;
  version: number;
  ownerPluginId: string;
  factory: CapabilityFactory<T>;
}

interface RegisteredCapability<T = unknown> extends CapabilityRegistration<T> {
  /** Generation in which this owner was active and its implementation valid. */
  generation: number;
}

export type CapabilityResolveFailureReason =
  | 'unavailable'
  | 'ambiguous'
  | 'version-mismatch'
  | 'factory-failed';

export interface CapabilityResolveFailure {
  ok: false;
  capability: string;
  reason: CapabilityResolveFailureReason;
  candidates?: ReadonlyArray<{ ownerPluginId: string; version: number }>;
  error?: unknown;
}

export interface CapabilityResolveSuccess<T> {
  ok: true;
  value: T;
  ownerPluginId: string;
  version: number;
}

export type CapabilityResolveResult<T> = CapabilityResolveSuccess<T> | CapabilityResolveFailure;

export interface CapabilityRuntimeContextInput {
  request: Request;
  options?: Readonly<Record<string, unknown>>;
  db: Database;
  env?: Readonly<Record<string, unknown>>;
  activatedPlugins: ReadonlySet<string>;
  activationGeneration?: number;
  /** Host-only raw config accessor used by provider factories. */
  getPluginConfig?: (pluginId: string) => Readonly<Record<string, unknown>>;
}

const INTERNAL_CONFIG_ACCESSOR = Symbol('typecho.capability.config-accessor');
type InternalRuntimeContext = CapabilityRuntimeContext & {
  [INTERNAL_CONFIG_ACCESSOR]?: (pluginId: string) => Readonly<Record<string, unknown>>;
};

const registrations = new Map<string, RegisteredCapability[]>();
const activeOwners = new Set<string>();
let activationGeneration = 0;

/** Register or replace one implementation for an owner/capability pair. */
export function registerCapability<T>(
  ownerPluginId: string,
  registration: Omit<CapabilityRegistration<T>, 'ownerPluginId'>,
): void {
  if (!isValidCapabilityName(registration.capability)) {
    throw new TypeError('capability must be a non-empty dot-separated name');
  }
  if (!Number.isSafeInteger(registration.version) || registration.version < 1) {
    throw new TypeError('capability version must be a positive integer');
  }
  if (typeof registration.factory !== 'function') {
    throw new TypeError('capability factory must be a function');
  }

  const list = registrations.get(ownerPluginId) ?? [];
  const entry: RegisteredCapability<T> = { ...registration, ownerPluginId, generation: activationGeneration };
  const existingIndex = list.findIndex(item => item.capability === entry.capability);
  if (existingIndex >= 0) list[existingIndex] = entry;
  else list.push(entry);
  registrations.set(ownerPluginId, list);
}

/** Remove all capability implementations registered by one plugin. */
export function unregisterCapabilityOwner(ownerPluginId: string): void {
  registrations.delete(ownerPluginId);
  activeOwners.delete(ownerPluginId);
}

/**
 * Bind the registry to the request activation generation. This is called by
 * the plugin runtime whenever the effective activated set is rebuilt.
 */
export function setCapabilityActivation(
  activePluginIds: ReadonlySet<string>,
  generation: number,
): void {
  activeOwners.clear();
  for (const pluginId of activePluginIds) activeOwners.add(pluginId);
  activationGeneration = generation;
  // A successfully initialized plugin can stay initialized while another
  // plugin is enabled/disabled. Rebind its implementation to the new
  // activation generation; inactive owners remain invalid until they are
  // explicitly activated again.
  for (const [ownerPluginId, ownerRegistrations] of registrations) {
    if (!activeOwners.has(ownerPluginId)) continue;
    for (const registration of ownerRegistrations) registration.generation = generation;
  }
}

export function getCapabilityActivationGeneration(): number {
  return activationGeneration;
}

/** Resolve one implementation without silently selecting among providers. */
export function resolveCapability<T>(
  runtimeContext: CapabilityRuntimeContext,
  descriptor: CapabilityDescriptor,
): CapabilityResolveResult<T> {
  const capability = descriptor.capability;
  const minVersion = descriptor.minVersion ?? 1;
  if (!isValidCapabilityName(capability) || !Number.isSafeInteger(minVersion) || minVersion < 1) {
    return { ok: false, capability, reason: 'unavailable' };
  }

  const candidates = [...registrations.values()]
    .flat()
    .filter(entry => (
      entry.capability === capability
      && activeOwners.has(entry.ownerPluginId)
      && runtimeContext.activatedPlugins.has(entry.ownerPluginId)
      && entry.generation === activationGeneration
      && runtimeContext.activationGeneration === activationGeneration
      && (!descriptor.ownerPluginId || descriptor.ownerPluginId === entry.ownerPluginId)
    ));

  const compatible = candidates.filter(entry => entry.version >= minVersion);
  if (compatible.length === 0) {
    return {
      ok: false,
      capability,
      reason: candidates.length > 0 ? 'version-mismatch' : 'unavailable',
      candidates: candidates.map(entry => ({ ownerPluginId: entry.ownerPluginId, version: entry.version })),
    };
  }
  if (compatible.length > 1) {
    return {
      ok: false,
      capability,
      reason: 'ambiguous',
      candidates: compatible.map(entry => ({ ownerPluginId: entry.ownerPluginId, version: entry.version })),
    };
  }

  const selected = compatible[0];
  try {
    const internal = runtimeContext as InternalRuntimeContext;
    const getConfig = internal[INTERNAL_CONFIG_ACCESSOR] ?? (() => ({}));
    const value = selected.factory({
      ...runtimeContext,
      getOwnPluginConfig: () => getConfig(selected.ownerPluginId),
    });
    return {
      ok: true,
      value: value as T,
      ownerPluginId: selected.ownerPluginId,
      version: selected.version,
    };
  } catch (error) {
    console.error(`[capability] Failed to create ${capability} from ${selected.ownerPluginId}:`, error);
    return { ok: false, capability, reason: 'factory-failed', error };
  }
}

/**
 * Construct a request-scoped context. Raw plugin configuration is kept in a
 * non-enumerable internal slot so it cannot leak through the public options
 * snapshot or be handed to consumers.
 */
export function createCapabilityRuntimeContext(
  input: CapabilityRuntimeContextInput,
): CapabilityRuntimeContext {
  const options = Object.fromEntries(
    Object.entries(input.options ?? {}).filter(([key]) => (
      // Raw plugin configuration stays behind the owner-scoped accessor, and
      // the signing secret is never part of the shareable options snapshot.
      !key.startsWith('plugin:') && key !== 'secret'
    )),
  );
  const context: InternalRuntimeContext = {
    request: input.request,
    signal: input.request.signal,
    options: Object.freeze(options),
    db: input.db,
    env: input.env ?? {},
    activatedPlugins: new Set(input.activatedPlugins),
    activationGeneration: input.activationGeneration ?? activationGeneration,
  };
  Object.defineProperty(context, INTERNAL_CONFIG_ACCESSOR, {
    value: input.getPluginConfig ?? (() => ({})),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(context);
}

/** Test/runtime reset used when the plugin registry is rebuilt. */
export function resetCapabilityRegistry(): void {
  registrations.clear();
  activeOwners.clear();
  activationGeneration = 0;
}

function isValidCapabilityName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/i.test(value);
}
