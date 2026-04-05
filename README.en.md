# Typecho-CF

中文 | [English](README.en.md)

A modern rewrite of [Typecho](https://typecho.org) in TypeScript, running on **Astro + Cloudflare Workers + D1**. Preserves Typecho's database schema for seamless data migration from PHP Typecho.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eslizn/typecho-cf)

---

## Features

**Frontend**: Post list / category / tag / author / search archives, nested comments (Gravatar), RSS 2.0 / Atom 1.0 / RSS 1.0, password-protected posts, responsive default theme

**Admin Dashboard**: Post & page editor, comment moderation, media manager (R2 drag-and-drop upload), user management (5 roles), theme switcher, plugin manager (enable/disable/configure), site settings, installation wizard

**System**: Theme system (npm package distribution), plugin system (Hook mechanism, 50+ hook points), PHP Typecho data migration tool, SHA-256 + salt authentication

---

## Installation & Deployment

### Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Cloudflare account

### Local Development

```bash
# Clone and install dependencies
git clone https://github.com/eslizn/typecho-cf.git
cd typecho-cf
pnpm install

# Start dev server (D1 + R2 are automatically simulated by wrangler)
pnpm run dev
```

Visit http://localhost:4321 — first visit auto-redirects to the installation wizard.

### Deploy to Cloudflare

**1. Create Cloudflare resources**

```bash
# Create D1 database
wrangler d1 create typecho-cf-db

# Create R2 bucket
wrangler r2 bucket create typecho-cf-uploads
```

**2. Update `wrangler.toml`**

Replace `database_id` with the actual D1 database ID from the previous step:

```toml
[[d1_databases]]
binding = "DB"
database_name = "typecho-cf-db"
database_id = "your-actual-database-id"
```

**3. Build and deploy**

```bash
pnpm run deploy
```

After deployment, visit your Worker URL — first visit auto-redirects to the installation wizard.

---

## Command Reference

| Command | Description |
|---------|-------------|
| `pnpm run dev` | Start local dev server |
| `pnpm run build` | Production build |
| `pnpm run deploy` | Build + deploy to Cloudflare Workers |
| `pnpm run test` | Run all tests |
| `pnpm run test:watch` | Watch mode |
| `pnpm run test:coverage` | Generate coverage report |
| `pnpm run db:generate` | Generate Drizzle migrations |
| `pnpm run db:studio` | Launch Drizzle Studio |
| `pnpm run db:migrate:local` | Migrate PHP Typecho data to local |
| `pnpm run db:migrate:cloudflare` | Migrate PHP Typecho data to Cloudflare D1 |
| `pnpm run db:migrate:dry-run` | Preview migration (no writes) |
| `pnpm run reset-password` | Reset user password (local) |
| `pnpm run reset-password:cloudflare` | Reset user password (Cloudflare) |

---

## Migrating from PHP Typecho

### Migration Steps

```bash
# Migrate to Cloudflare (production)
pnpm run db:migrate:cloudflare \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# Migrate to local (development)
pnpm run db:migrate:local \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# Preview mode (no data written)
pnpm run db:migrate:dry-run \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads
```

### Migration Options

| Option | Description | Default |
|--------|-------------|---------|
| `--source`, `-s` | Source SQLite database path | (required) |
| `--uploads`, `-u` | Source `usr/uploads/` directory | (required) |
| `--prefix` | Source table prefix | `typecho_` |
| `--dry-run`, `-n` | Preview mode | `false` |
| `--site-url` | New site URL (for rewriting attachment URLs) | — |
| `--d1-name` | D1 database name | `typecho-cf-db` |
| `--r2-bucket` | R2 bucket name | `typecho-cf-uploads` |

### Reset Password After Migration

Password hashing is incompatible (PHP phpass → SHA-256 + salt), so passwords must be reset after migration:

```bash
# Local
pnpm run reset-password

# Cloudflare
pnpm run reset-password:cloudflare
```

---

## Plugin Development

Plugins are distributed as npm packages and extend the system via a Hook mechanism.

**Full guide**: [Plugin Development Guide](src/plugins/README.md) — includes complete Props interfaces, all hook points, and the captcha plugin as an example.

### Minimal Plugin Structure

```
typecho-plugin-example/
├── package.json   # keywords must include ["typecho", "plugin"]
├── plugin.json    # Plugin metadata (with optional config declaration)
└── index.js       # ESM entry: export default function init({ addHook, pluginId }) {}
```

### Hook Example

```javascript
export default function init({ addHook, pluginId }) {
  // filter hook: transform rendered HTML
  addHook('content:content', pluginId, (html) => {
    return html + '<!-- by example plugin -->';
  });

  // call hook: notify after comment is saved
  addHook('feedback:finishComment', pluginId, (comment) => {
    console.log('new comment:', comment.coid);
  });
}
```

### Install a Plugin

```bash
pnpm add typecho-plugin-example
pnpm run build
```

---

## Theme Development

Themes are distributed as npm packages and can provide full custom templates or CSS-only styling.

**Full guide**: [Theme Development Guide](src/themes/README.md) — includes complete Props types and the minimal theme as an example.

### Minimal Theme Structure

```
typecho-theme-example/
├── package.json   # keywords must include ["typecho", "theme"]
├── theme.json     # Theme metadata (stylesheet declaration)
├── style.css      # Main stylesheet
└── components/    # Optional: custom Astro template components
    ├── Index.astro
    ├── Post.astro
    ├── Page.astro
    ├── Archive.astro
    └── NotFound.astro
```

### Install a Theme

```bash
pnpm add typecho-theme-example
pnpm run build
# Then switch to the new theme in the admin panel under "Appearance"
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | [Astro](https://astro.build) 6.x (SSR) |
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| ORM | [Drizzle ORM](https://orm.drizzle.team) |
| File Storage | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| Testing | [Vitest](https://vitest.dev) |
| Package Manager | pnpm |

---

## Compatibility with PHP Typecho

| Aspect | Status |
|--------|--------|
| Database schema | ✅ Fully compatible, can import SQLite DB directly |
| Default theme style | ✅ CSS & HTML structure matches Typecho default theme |
| URL structure | ✅ Routes match Typecho default permalink settings |
| Password hashing | ⚠️ Reset required after migration (different algorithm) |
| PHP themes / plugins | ❌ Must be repackaged in the new format (TypeScript / npm) |

---

## License

MIT
