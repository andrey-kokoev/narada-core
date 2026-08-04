import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  inspectPreparedTaskLifecycleStore,
  openLegacyTaskLifecycleStoreForMigration,
  openPreparedTaskLifecycleStore,
  prepareTaskLifecycleStore,
  resolveTaskLifecycleDatabasePath,
  type SqliteTaskLifecycleStore,
} from '@narada-core/task-governance-core/task-lifecycle-store';
import type {
  AdmitTicketProposalInput,
  AdmitTicketProposalResult,
  AdmitTicketSourceInput,
  AdmitTicketSourceResult,
  LoadTicketProcessingContextInput,
  RecordDraftReceiptInput,
  ReconcileDraftDispositionInput,
  TicketCorrelationKey,
  TicketRow,
  TicketSourceRow,
  TicketStatus,
  TicketProcessingContextResult,
  WorkLifecycleOpenOptions,
  WorkLifecycleMigrationOptions,
  WorkLifecycleMigrationReport,
  WorkLifecycleMigrationTableReport,
  WorkLifecyclePreparationInspection,
  WorkOutboxEvent,
} from './types.js';
import {
  WORK_LIFECYCLE_DATABASE_PATH,
  WORK_LIFECYCLE_SCHEMA_VERSION,
} from './types.js';

type Db = SqliteTaskLifecycleStore['db'];
type SqlRow = Record<string, unknown>;

const MAX_SUMMARY_BYTES = 2_048;
const MAX_REF_JSON_BYTES = 16_384;
const MAX_EVENT_JSON_BYTES = 16_384;
const MAX_OPERATION_RESULT_BYTES = 32_768;
const MAX_DRAFT_BODY_BYTES = 12 * 1024;
const TERMINAL_TASK_STATUSES = new Set(['closed', 'confirmed']);
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'body',
  'body_html',
  'body_text',
  'content',
  'email_body',
  'html',
  'raw',
  'raw_message',
  'transcript',
]);

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`work_lifecycle_migration_identifier_invalid:${value}`);
  }
  return `"${value}"`;
}

function rowCount(db: Db, table: string): number {
  const row = db.prepare(`select count(*) as count from ${quoteIdentifier(table)}`)
    .get() as SqlRow;
  return Number(row.count ?? 0);
}

function sqliteIntegrity(db: Db): string {
  const rows = db.prepare('pragma integrity_check').all() as SqlRow[];
  const results = rows.map((row) => String(Object.values(row)[0] ?? 'missing'));
  return results.length === 1 && results[0] === 'ok'
    ? 'ok'
    : results.join(';');
}

function sqliteCopiedTablesIntegrity(db: Db, tables: string[]): string {
  for (const table of tables) {
    const rows = db.prepare(
      `pragma integrity_check(${quoteIdentifier(table)})`,
    ).all() as SqlRow[];
    const results = rows.map((row) => String(Object.values(row)[0] ?? 'missing'));
    if (results.length !== 1 || results[0] !== 'ok') {
      return `${table}:${results.join(';') || 'missing'}`;
    }
  }
  return 'ok';
}

function tableColumns(db: Db, table: string): Array<{
  name: string;
  notnull: boolean;
  defaultValue: unknown;
  primaryKey: boolean;
}> {
  return (db.prepare(`pragma table_info(${quoteIdentifier(table)})`).all() as SqlRow[])
    .map((column) => ({
      name: String(column.name),
      notnull: Number(column.notnull) === 1,
      defaultValue: column.dflt_value,
      primaryKey: Number(column.pk) > 0,
    }));
}

const LEGACY_SITE_LOOP_TABLES = new Set([
  'directive_outcome_latest',
  'directive_outcomes',
]);

function isLegacySiteLoopTable(table: string): boolean {
  return table.startsWith('site_loop_') || LEGACY_SITE_LOOP_TABLES.has(table);
}

function ensureTaskAggregateRevisionTriggers(db: Db): void {
  const tables = db.prepare(
    "select name from sqlite_master where type = 'table'",
  ).all() as SqlRow[];
  for (const row of tables) {
    const table = String(row.name ?? '');
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(table)) continue;
    if (
      table === 'task_lifecycle'
      || table.startsWith('sqlite_')
      || table.startsWith('ticket_')
      || table.startsWith('work_')
    ) continue;
    const columns = db.prepare(`pragma table_info(${table})`).all() as SqlRow[];
    if (!columns.some((column) => String(column.name) === 'task_id')) continue;
    for (const [operation, reference] of [
      ['insert', 'new'],
      ['update', 'new'],
      ['delete', 'old'],
    ] as const) {
      const trigger = `work_task_revision_${table}_${operation}`;
      db.exec(`
        drop trigger if exists ${trigger};
        create trigger ${trigger}
        after ${operation} on ${table}
        when ${reference}.task_id is not null
        begin
          update task_lifecycle
             set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           where task_id = ${reference}.task_id;
        end;
      `);
    }
  }
}

function assertNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}_required`);
  return normalized;
}

function assertBounded(value: string, field: string, maxBytes: number): string {
  if (byteLength(value) > maxBytes) throw new Error(`${field}_too_large`);
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function stableId(prefix: string, value: unknown, length = 32): string {
  return `${prefix}_${digest(value).slice(0, length)}`;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function assertReferencePayload(value: Record<string, unknown>, field: string): string {
  const inspect = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => inspect(entry, `${path}[${index}]`));
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
        throw new Error(`${field}_contains_unbounded_payload:${path}.${key}`);
      }
      inspect(nested, `${path}.${key}`);
    }
  };
  inspect(value, field);
  return assertBounded(canonicalJson(value), field, MAX_REF_JSON_BYTES);
}

function normalizeDraftDispositionEvidence(
  input: ReconcileDraftDispositionInput['evidence'],
): ReconcileDraftDispositionInput['evidence'] & { evidence_json: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('ticket_draft_disposition_evidence_required');
  }
  if (input.schema !== 'narada.graph_mail.ticket_draft_disposition_receipt.v1') {
    throw new Error('ticket_draft_disposition_evidence_schema_invalid');
  }
  const sentEvidence = input.evidence_kind === 'synchronized_graph_observation'
    && input.disposition === 'sent'
    && input.is_draft === false;
  const confirmedDiscardEvidence = input.evidence_kind === 'operator_confirmed_graph_discard'
    && input.disposition === 'discarded'
    && input.is_draft === true
    && input.graph_delete_confirmed === true
    && input.graph_absence_confirmed === false;
  const recoveredDiscardEvidence = input.evidence_kind === 'operator_authorized_graph_absence_after_verified_discard'
    && input.disposition === 'discarded'
    && input.is_draft === true
    && input.graph_delete_confirmed === false
    && input.graph_absence_confirmed === true;
  if (!sentEvidence && !confirmedDiscardEvidence && !recoveredDiscardEvidence) {
    throw new Error('ticket_draft_disposition_evidence_state_invalid');
  }
  const normalized = {
    ...input,
    observation_id: assertNonEmpty(input.observation_id, 'draft_disposition_observation_id'),
    evidence_id: assertNonEmpty(input.evidence_id, 'draft_disposition_evidence_id'),
    ticket_id: assertNonEmpty(input.ticket_id, 'draft_disposition_evidence_ticket_id'),
    effect_claim_id: assertNonEmpty(input.effect_claim_id, 'draft_disposition_effect_claim_id'),
    draft_operation_key: assertNonEmpty(input.draft_operation_key, 'draft_disposition_operation_key'),
    mailbox_id: assertNonEmpty(input.mailbox_id, 'draft_disposition_mailbox_id'),
    draft_id: assertNonEmpty(input.draft_id, 'draft_disposition_evidence_draft_id'),
    observed_message_id: assertNonEmpty(input.observed_message_id, 'draft_disposition_message_id'),
    observed_at: assertNonEmpty(input.observed_at, 'draft_disposition_observed_at'),
    receipt_sha256: assertNonEmpty(input.receipt_sha256, 'draft_disposition_receipt_sha256'),
  };
  if (normalized.observation_id !== normalized.evidence_id) {
    throw new Error('ticket_draft_disposition_evidence_identity_mismatch');
  }
  if (!/^[a-f0-9]{64}$/.test(normalized.receipt_sha256)) {
    throw new Error('ticket_draft_disposition_receipt_sha256_invalid');
  }
  const { receipt_sha256: _receiptSha256, ...unsignedReceipt } = normalized;
  if (digest(unsignedReceipt) !== normalized.receipt_sha256) {
    throw new Error('ticket_draft_disposition_receipt_digest_mismatch');
  }
  return {
    ...normalized,
    evidence_json: assertReferencePayload(normalized, 'draft_disposition_evidence'),
  };
}

function ticketFromRow(row: SqlRow): TicketRow {
  return {
    ticket_id: String(row.ticket_id),
    ticket_number: Number(row.ticket_number),
    status: String(row.status) as TicketStatus,
    revision: Number(row.revision),
    summary: String(row.summary),
    resolution_code: row.resolution_code === null ? null : String(row.resolution_code),
    blocker_code: row.blocker_code === null ? null : String(row.blocker_code),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    terminal_at: row.terminal_at === null ? null : String(row.terminal_at),
  };
}

function sourceFromRow(row: SqlRow): TicketSourceRow {
  return {
    source_id: String(row.source_id),
    ticket_id: String(row.ticket_id),
    source_kind: String(row.source_kind),
    source_scope: String(row.source_scope),
    immutable_source_id: String(row.immutable_source_id),
    source_ref: parseJsonObject(row.source_ref_json),
    policy_version: String(row.policy_version),
    receipt_id: String(row.receipt_id),
    admitted_at: String(row.admitted_at),
  };
}

function ensureTaskRevisionColumn(db: Db): void {
  const columns = db.prepare('pragma table_info(task_lifecycle)').all() as SqlRow[];
  if (!columns.some((column) => String(column.name) === 'revision')) {
    db.exec('alter table task_lifecycle add column revision integer not null default 1;');
  }
}

function initializeWorkSchema(db: Db): void {
  db.pragma('foreign_keys = on');
  db.pragma('recursive_triggers = off');
  ensureTaskRevisionColumn(db);
  db.exec(`
    begin immediate;

    create table if not exists work_lifecycle_meta (
      singleton integer primary key check (singleton = 1),
      schema_version integer not null,
      prepared_at text not null
    );

    create table if not exists work_sequences (
      sequence_name text primary key,
      next_value integer not null check (next_value > 0)
    );

    create table if not exists tickets (
      ticket_id text primary key,
      ticket_number integer not null unique,
      status text not null check (
        status in ('actionable', 'effect_claimed', 'waiting_on_draft',
                   'waiting_on_task', 'blocked', 'resolved')
      ),
      revision integer not null check (revision > 0),
      summary text not null check (length(cast(summary as blob)) <= ${MAX_SUMMARY_BYTES}),
      resolution_code text,
      blocker_code text,
      created_at text not null,
      updated_at text not null,
      terminal_at text
    );

    create index if not exists idx_tickets_status_updated
      on tickets(status, updated_at);

    create table if not exists ticket_sources (
      source_id text primary key,
      ticket_id text not null references tickets(ticket_id),
      source_kind text not null,
      source_scope text not null,
      immutable_source_id text not null,
      source_ref_json text not null
        check (length(cast(source_ref_json as blob)) <= ${MAX_REF_JSON_BYTES}),
      policy_version text not null,
      receipt_id text not null unique,
      admitted_at text not null,
      unique(source_kind, source_scope, immutable_source_id)
    );

    create index if not exists idx_ticket_sources_ticket
      on ticket_sources(ticket_id, admitted_at);

    create table if not exists ticket_correlation_keys (
      kind text not null,
      scope text not null,
      value text not null,
      ticket_id text not null references tickets(ticket_id),
      policy_version text not null,
      admitted_at text not null,
      primary key(kind, scope, value)
    );

    create index if not exists idx_ticket_correlation_ticket
      on ticket_correlation_keys(ticket_id);

    create table if not exists ticket_task_links (
      ticket_id text not null references tickets(ticket_id),
      task_id text not null references task_lifecycle(task_id),
      link_kind text not null,
      operation_key text not null,
      status text not null check (status in ('active', 'terminal', 'superseded')),
      linked_at text not null,
      terminal_at text,
      primary key(ticket_id, task_id),
      unique(operation_key)
    );

    create index if not exists idx_ticket_task_links_task
      on ticket_task_links(task_id, status);

    create table if not exists ticket_effect_claims (
      claim_id text primary key,
      ticket_id text not null references tickets(ticket_id),
      ticket_revision integer not null,
      effect_kind text not null,
      operation_key text not null unique,
      request_digest text not null,
      status text not null check (status in ('claimed', 'completed', 'superseded')),
      receipt_id text,
      receipt_json text
        check (receipt_json is null or length(cast(receipt_json as blob)) <= ${MAX_REF_JSON_BYTES}),
      claimed_at text not null,
      completed_at text
    );

    create table if not exists ticket_draft_refs (
      ticket_id text not null references tickets(ticket_id),
      draft_id text not null,
      effect_claim_id text not null references ticket_effect_claims(claim_id),
      draft_ref_json text not null
        check (length(cast(draft_ref_json as blob)) <= ${MAX_REF_JSON_BYTES}),
      receipt_id text not null,
      disposition text,
      disposition_evidence_kind text,
      disposition_evidence_id text,
      disposition_evidence_json text
        check (disposition_evidence_json is null or length(cast(disposition_evidence_json as blob)) <= ${MAX_REF_JSON_BYTES}),
      created_at text not null,
      disposed_at text,
      primary key(ticket_id, draft_id)
    );

    create table if not exists work_lifecycle_events (
      event_id text primary key,
      aggregate_kind text not null check (aggregate_kind in ('ticket', 'task')),
      aggregate_id text not null,
      aggregate_revision integer not null,
      event_type text not null,
      schema_version integer not null,
      causation_id text not null,
      idempotency_key text not null unique,
      payload_json text not null
        check (length(cast(payload_json as blob)) <= ${MAX_EVENT_JSON_BYTES}),
      created_at text not null
    );

    create index if not exists idx_work_events_aggregate
      on work_lifecycle_events(aggregate_kind, aggregate_id, aggregate_revision);

    create table if not exists work_outbox (
      event_id text primary key references work_lifecycle_events(event_id),
      topic text not null,
      partition_key text not null,
      aggregate_kind text not null check (aggregate_kind in ('ticket', 'task')),
      aggregate_id text not null,
      aggregate_revision integer not null,
      schema_version integer not null,
      causation_id text not null,
      idempotency_key text not null unique,
      payload_json text not null
        check (length(cast(payload_json as blob)) <= ${MAX_EVENT_JSON_BYTES}),
      created_at text not null,
      available_at text not null,
      compacted_at text
    );

    create index if not exists idx_work_outbox_delivery
      on work_outbox(topic, available_at, created_at);

    create table if not exists work_outbox_consumer_requirements (
      topic text not null,
      consumer_id text not null,
      registered_at text not null,
      primary key(topic, consumer_id)
    );

    create table if not exists work_outbox_receipts (
      event_id text not null references work_outbox(event_id),
      consumer_id text not null,
      processed_at text not null,
      receipt_json text not null
        check (length(cast(receipt_json as blob)) <= ${MAX_REF_JSON_BYTES}),
      primary key(event_id, consumer_id)
    );

    create table if not exists work_operations (
      operation_key text primary key,
      operation_kind text not null,
      request_digest text not null,
      aggregate_kind text,
      aggregate_id text,
      aggregate_revision integer,
      result_json text not null
        check (length(cast(result_json as blob)) <= ${MAX_OPERATION_RESULT_BYTES}),
      created_at text not null
    );

    create index if not exists idx_work_operations_aggregate
      on work_operations(aggregate_kind, aggregate_id, created_at);

    insert into work_sequences(sequence_name, next_value)
      values ('ticket', 1)
      on conflict(sequence_name) do nothing;

    insert into work_lifecycle_meta(singleton, schema_version, prepared_at)
      values (1, ${WORK_LIFECYCLE_SCHEMA_VERSION}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      on conflict(singleton) do update set
        schema_version = excluded.schema_version,
        prepared_at = excluded.prepared_at;

    drop trigger if exists work_task_insert_event;
    create trigger work_task_insert_event
    after insert on task_lifecycle
    begin
      insert or ignore into work_lifecycle_events(
        event_id, aggregate_kind, aggregate_id, aggregate_revision, event_type,
        schema_version, causation_id, idempotency_key, payload_json, created_at
      ) values (
        'evt:task:' || new.task_id || ':revision:' || new.revision,
        'task', new.task_id, new.revision, 'task.created', 1,
        'task-create:' || new.task_id,
        'task:' || new.task_id || ':revision:' || new.revision,
        json_object('task_id', new.task_id, 'task_number', new.task_number,
                    'status', new.status, 'revision', new.revision),
        new.updated_at
      );
      insert or ignore into work_outbox(
        event_id, topic, partition_key, aggregate_kind, aggregate_id,
        aggregate_revision, schema_version, causation_id, idempotency_key,
        payload_json, created_at, available_at, compacted_at
      ) select event_id, 'work.task-lifecycle.v1', new.task_id, aggregate_kind,
               aggregate_id, aggregate_revision, schema_version, causation_id,
               idempotency_key, payload_json, created_at, created_at, null
        from work_lifecycle_events
       where event_id = 'evt:task:' || new.task_id || ':revision:' || new.revision;
    end;

    drop trigger if exists work_task_revision_event;
    create trigger work_task_revision_event
    after update on task_lifecycle
    when new.revision = old.revision
    begin
      update task_lifecycle
         set revision = old.revision + 1
       where task_id = new.task_id;
      insert or ignore into work_lifecycle_events(
        event_id, aggregate_kind, aggregate_id, aggregate_revision, event_type,
        schema_version, causation_id, idempotency_key, payload_json, created_at
      ) values (
        'evt:task:' || new.task_id || ':revision:' || (old.revision + 1),
        'task', new.task_id, old.revision + 1, 'task.lifecycle.changed', 1,
        'task-transition:' || new.task_id || ':' || (old.revision + 1),
        'task:' || new.task_id || ':revision:' || (old.revision + 1),
        json_object('task_id', new.task_id, 'task_number', new.task_number,
                    'status', new.status, 'previous_status', old.status,
                    'revision', old.revision + 1),
        new.updated_at
      );
      insert or ignore into work_outbox(
        event_id, topic, partition_key, aggregate_kind, aggregate_id,
        aggregate_revision, schema_version, causation_id, idempotency_key,
        payload_json, created_at, available_at, compacted_at
      ) select event_id, 'work.task-lifecycle.v1', new.task_id, aggregate_kind,
               aggregate_id, aggregate_revision, schema_version, causation_id,
               idempotency_key, payload_json, created_at, created_at, null
        from work_lifecycle_events
       where event_id = 'evt:task:' || new.task_id || ':revision:' || (old.revision + 1);
    end;

    drop trigger if exists work_task_terminal_reactivate_tickets;
    create trigger work_task_terminal_reactivate_tickets
    after update of status on task_lifecycle
    when new.status in ('closed', 'confirmed')
     and old.status not in ('closed', 'confirmed')
    begin
      update tickets
         set status = 'actionable',
             revision = revision + 1,
             blocker_code = null,
             terminal_at = null,
             updated_at = new.updated_at
       where ticket_id in (
         select ticket_id from ticket_task_links
          where task_id = new.task_id and status = 'active'
       );

      insert or ignore into work_lifecycle_events(
        event_id, aggregate_kind, aggregate_id, aggregate_revision, event_type,
        schema_version, causation_id, idempotency_key, payload_json, created_at
      )
      select
        'evt:ticket:' || link.ticket_id || ':task:' || new.task_id ||
          ':terminal:' || (old.revision + 1),
        'ticket', link.ticket_id, ticket.revision, 'ticket.task.terminal', 1,
        'task:' || new.task_id || ':revision:' || (old.revision + 1),
        'ticket:' || link.ticket_id || ':task:' || new.task_id ||
          ':terminal:' || (old.revision + 1),
        json_object('ticket_id', link.ticket_id, 'ticket_revision', ticket.revision,
                    'task_id', new.task_id, 'task_number', new.task_number,
                    'task_status', new.status, 'task_revision', old.revision + 1),
        new.updated_at
      from ticket_task_links link
      join tickets ticket on ticket.ticket_id = link.ticket_id
      where link.task_id = new.task_id and link.status = 'active';

      insert or ignore into work_outbox(
        event_id, topic, partition_key, aggregate_kind, aggregate_id,
        aggregate_revision, schema_version, causation_id, idempotency_key,
        payload_json, created_at, available_at, compacted_at
      )
      select event.event_id, 'work.ticket-work-due.v1', event.aggregate_id,
             event.aggregate_kind, event.aggregate_id, event.aggregate_revision,
             event.schema_version, event.causation_id, event.idempotency_key,
             event.payload_json, event.created_at, event.created_at, null
        from work_lifecycle_events event
       where event.event_id in (
         select 'evt:ticket:' || link.ticket_id || ':task:' || new.task_id ||
                ':terminal:' || (old.revision + 1)
           from ticket_task_links link
          where link.task_id = new.task_id and link.status = 'active'
       );

      update ticket_task_links
         set status = 'terminal', terminal_at = new.updated_at
       where task_id = new.task_id and status = 'active';
    end;

    commit;
  `);
  ensureTaskAggregateRevisionTriggers(db);
}

function hasWorkSchema(db: Db): boolean {
  const meta = db.prepare(
    'select schema_version from work_lifecycle_meta where singleton = 1',
  ).get() as SqlRow | undefined;
  if (Number(meta?.schema_version) !== WORK_LIFECYCLE_SCHEMA_VERSION) return false;
  const taskColumns = db.prepare('pragma table_info(task_lifecycle)').all() as SqlRow[];
  const draftColumns = db.prepare('pragma table_info(ticket_draft_refs)').all() as SqlRow[];
  return taskColumns.some((column) => String(column.name) === 'revision')
    && draftColumns.some((column) => String(column.name) === 'disposition_evidence_json');
}

export function resolveWorkLifecycleDatabasePath(
  siteRoot: string,
  databasePath: string = WORK_LIFECYCLE_DATABASE_PATH,
): string {
  return resolveTaskLifecycleDatabasePath(siteRoot, databasePath);
}

export function prepareWorkLifecycleStore(
  siteRoot: string,
  options: Pick<WorkLifecycleOpenOptions, 'databasePath'> = {},
): WorkLifecyclePreparationInspection {
  const databasePath = resolveWorkLifecycleDatabasePath(siteRoot, options.databasePath);
  const taskStore = prepareTaskLifecycleStore(siteRoot, { databasePath });
  try {
    initializeWorkSchema(taskStore.db);
  } finally {
    taskStore.db.close();
  }
  return inspectPreparedWorkLifecycleStore(siteRoot, { databasePath });
}

export function inspectPreparedWorkLifecycleStore(
  siteRoot: string,
  options: Pick<WorkLifecycleOpenOptions, 'databasePath'> = {},
): WorkLifecyclePreparationInspection {
  const databasePath = resolveWorkLifecycleDatabasePath(siteRoot, options.databasePath);
  if (!existsSync(databasePath)) {
    return {
      status: 'missing',
      db_path: databasePath,
      work_schema_version: null,
      task_schema_version: null,
      reason: 'database_missing',
    };
  }
  const taskInspection = inspectPreparedTaskLifecycleStore(siteRoot, { databasePath });
  if (taskInspection.status !== 'prepared') {
    return {
      status: taskInspection.status,
      db_path: databasePath,
      work_schema_version: null,
      task_schema_version: taskInspection.schema_version,
      reason: taskInspection.reason,
    };
  }
  let taskStore: SqliteTaskLifecycleStore | null = null;
  try {
    taskStore = openPreparedTaskLifecycleStore(siteRoot, { databasePath });
    const row = taskStore.db.prepare(
      'select schema_version from work_lifecycle_meta where singleton = 1',
    ).get() as SqlRow | undefined;
    const version = row ? Number(row.schema_version) : null;
    return {
      status: version === WORK_LIFECYCLE_SCHEMA_VERSION && hasWorkSchema(taskStore.db)
        ? 'prepared'
        : 'stale',
      db_path: databasePath,
      work_schema_version: version,
      task_schema_version: taskInspection.schema_version,
      ...(version === WORK_LIFECYCLE_SCHEMA_VERSION
        ? {}
        : { reason: `work_schema_version_${version ?? 'missing'}` }),
    };
  } catch (error) {
    return {
      status: 'invalid',
      db_path: databasePath,
      work_schema_version: null,
      task_schema_version: taskInspection.schema_version,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    taskStore?.db.close();
  }
}

export function openPreparedWorkLifecycleStore(
  siteRoot: string,
  options: WorkLifecycleOpenOptions = {},
): WorkLifecycleStore {
  const databasePath = resolveWorkLifecycleDatabasePath(siteRoot, options.databasePath);
  const inspection = inspectPreparedWorkLifecycleStore(siteRoot, { databasePath });
  if (inspection.status !== 'prepared') {
    throw new Error(`work_lifecycle_store_not_prepared:${inspection.reason ?? inspection.status}`);
  }
  const taskStore = openPreparedTaskLifecycleStore(siteRoot, { databasePath });
  taskStore.db.pragma('foreign_keys = on');
  taskStore.db.pragma('recursive_triggers = off');
  return new WorkLifecycleStore(taskStore, { ...options, databasePath });
}

export function migrateLegacyTaskLifecycleToWorkLifecycle(
  siteRoot: string,
  options: WorkLifecycleMigrationOptions = {},
): WorkLifecycleMigrationReport {
  const sourceDatabasePath = resolveTaskLifecycleDatabasePath(
    siteRoot,
    options.sourceDatabasePath ?? '.ai/task-lifecycle.db',
  );
  const targetDatabasePath = resolveWorkLifecycleDatabasePath(
    siteRoot,
    options.targetDatabasePath,
  );
  if (sourceDatabasePath === targetDatabasePath) {
    throw new Error('work_lifecycle_migration_source_equals_target');
  }
  if (!existsSync(sourceDatabasePath)) {
    throw new Error('work_lifecycle_migration_source_missing');
  }
  if (existsSync(targetDatabasePath)) {
    throw new Error('work_lifecycle_migration_target_exists');
  }
  const sourceInspection = inspectPreparedTaskLifecycleStore(siteRoot, {
    databasePath: sourceDatabasePath,
  });
  const sourceIsUnversionedCurrentSchema = sourceInspection.status === 'stale'
    && sourceInspection.schema_version === 0
    && sourceInspection.reason === 'task_lifecycle_store_not_prepared:schema_version_0';
  if (sourceInspection.status !== 'prepared' && !sourceIsUnversionedCurrentSchema) {
    throw new Error(`work_lifecycle_migration_source_not_prepared:${sourceInspection.reason ?? sourceInspection.status}`);
  }

  const sourceStore = openLegacyTaskLifecycleStoreForMigration(siteRoot, {
    databasePath: sourceDatabasePath,
  });
  const targetStore = prepareTaskLifecycleStore(siteRoot, {
    databasePath: targetDatabasePath,
  });
  const copiedTables: WorkLifecycleMigrationTableReport[] = [];
  const excludedLegacyTables: Array<{
    table: string;
    disposition: 'discarded_without_scan';
  }> = [];
  let sourceIntegrityTables: string[] = [];
  let sourceIntegrity = 'unknown';
  let sourceFenceOpen = false;
  try {
    sourceStore.db.exec('begin exclusive;');
    sourceFenceOpen = true;
    const sourceTableRows = sourceStore.db.prepare(`
      select name, sql from sqlite_master
       where type = 'table' and name not like 'sqlite_%'
       order by name
    `).all() as SqlRow[];
    const copiedSourceTableRows: SqlRow[] = [];
    for (const row of sourceTableRows) {
      const table = String(row.name);
      if (isLegacySiteLoopTable(table)) {
        excludedLegacyTables.push({
          table,
          disposition: 'discarded_without_scan',
        });
        continue;
      }
      if (table === 'tickets' || table.startsWith('ticket_') || table.startsWith('work_')) {
        throw new Error(`work_lifecycle_migration_source_already_contains_work_schema:${table}`);
      }
      copiedSourceTableRows.push(row);
    }
    sourceIntegrityTables = copiedSourceTableRows.map((row) => String(row.name));
    sourceIntegrity = sqliteCopiedTablesIntegrity(sourceStore.db, sourceIntegrityTables);
    if (sourceIntegrity !== 'ok') {
      throw new Error(`work_lifecycle_migration_source_integrity:${sourceIntegrity}`);
    }

    targetStore.db.pragma('foreign_keys = off');
    targetStore.db.transaction(() => {
      const targetTableNames = new Set(
        (targetStore.db.prepare(`
          select name from sqlite_master
           where type = 'table' and name not like 'sqlite_%'
        `).all() as SqlRow[]).map((row) => String(row.name)),
      );
      const extensionTables = new Set<string>();

      for (const row of copiedSourceTableRows) {
        const table = String(row.name);
        if (!targetTableNames.has(table)) {
          const sql = typeof row.sql === 'string' ? row.sql.trim() : '';
          if (!sql) throw new Error(`work_lifecycle_migration_extension_schema_missing:${table}`);
          targetStore.db.exec(sql);
          targetTableNames.add(table);
          extensionTables.add(table);
        }
      }

      for (const row of copiedSourceTableRows) {
        const table = String(row.name);
        const sourceColumns = tableColumns(sourceStore.db, table);
        const targetColumns = tableColumns(targetStore.db, table);
        const sourceColumnNames = new Set(sourceColumns.map((column) => column.name));
        const missingRequired = targetColumns.filter((column) => (
          column.notnull
          && !column.primaryKey
          && column.defaultValue === null
          && !sourceColumnNames.has(column.name)
        ));
        if (missingRequired.length > 0) {
          throw new Error(
            `work_lifecycle_migration_required_columns_missing:${table}:${missingRequired.map((column) => column.name).join(',')}`,
          );
        }
        const targetColumnNames = new Set(targetColumns.map((column) => column.name));
        const copiedColumns = sourceColumns
          .map((column) => column.name)
          .filter((column) => targetColumnNames.has(column));
        if (copiedColumns.length === 0) {
          throw new Error(`work_lifecycle_migration_no_common_columns:${table}`);
        }
        const columnSql = copiedColumns.map(quoteIdentifier).join(', ');
        const placeholders = copiedColumns.map(() => '?').join(', ');
        targetStore.db.exec(`delete from ${quoteIdentifier(table)};`);
        const insert = targetStore.db.prepare(
          `insert into ${quoteIdentifier(table)} (${columnSql}) values (${placeholders})`,
        );
        const rows = sourceStore.db.prepare(
          `select ${columnSql} from ${quoteIdentifier(table)}`,
        ).iterate() as Iterable<SqlRow>;
        let sourceRows = 0;
        for (const sourceRow of rows) {
          insert.run(...copiedColumns.map((column) => sourceRow[column]));
          sourceRows += 1;
        }
        const targetRows = rowCount(targetStore.db, table);
        if (sourceRows !== targetRows) {
          throw new Error(`work_lifecycle_migration_row_count_mismatch:${table}:${sourceRows}:${targetRows}`);
        }
        copiedTables.push({
          table,
          source_rows: sourceRows,
          target_rows: targetRows,
          copied_columns: copiedColumns,
          schema_source: extensionTables.has(table) ? 'legacy_extension' : 'target',
        });
      }

      if (extensionTables.size > 0) {
        const schemaObjects = sourceStore.db.prepare(`
          select type, name, tbl_name, sql from sqlite_master
           where type in ('index', 'trigger') and sql is not null
           order by type, name
        `).all() as SqlRow[];
        for (const object of schemaObjects) {
          const table = String(object.tbl_name);
          if (!extensionTables.has(table)) continue;
          const name = String(object.name);
          const exists = targetStore.db.prepare(
            'select 1 from sqlite_master where name = ?',
          ).get(name);
          if (!exists) targetStore.db.exec(String(object.sql));
        }
      }
    })();
    targetStore.db.pragma('foreign_keys = on');
    sourceStore.db.exec('commit;');
    sourceFenceOpen = false;
  } catch (error) {
    if (sourceFenceOpen) {
      try { sourceStore.db.exec('rollback;'); } catch { /* preserve migration error */ }
    }
    throw error;
  } finally {
    targetStore.db.close();
    sourceStore.db.close();
  }

  const preparation = prepareWorkLifecycleStore(siteRoot, {
    databasePath: targetDatabasePath,
  });
  if (preparation.status !== 'prepared') {
    throw new Error(`work_lifecycle_migration_target_not_prepared:${preparation.reason ?? preparation.status}`);
  }

  const workStore = openPreparedWorkLifecycleStore(siteRoot, {
    databasePath: targetDatabasePath,
    now: options.now,
  });
  let taskEventsSeeded = 0;
  const ticketMappings: WorkLifecycleMigrationReport['ticket_mappings'] = [];
  let targetIntegrity = 'unknown';
  let foreignKeyViolations = -1;
  try {
    taskEventsSeeded = workStore.db.transaction(() => {
      const inserted = workStore.db.prepare(`
        insert or ignore into work_lifecycle_events(
          event_id, aggregate_kind, aggregate_id, aggregate_revision, event_type,
          schema_version, causation_id, idempotency_key, payload_json, created_at
        )
        select 'evt:task:' || task_id || ':migration:' || revision,
               'task', task_id, revision, 'task.migrated', 1,
               'hard-cutover:' || task_id,
               'task:' || task_id || ':migration:' || revision,
               json_object('task_id', task_id, 'task_number', task_number,
                           'status', status, 'revision', revision),
               updated_at
          from task_lifecycle
      `).run().changes;
      workStore.db.prepare(`
        insert or ignore into work_outbox(
          event_id, topic, partition_key, aggregate_kind, aggregate_id,
          aggregate_revision, schema_version, causation_id, idempotency_key,
          payload_json, created_at, available_at, compacted_at
        )
        select event_id, 'work.task-lifecycle.v1', aggregate_id, aggregate_kind,
               aggregate_id, aggregate_revision, schema_version, causation_id,
               idempotency_key, payload_json, created_at, created_at, null
          from work_lifecycle_events where event_type = 'task.migrated'
      `).run();
      return inserted;
    })();

    for (const seed of [...(options.ticketSeeds ?? [])]
      .sort((left, right) => left.legacy_ticket_id.localeCompare(right.legacy_ticket_id))) {
      const admitted = workStore.admitSource(seed.source);
      if (!admitted.ticket_id || !admitted.ticket_number || !admitted.source_id) {
        throw new Error(`work_lifecycle_migration_ticket_admission_blocked:${seed.legacy_ticket_id}`);
      }
      if (seed.target_status === 'blocked') {
        workStore.admitProposal({
          ticket_id: admitted.ticket_id,
          expected_revision: admitted.ticket_revision!,
          route: 'blocked_operator',
          idempotency_key: `hard-cutover:${seed.legacy_ticket_id}:blocked`,
          causation_id: `hard-cutover:${seed.legacy_ticket_id}`,
          actor_id: 'hard-cutover',
          summary: seed.blocker_summary ?? seed.source.summary,
          blocker_code: seed.blocker_code ?? 'legacy_operator_disposition_required',
        });
        if (admitted.event_id) {
          workStore.db.prepare(
            "update work_outbox set topic = 'work.ticket-lifecycle.v1' where event_id = ?",
          ).run(admitted.event_id);
        }
      }
      ticketMappings.push({
        legacy_ticket_id: seed.legacy_ticket_id,
        ticket_id: admitted.ticket_id,
        ticket_number: admitted.ticket_number,
        status: seed.target_status,
        source_id: admitted.source_id,
      });
    }

    const violations = workStore.db.prepare('pragma foreign_key_check').all() as SqlRow[];
    foreignKeyViolations = violations.length;
    if (foreignKeyViolations !== 0) {
      throw new Error(`work_lifecycle_migration_foreign_key_violations:${foreignKeyViolations}`);
    }
    targetIntegrity = sqliteIntegrity(workStore.db);
    if (targetIntegrity !== 'ok') {
      throw new Error(`work_lifecycle_migration_target_integrity:${targetIntegrity}`);
    }
  } finally {
    workStore.close({ checkpointWal: true });
  }
  if (existsSync(`${targetDatabasePath}-wal`) || existsSync(`${targetDatabasePath}-shm`)) {
    throw new Error('work_lifecycle_migration_target_not_self_contained');
  }

  const taskRows = copiedTables.find((table) => table.table === 'task_lifecycle')?.target_rows ?? 0;
  return {
    schema: 'narada.work_lifecycle.hard_cutover_migration.v1',
    status: 'migrated',
    source_database_path: sourceDatabasePath,
    target_database_path: targetDatabasePath,
    source_fence: 'exclusive_transaction',
    source_integrity: sourceIntegrity,
    source_integrity_scope: 'copied_tables_only',
    source_integrity_tables: sourceIntegrityTables,
    target_integrity: targetIntegrity,
    foreign_key_violations: foreignKeyViolations,
    task_rows: taskRows,
    task_events_seeded: taskEventsSeeded,
    copied_tables: copiedTables,
    excluded_legacy_tables: excludedLegacyTables,
    ticket_mappings: ticketMappings,
  };
}

export class WorkLifecycleStore {
  readonly taskStore: SqliteTaskLifecycleStore;
  readonly databasePath: string;
  readonly #now: () => Date;
  #closed = false;

  constructor(taskStore: SqliteTaskLifecycleStore, options: Required<Pick<
    WorkLifecycleOpenOptions,
    'databasePath'
  >> & WorkLifecycleOpenOptions) {
    this.taskStore = taskStore;
    this.databasePath = options.databasePath;
    this.#now = options.now ?? (() => new Date());
  }

  get db(): Db {
    return this.taskStore.db;
  }

  close(options: { checkpointWal?: boolean } = {}): void {
    if (this.#closed) return;
    try {
      if (options.checkpointWal === true) {
        this.db.exec('pragma wal_checkpoint(TRUNCATE);');
      }
    } finally {
      this.#closed = true;
      this.db.close();
    }
  }

  getTicket(ticketId: string): TicketRow | undefined {
    const row = this.db.prepare('select * from tickets where ticket_id = ?')
      .get(ticketId) as SqlRow | undefined;
    return row ? ticketFromRow(row) : undefined;
  }

  getTicketByNumber(ticketNumber: number): TicketRow | undefined {
    const row = this.db.prepare('select * from tickets where ticket_number = ?')
      .get(ticketNumber) as SqlRow | undefined;
    return row ? ticketFromRow(row) : undefined;
  }

  listTickets(options: { status?: TicketStatus; limit?: number; offset?: number } = {}): TicketRow[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const offset = Math.max(0, options.offset ?? 0);
    const rows = options.status
      ? this.db.prepare(`
          select * from tickets where status = ?
          order by updated_at desc, ticket_number desc limit ? offset ?
        `).all(options.status, limit, offset) as SqlRow[]
      : this.db.prepare(`
          select * from tickets
          order by updated_at desc, ticket_number desc limit ? offset ?
        `).all(limit, offset) as SqlRow[];
    return rows.map(ticketFromRow);
  }

  listTicketSources(ticketId: string): TicketSourceRow[] {
    return (this.db.prepare(
      'select * from ticket_sources where ticket_id = ? order by admitted_at, source_id',
    ).all(ticketId) as SqlRow[]).map(sourceFromRow);
  }

  loadTicketProcessingContext(
    input: LoadTicketProcessingContextInput,
  ): TicketProcessingContextResult {
    const normalized = {
      ticket_id: assertNonEmpty(input.ticket_id, 'ticket_id'),
      triggering_event_id: assertNonEmpty(input.triggering_event_id, 'triggering_event_id'),
      idempotency_key: assertNonEmpty(input.idempotency_key, 'idempotency_key'),
    };
    const requestDigest = digest(normalized);
    return this.db.transaction(() => {
      this.#assertOpen();
      const existing = this.#existingOperation<TicketProcessingContextResult>(
        normalized.idempotency_key,
        requestDigest,
      );
      if (existing) return existing;

      const ticket = this.#requireTicket(normalized.ticket_id);
      const eventRow = this.db.prepare(`
        select event.*, outbox.topic
          from work_lifecycle_events event
          join work_outbox outbox on outbox.event_id = event.event_id
         where event.event_id = ?
           and event.aggregate_kind = 'ticket'
           and event.aggregate_id = ?
           and outbox.topic = 'work.ticket-work-due.v1'
      `).get(normalized.triggering_event_id, normalized.ticket_id) as SqlRow | undefined;
      if (!eventRow) throw new Error('ticket_processing_trigger_event_invalid');

      const sourceRows = this.db.prepare(`
        select * from ticket_sources
         where ticket_id = ?
         order by admitted_at, source_id limit 51
      `).all(ticket.ticket_id) as SqlRow[];
      const taskRows = this.db.prepare(`
        select link.ticket_id, link.task_id, link.link_kind, link.status,
               link.linked_at, link.terminal_at,
               task.task_number, task.status as task_status,
               task.revision as task_revision,
               spec.title
          from ticket_task_links link
          join task_lifecycle task on task.task_id = link.task_id
          left join task_specs spec on spec.task_id = link.task_id
         where link.ticket_id = ?
         order by link.linked_at, link.task_id limit 51
      `).all(ticket.ticket_id) as SqlRow[];
      const draftRows = this.db.prepare(`
        select ticket_id, draft_id, effect_claim_id, draft_ref_json, receipt_id,
               disposition, disposition_evidence_kind, disposition_evidence_id,
               disposition_evidence_json,
               created_at, disposed_at
          from ticket_draft_refs where ticket_id = ?
         order by created_at, draft_id limit 51
      `).all(ticket.ticket_id) as SqlRow[];
      const sourceCount = Number((this.db.prepare(
        'select count(*) as count from ticket_sources where ticket_id = ?',
      ).get(ticket.ticket_id) as SqlRow).count);
      const taskLinkCount = Number((this.db.prepare(
        'select count(*) as count from ticket_task_links where ticket_id = ?',
      ).get(ticket.ticket_id) as SqlRow).count);
      const draftRefCount = Number((this.db.prepare(
        'select count(*) as count from ticket_draft_refs where ticket_id = ?',
      ).get(ticket.ticket_id) as SqlRow).count);
      const sources = sourceRows.slice(0, 50).map(sourceFromRow);
      const taskLinks = taskRows.slice(0, 50).map((row) => ({
        ticket_id: String(row.ticket_id),
        task_id: String(row.task_id),
        task_number: Number(row.task_number),
        link_kind: String(row.link_kind),
        link_status: String(row.status),
        task_status: String(row.task_status),
        task_revision: Number(row.task_revision),
        title: row.title == null ? null : String(row.title),
        linked_at: String(row.linked_at),
        terminal_at: row.terminal_at === null ? null : String(row.terminal_at),
      }));
      const draftRefs = draftRows.slice(0, 50).map((row) => ({
        ticket_id: String(row.ticket_id),
        draft_id: String(row.draft_id),
        effect_claim_id: String(row.effect_claim_id),
        draft_ref: parseJsonObject(row.draft_ref_json),
        receipt_id: String(row.receipt_id),
        disposition: row.disposition === null ? null : String(row.disposition),
        disposition_evidence_kind: row.disposition_evidence_kind === null
          ? null
          : String(row.disposition_evidence_kind),
        disposition_evidence_id: row.disposition_evidence_id === null
          ? null
          : String(row.disposition_evidence_id),
        disposition_evidence: row.disposition_evidence_json === null
          ? null
          : parseJsonObject(row.disposition_evidence_json),
        created_at: String(row.created_at),
        disposed_at: row.disposed_at === null ? null : String(row.disposed_at),
      }));
      const result: TicketProcessingContextResult = {
        schema: 'narada.work_lifecycle.ticket_processing_context.v1',
        ticket,
        triggering_event: {
          event_id: String(eventRow.event_id),
          topic: String(eventRow.topic),
          aggregate_revision: Number(eventRow.aggregate_revision),
          event_type: String(eventRow.event_type),
          schema_version: Number(eventRow.schema_version),
          causation_id: String(eventRow.causation_id),
          idempotency_key: String(eventRow.idempotency_key),
          payload: parseJsonObject(eventRow.payload_json),
          created_at: String(eventRow.created_at),
        },
        sources,
        task_links: taskLinks,
        draft_refs: draftRefs,
        counts: {
          sources: sourceCount,
          task_links: taskLinkCount,
          draft_refs: draftRefCount,
        },
        truncated: {
          sources: sourceCount > 50,
          task_links: taskLinkCount > 50,
          draft_refs: draftRefCount > 50,
        },
      };
      this.#recordOperation(
        normalized.idempotency_key,
        'ticket.processing_context.load',
        requestDigest,
        'ticket',
        ticket.ticket_id,
        ticket.revision,
        result,
      );
      return result;
    })();
  }

  admitSource(input: AdmitTicketSourceInput): AdmitTicketSourceResult {
    const normalized = this.#normalizeSourceInput(input);
    const requestDigest = digest(normalized);
    return this.db.transaction(() => {
      this.#assertOpen();
      const existingOperation = this.#existingOperation<AdmitTicketSourceResult>(
        normalized.idempotency_key,
        requestDigest,
      );
      if (existingOperation) return existingOperation;

      const existingSource = this.db.prepare(`
        select * from ticket_sources
         where source_kind = ? and source_scope = ? and immutable_source_id = ?
      `).get(
        normalized.source_kind,
        normalized.source_scope,
        normalized.immutable_source_id,
      ) as SqlRow | undefined;
      if (existingSource) {
        const ticket = this.#requireTicket(String(existingSource.ticket_id));
        const result: AdmitTicketSourceResult = {
          schema: 'narada.work_lifecycle.ticket_source_admission.v1',
          status: 'already_associated',
          ticket_id: ticket.ticket_id,
          ticket_number: ticket.ticket_number,
          ticket_revision: ticket.revision,
          source_id: String(existingSource.source_id),
          receipt_id: String(existingSource.receipt_id),
        };
        this.#recordOperation(
          normalized.idempotency_key,
          'ticket.admit_source',
          requestDigest,
          'ticket',
          ticket.ticket_id,
          ticket.revision,
          result,
        );
        return result;
      }

      const candidateTicketIds = this.#correlationCandidates(normalized.correlation_keys);
      const receiptId = stableId('receipt_source', {
        source_kind: normalized.source_kind,
        source_scope: normalized.source_scope,
        immutable_source_id: normalized.immutable_source_id,
      });
      if (candidateTicketIds.length > 1) {
        const result: AdmitTicketSourceResult = {
          schema: 'narada.work_lifecycle.ticket_source_admission.v1',
          status: 'blocked',
          ticket_id: null,
          ticket_number: null,
          ticket_revision: null,
          source_id: null,
          receipt_id: receiptId,
          reason: 'ambiguous_correlation',
          candidate_ticket_ids: candidateTicketIds,
        };
        this.#recordOperation(
          normalized.idempotency_key,
          'ticket.admit_source',
          requestDigest,
          null,
          null,
          null,
          result,
        );
        return result;
      }

      const now = this.#now().toISOString();
      const created = candidateTicketIds.length === 0;
      let ticket: TicketRow;
      if (created) {
        const ticketNumber = this.#allocateTicketNumber();
        const ticketId = `ticket-${ticketNumber}`;
        this.db.prepare(`
          insert into tickets(
            ticket_id, ticket_number, status, revision, summary,
            resolution_code, blocker_code, created_at, updated_at, terminal_at
          ) values (?, ?, 'actionable', 1, ?, null, null, ?, ?, null)
        `).run(ticketId, ticketNumber, normalized.summary, now, now);
        ticket = this.#requireTicket(ticketId);
      } else {
        const ticketId = candidateTicketIds[0]!;
        this.db.prepare(`
          update tickets
             set status = 'actionable',
                 revision = revision + 1,
                 summary = ?,
                 resolution_code = null,
                 blocker_code = null,
                 terminal_at = null,
                 updated_at = ?
           where ticket_id = ?
        `).run(normalized.summary, now, ticketId);
        ticket = this.#requireTicket(ticketId);
      }

      const sourceId = stableId('source', {
        source_kind: normalized.source_kind,
        source_scope: normalized.source_scope,
        immutable_source_id: normalized.immutable_source_id,
      });
      this.db.prepare(`
        insert into ticket_sources(
          source_id, ticket_id, source_kind, source_scope, immutable_source_id,
          source_ref_json, policy_version, receipt_id, admitted_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sourceId,
        ticket.ticket_id,
        normalized.source_kind,
        normalized.source_scope,
        normalized.immutable_source_id,
        normalized.source_ref_json,
        normalized.policy_version,
        receiptId,
        now,
      );
      for (const key of normalized.correlation_keys) {
        this.db.prepare(`
          insert into ticket_correlation_keys(
            kind, scope, value, ticket_id, policy_version, admitted_at
          ) values (?, ?, ?, ?, ?, ?)
          on conflict(kind, scope, value) do nothing
        `).run(key.kind, key.scope, key.value, ticket.ticket_id, normalized.policy_version, now);
        const owner = this.db.prepare(`
          select ticket_id from ticket_correlation_keys
           where kind = ? and scope = ? and value = ?
        `).get(key.kind, key.scope, key.value) as SqlRow;
        if (String(owner.ticket_id) !== ticket.ticket_id) {
          throw new Error('ticket_source_correlation_conflict');
        }
      }

      const eventType = created ? 'ticket.created' : 'ticket.source.admitted';
      const eventId = this.#recordTicketEvent(
        ticket,
        eventType,
        normalized.causation_id,
        normalized.idempotency_key,
        'work.ticket-work-due.v1',
        { source_id: sourceId, source_kind: normalized.source_kind },
      );
      const result: AdmitTicketSourceResult = {
        schema: 'narada.work_lifecycle.ticket_source_admission.v1',
        status: created ? 'created' : 'attached',
        ticket_id: ticket.ticket_id,
        ticket_number: ticket.ticket_number,
        ticket_revision: ticket.revision,
        source_id: sourceId,
        receipt_id: receiptId,
        event_id: eventId,
      };
      this.#recordOperation(
        normalized.idempotency_key,
        'ticket.admit_source',
        requestDigest,
        'ticket',
        ticket.ticket_id,
        ticket.revision,
        result,
      );
      return result;
    })();
  }

  admitProposal(input: AdmitTicketProposalInput): AdmitTicketProposalResult {
    const normalized = this.#normalizeProposal(input);
    const requestDigest = digest(normalized);
    return this.db.transaction(() => {
      this.#assertOpen();
      const existing = this.#existingOperation<AdmitTicketProposalResult>(
        normalized.idempotency_key,
        requestDigest,
      );
      if (existing) return { ...existing, status: 'already_applied' as const };

      const before = this.#requireTicket(normalized.ticket_id);
      if (before.revision !== normalized.expected_revision) {
        throw new Error(
          `ticket_revision_conflict:expected_${normalized.expected_revision}:actual_${before.revision}`,
        );
      }
      const now = this.#now().toISOString();
      let eventType: string;
      let topic = 'work.ticket-lifecycle.v1';
      let taskId: string | undefined;
      let taskNumber: number | undefined;
      let effectClaimId: string | undefined;
      let draftOperationKey: string | undefined;
      let draftRequestDigest: string | undefined;
      let draftSourceId: string | undefined;
      let draftMailboxId: string | undefined;
      let draftSourceMessageId: string | undefined;
      let draftReplyMode: 'reply' | 'reply_all' | undefined;

      if (normalized.route === 'followup_task') {
        if (!normalized.task) throw new Error('ticket_proposal_task_required');
        const existingLink = this.db.prepare(
          'select task_id from ticket_task_links where operation_key = ?',
        ).get(normalized.idempotency_key) as SqlRow | undefined;
        if (existingLink) {
          taskId = String(existingLink.task_id);
          const lifecycle = this.taskStore.getLifecycle(taskId);
          taskNumber = lifecycle?.task_number;
        } else {
          taskNumber = this.taskStore.allocateTaskNumber();
          taskId = stableId('task', normalized.idempotency_key, 24);
          this.taskStore.upsertLifecycle({
            task_id: taskId,
            task_number: taskNumber,
            status: 'opened',
            governed_by: null,
            closed_at: null,
            closed_by: null,
            closure_mode: null,
            reopened_at: null,
            reopened_by: null,
            continuation_packet_json: null,
            updated_at: now,
          });
          this.taskStore.upsertTaskSpec({
            task_id: taskId,
            task_number: taskNumber,
            title: normalized.task.title,
            chapter_markdown: null,
            goal_markdown: normalized.task.goal,
            context_markdown: normalized.task.context ?? null,
            required_work_markdown: normalized.task.required_work,
            non_goals_markdown: normalized.task.non_goals ?? null,
            acceptance_criteria_json: canonicalJson(normalized.task.acceptance_criteria),
            dependencies_json: '[]',
            tags_json: canonicalJson(normalized.task.tags ?? []),
            updated_at: now,
          });
          this.taskStore.upsertTaskOutcomeContract({
            contract_id: stableId('contract_ticket_followup', normalized.idempotency_key, 24),
            task_id: taskId,
            outcome_type: 'ticket_followup_completion',
            allowed_outcomes_json: canonicalJson(['completed']),
            satisfying_outcomes_json: canonicalJson(['completed']),
            blocking_outcomes_json: canonicalJson([]),
            required_fields_json: canonicalJson(['summary']),
            capability_requirement: null,
            created_by: normalized.actor_id,
            created_at: now,
          });
          this.db.prepare(`
            insert into ticket_task_links(
              ticket_id, task_id, link_kind, operation_key, status, linked_at, terminal_at
            ) values (?, ?, 'followup', ?, 'active', ?, null)
          `).run(before.ticket_id, taskId, normalized.idempotency_key, now);
        }
        this.#transitionTicket(before.ticket_id, 'waiting_on_task', now, {
          summary: normalized.summary,
          resolutionCode: null,
          blockerCode: null,
          terminalAt: null,
        });
        eventType = 'ticket.followup_task.created';
      } else if (normalized.route === 'response_draft') {
        const draft = normalized.draft;
        if (!draft) throw new Error('ticket_proposal_draft_required');
        const source = this.db.prepare(`
          select * from ticket_sources
           where ticket_id = ? and source_id = ? and source_kind = 'mailbox_message'
        `).get(before.ticket_id, draft.source_id) as SqlRow | undefined;
        if (!source) throw new Error('ticket_proposal_draft_source_invalid');
        const sourceRef = parseJsonObject(source.source_ref_json);
        const sourceScope = assertNonEmpty(
          typeof source.source_scope === 'string' ? source.source_scope : '',
          'ticket_draft_source_scope',
        );
        const sourceRefScope = assertNonEmpty(
          typeof sourceRef.scope_id === 'string' ? sourceRef.scope_id : '',
          'ticket_draft_source_ref_scope_id',
        );
        if (sourceRefScope !== sourceScope) {
          throw new Error('ticket_draft_source_scope_mismatch');
        }
        const mailboxId = assertNonEmpty(
          typeof sourceRef.mailbox_id === 'string' ? sourceRef.mailbox_id : '',
          'ticket_draft_graph_mailbox_id',
        );
        const sourceMessageId = assertNonEmpty(
          typeof sourceRef.message_id === 'string' ? sourceRef.message_id : '',
          'ticket_draft_source_message_id',
        );
        if (String(source.immutable_source_id) !== sourceMessageId) {
          throw new Error('ticket_draft_source_identity_mismatch');
        }
        const draftRequest = {
          source_id: draft.source_id,
          mailbox_id: mailboxId,
          source_message_id: sourceMessageId,
          reply_mode: draft.reply_mode,
          ...(draft.body_text ? { body_text: draft.body_text } : {}),
          ...(draft.body_html ? { body_html: draft.body_html } : {}),
        };
        draftRequestDigest = digest(draftRequest);
        draftSourceId = draft.source_id;
        draftMailboxId = mailboxId;
        draftSourceMessageId = sourceMessageId;
        draftReplyMode = draft.reply_mode;
        draftOperationKey = stableId(
          'draft_operation',
          normalized.idempotency_key,
          32,
        );
        effectClaimId = stableId('effect_claim', draftOperationKey, 24);
        const nextRevision = before.revision + 1;
        this.db.prepare(`
          insert into ticket_effect_claims(
            claim_id, ticket_id, ticket_revision, effect_kind, operation_key,
            request_digest, status, receipt_id, receipt_json, claimed_at, completed_at
          ) values (?, ?, ?, 'graph.unsent_draft', ?, ?, 'claimed', null, null, ?, null)
        `).run(
          effectClaimId,
          before.ticket_id,
          nextRevision,
          draftOperationKey,
          draftRequestDigest,
          now,
        );
        this.#transitionTicket(before.ticket_id, 'effect_claimed', now, {
          summary: normalized.summary,
          resolutionCode: null,
          blockerCode: null,
          terminalAt: null,
        });
        eventType = 'ticket.draft_effect.claimed';
      } else if (normalized.route === 'resolved') {
        this.#assertResolutionAllowed(before.ticket_id);
        this.#transitionTicket(before.ticket_id, 'resolved', now, {
          summary: normalized.summary,
          resolutionCode: normalized.resolution_code ?? 'resolved',
          blockerCode: null,
          terminalAt: now,
        });
        eventType = 'ticket.resolved';
      } else {
        this.#transitionTicket(before.ticket_id, 'blocked', now, {
          summary: normalized.summary,
          resolutionCode: null,
          blockerCode: normalized.blocker_code ?? 'operator_required',
          terminalAt: null,
        });
        eventType = 'ticket.blocked.operator';
      }

      const after = this.#requireTicket(before.ticket_id);
      const eventId = this.#recordTicketEvent(
        after,
        eventType,
        normalized.causation_id,
        normalized.idempotency_key,
        topic,
        {
          route: normalized.route,
          actor_id: normalized.actor_id,
          ...(taskId ? { task_id: taskId, task_number: taskNumber } : {}),
          ...(effectClaimId
            ? {
              effect_claim_id: effectClaimId,
              draft_operation_key: draftOperationKey!,
              draft_request_digest: draftRequestDigest!,
              draft_source_id: draftSourceId!,
              mailbox_id: draftMailboxId!,
              source_message_id: draftSourceMessageId!,
              reply_mode: draftReplyMode!,
            }
            : {}),
        },
      );
      const result: AdmitTicketProposalResult = {
        schema: 'narada.work_lifecycle.ticket_proposal.v1',
        status: 'admitted',
        route: normalized.route,
        ticket_id: after.ticket_id,
        ticket_revision: after.revision,
        event_id: eventId,
        ...(taskId ? { task_id: taskId, task_number: taskNumber } : {}),
        ...(effectClaimId
          ? {
            effect_claim_id: effectClaimId,
            draft_operation_key: draftOperationKey!,
            draft_request_digest: draftRequestDigest!,
            draft_source_id: draftSourceId!,
            mailbox_id: draftMailboxId!,
            source_message_id: draftSourceMessageId!,
            reply_mode: draftReplyMode!,
          }
          : {}),
      };
      this.#recordOperation(
        normalized.idempotency_key,
        `ticket.proposal.${normalized.route}`,
        requestDigest,
        'ticket',
        after.ticket_id,
        after.revision,
        result,
      );
      return result;
    })();
  }

  recordDraftReceipt(input: RecordDraftReceiptInput): {
    status: 'recorded' | 'already_recorded' | 'superseded';
    ticket: TicketRow;
    event_id: string;
  } {
    const draftRefJson = assertReferencePayload(input.draft_ref, 'draft_ref');
    const normalized = {
      ...input,
      ticket_id: assertNonEmpty(input.ticket_id, 'ticket_id'),
      effect_claim_id: assertNonEmpty(input.effect_claim_id, 'effect_claim_id'),
      draft_operation_key: assertNonEmpty(input.draft_operation_key, 'draft_operation_key'),
      draft_request_digest: assertNonEmpty(input.draft_request_digest, 'draft_request_digest'),
      receipt_id: assertNonEmpty(input.receipt_id, 'receipt_id'),
      draft_id: assertNonEmpty(input.draft_id, 'draft_id'),
      idempotency_key: assertNonEmpty(input.idempotency_key, 'idempotency_key'),
      causation_id: assertNonEmpty(input.causation_id, 'causation_id'),
      draft_ref_json: draftRefJson,
    };
    if (!/^[a-f0-9]{64}$/.test(normalized.draft_request_digest)) {
      throw new Error('draft_request_digest_invalid');
    }
    const requestDigest = digest(normalized);
    return this.db.transaction(() => {
      this.#assertOpen();
      const prior = this.#existingOperation<{
        status: 'recorded' | 'already_recorded' | 'superseded';
        ticket: TicketRow;
        event_id: string;
      }>(normalized.idempotency_key, requestDigest);
      if (prior) {
        return prior.status === 'recorded'
          ? { ...prior, status: 'already_recorded' as const }
          : prior;
      }
      const claim = this.db.prepare(
        'select * from ticket_effect_claims where claim_id = ? and ticket_id = ?',
      ).get(normalized.effect_claim_id, normalized.ticket_id) as SqlRow | undefined;
      if (!claim) throw new Error('ticket_effect_claim_not_found');
      if (String(claim.operation_key) !== normalized.draft_operation_key) {
        throw new Error('ticket_effect_claim_operation_mismatch');
      }
      if (String(claim.request_digest) !== normalized.draft_request_digest) {
        throw new Error('ticket_effect_claim_request_digest_mismatch');
      }
      const ticket = this.#requireTicket(normalized.ticket_id);
      if (ticket.revision !== Number(claim.ticket_revision)) {
        this.db.prepare(
          "update ticket_effect_claims set status = 'superseded' where claim_id = ?",
        ).run(normalized.effect_claim_id);
        const eventId = this.#recordTicketEvent(
          ticket,
          'ticket.draft_effect.superseded',
          normalized.causation_id,
          normalized.idempotency_key,
          'work.ticket-lifecycle.v1',
          {
            effect_claim_id: normalized.effect_claim_id,
            claimed_revision: Number(claim.ticket_revision),
            current_revision: ticket.revision,
          },
        );
        const result = { status: 'superseded' as const, ticket, event_id: eventId };
        this.#recordOperation(
          normalized.idempotency_key,
          'ticket.draft.receipt',
          requestDigest,
          'ticket',
          ticket.ticket_id,
          ticket.revision,
          result,
        );
        return result;
      }
      const now = this.#now().toISOString();
      this.db.prepare(`
        update ticket_effect_claims
           set status = 'completed', receipt_id = ?, receipt_json = ?, completed_at = ?
         where claim_id = ? and status = 'claimed'
      `).run(
        normalized.receipt_id,
        canonicalJson({ draft_id: normalized.draft_id, draft_ref: normalized.draft_ref }),
        now,
        normalized.effect_claim_id,
      );
      this.db.prepare(`
        insert into ticket_draft_refs(
          ticket_id, draft_id, effect_claim_id, draft_ref_json, receipt_id,
          disposition, disposition_evidence_kind, disposition_evidence_id,
          created_at, disposed_at
        ) values (?, ?, ?, ?, ?, null, null, null, ?, null)
        on conflict(ticket_id, draft_id) do update set
          draft_ref_json = excluded.draft_ref_json,
          receipt_id = excluded.receipt_id
      `).run(
        normalized.ticket_id,
        normalized.draft_id,
        normalized.effect_claim_id,
        normalized.draft_ref_json,
        normalized.receipt_id,
        now,
      );
      this.#transitionTicket(normalized.ticket_id, 'waiting_on_draft', now, {
        resolutionCode: null,
        blockerCode: null,
        terminalAt: null,
      });
      const after = this.#requireTicket(normalized.ticket_id);
      const eventId = this.#recordTicketEvent(
        after,
        'ticket.draft.receipt_recorded',
        normalized.causation_id,
        normalized.idempotency_key,
        'work.ticket-lifecycle.v1',
        {
          effect_claim_id: normalized.effect_claim_id,
          draft_id: normalized.draft_id,
          receipt_id: normalized.receipt_id,
        },
      );
      const result = { status: 'recorded' as const, ticket: after, event_id: eventId };
      this.#recordOperation(
        normalized.idempotency_key,
        'ticket.draft.receipt',
        requestDigest,
        'ticket',
        after.ticket_id,
        after.revision,
        result,
      );
      return result;
    })();
  }

  reconcileDraftDisposition(input: ReconcileDraftDispositionInput): {
    status: 'reconciled' | 'already_reconciled';
    ticket: TicketRow;
    event_id: string;
  } {
    const evidence = normalizeDraftDispositionEvidence(input.evidence);
    if (evidence.ticket_id !== input.ticket_id || evidence.draft_id !== input.draft_id) {
      throw new Error('ticket_draft_disposition_evidence_target_mismatch');
    }
    const normalized = {
      ...input,
      ticket_id: assertNonEmpty(input.ticket_id, 'ticket_id'),
      draft_id: assertNonEmpty(input.draft_id, 'draft_id'),
      disposition: evidence.disposition,
      evidence_kind: evidence.evidence_kind,
      evidence_id: evidence.evidence_id,
      evidence,
      idempotency_key: assertNonEmpty(input.idempotency_key, 'idempotency_key'),
      causation_id: assertNonEmpty(input.causation_id, 'causation_id'),
    };
    const requestDigest = digest(normalized);
    return this.db.transaction(() => {
      this.#assertOpen();
      const prior = this.#existingOperation<{
        status: 'reconciled' | 'already_reconciled';
        ticket: TicketRow;
        event_id: string;
      }>(normalized.idempotency_key, requestDigest);
      if (prior) return { ...prior, status: 'already_reconciled' as const };
      const draft = this.db.prepare(
        'select * from ticket_draft_refs where ticket_id = ? and draft_id = ?',
      ).get(normalized.ticket_id, normalized.draft_id) as SqlRow | undefined;
      if (!draft) throw new Error('ticket_draft_ref_not_found');
      const draftRef = parseJsonObject(draft.draft_ref_json);
      if (
        String(draft.effect_claim_id) !== evidence.effect_claim_id
        || String(draftRef.draft_operation_key ?? '') !== evidence.draft_operation_key
        || String(draftRef.mailbox_id ?? '') !== evidence.mailbox_id
      ) throw new Error('ticket_draft_disposition_evidence_linkage_mismatch');
      const now = this.#now().toISOString();
      this.db.prepare(`
        update ticket_draft_refs
           set disposition = ?,
                disposition_evidence_kind = ?,
                disposition_evidence_id = ?,
                disposition_evidence_json = ?,
                disposed_at = ?
         where ticket_id = ? and draft_id = ?
      `).run(
        normalized.disposition,
        normalized.evidence_kind,
        normalized.evidence_id,
        evidence.evidence_json,
        now,
        normalized.ticket_id,
        normalized.draft_id,
      );
      this.#transitionTicket(normalized.ticket_id, 'actionable', now, {
        resolutionCode: null,
        blockerCode: null,
        terminalAt: null,
      });
      const after = this.#requireTicket(normalized.ticket_id);
      const eventId = this.#recordTicketEvent(
        after,
        'ticket.draft.disposition',
        normalized.causation_id,
        normalized.idempotency_key,
        'work.ticket-work-due.v1',
        {
          draft_id: normalized.draft_id,
          disposition: normalized.disposition,
          evidence_kind: normalized.evidence_kind,
          evidence_id: normalized.evidence_id,
        },
      );
      const result = { status: 'reconciled' as const, ticket: after, event_id: eventId };
      this.#recordOperation(
        normalized.idempotency_key,
        'ticket.draft.disposition',
        requestDigest,
        'ticket',
        after.ticket_id,
        after.revision,
        result,
      );
      return result;
    })();
  }

  listOutbox(
    consumerId: string,
    options: { topics?: string[]; limit?: number } = {},
  ): WorkOutboxEvent[] {
    const consumer = assertNonEmpty(consumerId, 'consumer_id');
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const topics = [...new Set((options.topics ?? []).map((topic) => topic.trim()).filter(Boolean))];
    const rows = topics.length > 0
      ? this.db.prepare(`
          select outbox.*
            from work_outbox outbox
           where outbox.topic in (${topics.map(() => '?').join(', ')})
             and outbox.available_at <= ?
             and not exists (
               select 1 from work_outbox_receipts receipt
                where receipt.event_id = outbox.event_id and receipt.consumer_id = ?
             )
           order by outbox.created_at, outbox.event_id
           limit ?
        `).all(...topics, this.#now().toISOString(), consumer, limit) as SqlRow[]
      : this.db.prepare(`
          select outbox.*
            from work_outbox outbox
           where outbox.available_at <= ?
             and not exists (
               select 1 from work_outbox_receipts receipt
                where receipt.event_id = outbox.event_id and receipt.consumer_id = ?
             )
           order by outbox.created_at, outbox.event_id
           limit ?
        `).all(this.#now().toISOString(), consumer, limit) as SqlRow[];
    return rows.map((row) => ({
      event_id: String(row.event_id),
      topic: String(row.topic),
      partition_key: String(row.partition_key),
      aggregate_kind: String(row.aggregate_kind) as 'ticket' | 'task',
      aggregate_id: String(row.aggregate_id),
      aggregate_revision: Number(row.aggregate_revision),
      schema_version: Number(row.schema_version),
      causation_id: String(row.causation_id),
      idempotency_key: String(row.idempotency_key),
      payload: parseJsonObject(row.payload_json),
      created_at: String(row.created_at),
      available_at: String(row.available_at),
      compacted_at: row.compacted_at === null ? null : String(row.compacted_at),
    }));
  }

  registerOutboxConsumer(topic: string, consumerId: string): void {
    this.#assertOpen();
    this.db.prepare(`
      insert into work_outbox_consumer_requirements(topic, consumer_id, registered_at)
      values (?, ?, ?)
      on conflict(topic, consumer_id) do nothing
    `).run(
      assertNonEmpty(topic, 'topic'),
      assertNonEmpty(consumerId, 'consumer_id'),
      this.#now().toISOString(),
    );
  }

  acknowledgeOutbox(
    eventId: string,
    consumerId: string,
    receipt: Record<string, unknown>,
  ): void {
    const receiptJson = assertReferencePayload(receipt, 'outbox_receipt');
    this.db.transaction(() => {
      this.#assertOpen();
      const event = this.db.prepare('select event_id from work_outbox where event_id = ?')
        .get(assertNonEmpty(eventId, 'event_id'));
      if (!event) throw new Error('work_outbox_event_not_found');
      this.db.prepare(`
        insert into work_outbox_receipts(event_id, consumer_id, processed_at, receipt_json)
        values (?, ?, ?, ?)
        on conflict(event_id, consumer_id) do update set
          processed_at = excluded.processed_at,
          receipt_json = excluded.receipt_json
      `).run(
        eventId,
        assertNonEmpty(consumerId, 'consumer_id'),
        this.#now().toISOString(),
        receiptJson,
      );
    })();
  }

  compactAcknowledgedOutbox(before: string): { compacted: number } {
    const cutoff = new Date(before);
    if (Number.isNaN(cutoff.getTime())) throw new Error('compact_before_invalid');
    return this.db.transaction(() => {
      this.#assertOpen();
      const now = this.#now().toISOString();
      const result = this.db.prepare(`
        update work_outbox as outbox
           set payload_json = '{}', compacted_at = ?
         where outbox.compacted_at is null
           and outbox.created_at < ?
           and exists (
             select 1 from work_outbox_consumer_requirements requirement
              where requirement.topic = outbox.topic
           )
           and not exists (
             select 1 from work_outbox_consumer_requirements requirement
              where requirement.topic = outbox.topic
                and not exists (
                  select 1 from work_outbox_receipts receipt
                   where receipt.event_id = outbox.event_id
                     and receipt.consumer_id = requirement.consumer_id
                )
           )
      `).run(now, cutoff.toISOString());
      return { compacted: result.changes };
    })();
  }

  inspectStorageBounds(): {
    status: 'ok' | 'violation';
    violations: Array<{ table: string; row_id: string; bytes: number; limit: number }>;
  } {
    const checks = [
      ['tickets', 'ticket_id', 'summary', MAX_SUMMARY_BYTES],
      ['ticket_sources', 'source_id', 'source_ref_json', MAX_REF_JSON_BYTES],
      ['work_lifecycle_events', 'event_id', 'payload_json', MAX_EVENT_JSON_BYTES],
      ['work_outbox', 'event_id', 'payload_json', MAX_EVENT_JSON_BYTES],
      ['work_operations', 'operation_key', 'result_json', MAX_OPERATION_RESULT_BYTES],
    ] as const;
    const violations: Array<{ table: string; row_id: string; bytes: number; limit: number }> = [];
    for (const [table, idColumn, valueColumn, limit] of checks) {
      const rows = this.db.prepare(`
        select ${idColumn} as row_id, length(cast(${valueColumn} as blob)) as bytes
          from ${table}
         where length(cast(${valueColumn} as blob)) > ?
      `).all(limit) as SqlRow[];
      for (const row of rows) {
        violations.push({
          table,
          row_id: String(row.row_id),
          bytes: Number(row.bytes),
          limit,
        });
      }
    }
    return { status: violations.length === 0 ? 'ok' : 'violation', violations };
  }

  #normalizeSourceInput(input: AdmitTicketSourceInput): AdmitTicketSourceInput & {
    source_ref_json: string;
  } {
    const keys = new Map<string, TicketCorrelationKey>();
    for (const candidate of input.correlation_keys ?? []) {
      const key = {
        kind: assertNonEmpty(candidate.kind, 'correlation_kind'),
        scope: assertNonEmpty(candidate.scope, 'correlation_scope'),
        value: assertBounded(
          assertNonEmpty(candidate.value, 'correlation_value'),
          'correlation_value',
          1_024,
        ),
      };
      keys.set(canonicalJson(key), key);
    }
    return {
      ...input,
      source_kind: assertNonEmpty(input.source_kind, 'source_kind'),
      source_scope: assertNonEmpty(input.source_scope, 'source_scope'),
      immutable_source_id: assertBounded(
        assertNonEmpty(input.immutable_source_id, 'immutable_source_id'),
        'immutable_source_id',
        2_048,
      ),
      idempotency_key: assertNonEmpty(input.idempotency_key, 'idempotency_key'),
      causation_id: assertNonEmpty(input.causation_id, 'causation_id'),
      policy_version: assertNonEmpty(input.policy_version, 'policy_version'),
      summary: assertBounded(
        assertNonEmpty(input.summary, 'summary'),
        'summary',
        MAX_SUMMARY_BYTES,
      ),
      correlation_keys: [...keys.values()],
      source_ref_json: assertReferencePayload(input.source_ref, 'source_ref'),
    };
  }

  #normalizeProposal(input: AdmitTicketProposalInput): AdmitTicketProposalInput {
    if (!Number.isInteger(input.expected_revision) || input.expected_revision < 1) {
      throw new Error('expected_revision_invalid');
    }
    if (!['response_draft', 'followup_task', 'resolved', 'blocked_operator'].includes(input.route)) {
      throw new Error('ticket_proposal_route_invalid');
    }
    if (input.task) {
      if (input.route !== 'followup_task') throw new Error('ticket_proposal_task_route_invalid');
      assertBounded(assertNonEmpty(input.task.title, 'task_title'), 'task_title', 1_024);
      assertBounded(assertNonEmpty(input.task.goal, 'task_goal'), 'task_goal', 8_192);
      assertBounded(
        assertNonEmpty(input.task.required_work, 'task_required_work'),
        'task_required_work',
        16_384,
      );
      if (!Array.isArray(input.task.acceptance_criteria)) {
        throw new Error('task_acceptance_criteria_required');
      }
    }
    if (input.route === 'followup_task' && !input.task) {
      throw new Error('ticket_proposal_task_required');
    }
    let normalizedDraft: AdmitTicketProposalInput['draft'];
    if (input.draft) {
      if (input.route !== 'response_draft') throw new Error('ticket_proposal_draft_route_invalid');
      if (input.draft.reply_mode !== 'reply' && input.draft.reply_mode !== 'reply_all') {
        throw new Error('ticket_proposal_draft_reply_mode_invalid');
      }
      const bodyText = input.draft.body_text === undefined
        ? undefined
        : assertBounded(input.draft.body_text, 'draft_body_text', MAX_DRAFT_BODY_BYTES);
      const bodyHtml = input.draft.body_html === undefined
        ? undefined
        : assertBounded(input.draft.body_html, 'draft_body_html', MAX_DRAFT_BODY_BYTES);
      if ((bodyText ? 1 : 0) + (bodyHtml ? 1 : 0) !== 1) {
        throw new Error('ticket_proposal_draft_exactly_one_body_required');
      }
      normalizedDraft = {
        source_id: assertNonEmpty(input.draft.source_id, 'draft_source_id'),
        reply_mode: input.draft.reply_mode,
        ...(bodyText ? { body_text: bodyText } : {}),
        ...(bodyHtml ? { body_html: bodyHtml } : {}),
      };
    }
    if (input.route === 'response_draft' && !normalizedDraft) {
      throw new Error('ticket_proposal_draft_required');
    }
    return {
      ...input,
      ticket_id: assertNonEmpty(input.ticket_id, 'ticket_id'),
      idempotency_key: assertNonEmpty(input.idempotency_key, 'idempotency_key'),
      causation_id: assertNonEmpty(input.causation_id, 'causation_id'),
      actor_id: assertNonEmpty(input.actor_id, 'actor_id'),
      summary: assertBounded(
        assertNonEmpty(input.summary, 'summary'),
        'summary',
        MAX_SUMMARY_BYTES,
      ),
      ...(normalizedDraft ? { draft: normalizedDraft } : {}),
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('work_lifecycle_store_closed');
  }

  #requireTicket(ticketId: string): TicketRow {
    const ticket = this.getTicket(ticketId);
    if (!ticket) throw new Error(`ticket_not_found:${ticketId}`);
    return ticket;
  }

  #allocateTicketNumber(): number {
    const row = this.db.prepare(
      "select next_value from work_sequences where sequence_name = 'ticket'",
    ).get() as SqlRow;
    const value = Number(row.next_value);
    this.db.prepare(
      "update work_sequences set next_value = next_value + 1 where sequence_name = 'ticket'",
    ).run();
    return value;
  }

  #correlationCandidates(keys: TicketCorrelationKey[]): string[] {
    const candidates = new Set<string>();
    const statement = this.db.prepare(`
      select ticket_id from ticket_correlation_keys
       where kind = ? and scope = ? and value = ?
    `);
    for (const key of keys) {
      const row = statement.get(key.kind, key.scope, key.value) as SqlRow | undefined;
      if (row) candidates.add(String(row.ticket_id));
    }
    return [...candidates].sort();
  }

  #transitionTicket(
    ticketId: string,
    status: TicketStatus,
    updatedAt: string,
    updates: {
      summary?: string;
      resolutionCode?: string | null;
      blockerCode?: string | null;
      terminalAt?: string | null;
    },
  ): void {
    const current = this.#requireTicket(ticketId);
    this.db.prepare(`
      update tickets
         set status = ?,
             revision = revision + 1,
             summary = ?,
             resolution_code = ?,
             blocker_code = ?,
             terminal_at = ?,
             updated_at = ?
       where ticket_id = ?
    `).run(
      status,
      updates.summary ?? current.summary,
      updates.resolutionCode === undefined ? current.resolution_code : updates.resolutionCode,
      updates.blockerCode === undefined ? current.blocker_code : updates.blockerCode,
      updates.terminalAt === undefined ? current.terminal_at : updates.terminalAt,
      updatedAt,
      ticketId,
    );
  }

  #assertResolutionAllowed(ticketId: string): void {
    const unresolvedTask = this.db.prepare(`
      select link.task_id
        from ticket_task_links link
        join task_lifecycle task on task.task_id = link.task_id
       where link.ticket_id = ?
         and link.status = 'active'
         and task.status not in ('closed', 'confirmed')
       limit 1
    `).get(ticketId);
    if (unresolvedTask) throw new Error('ticket_resolution_blocked_by_task');
    const unresolvedDraft = this.db.prepare(`
      select claim_id
        from ticket_effect_claims
       where ticket_id = ? and status = 'claimed'
       limit 1
    `).get(ticketId);
    if (unresolvedDraft) throw new Error('ticket_resolution_blocked_by_effect_claim');
    const waitingDraft = this.db.prepare(`
      select draft_id
        from ticket_draft_refs
       where ticket_id = ? and disposition is null
       limit 1
    `).get(ticketId);
    if (waitingDraft) throw new Error('ticket_resolution_blocked_by_draft');
  }

  #recordTicketEvent(
    ticket: TicketRow,
    eventType: string,
    causationId: string,
    idempotencyKey: string,
    topic: string,
    extra: Record<string, unknown>,
  ): string {
    const eventId = stableId('event', {
      aggregate_kind: 'ticket',
      aggregate_id: ticket.ticket_id,
      aggregate_revision: ticket.revision,
      event_type: eventType,
      idempotency_key: idempotencyKey,
    });
    const payloadJson = assertBounded(canonicalJson({
      ticket_id: ticket.ticket_id,
      ticket_number: ticket.ticket_number,
      ticket_revision: ticket.revision,
      ticket_status: ticket.status,
      event_type: eventType,
      ...extra,
    }), 'event_payload', MAX_EVENT_JSON_BYTES);
    const now = this.#now().toISOString();
    this.db.prepare(`
      insert into work_lifecycle_events(
        event_id, aggregate_kind, aggregate_id, aggregate_revision, event_type,
        schema_version, causation_id, idempotency_key, payload_json, created_at
      ) values (?, 'ticket', ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      eventId,
      ticket.ticket_id,
      ticket.revision,
      eventType,
      causationId,
      `event:${idempotencyKey}`,
      payloadJson,
      now,
    );
    this.db.prepare(`
      insert into work_outbox(
        event_id, topic, partition_key, aggregate_kind, aggregate_id,
        aggregate_revision, schema_version, causation_id, idempotency_key,
        payload_json, created_at, available_at, compacted_at
      ) values (?, ?, ?, 'ticket', ?, ?, 1, ?, ?, ?, ?, ?, null)
    `).run(
      eventId,
      topic,
      ticket.ticket_id,
      ticket.ticket_id,
      ticket.revision,
      causationId,
      `outbox:${idempotencyKey}`,
      payloadJson,
      now,
      now,
    );
    return eventId;
  }

  #existingOperation<T>(operationKey: string, requestDigest: string): T | undefined {
    const row = this.db.prepare(
      'select request_digest, result_json from work_operations where operation_key = ?',
    ).get(operationKey) as SqlRow | undefined;
    if (!row) return undefined;
    if (String(row.request_digest) !== requestDigest) {
      throw new Error(`work_operation_idempotency_conflict:${operationKey}`);
    }
    return JSON.parse(String(row.result_json)) as T;
  }

  #recordOperation(
    operationKey: string,
    operationKind: string,
    requestDigest: string,
    aggregateKind: 'ticket' | 'task' | null,
    aggregateId: string | null,
    aggregateRevision: number | null,
    result: unknown,
  ): void {
    const resultJson = assertBounded(
      canonicalJson(result),
      'operation_result',
      MAX_OPERATION_RESULT_BYTES,
    );
    this.db.prepare(`
      insert into work_operations(
        operation_key, operation_kind, request_digest, aggregate_kind,
        aggregate_id, aggregate_revision, result_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operationKey,
      operationKind,
      requestDigest,
      aggregateKind,
      aggregateId,
      aggregateRevision,
      resultJson,
      this.#now().toISOString(),
    );
  }
}

export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}
