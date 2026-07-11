import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "./sqlite-database.js";
import {
  TASK_LIFECYCLE_BUSY_TIMEOUT_MS,
  TASK_LIFECYCLE_FAST_SQLITE_ENV,
  TASK_LIFECYCLE_SYNCHRONOUS_MODE,
} from "./task-lifecycle-store.js";
import {
  assertSqliteRuntimeSupported,
  selectSqliteRuntime,
} from "./sqlite-runtime.js";

type Db = Database;

export type DirectiveSourceKind = "operator" | "agent" | "system";
export type DirectiveKind = "instruction" | "attention" | "constraint" | "policy" | "handoff" | "pause" | "escalation";
export type DirectiveTargetKind = "agent" | "carrier" | "site" | "role" | "task" | "session" | "workspace";
export type DirectiveContentKind = "instruction" | "constraint" | "routing" | "delivery" | "context" | "plain_text" | "task_ref" | "work_ref" | "source_ref" | "policy_ref" | "structured_instruction";
export type DirectiveAdmissionStatus = "candidate" | "admitted" | "refused" | "delivered" | "superseded" | "expired";
export type DirectiveDeliveryStatus = "pending" | "leased" | "delivered" | "receipt_recorded" | "failed" | "expired";
export type DirectiveRefKind = "task" | "work" | "source" | "policy" | "carrier" | "session";
export type DirectiveTriageStatus = "untriaged" | "carrier_accepted" | "accepted" | "refused" | "ignored_stale" | "superseded" | "blocked" | "needs_operator";

export interface DirectiveSource { readonly kind: DirectiveSourceKind; readonly id: string; readonly label?: string }
export interface DirectiveAuthority { readonly locus: string; readonly basis: string }
export interface DirectiveTarget { readonly kind: DirectiveTargetKind; readonly id: string }
export interface DirectiveRef { readonly kind: DirectiveRefKind; readonly id: string; readonly locus?: string; readonly relation?: string }
export interface DirectiveContent { readonly kind: DirectiveContentKind; readonly text: string; readonly refs?: readonly DirectiveRef[]; readonly data?: Record<string, unknown> }
export interface DirectiveOrdering { readonly priority: number; readonly sequence: number; readonly not_before?: string; readonly expires_at?: string }
export interface DirectiveAdmission { readonly status: DirectiveAdmissionStatus; readonly decided_at?: string; readonly decided_by?: string; readonly reason?: string }
export interface DirectiveDelivery { readonly status?: DirectiveDeliveryStatus; readonly delivered_at?: string; readonly transport?: string; readonly artifact_ref?: string; readonly lease_id?: string; readonly leased_until?: string; readonly carrier_session_id?: string; readonly receipt_id?: string }
export interface Directive {
  readonly schema: "narada.directive.v1";
  readonly directive_id: string;
  readonly kind: DirectiveKind;
  readonly created_at: string;
  readonly source: DirectiveSource;
  readonly authority: DirectiveAuthority;
  readonly target: DirectiveTarget;
  readonly content: DirectiveContent;
  readonly ordering: DirectiveOrdering;
  readonly admission: DirectiveAdmission;
  readonly delivery?: DirectiveDelivery;
}
export interface DirectiveDraft {
  readonly kind?: DirectiveKind;
  readonly created_at: string;
  readonly source: DirectiveSource;
  readonly authority: DirectiveAuthority;
  readonly target: DirectiveTarget;
  readonly content: DirectiveContent;
  readonly ordering?: Partial<DirectiveOrdering>;
}
export interface DirectiveDeliveryAttempt {
  readonly schema: "narada.directive-delivery-attempt.v1";
  readonly attempt_id: string;
  readonly directive_id: string;
  readonly attempted_at: string;
  readonly target: DirectiveTarget;
  readonly transport: string;
  readonly status: "leased" | "delivered" | "failed" | "expired";
  readonly lease_id?: string;
  readonly leased_until?: string;
  readonly carrier_session_id?: string;
  readonly reason?: string;
}
export interface DirectiveReceipt {
  readonly schema: "narada.directive-receipt.v1";
  readonly receipt_id: string;
  readonly directive_id: string;
  readonly received_at: string;
  readonly carrier_session_id: string;
  readonly agent_id: string;
  readonly transport: string;
}
export interface DirectiveTriageRecord {
  readonly schema: "narada.directive-triage.v1";
  readonly triage_id: string;
  readonly directive_id: string;
  readonly triaged_at: string;
  readonly agent_id: string;
  readonly status: DirectiveTriageStatus;
  readonly reason?: string;
  readonly selected_work_ref?: DirectiveRef;
}

export interface DirectiveAdmissionResult {
  readonly directive: Directive;
  readonly isNew: boolean;
  readonly idempotencyKey: string | null;
}

export interface PendingDirectiveQuery {
  readonly target?: Partial<DirectiveTarget>;
  readonly nowIso?: string;
  readonly limit?: number;
}

export interface AdmittedWorkDirectiveInput {
  readonly siteId: string;
  readonly authorityLocus: string;
  readonly systemEmitterId: string;
  readonly residentAgentId?: string;
  readonly residentRole?: string;
  readonly taskId: string;
  readonly taskNumber?: number | null;
  readonly transitionId?: string | null;
  readonly workId?: string | null;
  readonly sourceId?: string | null;
  readonly title?: string | null;
  readonly admittedAt?: string;
}

export class SqliteDirectiveRuntimeStore {
  readonly db: Db;

  constructor(opts: { readonly db: Db }) {
    this.db = opts.db;
  }

  initSchema(): void {
    this.db.exec(`
      create table if not exists directive_records (
        directive_id text primary key,
        idempotency_key text unique,
        kind text not null,
        source_kind text not null,
        source_id text not null,
        authority_locus text not null,
        authority_basis text not null,
        target_kind text not null,
        target_id text not null,
        content_kind text not null,
        admission_status text not null,
        delivery_status text not null,
        created_at text not null,
        not_before text,
        expires_at text,
        priority integer not null,
        sequence integer not null,
        directive_json text not null,
        updated_at text not null
      );

      create index if not exists idx_directive_records_pending
        on directive_records(admission_status, delivery_status, target_kind, target_id, not_before, expires_at, priority, sequence, created_at);

      create table if not exists directive_refs (
        directive_id text not null,
        ref_kind text not null,
        ref_id text not null,
        locus text,
        relation text,
        primary key (directive_id, ref_kind, ref_id),
        foreign key (directive_id) references directive_records(directive_id)
      );

      create table if not exists directive_emission_authorizations (
        authorization_id text primary key,
        directive_id text,
        idempotency_key text unique,
        authorized_at text not null,
        authorized_by_json text not null,
        authorized_emitter_json text not null,
        authority_json text not null,
        template_json text not null,
        status text not null,
        authorization_json text not null
      );

      create table if not exists directive_delivery_attempts (
        attempt_id text primary key,
        directive_id text not null,
        attempted_at text not null,
        target_kind text not null,
        target_id text not null,
        transport text not null,
        status text not null,
        lease_id text,
        leased_until text,
        carrier_session_id text,
        reason text,
        attempt_json text not null,
        foreign key (directive_id) references directive_records(directive_id)
      );

      create index if not exists idx_directive_delivery_attempts_directive
        on directive_delivery_attempts(directive_id, attempted_at);

      create table if not exists directive_receipts (
        receipt_id text primary key,
        directive_id text not null,
        received_at text not null,
        carrier_session_id text not null,
        agent_id text not null,
        transport text not null,
        receipt_json text not null,
        foreign key (directive_id) references directive_records(directive_id)
      );

      create table if not exists directive_triage_records (
        triage_id text primary key,
        directive_id text not null,
        triaged_at text not null,
        agent_id text not null,
        status text not null,
        reason text,
        selected_work_ref_json text,
        triage_json text not null,
        foreign key (directive_id) references directive_records(directive_id)
      );
    `);
  }

  admitDirective(draft: DirectiveDraft, args: { readonly actor: string; readonly reason: string; readonly idempotencyKey?: string | null }): DirectiveAdmissionResult {
    const directive = admitDirective(createDirective(draft), {
      decided_at: nowIso(),
      decided_by: args.actor,
      reason: args.reason,
    });
    return this.upsertDirective(directive, args.idempotencyKey ?? null);
  }

  upsertDirective(directive: Directive, idempotencyKey: string | null = null): DirectiveAdmissionResult {
    this.initSchema();
    if (idempotencyKey) {
      const existing = this.db.prepare(`select directive_json from directive_records where idempotency_key = ?`).get(idempotencyKey) as { directive_json: string } | undefined;
      if (existing) return { directive: JSON.parse(existing.directive_json) as Directive, isNew: false, idempotencyKey };
    }

    const deliveryStatus = directive.delivery?.status ?? "pending";
    this.db.prepare(`
      insert into directive_records (
        directive_id, idempotency_key, kind, source_kind, source_id, authority_locus, authority_basis,
        target_kind, target_id, content_kind, admission_status, delivery_status, created_at,
        not_before, expires_at, priority, sequence, directive_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(directive_id) do update set
        directive_json = excluded.directive_json,
        admission_status = excluded.admission_status,
        delivery_status = excluded.delivery_status,
        updated_at = excluded.updated_at
    `).run(
      directive.directive_id,
      idempotencyKey,
      directive.kind,
      directive.source.kind,
      directive.source.id,
      directive.authority.locus,
      directive.authority.basis,
      directive.target.kind,
      directive.target.id,
      directive.content.kind,
      directive.admission.status,
      deliveryStatus,
      directive.created_at,
      directive.ordering.not_before ?? null,
      directive.ordering.expires_at ?? null,
      directive.ordering.priority,
      directive.ordering.sequence,
      JSON.stringify(directive),
      nowIso(),
    );
    this.replaceRefs(directive.directive_id, directive.content.refs ?? []);
    return { directive, isNew: true, idempotencyKey };
  }

  getDirective(directiveId: string): Directive | undefined {
    this.initSchema();
    const row = this.db.prepare(`select directive_json from directive_records where directive_id = ?`).get(directiveId) as { directive_json: string } | undefined;
    return row ? JSON.parse(row.directive_json) as Directive : undefined;
  }

  listPending(query: PendingDirectiveQuery = {}): Directive[] {
    this.initSchema();
    const now = query.nowIso ?? nowIso();
    const limit = Math.max(1, Math.min(500, query.limit ?? 100));
    const clauses = [
      `admission_status = 'admitted'`,
      `delivery_status in ('pending', 'failed')`,
      `(
        delivery_status != 'failed'
        or (
          coalesce(json_extract(directive_json, '$.delivery.failure_reason'), '') not in (
            'lease_expired_without_carrier_receipt',
            'delivery_without_receipt_past_threshold',
            'delivery_stale'
          )
          and coalesce(json_extract(directive_json, '$.delivery.failure_reason'), '') not like 'terminal_outcome_%'
          and coalesce(json_extract(directive_json, '$.delivery.failure_reason'), '') not like 'operator_paused_%'
        )
      )`,
      `(not_before is null or not_before <= ?)`,
      `(expires_at is null or expires_at > ?)`,
    ];
    const params: unknown[] = [now, now];
    if (query.target?.kind) {
      clauses.push(`target_kind = ?`);
      params.push(query.target.kind);
    }
    if (query.target?.id) {
      clauses.push(`target_id = ?`);
      params.push(query.target.id);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      select directive_json from directive_records
      where ${clauses.join(" and ")}
      order by priority desc, sequence asc, created_at asc, directive_id asc
      limit ?
    `).all(...params) as Array<{ directive_json: string }>;
    return rows.map((row) => JSON.parse(row.directive_json) as Directive);
  }

  leaseDelivery(directiveId: string, lease: { readonly leaseId: string; readonly leasedUntil: string; readonly transport: string; readonly carrierSessionId?: string | null }): DirectiveDeliveryAttempt {
    this.initSchema();
    const directive = this.requireDirective(directiveId);
    const leased = markDirectiveDeliveryLeased(directive, {
      lease_id: lease.leaseId,
      leased_until: lease.leasedUntil,
      transport: lease.transport,
      carrier_session_id: lease.carrierSessionId ?? undefined,
    });
    this.upsertDirective(leased);
    const attempt: DirectiveDeliveryAttempt = {
      schema: "narada.directive-delivery-attempt.v1",
      attempt_id: `dirattempt_${hashStable({ directiveId, lease }).slice(0, 32)}`,
      directive_id: directiveId,
      attempted_at: nowIso(),
      target: directive.target,
      transport: lease.transport,
      status: "leased",
      lease_id: lease.leaseId,
      leased_until: lease.leasedUntil,
      carrier_session_id: lease.carrierSessionId ?? undefined,
    };
    this.insertAttempt(attempt);
    return attempt;
  }

  recordReceipt(directiveId: string, receipt: Omit<DirectiveReceipt, "schema" | "receipt_id" | "directive_id">): DirectiveReceipt {
    this.initSchema();
    const { directive, receipt: recorded } = recordDirectiveReceipt(this.requireDirective(directiveId), receipt);
    this.upsertDirective(directive);
    this.db.prepare(`
      insert or replace into directive_receipts (
        receipt_id, directive_id, received_at, carrier_session_id, agent_id, transport, receipt_json
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
      recorded.receipt_id,
      recorded.directive_id,
      recorded.received_at,
      recorded.carrier_session_id,
      recorded.agent_id,
      recorded.transport,
      JSON.stringify(recorded),
    );
    return recorded;
  }

  recordTriage(directiveId: string, triage: Omit<DirectiveTriageRecord, "schema" | "triage_id" | "directive_id">): DirectiveTriageRecord {
    this.initSchema();
    const record = createDirectiveTriageRecord(this.requireDirective(directiveId), triage);
    this.db.prepare(`
      insert or replace into directive_triage_records (
        triage_id, directive_id, triaged_at, agent_id, status, reason, selected_work_ref_json, triage_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.triage_id,
      record.directive_id,
      record.triaged_at,
      record.agent_id,
      record.status,
      record.reason ?? null,
      record.selected_work_ref ? JSON.stringify(record.selected_work_ref) : null,
      JSON.stringify(record),
    );
    return record;
  }

  emitResidentDirectiveForAdmittedWork(input: AdmittedWorkDirectiveInput): DirectiveAdmissionResult {
    const admittedAt = input.admittedAt ?? nowIso();
    const target: DirectiveTarget = input.residentAgentId
      ? { kind: "agent", id: input.residentAgentId }
      : { kind: "role", id: input.residentRole ?? "resident" };
    const refs: DirectiveRef[] = [
      { kind: "task", id: input.taskId, locus: input.siteId, relation: "admitted_work" },
    ];
    if (input.workId) refs.push({ kind: "work", id: input.workId, locus: input.siteId, relation: "admitted_work" });
    if (input.sourceId) refs.push({ kind: "source", id: input.sourceId, locus: input.siteId, relation: "source_of_admitted_work" });

    const directive = createDirective({
      kind: "attention",
      created_at: admittedAt,
      source: { kind: "system", id: input.systemEmitterId },
      authority: { locus: input.authorityLocus, basis: `task_admission_transition:${input.transitionId ?? input.taskId}` },
      target,
      content: {
        kind: "work_ref",
        text: input.title
          ? `Resident work contract: inspect task ${input.taskNumber ?? input.taskId}; claim it as the resident if eligible; do bounded work only within admitted Site authority; submit a task lifecycle report with findings, no_files_changed or changed_files evidence, blockers if any, and the delivered directive_id token; do not send outbound customer-visible effects. Newly admitted work: ${input.title}`
          : `Resident work contract: inspect task ${input.taskNumber ?? input.taskId}; claim it as the resident if eligible; do bounded work only within admitted Site authority; submit a task lifecycle report with findings, no_files_changed or changed_files evidence, blockers if any, and the delivered directive_id token; do not send outbound customer-visible effects.`,
        refs,
        data: {
          task_id: input.taskId,
          task_number: input.taskNumber ?? null,
          transition_id: input.transitionId ?? null,
          work_id: input.workId ?? null,
          source_id: input.sourceId ?? null,
        },
      },
      ordering: { priority: 100, sequence: 0 },
    });
    const validation = validateDirectiveForAdmission(directive, {
      authorityLocus: input.authorityLocus,
      residentAgentId: input.residentAgentId,
      residentRole: input.residentRole ?? "resident",
    });
    if (!validation.valid) throw new Error(`directive_admission_refused:${validation.errors.join(",")}`);
    const admitted = admitDirective(directive, {
      decided_at: admittedAt,
      decided_by: input.systemEmitterId,
      reason: "new_admitted_work",
    });
    return this.upsertDirective(admitted, `admitted-work:${input.siteId}:${input.taskId}:${input.transitionId ?? "initial"}:${target.kind}:${target.id}`);
  }

  private requireDirective(directiveId: string): Directive {
    const directive = this.getDirective(directiveId);
    if (!directive) throw new Error(`directive_not_found:${directiveId}`);
    return directive;
  }

  private replaceRefs(directiveId: string, refs: readonly DirectiveRef[]): void {
    this.db.prepare(`delete from directive_refs where directive_id = ?`).run(directiveId);
    const insert = this.db.prepare(`
      insert or ignore into directive_refs (directive_id, ref_kind, ref_id, locus, relation)
      values (?, ?, ?, ?, ?)
    `);
    for (const ref of refs) {
      insert.run(directiveId, ref.kind, ref.id, ref.locus ?? null, ref.relation ?? null);
    }
  }

  private insertAttempt(attempt: DirectiveDeliveryAttempt): void {
    this.db.prepare(`
      insert or replace into directive_delivery_attempts (
        attempt_id, directive_id, attempted_at, target_kind, target_id, transport, status,
        lease_id, leased_until, carrier_session_id, reason, attempt_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.attempt_id,
      attempt.directive_id,
      attempt.attempted_at,
      attempt.target.kind,
      attempt.target.id,
      attempt.transport,
      attempt.status,
      attempt.lease_id ?? null,
      attempt.leased_until ?? null,
      attempt.carrier_session_id ?? null,
      attempt.reason ?? null,
      JSON.stringify(attempt),
    );
  }
}

export function openDirectiveRuntimeStore(cwd: string): SqliteDirectiveRuntimeStore {
  const runtime = selectSqliteRuntime();
  assertSqliteRuntimeSupported(runtime);
  const aiDir = join(cwd, ".ai");
  mkdirSync(aiDir, { recursive: true });
  const dbPath = join(aiDir, "task-lifecycle.db");
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${TASK_LIFECYCLE_BUSY_TIMEOUT_MS}`);
  if (process.env[TASK_LIFECYCLE_FAST_SQLITE_ENV] === "1") {
    db.pragma("journal_mode = MEMORY");
    db.pragma("synchronous = OFF");
  } else {
    db.pragma("journal_mode = WAL");
    db.pragma(`synchronous = ${TASK_LIFECYCLE_SYNCHRONOUS_MODE}`);
  }
  const store = new SqliteDirectiveRuntimeStore({ db });
  store.initSchema();
  return store;
}

export function leaseId(directiveId: string, carrierSessionId: string, now = nowIso()): string {
  return `dirlease_${hashStable({ directiveId, carrierSessionId, now }).slice(0, 32)}`;
}

export function leaseExpiryIso(minutes = 5): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function directiveStatusForAgent(
  store: SqliteDirectiveRuntimeStore,
  agent: { readonly agentId: string; readonly role?: string | null },
): { readonly pending: Directive[]; readonly target: DirectiveTarget[] } {
  const targets: DirectiveTarget[] = [{ kind: "agent", id: agent.agentId }];
  if (agent.role) targets.push({ kind: "role", id: agent.role });
  const pending = targets.flatMap((target) => store.listPending({ target }));
  return { pending, target: targets };
}

function createDirective(draft: DirectiveDraft): Directive {
  const directive: Omit<Directive, "directive_id"> = {
    schema: "narada.directive.v1",
    kind: draft.kind ?? inferDirectiveKind(draft.content.kind),
    created_at: draft.created_at,
    source: draft.source,
    authority: draft.authority,
    target: draft.target,
    content: draft.content,
    ordering: {
      priority: draft.ordering?.priority ?? 0,
      sequence: draft.ordering?.sequence ?? 0,
      not_before: draft.ordering?.not_before,
      expires_at: draft.ordering?.expires_at,
    },
    admission: { status: "candidate" },
  };
  return { ...directive, directive_id: `dir_${hashStable(directive).slice(0, 32)}` };
}

function admitDirective(directive: Directive, decision: { readonly decided_at: string; readonly decided_by: string; readonly reason?: string }): Directive {
  return {
    ...directive,
    admission: {
      status: "admitted",
      decided_at: decision.decided_at,
      decided_by: decision.decided_by,
      reason: decision.reason,
    },
  };
}

function markDirectiveDeliveryLeased(
  directive: Directive,
  lease: { readonly lease_id: string; readonly leased_until: string; readonly transport: string; readonly carrier_session_id?: string },
): Directive {
  return {
    ...directive,
    delivery: {
      status: "leased",
      lease_id: lease.lease_id,
      leased_until: lease.leased_until,
      transport: lease.transport,
      carrier_session_id: lease.carrier_session_id,
    },
  };
}

function recordDirectiveReceipt(
  directive: Directive,
  receipt: Omit<DirectiveReceipt, "schema" | "receipt_id" | "directive_id">,
): { readonly directive: Directive; readonly receipt: DirectiveReceipt } {
  const base = { schema: "narada.directive-receipt.v1" as const, directive_id: directive.directive_id, ...receipt };
  const recorded = { ...base, receipt_id: `dirrcpt_${hashStable(base).slice(0, 32)}` };
  return {
    directive: {
      ...directive,
      delivery: {
        ...(directive.delivery ?? {}),
        status: "receipt_recorded",
        delivered_at: directive.delivery?.delivered_at ?? receipt.received_at,
        transport: receipt.transport,
        carrier_session_id: receipt.carrier_session_id,
        receipt_id: recorded.receipt_id,
      },
    },
    receipt: recorded,
  };
}

function createDirectiveTriageRecord(
  directive: Directive,
  triage: Omit<DirectiveTriageRecord, "schema" | "triage_id" | "directive_id">,
): DirectiveTriageRecord {
  const base = { schema: "narada.directive-triage.v1" as const, directive_id: directive.directive_id, ...triage };
  return { ...base, triage_id: `dirtriage_${hashStable(base).slice(0, 32)}` };
}

function validateDirectiveForAdmission(
  directive: Directive,
  options: { readonly authorityLocus?: string; readonly residentAgentId?: string; readonly residentRole?: string } = {},
): { readonly valid: boolean; readonly errors: string[]; readonly warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!directive.source.kind || !directive.source.id) errors.push("missing_source_identity");
  if (!directive.authority.locus) errors.push("missing_authority_locus");
  if (!directive.authority.basis) errors.push("missing_authority_basis");
  if (options.authorityLocus && directive.authority.locus !== options.authorityLocus) errors.push(`authority_locus_mismatch:${directive.authority.locus}`);
  if (!directive.target.kind || !directive.target.id) errors.push("missing_target");
  if (!directive.content.kind) errors.push("missing_content_kind");
  if (directive.kind === "attention" && directive.source.kind === "system") {
    const hasWorkRef = (directive.content.refs ?? []).some((ref) => ref.kind === "task" || ref.kind === "work");
    if (!hasWorkRef) errors.push("system_attention_directive_requires_task_or_work_ref");
    const targetsResident =
      (options.residentAgentId && directive.target.kind === "agent" && directive.target.id === options.residentAgentId)
      || (options.residentRole && directive.target.kind === "role" && directive.target.id === options.residentRole);
    if (!targetsResident && (options.residentAgentId || options.residentRole)) warnings.push("system_attention_directive_not_targeted_to_configured_resident");
  }
  return { valid: errors.length === 0, errors, warnings };
}

function inferDirectiveKind(contentKind: DirectiveContentKind): DirectiveKind {
  if (contentKind === "constraint" || contentKind === "policy_ref") return "constraint";
  if (contentKind === "routing" || contentKind === "delivery") return "handoff";
  if (contentKind === "task_ref" || contentKind === "work_ref" || contentKind === "source_ref") return "attention";
  return "instruction";
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
