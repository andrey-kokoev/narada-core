export const WORK_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const WORK_LIFECYCLE_DATABASE_PATH = '.ai/work-lifecycle.db' as const;

export type TicketStatus =
  | 'actionable'
  | 'effect_claimed'
  | 'waiting_on_draft'
  | 'waiting_on_task'
  | 'blocked'
  | 'resolved';

export type TicketProposalRoute =
  | 'response_draft'
  | 'followup_task'
  | 'resolved'
  | 'blocked_operator';

export interface TicketRow {
  ticket_id: string;
  ticket_number: number;
  status: TicketStatus;
  revision: number;
  summary: string;
  resolution_code: string | null;
  blocker_code: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export interface TicketSourceIdentity {
  source_kind: string;
  source_scope: string;
  immutable_source_id: string;
}

export interface TicketCorrelationKey {
  kind: string;
  scope: string;
  value: string;
}

export interface TicketSourceRow extends TicketSourceIdentity {
  source_id: string;
  ticket_id: string;
  source_ref: Record<string, unknown>;
  policy_version: string;
  receipt_id: string;
  admitted_at: string;
}

export interface AdmitTicketSourceInput extends TicketSourceIdentity {
  idempotency_key: string;
  causation_id: string;
  policy_version: string;
  summary: string;
  source_ref: Record<string, unknown>;
  correlation_keys: TicketCorrelationKey[];
}

export interface AdmitTicketSourceResult {
  schema: 'narada.work_lifecycle.ticket_source_admission.v1';
  status: 'created' | 'attached' | 'already_associated' | 'blocked';
  ticket_id: string | null;
  ticket_number: number | null;
  ticket_revision: number | null;
  source_id: string | null;
  receipt_id: string;
  reason?: 'ambiguous_correlation';
  candidate_ticket_ids?: string[];
  event_id?: string;
}

export interface TicketTaskProposal {
  title: string;
  goal: string;
  context?: string | null;
  required_work: string;
  non_goals?: string | null;
  acceptance_criteria: string[];
  tags?: string[];
}

export interface TicketDraftProposal {
  source_id: string;
  reply_mode: 'reply' | 'reply_all';
  body_text?: string;
  body_html?: string;
}

export interface AdmitTicketProposalInput {
  ticket_id: string;
  expected_revision: number;
  route: TicketProposalRoute;
  idempotency_key: string;
  causation_id: string;
  actor_id: string;
  summary: string;
  task?: TicketTaskProposal;
  draft?: TicketDraftProposal;
  resolution_code?: string;
  blocker_code?: string;
}

export interface AdmitTicketProposalResult {
  schema: 'narada.work_lifecycle.ticket_proposal.v1';
  status: 'admitted' | 'already_applied';
  route: TicketProposalRoute;
  ticket_id: string;
  ticket_revision: number;
  event_id: string;
  task_id?: string;
  task_number?: number;
  effect_claim_id?: string;
  draft_operation_key?: string;
  draft_request_digest?: string;
  draft_source_id?: string;
  mailbox_id?: string;
  source_message_id?: string;
  reply_mode?: 'reply' | 'reply_all';
}

export interface RecordDraftReceiptInput {
  ticket_id: string;
  effect_claim_id: string;
  draft_operation_key: string;
  draft_request_digest: string;
  receipt_id: string;
  draft_id: string;
  draft_ref: Record<string, unknown>;
  idempotency_key: string;
  causation_id: string;
}

export interface LoadTicketProcessingContextInput {
  ticket_id: string;
  triggering_event_id: string;
  idempotency_key: string;
}

export interface TicketProcessingContextResult {
  schema: 'narada.work_lifecycle.ticket_processing_context.v1';
  ticket: TicketRow;
  triggering_event: Record<string, unknown>;
  sources: TicketSourceRow[];
  task_links: Record<string, unknown>[];
  draft_refs: Record<string, unknown>[];
  counts: {
    sources: number;
    task_links: number;
    draft_refs: number;
  };
  truncated: {
    sources: boolean;
    task_links: boolean;
    draft_refs: boolean;
  };
}

export interface ReconcileDraftDispositionInput {
  ticket_id: string;
  draft_id: string;
  disposition: string;
  evidence_kind: 'graph_operation_receipt' | 'synchronized_graph_observation';
  evidence_id: string;
  idempotency_key: string;
  causation_id: string;
}

export interface WorkOutboxEvent {
  event_id: string;
  topic: string;
  partition_key: string;
  aggregate_kind: 'ticket' | 'task';
  aggregate_id: string;
  aggregate_revision: number;
  schema_version: number;
  causation_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  created_at: string;
  available_at: string;
  compacted_at: string | null;
}

export interface WorkLifecyclePreparationInspection {
  status: 'prepared' | 'missing' | 'stale' | 'invalid';
  db_path: string;
  work_schema_version: number | null;
  task_schema_version: number | null;
  reason?: string;
}

export interface WorkLifecycleOpenOptions {
  databasePath?: string;
  writerId?: string;
  writerLeaseMs?: number;
  now?: () => Date;
}

export interface LegacyTicketMigrationSeed {
  legacy_ticket_id: string;
  target_status: 'actionable' | 'blocked';
  blocker_code?: string;
  blocker_summary?: string;
  source: AdmitTicketSourceInput;
}

export interface WorkLifecycleMigrationOptions {
  sourceDatabasePath?: string;
  targetDatabasePath?: string;
  ticketSeeds?: LegacyTicketMigrationSeed[];
  now?: () => Date;
}

export interface WorkLifecycleMigrationTableReport {
  table: string;
  source_rows: number;
  target_rows: number;
  copied_columns: string[];
  schema_source: 'target' | 'legacy_extension';
}

export interface WorkLifecycleMigrationReport {
  schema: 'narada.work_lifecycle.hard_cutover_migration.v1';
  status: 'migrated';
  source_database_path: string;
  target_database_path: string;
  source_fence: 'exclusive_transaction';
  source_integrity: string;
  source_integrity_scope: 'copied_tables_only';
  source_integrity_tables: string[];
  target_integrity: string;
  foreign_key_violations: number;
  task_rows: number;
  task_events_seeded: number;
  copied_tables: WorkLifecycleMigrationTableReport[];
  excluded_legacy_tables: Array<{
    table: string;
    disposition: 'discarded_without_scan';
  }>;
  ticket_mappings: Array<{
    legacy_ticket_id: string;
    ticket_id: string;
    ticket_number: number;
    status: 'actionable' | 'blocked';
    source_id: string;
  }>;
}
