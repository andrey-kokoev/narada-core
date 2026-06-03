# @narada2/task-governance-core

Task governance is Narada's self-build control subsystem. It owns the durable task lifecycle, task assignment, evidence admission, task projection, recommendation, reconciliation-facing domain rules, and package-level tests for those rules.

The CLI is an adapter. It may parse arguments, call package services, and format bounded output. It must not become the authority owner for task state transitions.

## Package Role

This package exists because task management is no longer a CLI helper. It has its own authority grammar:

- task lifecycle status is durable state;
- assignment intent is an admitted request, not a file edit;
- assignment lifecycle services own claim, continue, and release transitions;
- evidence admission is a governed crossing;
- criteria proof is explicit state, not checkbox trust;
- recommendations are advisory signals over task authority;
- markdown task artifacts are compatibility/spec projections until full task-spec authority is migrated.

## Layer Contract

The package is organized around these layers.

| Layer | Owns | May Import | Must Not Own |
| --- | --- | --- | --- |
| Domain model | Task status, assignment intent, evidence, recommendation, graph, projection types | Pure TypeScript helpers | CLI formatting, process execution |
| Store | SQLite-backed task lifecycle/schema and task-owned rows | Control-plane SQLite binding | Operator output policy |
| Projection | Merged read surfaces over lifecycle/spec/evidence | Store and markdown compatibility readers | Lifecycle mutations |
| Services | Governed task operations and orchestration | Domain, store, projection | Commander parsing, terminal formatting |
| Tests | Package-owned domain invariants | Package source | CLI adapter behavior except through stable service contracts |

## CLI Boundary

CLI command files under `packages/layers/cli/src/commands` should eventually be thin adapters:

1. Parse flags and positional arguments.
2. Resolve cwd and command output mode.
3. Call a package-owned service.
4. Emit bounded output through CLI output admission.

Task transition logic, evidence admission decisions, recommendation scoring, lifecycle persistence, and reconciliation logic belong here, not in CLI command files.

Compatibility shims currently remain in `packages/layers/cli/src/lib/task-*.ts` so existing command/test imports can migrate incrementally. New task-domain code should import this package directly.

The service extraction queue is tracked in
[`docs/concepts/task-cli-service-extraction-rails.md`](../../docs/concepts/task-cli-service-extraction-rails.md).

## CEIZ / TIZ Boundary

Command Execution Intent Zone and Testing Intent Zone row shapes are mirrored locally as neutral persistence types. Task governance persists references and row projections needed for task evidence, but the authority grammar of command execution and test execution is not task-owned.

- CEIZ owns command-run request/result types and execution-output admission semantics.
- TIZ owns verification request/result types and test-run policy.
- Task governance references CEIZ/TIZ artifacts as evidence, but does not define their authority grammar.

## Local Development

The CLI consumes this package through workspace package exports. After editing `packages/task-governance/src`, run:

```bash
pnpm --filter @narada2/task-governance-core build
pnpm --filter @narada2/cli typecheck
```

After editing lower shared contracts in `packages/intent-zones/src`, build from the lower package upward:

```bash
pnpm --filter @narada2/intent-zones build
pnpm --filter @narada2/task-governance-core build
pnpm --filter @narada2/cli typecheck
```

`pnpm verify` includes only the `@narada2/task-governance-core` smoke test. Broader package tests are intentionally separate because they exercise file-backed SQLite and dominate the fast gate runtime:

```bash
pnpm --filter @narada2/task-governance-core test:smoke
pnpm --filter @narada2/task-governance-core test:fast
```

Assignment-lifecycle integration coverage is also separate:

```bash
pnpm --filter @narada2/task-governance-core test:assignment-lifecycle
```

The exhaustive governance test is also intentionally separate:

```bash
pnpm --filter @narada2/task-governance-core test:governance
```

Use `test:fast` when changing projection, recommender, evidence admission, close, allocation, or search semantics. Use the assignment-lifecycle test when changing claim, continue, release, roster, or assignment-intent semantics. Use the exhaustive governance test when changing lint, lifecycle, report, review, or dependency semantics.
