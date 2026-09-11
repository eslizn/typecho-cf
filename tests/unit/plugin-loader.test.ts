import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverPlugins } from '@/integrations/plugin-loader';
import { planPluginActivation, planPluginActivationAction, type PluginDependencyNode } from '@/lib/plugin-dependencies';

const temporaryRoots: string[] = [];

function writePlugin(directory: string, packageName: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: packageName,
    keywords: ['typecho', 'plugin'],
    typecho: { plugin: { id: packageName, name: packageName } },
  }));
  writeFileSync(join(directory, 'index.ts'), 'export default function init() {}');
}

function writePackage(directory: string, value: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(value));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin loader declared dependencies', () => {
  it('ignores a typecho plugin that is only present in node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-plugin-loader-'));
    temporaryRoots.push(root);

    writePlugin(join(root, 'node_modules', 'typecho-plugin-unlisted'), 'typecho-plugin-unlisted');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));

    expect(discoverPlugins(root)).toEqual([]);
  });

  it('discovers declared local and registry-style plugins', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-plugin-loader-'));
    temporaryRoots.push(root);

    const localName = 'typecho-plugin-local';
    const externalName = 'typecho-plugin-external';
    writePlugin(join(root, 'src', 'plugins', localName), localName);
    writePlugin(join(root, 'node_modules', externalName), externalName);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        [localName]: `file:src/plugins/${localName}`,
        [externalName]: '1.0.0',
      },
    }));

    const plugins = discoverPlugins(root);

    expect(plugins.map(plugin => plugin.packageName)).toEqual([localName, externalName]);
    expect(plugins[0].importPath).toBe(`/src/plugins/${localName}/index.ts`);
    expect(plugins[1].importPath).toBe(`${externalName}/index.ts`);
  });

  it('discovers transitive plugins from runtime dependency metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-plugin-loader-'));
    temporaryRoots.push(root);

    const parent = 'typecho-plugin-parent';
    const dependency = 'typecho-plugin-dependency';
    writePlugin(join(root, 'node_modules', parent), parent);
    writePackage(join(root, 'node_modules', parent), {
      name: parent,
      version: '1.0.0',
      keywords: ['typecho', 'plugin'],
      typecho: { plugin: { id: parent, name: parent, version: '1.0.0' } },
      dependencies: { [dependency]: '^2.0.0' },
    });
    writePackage(join(root, 'node_modules', dependency), {
      name: dependency,
      version: '2.1.0',
      keywords: ['typecho', 'plugin'],
      typecho: { plugin: { id: dependency, name: dependency, version: '2.1.0' } },
    });
    writeFileSync(join(root, 'node_modules', dependency, 'index.ts'), 'export default function init() {}');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [parent]: '1.0.0' } }));

    const plugins = discoverPlugins(root);
    expect(plugins.map(plugin => plugin.id)).toEqual([parent, dependency]);
    expect(plugins[0].dependencies).toEqual([{
      pluginId: dependency,
      packageName: dependency,
      range: '^2.0.0',
      kind: 'required',
    }]);
    expect(plugins[0].issues).toEqual([]);
  });

  it('imports a transitive plugin from its nested node_modules path', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-plugin-loader-'));
    temporaryRoots.push(root);

    const parent = 'typecho-plugin-parent';
    const dependency = 'typecho-plugin-nested-dependency';
    writePackage(join(root, 'node_modules', parent), {
      name: parent,
      version: '1.0.0',
      keywords: ['typecho', 'plugin'],
      typecho: { plugin: { id: parent, name: parent, version: '1.0.0' } },
      dependencies: { [dependency]: '^1.0.0' },
    });
    writeFileSync(join(root, 'node_modules', parent, 'index.ts'), 'export default function init() {}');
    writePlugin(join(root, 'node_modules', parent, 'node_modules', dependency), dependency);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [parent]: '1.0.0' } }));

    const plugins = discoverPlugins(root);
    expect(plugins.map(plugin => plugin.id)).toEqual([parent, dependency]);
    expect(plugins[1].importPath).toBe(`/node_modules/${parent}/node_modules/${dependency}/index.ts`);
  });

  it('ignores dev-only plugins and keeps optional dependency failures non-blocking', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-plugin-loader-'));
    temporaryRoots.push(root);

    const parent = 'typecho-plugin-parent';
    const devOnly = 'typecho-plugin-dev-only';
    writePlugin(join(root, 'node_modules', devOnly), devOnly);
    writePackage(join(root, 'node_modules', parent), {
      name: parent,
      version: '1.0.0',
      keywords: ['typecho', 'plugin'],
      typecho: { plugin: { id: parent, name: parent, version: '1.0.0' } },
      optionalDependencies: { 'typecho-plugin-missing-optional': '^1.0.0' },
    });
    writeFileSync(join(root, 'node_modules', parent, 'index.ts'), 'export default function init() {}');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: { [parent]: '1.0.0' },
      devDependencies: { [devOnly]: '1.0.0' },
    }));

    const plugins = discoverPlugins(root);
    expect(plugins.map(plugin => plugin.id)).toEqual([parent]);
    expect(plugins[0].issues).toEqual([]);
  });

  it('treats a non-semver dependency specifier as unverifiable instead of blocking', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-plugin-loader-'));
    temporaryRoots.push(root);

    const parent = 'typecho-plugin-parent';
    const dependency = 'typecho-plugin-latest-dependency';
    writePlugin(join(root, 'node_modules', parent), parent);
    writePackage(join(root, 'node_modules', parent), {
      name: parent,
      version: '1.0.0',
      keywords: ['typecho', 'plugin'],
      typecho: { plugin: { id: parent, name: parent, version: '1.0.0' } },
      dependencies: { [dependency]: 'latest' },
    });
    writePackage(join(root, 'node_modules', dependency), {
      name: dependency,
      version: '3.2.1',
      keywords: ['typecho', 'plugin'],
      typecho: { plugin: { id: dependency, name: dependency, version: '3.2.1' } },
    });
    writeFileSync(join(root, 'node_modules', dependency, 'index.ts'), 'export default function init() {}');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [parent]: '1.0.0' } }));

    const plugins = discoverPlugins(root);
    const consumer = plugins.find(plugin => plugin.id === parent)!;
    expect(consumer.dependencies).toEqual([{
      pluginId: dependency,
      packageName: dependency,
      range: 'latest',
      kind: 'required',
    }]);
    expect(consumer.issues).toEqual([{
      pluginId: parent,
      dependencyId: dependency,
      code: 'unverifiable-dependency-range',
      message: expect.stringContaining('not a semver range'),
    }]);

    // The diagnostic is informational: the admin can still enable both
    // plugins, and the range check reports no version mismatch.
    const nodes = new Map<string, PluginDependencyNode>(
      plugins.map(plugin => [plugin.id, {
        id: plugin.id,
        dependencies: plugin.dependencies,
        issues: plugin.issues,
      }] as [string, PluginDependencyNode]),
    );
    const plan = planPluginActivation([parent, dependency], nodes);
    expect(plan.blocked).toEqual([]);
    expect(plan.effective).toEqual([dependency, parent]);
    expect(plan.diagnostics.map(issue => issue.code)).toEqual(['unverifiable-dependency-range']);
  });

  it('still reports a required dependency whose installed version misses the range', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-plugin-loader-'));
    temporaryRoots.push(root);

    const parent = 'typecho-plugin-parent';
    const dependency = 'typecho-plugin-old-dependency';
    writePlugin(join(root, 'node_modules', parent), parent);
    writePackage(join(root, 'node_modules', parent), {
      name: parent,
      version: '1.0.0',
      keywords: ['typecho', 'plugin'],
      typecho: { plugin: { id: parent, name: parent, version: '1.0.0' } },
      dependencies: { [dependency]: '^9.0.0' },
    });
    writePackage(join(root, 'node_modules', dependency), {
      name: dependency,
      version: '3.2.1',
      keywords: ['typecho', 'plugin'],
      typecho: { plugin: { id: dependency, name: dependency, version: '3.2.1' } },
    });
    writeFileSync(join(root, 'node_modules', dependency, 'index.ts'), 'export default function init() {}');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [parent]: '1.0.0' } }));

    const consumer = discoverPlugins(root).find(plugin => plugin.id === parent)!;
    expect(consumer.issues).toEqual([{
      pluginId: parent,
      dependencyId: dependency,
      code: 'unsatisfied-required-dependency',
      message: expect.stringContaining('but 3.2.1 is installed'),
    }]);
  });
});


describe('plugin activation dependency plans', () => {
  const nodes = new Map<string, PluginDependencyNode>([
    ['provider', { id: 'provider' }],
    ['consumer', {
      id: 'consumer',
      dependencies: [{ pluginId: 'provider', packageName: 'provider', range: '^1.0.0', kind: 'required' }],
    }],
    ['optional-consumer', {
      id: 'optional-consumer',
      dependencies: [{ pluginId: 'provider', packageName: 'provider', range: '^1.0.0', kind: 'optional' }],
    }],
  ]);

  it('does not auto-enable required dependencies', () => {
    const plan = planPluginActivation(['consumer'], nodes);
    expect(plan.effective).toEqual([]);
    expect(plan.blocked).toEqual(['consumer']);
    expect(plan.diagnostics[0].code).toBe('dependency-not-active');
  });

  it('orders active dependencies before their consumers', () => {
    expect(planPluginActivation(['consumer', 'provider'], nodes).effective)
      .toEqual(['provider', 'consumer']);
  });

  it('cascades required dependents but leaves optional consumers available', () => {
    const plan = planPluginActivationAction(
      ['provider', 'consumer', 'optional-consumer'],
      'provider',
      'deactivate',
      nodes,
    );
    expect(plan.ok).toBe(true);
    expect(plan.cascadedDependents).toEqual(['consumer']);
    expect(plan.effective).toEqual(['optional-consumer']);
  });

  it('still blocks a plugin whose dependency issue is a real version mismatch', () => {
    const plan = planPluginActivation(['consumer-blocked', 'provider'], new Map<string, PluginDependencyNode>([
      ['provider', { id: 'provider' }],
      ['consumer-blocked', {
        id: 'consumer-blocked',
        dependencies: [{ pluginId: 'provider', packageName: 'provider', range: '^9.0.0', kind: 'required' }],
        issues: [{
          pluginId: 'consumer-blocked',
          dependencyId: 'provider',
          code: 'unsatisfied-required-dependency',
          message: 'version mismatch',
        }],
      }],
    ]));
    expect(plan.blocked).toEqual(['consumer-blocked']);
    expect(plan.effective).toEqual(['provider']);
  });

  it('does not block a plugin whose only issue is an unverifiable range', () => {
    const plan = planPluginActivation(['consumer-notice', 'provider'], new Map<string, PluginDependencyNode>([
      ['provider', { id: 'provider' }],
      ['consumer-notice', {
        id: 'consumer-notice',
        dependencies: [{ pluginId: 'provider', packageName: 'provider', range: 'latest', kind: 'required' }],
        issues: [{
          pluginId: 'consumer-notice',
          dependencyId: 'provider',
          code: 'unverifiable-dependency-range',
          message: 'cannot verify the range',
        }],
      }],
    ]));
    expect(plan.blocked).toEqual([]);
    expect(plan.effective).toEqual(['provider', 'consumer-notice']);
  });
});
