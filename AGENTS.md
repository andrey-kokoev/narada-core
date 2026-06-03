# AGENTS.md

Guidance for agents working in this repository.

## Repository Purpose

`narada-core` contains neutral shared Narada core packages. These packages are intended to be consumed by Narada proper and MCP surface repos without depending on either repo's runtime internals.

Current packages:

- `@narada2/task-governance-core`: neutral task governance domain core.

## Development Rules

- Use TypeScript sources under `packages/*/src` and tests under `packages/*/test`.
- Preserve ESM/NodeNext package behavior.
- Keep this repo domain-focused: no MCP stdio server ownership, no carrier launch logic, and no site-local adapter code.
- Do not import from Narada proper packages such as `@narada2/task-governance`.
- Do not import from MCP surface packages such as `@narada2/task-lifecycle-mcp` or `@narada2/mcp-transport`.
- Add import-boundary tests when introducing new package dependencies or package exports.

## Common Commands

```powershell
pnpm build
pnpm typecheck
pnpm test
```

## Verification Expectations

Before handing off changes:

- Run the package-level test for the touched package when possible.
- Run `pnpm build` or `pnpm typecheck` when changing TypeScript config, exports, or public types.
- Run root `pnpm test` when moving shared domain behavior or changing dependency boundaries.

## Boundary Notes

- `narada-core` owns neutral domain logic and contracts.
- `mcp-surfaces` owns MCP transport and MCP server surface mechanics.
- `narada` owns product/site/runtime integration and application-specific orchestration.
