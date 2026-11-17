---
name: health-audit
description: Audit Typecho-CF code or a proposed change for defects, specific optimization opportunities, and gaps in documentation, agent skills, or tests. Deliver prioritized findings for the operator to select and offer a PR after implementing approved work.
---

# Repository Health Audit

## Inspect

1. Check the branch, worktree status, and relevant diff. Use the requested scope and identify the comparison base if reviewing a change. For a repository audit, use the `AGENTS.md` file index to map the source, tests, docs, and skills. Sample by risk, starting with authentication, writes to D1, request routing and caching, and plugin or task lifecycles when relevant.
2. Read the applicable sections of [AGENTS.md](../../../AGENTS.md), then open the relevant feature docs and tests. Use targeted searches to trace the entry point, affected callers, error paths, and existing coverage. Expand the search when a shared contract or promising finding warrants it.
3. Validate each candidate against the expected contract and a reachable scenario. Prefer direct code and test evidence. When verification is requested, run the smallest relevant check first. For a performance improvement, identify the repeated work or cost and how to measure it. For a docs or skill gap, identify the stale or missing instruction and the behavior it affects. For a test gap, identify the uncovered behavior and why a regression matters.
4. Review names and style against neighboring code and TypeScript conventions. Use descriptive `camelCase` names for variables, parameters, and functions, `PascalCase` for types and enum-like constant objects, and the established constant style for scalar module constants. Check that names convey domain meaning, boolean names read as predicates, abbreviations are established, and external/schema field names remain compatible. Prefer explicit types and type-only imports, small cohesive functions, clear control flow, and consistent existing formatting. Raise a style item only when it hurts clarity, correctness, or consistency.

Run `pnpm run lint` for the files in scope. ESLint covers TypeScript, Astro frontmatter and inline scripts, tests, and scripts, enforcing naming, type-only imports, unused imports, Promise handling, and Workers runtime boundaries (`node:*` imports, Node globals, direct forwarded-IP reads, and `Astro.locals.runtime.env`). Use lint output for these mechanical checks and reserve the report for context-dependent naming and style issues; do not manually re-report every lint message. Existing lint violations still count as findings when they occur in reviewed code or block reliable enforcement.

## Deliver the report

Keep the review read only until the operator selects work. Sort actionable findings by impact and give each a stable ID such as `F1`. Include the category, priority, narrow file and line reference, triggering condition, evidence, impact, and proposed fix or verification. Use **P1** for serious security, data, or major workflow impact, **P2** for bounded defects or material regression risks, and **P3** for lower impact work. Combine findings caused by the same issue. Label optional improvements and distinguish unverified leads from confirmed findings.

State the scope actually examined, checks run, and material gaps or blockers. If nothing actionable is supported, say so. Invite the operator to select findings by ID when there are findings to act on.

## Apply selected changes

Implement the selected work, preserving unrelated edits. For fixes and behavior changes, add regression coverage and run the required checks in `AGENTS.md` §10.4 plus any applicable build or render checks. Update affected canonical docs or skills when their instructions change. Report the result and offer a PR for the selected changes once they are reviewable. If the operator already authorized a PR, proceed with that authorization.
