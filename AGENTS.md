# AGENTS.md

Guidance for agents working in this repository.

## Repository Purpose

`narada-core` contains neutral shared Narada core packages. These packages are intended to be consumed by Narada proper and MCP surface repos without depending on either repo's runtime internals.

Current packages:

- `@narada2/task-governance-core`: neutral task governance domain core.

## Common Commands

```powershell
pnpm build        # tsc -b (incremental project references)
pnpm typecheck    # tsc -b --pretty false
pnpm test         # pnpm -r test (runs all packages' test scripts)
```

## Package-Level Commands

Run from the repo root:

```powershell
pnpm --filter @narada2/task-governance-core build
pnpm --filter @narada2/task-governance-core typecheck   # tsc --noEmit (NOT tsc -b)
pnpm --filter @narada2/task-governance-core test
```

### Targeted Tests

All vitest tests use `--pool=forks --no-file-parallelism --maxWorkers=1 --minWorkers=1 --testTimeout=120000 --hookTimeout=120000` because tests exercise file-backed SQLite and cannot share a database connection.

```powershell
pnpm --filter @narada2/task-governance-core test:smoke   # single fastest test
pnpm --filter @narada2/task-governance-core test:fast     # core domain tests (projection, recommender, evidence, close, allocate, search)
pnpm --filter @narada2/task-governance-core test:assignment-lifecycle  # claim/continue/release/roster
pnpm --filter @narada2/task-governance-core test:governance            # exhaustive lint/lifecycle/report/review
```

Guidance:

- Use `test:smoke` for quick iteration.
- Use `test:fast` when changing projection, recommender, evidence admission, close, allocation, or search semantics.
- Use `test:assignment-lifecycle` when changing assignment-intent, claim, continue, release, or roster semantics.
- Use `test:governance` when changing lint, lifecycle, report, review, or dependency semantics.
- Run the full `test` script before handing off changes.

## Import Boundary

Each package enforces that source files do not import from forbidden packages (e.g. `@narada2/task-governance`, `@narada2/task-lifecycle-mcp`, `@narada2/mcp-transport`).

- `.import-boundary-files.json` in the package root lists every source file that must be checked.
- `test/import-boundary.test.mjs` (plain Node script, not vitest) runs the checks.
- When adding a new source file, add its path to `.import-boundary-files.json` or the import-boundary test will not cover it.

## Development Rules

- TypeScript sources under `packages/*/src`, tests under `packages/*/test`.
- Preserve ESM/NodeNext module resolution.
- `strict: true` is set per-package (not in `tsconfig.base.json`).
- This repo is domain-focused: no MCP stdio server ownership, no carrier launch logic, no site-local adapter code.
- Do not import from Narada proper packages (e.g. `@narada2/task-governance`).
- Do not import from MCP surface packages (e.g. `@narada2/task-lifecycle-mcp`, `@narada2/mcp-transport`).

## Environment Requirements

- Node >= 22.0.0 (required by `@narada2/task-governance-core`)
- pnpm@10.9.0 (declared in root `package.json`)

## Architecture

- `narada-core` — this repo — owns neutral domain logic and contracts.
- `narada` — separate repo — owns product/site/runtime integration.
- `mcp-surfaces` — separate repo — owns MCP transport and MCP server surface mechanics.

## Verification Expectations

Before handing off changes:

- Run the relevant targeted test for the touched domain.
- Run `pnpm build` or `pnpm typecheck` when changing TypeScript config, exports, or public types.
- Run root `pnpm test` when moving shared domain behavior or changing dependency boundaries.
