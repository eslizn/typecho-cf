import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface DeclaredPackage {
  packageName: string;
  packageDir: string;
  /** Source path for local file dependencies, expressed in Vite root form. */
  importBase?: string;
}

export interface RuntimePackage {
  packageName: string;
  packageDir: string;
  packageJson: Record<string, unknown>;
  importBase?: string;
  direct: boolean;
}

export interface RuntimePackageDependency {
  packageName: string;
  specifier: string;
  kind: 'required' | 'optional';
  parent: RuntimePackage;
  target?: RuntimePackage;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

function toViteRootPath(rootDir: string, filePath: string): string | undefined {
  const relativePath = relative(rootDir, filePath);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    return undefined;
  }
  return `/${relativePath.split(sep).join('/')}`;
}

/**
 * Resolve only packages explicitly declared by the application package.json.
 *
 * Local file dependencies are resolved from their source directory so a
 * stale pnpm snapshot cannot hide current workspace changes. Registry-style
 * dependencies are resolved from the direct node_modules entry. Packages
 * that are absent or malformed are ignored and will not enter the build graph.
 */
export function discoverDeclaredPackages(rootDir: string): DeclaredPackage[] {
  return discoverRuntimePackages(rootDir)
    .filter(packageInfo => packageInfo.direct)
    .map(({ packageName, packageDir, importBase }) => ({ packageName, packageDir, importBase }));
}

/**
 * Resolve the complete runtime package graph from the root package manifest.
 * This intentionally excludes devDependencies: only packages that can be
 * installed in production are allowed to introduce a Typecho plugin.
 */
export function discoverRuntimePackages(rootDir: string): RuntimePackage[] {
  const rootPackage = readPackageJson(join(rootDir, 'package.json'));
  if (!rootPackage) return [];

  const packages: RuntimePackage[] = [];
  const visited = new Set<string>();
  const queue: Array<{ packageName: string; specifier: string; parentDir: string; direct: boolean }> = [];
  for (const [packageName, specifier] of collectRuntimeDependencies(rootPackage)) {
    queue.push({ packageName, specifier, parentDir: rootDir, direct: true });
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    const packageDir = resolvePackageDirectory(rootDir, item.parentDir, item.packageName, item.specifier);
    if (!packageDir || visited.has(packageDir)) continue;
    const packageJson = readPackageJson(join(packageDir, 'package.json'));
    if (!packageJson) continue;

    const packageInfo: RuntimePackage = {
      packageName: typeof packageJson.name === 'string' ? packageJson.name : item.packageName,
      packageDir,
      packageJson,
      // Direct registry packages can use normal package resolution from the
      // generated virtual module. A transitive registry plugin may only be
      // visible from its parent's nested node_modules (notably with pnpm's
      // isolated linker), so retain a root-relative import path for it.
      importBase: item.specifier.startsWith('file:') || !item.direct
        ? toViteRootPath(rootDir, packageDir)
        : undefined,
      direct: item.direct,
    };
    visited.add(packageDir);
    packages.push(packageInfo);

    for (const [packageName, specifier] of collectRuntimeDependencies(packageJson)) {
      queue.push({ packageName, specifier, parentDir: packageDir, direct: false });
    }
  }

  return packages;
}

/** Resolve dependency declarations together with their package targets. */
export function discoverRuntimePackageDependencies(
  rootDir: string,
): { packages: RuntimePackage[]; dependencies: RuntimePackageDependency[] } {
  const packages = discoverRuntimePackages(rootDir);
  const byDirectory = new Map(packages.map(packageInfo => [packageInfo.packageDir, packageInfo]));
  const dependencies: RuntimePackageDependency[] = [];

  for (const parent of packages) {
    for (const [packageName, specifier, kind] of collectRuntimeDependenciesWithKind(parent.packageJson)) {
      const targetDir = resolvePackageDirectory(rootDir, parent.packageDir, packageName, specifier);
      dependencies.push({
        packageName,
        specifier,
        kind,
        parent,
        target: targetDir ? byDirectory.get(targetDir) : undefined,
      });
    }
  }

  return { packages, dependencies };
}

function readPackageJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function collectRuntimeDependencies(pkg: Record<string, unknown>): Array<[string, string]> {
  return [...collectRuntimeDependenciesWithKind(pkg)].map(([packageName, specifier]) => (
    [packageName, specifier] as [string, string]
  ));
}

function collectRuntimeDependenciesWithKind(
  pkg: Record<string, unknown>,
): Array<[string, string, 'required' | 'optional']> {
  const dependencySpecs = new Map<string, { specifier: string; kind: 'required' | 'optional' }>();
  for (const field of DEPENDENCY_FIELDS) {
    const section = pkg[field];
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    for (const [packageName, specifier] of Object.entries(section as Record<string, unknown>)) {
      if (typeof specifier !== 'string') continue;
      const optional = field === 'optionalDependencies'
        || (field === 'peerDependencies' && isOptionalPeer(pkg, packageName));
      const previous = dependencySpecs.get(packageName);
      if (!previous || (!optional && previous.kind === 'optional')) {
        dependencySpecs.set(packageName, { specifier, kind: optional ? 'optional' : 'required' });
      }
    }
  }
  return [...dependencySpecs.entries()].map(([packageName, value]) => [packageName, value.specifier, value.kind]);
}

function isOptionalPeer(pkg: Record<string, unknown>, packageName: string): boolean {
  const meta = pkg.peerDependenciesMeta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const entry = (meta as Record<string, unknown>)[packageName];
  return !!entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as Record<string, unknown>).optional === true;
}

function resolvePackageDirectory(
  rootDir: string,
  parentDir: string,
  packageName: string,
  specifier: string,
): string | undefined {
  const candidates: string[] = [];
  if (specifier.startsWith('file:')) {
    candidates.push(join(parentDir, specifier.slice('file:'.length)));
  } else {
    let current = parentDir;
    while (true) {
      candidates.push(join(current, 'node_modules', packageName));
      if (current === rootDir) break;
      const parent = join(current, '..');
      if (parent === current) break;
      current = parent;
    }
  }
  for (const candidate of candidates) {
    try {
      return realpathSync(candidate);
    } catch {
      // Continue to the next node_modules ancestor.
    }
  }
  return undefined;
}
