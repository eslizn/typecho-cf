/**
 * Runtime representation of the plugin dependency graph.
 *
 * The graph is generated from package-manager metadata at build time. This
 * module intentionally knows nothing about package.json or the AI plugin so
 * it can also be used by the admin activation path and request bootstrap.
 */

export type PluginDependencyKind = 'required' | 'optional';

export interface PluginDependency {
  pluginId: string;
  packageName: string;
  range: string;
  kind: PluginDependencyKind;
}

export type PluginDependencyIssueCode =
  | 'duplicate-plugin-id'
  | 'missing-required-dependency'
  | 'unsatisfied-required-dependency'
  | 'unverifiable-dependency-range'
  | 'dependency-not-active'
  | 'dependency-cycle'
  | 'unknown-plugin';

/**
 * Issue codes that make a plugin unavailable.
 *
 * Codes outside this set are diagnostics only: an unverifiable dependency
 * range (for example `latest` or an `npm:` alias) must not stop an admin from
 * enabling the plugin, because it cannot be evaluated offline either way.
 */
export const BLOCKING_DEPENDENCY_ISSUE_CODES: ReadonlySet<PluginDependencyIssueCode> = new Set([
  'duplicate-plugin-id',
  'missing-required-dependency',
  'unsatisfied-required-dependency',
  'dependency-not-active',
  'dependency-cycle',
  'unknown-plugin',
]);

export interface PluginDependencyIssue {
  pluginId: string;
  dependencyId?: string;
  code: PluginDependencyIssueCode;
  message: string;
}

export interface PluginDependencyNode {
  id: string;
  dependencies?: ReadonlyArray<PluginDependency>;
  issues?: ReadonlyArray<PluginDependencyIssue>;
}

export interface PluginActivationPlan {
  requested: string[];
  effective: string[];
  blocked: string[];
  diagnostics: PluginDependencyIssue[];
}

export interface PluginActivationActionPlan extends PluginActivationPlan {
  ok: boolean;
  action: 'activate' | 'deactivate';
  pluginId: string;
  cascadedDependents: string[];
}

/**
 * Validate a requested activation set. Dependencies are never auto-enabled;
 * a required dependency must already be present in the requested set.
 */
export function planPluginActivation(
  requestedIds: Iterable<string>,
  nodes: ReadonlyMap<string, PluginDependencyNode>,
  opaqueIds: ReadonlySet<string> = new Set(),
): PluginActivationPlan {
  const requested = uniqueIds(requestedIds);
  const requestedSet = new Set(requested);
  const diagnostics: PluginDependencyIssue[] = [];
  const diagnosticKeys = new Set<string>();
  const blocked = new Set<string>();
  const known = new Set([...nodes.keys(), ...opaqueIds]);

  const addDiagnostic = (issue: PluginDependencyIssue): void => {
    const key = `${issue.pluginId}\u0000${issue.dependencyId ?? ''}\u0000${issue.code}`;
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push(issue);
  };

  for (const pluginId of requested) {
    if (known.has(pluginId)) continue;
    blocked.add(pluginId);
    addDiagnostic({
      pluginId,
      code: 'unknown-plugin',
      message: `Plugin ${pluginId} is not discovered by the build-time plugin registry.`,
    });
  }

  const cycleNodes = findRequiredCycleNodes(nodes);
  for (const pluginId of cycleNodes) {
    if (!requestedSet.has(pluginId)) continue;
    blocked.add(pluginId);
    addDiagnostic({
      pluginId,
      code: 'dependency-cycle',
      message: `Plugin ${pluginId} is part of a required dependency cycle.`,
    });
  }

  const states = new Map<string, 'visiting' | 'valid' | 'blocked'>();
  const canActivate = (pluginId: string): boolean => {
    if (!known.has(pluginId)) return false;
    const state = states.get(pluginId);
    if (state === 'valid') return true;
    if (state === 'blocked') return false;
    if (state === 'visiting') return false;
    states.set(pluginId, 'visiting');

    const node = nodes.get(pluginId);
    if (!node) {
      states.set(pluginId, 'valid');
      return true;
    }

    let valid = true;
    for (const issue of node.issues ?? []) {
      addDiagnostic(issue);
      if (BLOCKING_DEPENDENCY_ISSUE_CODES.has(issue.code)) valid = false;
    }

    if (cycleNodes.has(pluginId)) valid = false;
    for (const dependency of node.dependencies ?? []) {
      if (dependency.kind !== 'required') continue;
      if (!known.has(dependency.pluginId)) {
        valid = false;
        addDiagnostic({
          pluginId,
          dependencyId: dependency.pluginId,
          code: 'missing-required-dependency',
          message: `Plugin ${pluginId} requires missing plugin ${dependency.pluginId}.`,
        });
        continue;
      }
      if (!requestedSet.has(dependency.pluginId)) {
        valid = false;
        addDiagnostic({
          pluginId,
          dependencyId: dependency.pluginId,
          code: 'dependency-not-active',
          message: `Plugin ${pluginId} requires ${dependency.pluginId} to be enabled first.`,
        });
        continue;
      }
      if (!canActivate(dependency.pluginId)) {
        valid = false;
        addDiagnostic({
          pluginId,
          dependencyId: dependency.pluginId,
          code: 'unsatisfied-required-dependency',
          message: `Plugin ${pluginId} cannot use invalid dependency ${dependency.pluginId}.`,
        });
      }
    }

    states.set(pluginId, valid ? 'valid' : 'blocked');
    if (!valid) blocked.add(pluginId);
    return valid;
  };

  for (const pluginId of requested) canActivate(pluginId);

  const active = new Set(requested.filter(pluginId => !blocked.has(pluginId)));
  const effective: string[] = [];
  const visited = new Set<string>();
  const visit = (pluginId: string): void => {
    if (!active.has(pluginId) || visited.has(pluginId)) return;
    visited.add(pluginId);
    const node = nodes.get(pluginId);
    for (const dependency of node?.dependencies ?? []) {
      if (active.has(dependency.pluginId)) visit(dependency.pluginId);
    }
    effective.push(pluginId);
  };
  for (const pluginId of requested) visit(pluginId);

  return {
    requested,
    effective,
    blocked: requested.filter(pluginId => blocked.has(pluginId)),
    diagnostics,
  };
}

/** Apply one admin enable/disable action to the requested activation set. */
export function planPluginActivationAction(
  requestedIds: Iterable<string>,
  pluginId: string,
  action: 'activate' | 'deactivate',
  nodes: ReadonlyMap<string, PluginDependencyNode>,
  opaqueIds: ReadonlySet<string> = new Set(),
): PluginActivationActionPlan {
  const current = new Set(uniqueIds(requestedIds));
  const cascadedDependents: string[] = [];

  if (action === 'activate') {
    current.add(pluginId);
  } else {
    const removed = new Set<string>([pluginId]);
    current.delete(pluginId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [candidateId, node] of nodes) {
        if (!current.has(candidateId)) continue;
        const requiresRemoved = (node.dependencies ?? []).some(dependency =>
          dependency.kind === 'required' && removed.has(dependency.pluginId));
        if (!requiresRemoved) continue;
        current.delete(candidateId);
        removed.add(candidateId);
        cascadedDependents.push(candidateId);
        changed = true;
      }
    }
  }

  const plan = planPluginActivation(current, nodes, opaqueIds);
  const targetBlocked = action === 'activate' && plan.blocked.includes(pluginId);
  return {
    ...plan,
    ok: action === 'deactivate' || !targetBlocked,
    action,
    pluginId,
    cascadedDependents,
  };
}

function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter(id => typeof id === 'string' && id.length > 0))];
}

function findRequiredCycleNodes(nodes: ReadonlyMap<string, PluginDependencyNode>): Set<string> {
  const states = new Map<string, 'unvisited' | 'visiting' | 'visited'>();
  const stack: string[] = [];
  const cycles = new Set<string>();

  const visit = (pluginId: string): void => {
    const state = states.get(pluginId) ?? 'unvisited';
    if (state === 'visited') return;
    if (state === 'visiting') {
      const start = stack.lastIndexOf(pluginId);
      if (start >= 0) for (const id of stack.slice(start)) cycles.add(id);
      return;
    }
    states.set(pluginId, 'visiting');
    stack.push(pluginId);
    for (const dependency of nodes.get(pluginId)?.dependencies ?? []) {
      if (dependency.kind === 'required' && nodes.has(dependency.pluginId)) visit(dependency.pluginId);
    }
    stack.pop();
    states.set(pluginId, 'visited');
  };

  for (const pluginId of nodes.keys()) visit(pluginId);
  return cycles;
}
