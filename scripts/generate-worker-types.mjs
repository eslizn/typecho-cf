import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wranglerCli = require.resolve('wrangler');
const args = ['types', 'worker-configuration.d.ts'];
const result = spawnSync(process.execPath, [wranglerCli, ...args], {
  cwd: process.cwd(),
  stdio: 'inherit',
  // Invoke the pinned CLI entry directly so Windows does not need a shell
  // trampoline for the generated type file path.
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
