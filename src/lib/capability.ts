/**
 * Generic capability registry.
 *
 * Capabilities are deliberately independent from HookPoints, plugin manifests
 * and package dependencies. A plugin registers an implementation during init;
 * a consumer resolves one against an invocation-scoped runtime context.
 */
import type { Database } from '@/db';

export interface CapabilityDescriptor {
  capability: string;
  minVersion?: number;
  /** Optional explicit owner. Without it, more than one match is ambiguous. */
  ownerPluginId?: string;
}

interface CapabilityRuntimeSnapshot {
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

export interface CapabilityRuntimeContext extends CapabilityRuntimeSnapshot {
  readonly request: Request;
}

export interface BackgroundCapabilityRuntimeContext extends CapabilityRuntimeSnapshot {
  readonly request?: undefined;
}

export type CapabilityInvocationContext = CapabilityRuntimeContext | BackgroundCapabilityRuntimeContext;

interface CapabilityProviderConfig {
  /** Read the registering plugin's own configuration, including secrets. */
  readonly getOwnPluginConfig: () => Readonly<Record<string, unknown>>;
}

/** Context visible only to an HTTP capability provider factory. */
export type CapabilityFactoryContext = CapabilityRuntimeContext & CapabilityProviderConfig;
export type CapabilityFactory<T> = (context: CapabilityFactoryContext) => T;

export type CapabilityRegistrationInput<T = unknown> = {
  capability: string;
  version: number;
} & (
  | { scope?: 'request'; factory: CapabilityFactory<T> }
  | { scope: 'any'; factory: (context: CapabilityInvocationContext & CapabilityProviderConfig) => T }
);

export type CapabilityRegistration<T = unknown> = CapabilityRegistrationInput<T> & {
  ownerPluginId: string;
};

type RegisteredCapability<T = unknown> = CapabilityRegistration<T> & {
  /** Generation in which this owner was active and its implementation valid. */
  generation: number;
};

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
  /** False for request-scoped implementations, which Cron/consumer paths cannot resolve. */
  backgroundAvailable: boolean;
}

export type CapabilityResolveResult<T> = CapabilityResolveSuccess<T> | CapabilityResolveFailure;

interface CapabilityRuntimeSnapshotInput {
  options?: Readonly<Record<string, unknown>>;
  db: Database;
  env?: Readonly<Record<string, unknown>>;
  activatedPlugins: ReadonlySet<string>;
  activationGeneration?: number;
  /** Host-only raw config accessor used by provider factories. */
  getPluginConfig?: (pluginId: string) => Readonly<Record<string, unknown>>;
  /** Fresh authoritative database context for an operation with side effects. */
  getPrimaryDb?: () => Database;
}

export interface CapabilityRuntimeContextInput extends CapabilityRuntimeSnapshotInput {
  request: Request;
}

export interface BackgroundCapabilityRuntimeContextInput extends CapabilityRuntimeSnapshotInput {
  request?: undefined;
  signal?: AbortSignal;
}

const INTERNAL_CONFIG_ACCESSOR = Symbol('typecho.capability.config-accessor');
const INTERNAL_PRIMARY_DB = Symbol('typecho.capability.primary-db');
type InternalRuntimeContext = CapabilityInvocationContext & {
  [INTERNAL_CONFIG_ACCESSOR]?: (pluginId: string) => Readonly<Record<string, unknown>>;
  [INTERNAL_PRIMARY_DB]?: () => Database;
};

const registrations = new Map<string, RegisteredCapability[]>();
const activeOwners = new Set<string>();
let activationGeneration = 0;

/** Register or replace one implementation for an owner/capability pair. */
export function registerCapability<T>(
  ownerPluginId: string,
  registration: CapabilityRegistrationInput<T>,
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
  runtimeContext: CapabilityInvocationContext,
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
      && (runtimeContext.request !== undefined || entry.scope === 'any')
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
    const getOwnPluginConfig = () => getConfig(selected.ownerPluginId);
    let value: unknown;
    if (selected.scope === 'any') {
      value = selected.factory({ ...runtimeContext, getOwnPluginConfig });
    } else if (runtimeContext.request !== undefined) {
      value = selected.factory({ ...runtimeContext, getOwnPluginConfig });
    } else {
      return { ok: false, capability, reason: 'unavailable' };
    }
    return {
      ok: true,
      value: value as T,
      ownerPluginId: selected.ownerPluginId,
      version: selected.version,
      backgroundAvailable: selected.scope === 'any',
    };
  } catch (error) {
    console.error(`[capability] Failed to create ${capability} from ${selected.ownerPluginId}:`, error);
    return { ok: false, capability, reason: 'factory-failed', error };
  }
}

/**
 * Construct an invocation-scoped context. Raw plugin configuration is kept in a
 * non-enumerable internal slot so it cannot leak through the public options
 * snapshot or be handed to consumers.
 */
export function createCapabilityRuntimeContext(
  input: CapabilityRuntimeContextInput,
): CapabilityRuntimeContext;
export function createCapabilityRuntimeContext(
  input: BackgroundCapabilityRuntimeContextInput,
): BackgroundCapabilityRuntimeContext;
export function createCapabilityRuntimeContext(
  input: CapabilityRuntimeContextInput | BackgroundCapabilityRuntimeContextInput,
): CapabilityInvocationContext {
  const options = Object.fromEntries(
    Object.entries(input.options ?? {}).filter(([key]) => (
      // Raw plugin configuration stays behind the owner-scoped accessor, and
      // the signing secret is never part of the shareable options snapshot.
      !key.startsWith('plugin:') && key !== 'secret'
    )),
  );
  const snapshot: CapabilityRuntimeSnapshot = {
    signal: input.request === undefined
      ? input.signal ?? new AbortController().signal
      : input.request.signal,
    options: Object.freeze(options),
    db: input.db,
    env: input.env ?? {},
    activatedPlugins: new Set(input.activatedPlugins),
    activationGeneration: input.activationGeneration ?? activationGeneration,
  };
  const context: InternalRuntimeContext = input.request === undefined
    ? snapshot
    : { ...snapshot, request: input.request };
  Object.defineProperties(context, {
    [INTERNAL_CONFIG_ACCESSOR]: { value: input.getPluginConfig },
    [INTERNAL_PRIMARY_DB]: { value: input.getPrimaryDb },
  });
  return Object.freeze(context);
}

export function getCapabilityPrimaryDb(context: CapabilityInvocationContext): Database | undefined {
  return (context as InternalRuntimeContext)[INTERNAL_PRIMARY_DB]?.();
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
