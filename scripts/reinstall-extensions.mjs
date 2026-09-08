import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function readJson(filePath) {
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isTypechoExtensionManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.keywords)) return false;

  const keywords = new Set(
    manifest.keywords
      .filter((keyword) => typeof keyword === 'string')
      .map((keyword) => keyword.toLowerCase()),
  );
  return keywords.has('typecho') && (keywords.has('plugin') || keywords.has('theme'));
}

function isTypechoSourcePath(specifier) {
  if (!specifier.startsWith('file:')) return false;

  const sourcePath = specifier.slice('file:'.length).replace(/\\/g, '/');
  return /(^|\/)src\/(plugins|themes)(\/|$)/i.test(sourcePath);
}

function readDependencyManifest(rootDir, packageName, specifier) {
  if (specifier.startsWith('file:')) {
    const sourceDir = resolve(rootDir, specifier.slice('file:'.length));
    const sourceManifest = readJson(join(sourceDir, 'package.json'));
    if (sourceManifest) return sourceManifest;
  }

  return readJson(join(rootDir, 'node_modules', packageName, 'package.json'));
}

/**
 * Find all declared Typecho plugin/theme packages without relying on the
 * installed virtual-store snapshot to enumerate the dependency graph.
 */
export function collectTypechoPackageNames(rootDir = ROOT_DIR) {
  const rootManifest = readJson(join(rootDir, 'package.json'));
  if (!rootManifest) return [];

  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = rootManifest[field];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;

    for (const [packageName, specifier] of Object.entries(dependencies)) {
      if (typeof specifier !== 'string') continue;

      const manifest = readDependencyManifest(rootDir, packageName, specifier);
      if (isTypechoExtensionManifest(manifest) || isTypechoSourcePath(specifier)) {
        names.add(packageName);
      }
    }
  }

  return [...names];
}

export function buildInstallArgs() {
  return ['install', '--force', '--frozen-lockfile'];
}

export function run(rootDir = ROOT_DIR) {
  const packageNames = collectTypechoPackageNames(rootDir);
  if (packageNames.length === 0) {
    console.log('[reinstall:extensions] No declared Typecho plugin/theme dependencies found.');
    return 0;
  }

  console.log(`[reinstall:extensions] Found ${packageNames.length} declared plugin/theme package(s):`);
  for (const packageName of packageNames) console.log(`  - ${packageName}`);

  const modulesDir = join(rootDir, 'node_modules');
  try {
    // pnpm 11 can reuse a stale file: directory snapshot even with --force.
    // Removing only the generated modules directory makes the next install
    // import the current local plugin/theme directories without touching the
    // source tree or changing unrelated locked versions.
    rmSync(modulesDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch (error) {
    console.error(`[reinstall:extensions] Failed to remove ${modulesDir}:`, error.message);
    return 1;
  }

  console.log(`[reinstall:extensions] Rebuilding all dependencies from ${modulesDir}`);
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(pnpmCommand, buildInstallArgs(), {
    cwd: rootDir,
    stdio: 'inherit',
    // Node refuses to spawn .cmd files directly on Windows (EINVAL).
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`[reinstall:extensions] Failed to run ${pnpmCommand}:`, result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedScript === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
