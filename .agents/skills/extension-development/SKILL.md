---
name: extension-development
description: Build or extend Typecho-CF plugins and themes, integrate them through the repository's loaders, and cover requested behavior with automated tests.
---

# Plugin and Theme Development

Start from the requested behavior and identify observable acceptance criteria. Read the applicable sections of [AGENTS.md](../../../AGENTS.md) (§6 for plugins, §7 for themes, §10 for tests) and the selected extension guide below. Use one similar in-tree extension as a reference and open further examples only for the integration points involved. Ask only when a missing product decision would change the result materially.

For a new in-tree package, put it under `src/plugins/` or `src/themes/` and add its `file:` dependency in the root `package.json`. When package metadata changes dependency resolution, refresh `pnpm-lock.yaml` with the pinned pnpm version. Keep implementation in the extension when the existing SDK or theme Props cover the requirement. If a core contract must change, follow the applicable `AGENTS.md` requirements and verify the affected callers.

## Plugin

Use the [plugin guide](../../../src/plugins/README.md) for manifest, SDK, and test conventions. Register canonical hooks in lazy `init()` and keep I/O and side effects out of module evaluation. Check the real hook call site for timing and context. For routes, configuration, capabilities, or tasks, read the relevant guide sections and verify the applicable lifecycle, permission, cache, secret handling, and failure rules.

Use the colocated `index.test.ts` for hook registration, guards, success, rejection, edge cases, and configuration validation when applicable. Mock external services for failure paths. Add an integration case when the feature depends on core routing, authorization, persistence, or activation behavior that a direct hook test cannot prove.

## Theme

Use the [theme guide](../../../src/themes/README.md) to choose between CSS with default templates and custom Astro components. Use typed theme Props and system `Base.astro` where suitable. A theme that renders its own document must provide the required stylesheet and frontend hook integration. Preserve escaping, navigation, and accessibility where the theme touches them.

Cover the requested behavior with loader or unit tests where relevant. For template output, render real components with the Astro Container API in `tests/astro/` and assert observable behavior such as links, escaping, or fallback content. Use integration tests when settings or theme selection depend on persistence.

## Verify and deliver

- Iterate with focused cases using `pnpm run test <path>` or `pnpm run test:astro <path>`. Map each acceptance criterion to coverage and include applicable rejection or fallback paths. Reuse existing fixtures and helpers.
- Run `pnpm run test` and `pnpm run typecheck` on the finished changes as required by `AGENTS.md`. Run `pnpm run lint` for TypeScript changes, `pnpm run test:astro` for template behavior changes, and `pnpm run build` for new packages or changes to discovery, generated assets, or build entry points. For discovery changes, confirm the build finds the extension and emits its expected artifacts where applicable.
- Summarize delivered behavior, integration, tests, and any checks that could not run. Update extension usage or configuration docs when the operator needs new setup information.
