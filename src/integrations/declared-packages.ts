import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface DeclaredPackage {
  packageName: string;
  packageDir: string;
  /** Source path for local file dependencies, expressed in Vite root form. */
  importBase?: string;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

function toViteRootPath(rootDir: string, filePath: string): string {
  return `/${relative(rootDir, filePath).split(sep).join('/')}`;
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
  const packagePath = join(rootDir, 'package.json');
  if (!existsSync(packagePath)) return [];

  let rootPackage: Record<string, unknown>;
  try {
    rootPackage = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }

  const dependencySpecs = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    const section = rootPackage[field];
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    for (const [packageName, specifier] of Object.entries(section)) {
      if (typeof specifier === 'string') dependencySpecs.set(packageName, specifier);
    }
  }

  const packages: DeclaredPackage[] = [];
  for (const [packageName, specifier] of dependencySpecs) {
    try {
      if (specifier.startsWith('file:')) {
        const packageDir = realpathSync(join(rootDir, specifier.slice('file:'.length)));
        packages.push({
          packageName,
          packageDir,
          importBase: toViteRootPath(rootDir, packageDir),
        });
        continue;
      }

      const packageDir = realpathSync(join(rootDir, 'node_modules', packageName));
      packages.push({ packageName, packageDir });
    } catch {
      // An optional or not-yet-installed dependency is not part of this build.
    }
  }

  return packages;
}
