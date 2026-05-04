#!/usr/bin/env tsx
/**
 * Typecho Data Migration Tool
 *
 * Migrate data from a legacy Typecho (PHP) SQLite database to:
 *   1. Cloudflare D1 + R2 (production)
 *   2. Local SQLite + local directory (development / wrangler dev)
 *
 * Usage:
 *   # Migrate to Cloudflare (remote)
 *   npx tsx scripts/migrate.ts --source /path/to/typecho.db --uploads /path/to/usr/uploads --target cloudflare
 *
 *   # Migrate to local (wrangler dev uses .wrangler/)
 *   npx tsx scripts/migrate.ts --source /path/to/typecho.db --uploads /path/to/usr/uploads --target local
 *
 *   # Dry run (preview only, no writes)
 *   npx tsx scripts/migrate.ts --source /path/to/typecho.db --uploads /path/to/usr/uploads --target local --dry-run
 *
 *   # Specify table prefix (default: typecho_)
 *   npx tsx scripts/migrate.ts --source /path/to/typecho.db --uploads /path/to/usr/uploads --target local --prefix typecho_
 *
 *   # Specify site URL for attachment URL rewriting
 *   npx tsx scripts/migrate.ts --source /path/to/typecho.db --uploads /path/to/usr/uploads --target cloudflare --site-url https://example.com
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI Arguments ───────────────────────────────────────────────────────────

interface MigrateOptions {
  source: string;        // Path to source Typecho SQLite DB
  uploads: string;       // Path to source usr/uploads/ directory
  target: 'cloudflare' | 'local';
  prefix: string;        // Source table prefix (default: typecho_)
  dryRun: boolean;
  siteUrl: string;       // New site URL for attachment rewriting
  d1Name: string;        // D1 database name
  r2Bucket: string;      // R2 bucket name
}

function parseArgs(): MigrateOptions {
  const args = process.argv.slice(2);
  const opts: MigrateOptions = {
    source: '',
    uploads: '',
    target: 'local',
    prefix: 'typecho_',
    dryRun: false,
    siteUrl: '',
    d1Name: 'typecho-cf-db',
    r2Bucket: 'typecho-cf-uploads',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--source': case '-s':
        opts.source = args[++i]; break;
      case '--uploads': case '-u':
        opts.uploads = args[++i]; break;
      case '--target': case '-t':
        opts.target = args[++i] as 'cloudflare' | 'local'; break;
      case '--prefix':
        opts.prefix = args[++i]; break;
      case '--dry-run': case '-n':
        opts.dryRun = true; break;
      case '--site-url':
        opts.siteUrl = args[++i]; break;
      case '--d1-name':
        opts.d1Name = args[++i]; break;
      case '--r2-bucket':
        opts.r2Bucket = args[++i]; break;
      case '--help': case '-h':
        printHelp(); process.exit(0);
    }
  }

  if (!opts.source) {
    console.error('❌ --source is required (path to Typecho SQLite database)');
    printHelp();
    process.exit(1);
  }

  if (!fs.existsSync(opts.source)) {
    console.error(`❌ Source database not found: ${opts.source}`);
    process.exit(1);
  }

  return opts;
}

function printHelp() {
  console.log(`
Typecho Migration Tool
======================

Usage:
  npx tsx scripts/migrate.ts [options]

Options:
  --source, -s <path>     Source Typecho SQLite database path (required)
  --uploads, -u <path>    Source usr/uploads/ directory path (optional)
  --target, -t <type>     Target: "cloudflare" or "local" (default: local)
  --prefix <prefix>       Source table prefix (default: typecho_)
  --site-url <url>        New site URL for rewriting attachment URLs
  --d1-name <name>        D1 database name (default: typecho-cf-db)
  --r2-bucket <name>      R2 bucket name (default: typecho-cf-uploads)
  --dry-run, -n           Preview migration without making changes
  --help, -h              Show this help

Examples:
  # Local migration (for wrangler dev)
  npx tsx scripts/migrate.ts -s ./old-typecho.db -u ./old-uploads -t local

  # Cloudflare migration (production)
  npx tsx scripts/migrate.ts -s ./old-typecho.db -u ./old-uploads -t cloudflare --site-url https://blog.example.com

  # Dry run
  npx tsx scripts/migrate.ts -s ./old-typecho.db -u ./old-uploads -t local -n
`);
}

// ─── Source Database Reader ──────────────────────────────────────────────────

interface SourceRow {
  [key: string]: any;
}

class SourceReader {
  private db: ReturnType<typeof Database>;
  private prefix: string;

  constructor(dbPath: string, prefix: string) {
    this.db = new Database(dbPath, { readonly: true });
    this.prefix = prefix;
  }

  private table(name: string): string {
    return `${this.prefix}${name}`;
  }

  /** Check if a table exists in the source database */
  private tableExists(name: string): boolean {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name=?`
    ).get(this.table(name)) as { count: number };
    return row.count > 0;
  }

  getUsers(): SourceRow[] {
    if (!this.tableExists('users')) return [];
    return this.db.prepare(`SELECT * FROM ${this.table('users')}`).all() as SourceRow[];
  }

  getContents(): SourceRow[] {
    if (!this.tableExists('contents')) return [];
    return this.db.prepare(`SELECT * FROM ${this.table('contents')}`).all() as SourceRow[];
  }

  getComments(): SourceRow[] {
    if (!this.tableExists('comments')) return [];
    return this.db.prepare(`SELECT * FROM ${this.table('comments')}`).all() as SourceRow[];
  }

  getMetas(): SourceRow[] {
    if (!this.tableExists('metas')) return [];
    return this.db.prepare(`SELECT * FROM ${this.table('metas')}`).all() as SourceRow[];
  }

  getRelationships(): SourceRow[] {
    if (!this.tableExists('relationships')) return [];
    return this.db.prepare(`SELECT * FROM ${this.table('relationships')}`).all() as SourceRow[];
  }

  getOptions(): SourceRow[] {
    if (!this.tableExists('options')) return [];
    return this.db.prepare(`SELECT * FROM ${this.table('options')}`).all() as SourceRow[];
  }

  getFields(): SourceRow[] {
    if (!this.tableExists('fields')) return [];
    return this.db.prepare(`SELECT * FROM ${this.table('fields')}`).all() as SourceRow[];
  }

  close() {
    this.db.close();
  }
}

// ─── Password Conversion ────────────────────────────────────────────────────

/**
 * Detect password hash format from old Typecho.
 * Original Typecho PHP uses portable phpass ($P$ prefix).
 * We keep old hashes as-is with a $PHPASS$ prefix marker,
 * so the app can recognize them and prompt for password reset.
 *
 * If already in our $SHA256$ format, keep as-is.
 */
function convertPasswordHash(hash: string | null): string {
  if (!hash) return '';
  // Already our format
  if (hash.startsWith('$SHA256$')) return hash;
  // PHP phpass format: $P$B... or $H$...
  if (hash.startsWith('$P$') || hash.startsWith('$H$')) {
    return `$PHPASS$${hash}`;
  }
  // MD5 (very old Typecho)
  if (/^[a-f0-9]{32}$/.test(hash)) {
    return `$MD5$${hash}`;
  }
  // Unknown format, keep with marker
  return `$LEGACY$${hash}`;
}

// ─── Option Filtering ───────────────────────────────────────────────────────

/**
 * Options to skip during migration (will be re-initialized by the new system)
 */
const SKIP_OPTIONS = new Set([
  'installed',    // Will be set by migration
  'secret',       // Will be regenerated
  'rewrite',      // Removed in new version
  'actionTable',  // PHP-specific
  'panelTable',   // PHP-specific
  'routingTable', // Handled specially — permalink pattern extracted below
]);

/**
 * Extract permalink pattern from Typecho's routingTable option.
 *
 * The routingTable is a PHP-serialized associative array. The `post` entry
 * contains a `url` key whose value is the permalink pattern, e.g.:
 *   /archives/[cid:digital]/
 *   /archives/[slug].html
 *   /[year:digital:4]/[month:digital:2]/[day:digital:2]/[slug].html
 *   /[category]/[slug].html
 *
 * We convert Typecho's placeholder syntax to our {var} syntax:
 *   [cid:digital]   → {cid}
 *   [slug]           → {slug}
 *   [year:digital:4] → {year}
 *   [month:digital:2]→ {month}
 *   [day:digital:2]  → {day}
 *   [category]       → {category}
 */
function extractPermalinkFromRoutingTable(routingTableValue: string | null): string | null {
  if (!routingTableValue) return null;

  // Try to find the post URL pattern from the PHP-serialized string.
  // Pattern: s:LEN:"post";a:NUM:{...s:LEN:"url";s:LEN:"VALUE";...}
  // We use a simpler approach: find "url" value right after "post" section.

  // First, extract all url values — the one associated with 'post' route
  // In Typecho's routingTable, the structure is:
  //   "post" => array("url" => "/archives/[cid:digital]/", ...)
  //   "page" => array("url" => "/[slug].html", ...)

  // Simple regex approach for PHP serialized data:
  // Find: s:4:"post";a:... then the next s:3:"url";s:N:"VALUE"
  const postMatch = routingTableValue.match(
    /s:\d+:"post";a:\d+:\{[^}]*?s:\d+:"url";s:\d+:"([^"]+)"/
  );

  if (!postMatch) {
    // Fallback: try to find any url pattern that looks like an archive route
    const urlMatch = routingTableValue.match(
      /s:\d+:"url";s:\d+:"(\/(?:archives\/)?[^"]*\[(?:cid|slug)[^"]*)"/ 
    );
    if (!urlMatch) return null;
    return convertTypechoPattern(urlMatch[1]);
  }

  return convertTypechoPattern(postMatch[1]);
}

/**
 * Extract page permalink pattern from Typecho's routingTable option.
 *
 * In Typecho's routingTable, the `page` entry contains:
 *   "page" => array("url" => "/[slug].html", ...)
 *
 * Default Typecho page pattern is /[slug].html
 */
function extractPagePatternFromRoutingTable(routingTableValue: string | null): string | null {
  if (!routingTableValue) return null;

  const pageMatch = routingTableValue.match(
    /s:\d+:"page";a:\d+:\{[^}]*?s:\d+:"url";s:\d+:"([^"]+)"/
  );

  if (!pageMatch) return null;
  return convertTypechoPattern(pageMatch[1]);
}

/**
 * Extract category permalink pattern from Typecho's routingTable option.
 *
 * In Typecho's routingTable, the `category` entry contains:
 *   "category" => array("url" => "/category/[slug]/", ...)
 *   or "category_page" => array("url" => "/category/[slug]/[page:digital]/", ...)
 *
 * We only extract the base category pattern (without pagination).
 * Default Typecho category pattern is /category/[slug]/
 */
function extractCategoryPatternFromRoutingTable(routingTableValue: string | null): string | null {
  if (!routingTableValue) return null;

  // Match "category" entry (NOT "category_page")
  // The key "category" is exactly 8 chars: s:8:"category";
  const categoryMatch = routingTableValue.match(
    /s:8:"category";a:\d+:\{[^}]*?s:\d+:"url";s:\d+:"([^"]+)"/
  );

  if (!categoryMatch) return null;
  return convertTypechoPattern(categoryMatch[1]);
}

/**
 * Convert Typecho's URL pattern syntax to our {var} syntax.
 * Examples:
 *   /archives/[cid:digital]/    → /archives/{cid}/
 *   /[year:digital:4]/[month:digital:2]/[day:digital:2]/[slug].html → /{year}/{month}/{day}/{slug}.html
 */
function convertTypechoPattern(pattern: string): string {
  return pattern
    .replace(/\[cid(?::digital)?\]/g, '{cid}')
    .replace(/\[slug\]/g, '{slug}')
    .replace(/\[mid(?::digital)?\]/g, '{mid}')
    .replace(/\[year(?::digital(?::\d+)?)?\]/g, '{year}')
    .replace(/\[month(?::digital(?::\d+)?)?\]/g, '{month}')
    .replace(/\[day(?::digital(?::\d+)?)?\]/g, '{day}')
    .replace(/\[category\]/g, '{category}')
    .replace(/\[(\w+)(?::[^\]]+)?\]/g, '{$1}'); // catch-all for any remaining
}

/** Options that need value transformation */
function transformOptionValue(name: string, value: string | null, siteUrl: string): string | null {
  if (value === null) return null;

  // Rewrite siteUrl if new one provided
  if (name === 'siteUrl' && siteUrl) {
    return siteUrl.replace(/\/$/, '');
  }

  return value;
}

// ─── Attachment URL Rewriting ───────────────────────────────────────────────

/**
 * Rewrite attachment text (JSON) to update file paths/URLs for the new system.
 * Also handles legacy Typecho attachment text format:
 *   a:5:{s:4:"name";s:10:"image.jpg";s:4:"path";s:28:"/usr/uploads/2024/03/image.jpg";...}
 *
 * In the new system, attachment text is JSON:
 *   {"name":"image.jpg","path":"usr/uploads/2024/03/image.jpg","size":12345,"type":"image/jpeg","url":"https://..."}
 */
function rewriteAttachmentText(text: string | null, siteUrl: string): string | null {
  if (!text) return text;

  // Try JSON parse first (already new format)
  try {
    const obj = JSON.parse(text);
    if (obj.path && siteUrl) {
      obj.url = `${siteUrl.replace(/\/$/, '')}/${obj.path.replace(/^\//, '')}`;
    }
    return JSON.stringify(obj);
  } catch {
    // Not JSON — try PHP serialized format
  }

  // Parse PHP serialized attachment data
  const phpMeta = parsePhpSerializedAttachment(text);
  if (phpMeta) {
    const newMeta: Record<string, any> = {
      name: phpMeta.name || '',
      path: phpMeta.path ? phpMeta.path.replace(/^\//, '') : '',
      size: phpMeta.size || 0,
      type: phpMeta.type || guessMimeType(phpMeta.name || ''),
    };
    if (siteUrl && newMeta.path) {
      newMeta.url = `${siteUrl.replace(/\/$/, '')}/${newMeta.path}`;
    }
    return JSON.stringify(newMeta);
  }

  // Unknown format, keep as-is
  return text;
}

/**
 * Minimal PHP serialized attachment parser.
 * Handles: a:N:{s:LEN:"key";s:LEN:"value";...}
 */
function parsePhpSerializedAttachment(text: string): Record<string, string> | null {
  if (!text.startsWith('a:')) return null;

  const result: Record<string, string> = {};
  // Extract key-value pairs with regex
  const pattern = /s:\d+:"([^"]+)";(?:s:\d+:"([^"]*?)";|i:(\d+);)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    result[match[1]] = match[2] ?? match[3] ?? '';
  }

  return Object.keys(result).length > 0 ? result : null;
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', avif: 'image/avif',
    pdf: 'application/pdf', zip: 'application/zip',
    txt: 'text/plain', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mimeMap[ext || ''] || 'application/octet-stream';
}

// ─── Target Writers ─────────────────────────────────────────────────────────

interface MigrationStats {
  users: number;
  contents: number;
  comments: number;
  metas: number;
  relationships: number;
  options: number;
  fields: number;
  files: number;
  errors: string[];
}

abstract class TargetWriter {
  abstract init(): void;
  abstract writeUsers(rows: SourceRow[]): number;
  abstract writeContents(rows: SourceRow[], siteUrl: string): number;
  abstract writeComments(rows: SourceRow[]): number;
  abstract writeMetas(rows: SourceRow[]): number;
  abstract writeRelationships(rows: SourceRow[]): number;
  abstract writeOptions(rows: SourceRow[], siteUrl: string): number;
  abstract writeFields(rows: SourceRow[]): number;
  abstract uploadFile(relativePath: string, absolutePath: string): boolean;
  abstract finalize(): void;
}

// ─── Wrangler Writer (unified for both local and remote) ─────────────────────

class WranglerWriter extends TargetWriter {
  private d1Name: string;
  private r2Bucket: string;
  private tempDir: string;
  private isLocal: boolean;

  constructor(d1Name: string, r2Bucket: string, isLocal: boolean) {
    super();
    this.d1Name = d1Name;
    this.r2Bucket = r2Bucket;
    this.isLocal = isLocal;
    this.tempDir = path.join(path.resolve(__dirname, '..'), '.migrate-temp');
  }

  private get locationFlag(): string {
    return this.isLocal ? '--local' : '--remote';
  }

  private exec(cmd: string): string {
    try {
      return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      throw new Error(`Command failed: ${cmd}\n${e.stderr || e.message}`);
    }
  }

  private execD1SQL(sql: string): void {
    // Write SQL to temp file then execute via wrangler
    const tmpFile = path.join(this.tempDir, `migrate_${Date.now()}.sql`);
    fs.writeFileSync(tmpFile, sql, 'utf-8');
    try {
      this.exec(`wrangler d1 execute ${this.d1Name} ${this.locationFlag} --file="${tmpFile}"`);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  }

  init() {
    fs.mkdirSync(this.tempDir, { recursive: true });

    const target = this.isLocal ? 'local' : 'remote';
    console.log(`  🔄 Applying D1 migrations (${target})...`);
    try {
      this.exec(`wrangler d1 migrations apply ${this.d1Name} ${this.locationFlag}`);
      console.log('  ✅ D1 migrations applied');
    } catch (e: any) {
      console.log('  ⚠️  D1 migrations may already be applied:', e.message?.substring(0, 100));
    }
  }

  private buildInsertSQL(table: string, columns: string[], rows: Record<string, any>[]): string {
    if (rows.length === 0) return '';

    const stmts: string[] = [];
    for (const row of rows) {
      const values = columns.map(col => {
        const v = row[col];
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') return String(v);
        // Escape single quotes
        return `'${String(v).replace(/'/g, "''")}'`;
      });
      stmts.push(`INSERT OR REPLACE INTO ${table} (${columns.map(c => `"${c}"`).join(',')}) VALUES (${values.join(',')});`);
    }

    return stmts.join('\n');
  }

  writeUsers(rows: SourceRow[]): number {
    if (rows.length === 0) return 0;
    const mapped = rows.map(u => ({
      uid: u.uid,
      name: u.name || null,
      password: convertPasswordHash(u.password),
      mail: u.mail || null,
      url: u.url || null,
      screenName: u.screenName || u.name || null,
      created: u.created || 0,
      activated: u.activated || 0,
      logged: u.logged || 0,
      group: u.group || 'visitor',
      authCode: u.authCode || null,
    }));
    const cols = ['uid', 'name', 'password', 'mail', 'url', 'screenName', 'created', 'activated', 'logged', 'group', 'authCode'];
    for (let i = 0; i < mapped.length; i += 50) {
      const batch = mapped.slice(i, i + 50);
      const sql = this.buildInsertSQL('typecho_users', cols, batch);
      this.execD1SQL(sql);
    }
    return mapped.length;
  }

  writeContents(rows: SourceRow[], siteUrl: string): number {
    if (rows.length === 0) return 0;
    const mapped = rows.map(c => {
      let text = c.text || '';
      if (c.type === 'attachment') {
        text = rewriteAttachmentText(text, siteUrl) || text;
      }
      return {
        cid: c.cid,
        title: c.title || null,
        slug: c.slug || null,
        created: c.created || 0,
        modified: c.modified || 0,
        text,
        order: c.order || 0,
        authorId: c.authorId || 0,
        template: c.template || null,
        type: c.type || 'post',
        status: c.status || 'publish',
        password: c.password || null,
        commentsNum: c.commentsNum || 0,
        allowComment: c.allowComment || '0',
        allowPing: c.allowPing || '0',
        allowFeed: c.allowFeed || '0',
        parent: c.parent || 0,
      };
    });
    const cols = ['cid', 'title', 'slug', 'created', 'modified', 'text', 'order', 'authorId', 'template', 'type', 'status', 'password', 'commentsNum', 'allowComment', 'allowPing', 'allowFeed', 'parent'];
    for (let i = 0; i < mapped.length; i += 50) {
      const batch = mapped.slice(i, i + 50);
      const sql = this.buildInsertSQL('typecho_contents', cols, batch);
      this.execD1SQL(sql);
    }
    return mapped.length;
  }

  writeComments(rows: SourceRow[]): number {
    if (rows.length === 0) return 0;
    const mapped = rows.map(c => ({
      coid: c.coid,
      cid: c.cid || 0,
      created: c.created || 0,
      author: c.author || null,
      authorId: c.authorId || 0,
      ownerId: c.ownerId || 0,
      mail: c.mail || null,
      url: c.url || null,
      ip: c.ip || null,
      agent: c.agent || null,
      text: c.text || null,
      type: c.type || 'comment',
      status: c.status || 'approved',
      parent: c.parent || 0,
    }));
    const cols = ['coid', 'cid', 'created', 'author', 'authorId', 'ownerId', 'mail', 'url', 'ip', 'agent', 'text', 'type', 'status', 'parent'];
    for (let i = 0; i < mapped.length; i += 50) {
      const batch = mapped.slice(i, i + 50);
      const sql = this.buildInsertSQL('typecho_comments', cols, batch);
      this.execD1SQL(sql);
    }
    return mapped.length;
  }

  writeMetas(rows: SourceRow[]): number {
    if (rows.length === 0) return 0;
    const mapped = rows.map(m => ({
      mid: m.mid,
      name: m.name || null,
      slug: m.slug || null,
      type: m.type || 'category',
      description: m.description || null,
      count: m.count || 0,
      order: m.order || 0,
      parent: m.parent || 0,
    }));
    const cols = ['mid', 'name', 'slug', 'type', 'description', 'count', 'order', 'parent'];
    for (let i = 0; i < mapped.length; i += 50) {
      const batch = mapped.slice(i, i + 50);
      const sql = this.buildInsertSQL('typecho_metas', cols, batch);
      this.execD1SQL(sql);
    }
    return mapped.length;
  }

  writeRelationships(rows: SourceRow[]): number {
    if (rows.length === 0) return 0;
    const mapped = rows.map(r => ({ cid: r.cid, mid: r.mid }));
    const cols = ['cid', 'mid'];
    for (let i = 0; i < mapped.length; i += 50) {
      const batch = mapped.slice(i, i + 50);
      const sql = this.buildInsertSQL('typecho_relationships', cols, batch);
      this.execD1SQL(sql);
    }
    return mapped.length;
  }

  writeOptions(rows: SourceRow[], siteUrl: string): number {
    if (rows.length === 0) return 0;
    const mapped: Record<string, any>[] = [];
    let routingTableValue: string | null = null;

    for (const o of rows) {
      // Capture routingTable value before skipping
      if (o.name === 'routingTable') {
        routingTableValue = o.value;
      }
      if (SKIP_OPTIONS.has(o.name)) continue;
      mapped.push({
        name: o.name,
        user: o.user || 0,
        value: transformOptionValue(o.name, o.value, siteUrl),
      });
    }

    // Extract permalink pattern from routingTable
    if (routingTableValue) {
      const pattern = extractPermalinkFromRoutingTable(routingTableValue);
      if (pattern && pattern !== '/archives/{cid}/') {
        console.log(`    📎 Extracted post permalink pattern: ${pattern}`);
        mapped.push({ name: 'permalinkPattern', user: 0, value: pattern });
      }

      const pagePattern = extractPagePatternFromRoutingTable(routingTableValue);
      if (pagePattern && pagePattern !== '/{slug}.html') {
        console.log(`    📎 Extracted page permalink pattern: ${pagePattern}`);
        mapped.push({ name: 'pagePattern', user: 0, value: pagePattern });
      }

      const categoryPattern = extractCategoryPatternFromRoutingTable(routingTableValue);
      if (categoryPattern && categoryPattern !== '/category/{slug}/') {
        console.log(`    📎 Extracted category permalink pattern: ${categoryPattern}`);
        mapped.push({ name: 'categoryPattern', user: 0, value: categoryPattern });
      }
    }

    // Set installed flag
    mapped.push({ name: 'installed', user: 0, value: '1' });

    const cols = ['name', 'user', 'value'];
    for (let i = 0; i < mapped.length; i += 50) {
      const batch = mapped.slice(i, i + 50);
      const sql = this.buildInsertSQL('typecho_options', cols, batch);
      this.execD1SQL(sql);
    }
    return mapped.length;
  }

  writeFields(rows: SourceRow[]): number {
    if (rows.length === 0) return 0;
    const mapped = rows.map(f => ({
      cid: f.cid,
      name: f.name,
      type: f.type || 'str',
      str_value: f.str_value || null,
      int_value: f.int_value || 0,
      float_value: f.float_value || 0,
    }));
    const cols = ['cid', 'name', 'type', 'str_value', 'int_value', 'float_value'];
    for (let i = 0; i < mapped.length; i += 50) {
      const batch = mapped.slice(i, i + 50);
      const sql = this.buildInsertSQL('typecho_fields', cols, batch);
      this.execD1SQL(sql);
    }
    return mapped.length;
  }

  uploadFile(relativePath: string, absolutePath: string): boolean {
    const r2Key = `usr/uploads/${relativePath}`;
    this.exec(`wrangler r2 object put "${this.r2Bucket}/${r2Key}" --file="${absolutePath}" ${this.locationFlag}`);
    return true;
  }

  finalize() {
    // Clean up temp directory
    if (fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }
}

// ─── Dry Run Writer ──────────────────────────────────────────────────────────

class DryRunWriter extends TargetWriter {
  init() { console.log('  🔍 Dry run mode — no changes will be made'); }
  writeUsers(rows: SourceRow[]) { return rows.length; }
  writeContents(rows: SourceRow[]) { return rows.length; }
  writeComments(rows: SourceRow[]) { return rows.length; }
  writeMetas(rows: SourceRow[]) { return rows.length; }
  writeRelationships(rows: SourceRow[]) { return rows.length; }
  writeOptions(rows: SourceRow[]) { return rows.length; }
  writeFields(rows: SourceRow[]) { return rows.length; }
  uploadFile() { return true; }
  finalize() {}
}

// ─── File Scanner ───────────────────────────────────────────────────────────

function scanUploadFiles(uploadsDir: string): { relativePath: string; absolutePath: string }[] {
  if (!uploadsDir || !fs.existsSync(uploadsDir)) return [];

  const files: { relativePath: string; absolutePath: string }[] = [];

  function walk(dir: string, base: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(base, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        files.push({ relativePath: relPath.replace(/\\/g, '/'), absolutePath: fullPath });
      }
    }
  }

  walk(uploadsDir, '');
  return files;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log(`
╔══════════════════════════════════════════════╗
║       Typecho Data Migration Tool            ║
╚══════════════════════════════════════════════╝
`);

  console.log(`📋 Configuration:`);
  console.log(`  Source DB:    ${opts.source}`);
  console.log(`  Uploads Dir:  ${opts.uploads || '(none)'}`);
  console.log(`  Target:       ${opts.target}`);
  console.log(`  Table Prefix: ${opts.prefix}`);
  console.log(`  Site URL:     ${opts.siteUrl || '(keep original)'}`);
  console.log(`  Dry Run:      ${opts.dryRun}`);
  console.log();

  // Open source DB
  console.log('📖 Reading source database...');
  const reader = new SourceReader(opts.source, opts.prefix);

  const users = reader.getUsers();
  const contents = reader.getContents();
  const comments = reader.getComments();
  const metas = reader.getMetas();
  const relationships = reader.getRelationships();
  const options = reader.getOptions();
  const fields = reader.getFields();
  reader.close();

  console.log(`  Users:         ${users.length}`);
  console.log(`  Contents:      ${contents.length} (${contents.filter(c => c.type === 'post').length} posts, ${contents.filter(c => c.type === 'page').length} pages, ${contents.filter(c => c.type === 'attachment').length} attachments)`);
  console.log(`  Comments:      ${comments.length}`);
  console.log(`  Metas:         ${metas.length} (${metas.filter(m => m.type === 'category').length} categories, ${metas.filter(m => m.type === 'tag').length} tags)`);
  console.log(`  Relationships: ${relationships.length}`);
  console.log(`  Options:       ${options.length}`);
  console.log(`  Fields:        ${fields.length}`);

  // Scan upload files
  const uploadFiles = scanUploadFiles(opts.uploads);
  console.log(`  Upload Files:  ${uploadFiles.length}`);
  console.log();

  // Create writer
  let writer: TargetWriter;
  if (opts.dryRun) {
    writer = new DryRunWriter();
  } else if (opts.target === 'cloudflare') {
    writer = new WranglerWriter(opts.d1Name, opts.r2Bucket, false);
  } else {
    writer = new WranglerWriter(opts.d1Name, opts.r2Bucket, true);
  }

  // Initialize target
  console.log(`🔧 Initializing target (${opts.target})...`);
  writer.init();
  console.log();

  const stats: MigrationStats = {
    users: 0, contents: 0, comments: 0, metas: 0,
    relationships: 0, options: 0, fields: 0, files: 0,
    errors: [],
  };

  // Migrate data
  console.log('📝 Migrating data...');

  process.stdout.write('  Users...          ');
  stats.users = writer.writeUsers(users);
  console.log(`✅ ${stats.users}`);

  process.stdout.write('  Contents...       ');
  stats.contents = writer.writeContents(contents, opts.siteUrl);
  console.log(`✅ ${stats.contents}`);

  process.stdout.write('  Comments...       ');
  stats.comments = writer.writeComments(comments);
  console.log(`✅ ${stats.comments}`);

  process.stdout.write('  Metas...          ');
  stats.metas = writer.writeMetas(metas);
  console.log(`✅ ${stats.metas}`);

  process.stdout.write('  Relationships...  ');
  stats.relationships = writer.writeRelationships(relationships);
  console.log(`✅ ${stats.relationships}`);

  process.stdout.write('  Options...        ');
  stats.options = writer.writeOptions(options, opts.siteUrl);
  console.log(`✅ ${stats.options}`);

  process.stdout.write('  Fields...         ');
  stats.fields = writer.writeFields(fields);
  console.log(`✅ ${stats.fields}`);

  // Migrate files
  if (uploadFiles.length > 0) {
    console.log();
    console.log('📁 Migrating upload files...');
    let fileCount = 0;
    for (const file of uploadFiles) {
      try {
        writer.uploadFile(file.relativePath, file.absolutePath);
        fileCount++;
        if (fileCount % 10 === 0 || fileCount === uploadFiles.length) {
          process.stdout.write(`\r  Files: ${fileCount}/${uploadFiles.length}`);
        }
      } catch (e: any) {
        stats.errors.push(`File ${file.relativePath}: ${e.message}`);
      }
    }
    stats.files = fileCount;
    console.log(` ✅`);
  }

  // Finalize
  writer.finalize();

  // Summary
  console.log();
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║              Migration Summary               ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Users:         ${String(stats.users).padStart(6)}                     ║`);
  console.log(`║  Contents:      ${String(stats.contents).padStart(6)}                     ║`);
  console.log(`║  Comments:      ${String(stats.comments).padStart(6)}                     ║`);
  console.log(`║  Metas:         ${String(stats.metas).padStart(6)}                     ║`);
  console.log(`║  Relationships: ${String(stats.relationships).padStart(6)}                     ║`);
  console.log(`║  Options:       ${String(stats.options).padStart(6)}                     ║`);
  console.log(`║  Fields:        ${String(stats.fields).padStart(6)}                     ║`);
  console.log(`║  Files:         ${String(stats.files).padStart(6)}                     ║`);
  console.log('╚══════════════════════════════════════════════╝');

  if (stats.errors.length > 0) {
    console.log();
    console.log(`⚠️  ${stats.errors.length} error(s) during migration:`);
    for (const err of stats.errors.slice(0, 20)) {
      console.log(`  - ${err}`);
    }
    if (stats.errors.length > 20) {
      console.log(`  ... and ${stats.errors.length - 20} more`);
    }
  }

  console.log();
  if (opts.dryRun) {
    console.log('🔍 This was a dry run. No changes were made.');
    console.log('   Remove --dry-run to perform the actual migration.');
  } else {
    console.log('✅ Migration complete!');
    if (opts.target === 'local') {
      console.log();
      console.log('📌 Next steps:');
      console.log('   1. Copy data/typecho.db to .wrangler/state/v3/d1/ (or use wrangler d1 execute --local)');
      console.log('   2. Run: npx wrangler dev');
      console.log();
      console.log('   ⚠️  User passwords from old Typecho use PHP phpass format.');
      console.log('   They are marked with $PHPASS$ prefix and will need to be reset');
      console.log('   via the admin panel (or use the forgot password flow).');
    } else {
      console.log();
      console.log('📌 Next steps:');
      console.log('   1. Verify data at: https://dash.cloudflare.com/ → D1 → typecho-cf-db');
      console.log('   2. Deploy: npx wrangler deploy');
      console.log();
      console.log('   ⚠️  User passwords from old Typecho use PHP phpass format.');
      console.log('   They are marked with $PHPASS$ prefix and will need to be reset.');
    }
  }
}

main().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
