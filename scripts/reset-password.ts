#!/usr/bin/env tsx
/**
 * Typecho Password Reset Tool
 *
 * Reset a user's password in the D1 database (local or remote).
 *
 * Usage:
 *   # Reset password for local D1 (wrangler dev)
 *   pnpm reset-password --user admin --password newpass123
 *
 *   # Reset password for remote D1 (Cloudflare)
 *   pnpm reset-password:remote --user admin --password newpass123
 *
 *   # Using npx directly
 *   npx tsx scripts/reset-password.ts --user admin --password newpass123 --target local
 *   npx tsx scripts/reset-password.ts --user admin --password newpass123 --target cloudflare
 *
 *   # List all users
 *   npx tsx scripts/reset-password.ts --list --target local
 *
 *   # Auto-generate a random password
 *   npx tsx scripts/reset-password.ts --user admin --target local
 */

import { execSync } from 'node:child_process';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ─── CLI Arguments ───────────────────────────────────────────────────────────

interface ResetOptions {
  user: string;
  password: string;
  target: 'local' | 'cloudflare';
  d1Name: string;
  list: boolean;
}

function parseArgs(): ResetOptions {
  const args = process.argv.slice(2);
  const opts: ResetOptions = {
    user: '',
    password: '',
    target: 'local',
    d1Name: 'typecho-cf-db',
    list: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--user':
      case '-u':
        opts.user = args[++i] || '';
        break;
      case '--password':
      case '-p':
        opts.password = args[++i] || '';
        break;
      case '--target':
      case '-t':
        opts.target = (args[++i] || 'local') as 'local' | 'cloudflare';
        break;
      case '--d1-name':
        opts.d1Name = args[++i] || 'typecho-cf-db';
        break;
      case '--list':
      case '-l':
        opts.list = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`
Typecho-CF Password Reset Tool
===============================

Usage:
  npx tsx scripts/reset-password.ts [options]

Options:
  --user, -u <name>       Username to reset password for (required unless --list)
  --password, -p <pass>   New password (auto-generated if omitted)
  --target, -t <target>   Target: "local" (default) or "cloudflare"
  --d1-name <name>        D1 database name (default: typecho-cf-db)
  --list, -l              List all users
  --help, -h              Show this help

Examples:
  # Reset admin password (local)
  pnpm reset-password --user admin --password newpass123

  # Reset admin password (remote/Cloudflare)
  pnpm reset-password:remote --user admin --password newpass123

  # Auto-generate password (local)
  pnpm reset-password --user admin

  # List all users (local)
  pnpm reset-password --list

  # List all users (remote)
  pnpm reset-password:remote --list
`);
}

// ─── Password Hashing (matches src/lib/auth.ts — PBKDF2) ────────────────────

function generateSalt(length: number): string {
  const array = randomBytes(length);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hashPassword(password: string): string {
  const iterations = 100000;
  const salt = generateSalt(16);
  const hash = pbkdf2Hash(password, salt, iterations);
  return `$PBKDF2$${iterations}$${salt}$${hash}`;
}

function pbkdf2Hash(password: string, salt: string, iterations: number): string {
  const derived = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return derived.toString('hex');
}

function generateRandomPassword(length = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

// ─── D1 Execution ────────────────────────────────────────────────────────────

function d1Execute(sql: string, d1Name: string, remote: boolean): string {
  const remoteFlag = remote ? '--remote' : '--local';
  // Escape single quotes in SQL for shell, then wrap in double quotes
  const escapedSql = sql.replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute ${d1Name} ${remoteFlag} --command "${escapedSql}"`;

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectRoot,
    });
    return output;
  } catch (err: any) {
    const stderr = err.stderr || err.message || '';
    const stdout = err.stdout || '';
    if (stderr.includes('no such table') || stdout.includes('no such table')) {
      console.error('❌ 数据库表不存在，请先运行安装向导或数据库迁移');
      process.exit(1);
    }
    console.error('❌ wrangler 执行失败:');
    if (err.stderr) console.error(err.stderr);
    if (err.stdout) console.error(err.stdout);
    process.exit(1);
  }
}

// ─── List Users ──────────────────────────────────────────────────────────────

function listUsers(d1Name: string, remote: boolean): void {
  const targetLabel = remote ? 'Cloudflare (远程)' : '本地';
  console.log(`\n📋 用户列表 [${targetLabel}]\n`);

  const sql = 'SELECT uid, name, mail, screenName, [group], logged FROM typecho_users ORDER BY uid';
  const output = d1Execute(sql, d1Name, remote);

  // Parse wrangler D1 JSON output
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.log(output);
    return;
  }

  try {
    const results = JSON.parse(jsonMatch[0]);
    // wrangler wraps in [{ results: [...] }]
    const rows = Array.isArray(results[0]?.results) ? results[0].results : results;
    if (rows.length === 0) {
      console.log('  (无用户)');
      return;
    }

    console.log('  UID | 用户名          | 昵称            | 邮箱                    | 角色');
    console.log('  ' + '-'.repeat(80));
    for (const row of rows) {
      const uid = String(row.uid).padStart(3);
      const name = (row.name || '').padEnd(15);
      const screen = (row.screenName || '').padEnd(15);
      const mail = (row.mail || '').padEnd(23);
      const group = row.group || 'visitor';
      console.log(`  ${uid} | ${name} | ${screen} | ${mail} | ${group}`);
    }
    console.log(`\n  共 ${rows.length} 个用户\n`);
  } catch {
    console.log(output);
  }
}

// ─── Reset Password ──────────────────────────────────────────────────────────

function resetPassword(user: string, password: string, d1Name: string, remote: boolean): void {
  const targetLabel = remote ? 'Cloudflare (远程)' : '本地';

  // 1. Check user exists
  console.log(`\n🔍 查找用户 "${user}" [${targetLabel}]...`);

  const escapedUser = user.replace(/'/g, "''");
  const checkSql = `SELECT uid, name, screenName, [group] FROM typecho_users WHERE name = '${escapedUser}'`;
  const checkOutput = d1Execute(checkSql, d1Name, remote);

  const jsonMatch = checkOutput.match(/\[[\s\S]*\]/);
  let rows: any[] = [];
  if (jsonMatch) {
    try {
      const results = JSON.parse(jsonMatch[0]);
      rows = Array.isArray(results[0]?.results) ? results[0].results : results;
    } catch { /* ignore */ }
  }

  if (rows.length === 0) {
    console.error(`❌ 用户 "${user}" 不存在`);
    console.log('\n💡 使用 --list 参数查看所有用户');
    process.exit(1);
  }

  const userInfo = rows[0];
  console.log(`  ✅ 找到用户: uid=${userInfo.uid}, 昵称="${userInfo.screenName || userInfo.name}", 角色=${userInfo.group}`);

  // 2. Hash new password
  const hashedPassword = hashPassword(password);

  // 3. Update password
  console.log(`🔐 重置密码...`);
  const updateSql = `UPDATE typecho_users SET password = '${hashedPassword}' WHERE name = '${escapedUser}'`;
  d1Execute(updateSql, d1Name, remote);

  console.log(`\n✅ 密码重置成功！`);
  console.log(`  用户名: ${user}`);
  console.log(`  新密码: ${password}`);
  console.log(`  目标:   ${targetLabel}`);
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const opts = parseArgs();
  const remote = opts.target === 'cloudflare';

  if (opts.list) {
    listUsers(opts.d1Name, remote);
    return;
  }

  if (!opts.user) {
    console.error('❌ 请指定用户名 (--user <name>)');
    console.log('💡 使用 --help 查看帮助，--list 查看所有用户');
    process.exit(1);
  }

  // Auto-generate password if not provided
  if (!opts.password) {
    opts.password = generateRandomPassword();
    console.log(`🎲 自动生成密码: ${opts.password}`);
  }

  resetPassword(opts.user, opts.password, opts.d1Name, remote);
}

main();
