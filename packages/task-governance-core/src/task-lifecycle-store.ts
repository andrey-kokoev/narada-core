/**
 * SQLite-backed Task Lifecycle Store
 *
 * Authoritative durable state for task lifecycle, assignments, reports,
 * reviews, and task number allocation. Operates on a dedicated SQLite
 * database separate from the Narada control plane.
 *
 * This store implements the authority model from Decision 547:
 * - SQLite owns lifecycle state (status, provenance, assignments)
 * - Markdown owns authored specification (goal, work, criteria)
 * - No field is independently authoritative in both stores
 */

import Database from "./sqlite-database.js";
import { join } from "node:path";
import type { VerificationRunRow } from "./intent-zone-types.js";
import type {
  CommandApprovalPosture,
  CommandEnvPolicy,
  CommandOutputAdmissionProfile,
  CommandRunRow,
  CommandRunStatus,
  CommandSideEffectClass,
  CommandStdinPolicy,
} from "./intent-zone-types.js";
import type {
  RepoPublicationRow,
  RepoPublicationStatus,
} from "./intent-zone-types.js";
import {
  assertSqliteRuntimeSupported,
  selectSqliteRuntime,
} from "./sqlite-runtime.js";
import { normalizeTaskTags, parseStoredTaskTags, requireTaskTagsArray } from './task-tags.js';

type Db = Database;

export type TaskStatus =
  | "draft"
  | "opened"
  | "claimed"
  | "needs_continuation"
  | "in_review"
  | "awaiting_dependencies"
  | "deferred"
  | "closed"
  | "confirmed";

export type TaskClosureMode =
  | "operator_direct"
  | "peer_reviewed"
  | "agent_finish"
  | "emergency";

export interface TaskLifecycleRow {
  task_id: string;
  task_number: number;
  status: TaskStatus;
  governed_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  closure_mode?: TaskClosureMode | null;
  relative_priority?: number | null;
  priority_reason?: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  continuation_packet_json: string | null;
  updated_at: string;
}

export type AssignmentIntent = "primary" | "review" | "repair" | "takeover";

export interface TaskAssignmentRow {
  assignment_id: string;
  task_id: string;
  agent_id: string;
  agent_identity_ref_json?: string | null;
  claimed_at: string;
  released_at: string | null;
  release_reason: string | null;
  intent: AssignmentIntent;
}

export interface TaskAssignmentRecordRow {
  task_id: string;
  record_json: string;
  updated_at: string;
}

export interface TaskReportRow {
  report_id: string;
  task_id: string;
  agent_id: string;
  agent_identity_ref_json?: string | null;
  summary: string;
  changed_files_json: string | null;
  verification_json: string | null;
  directive_id?: string | null;
  submitted_at: string;
}

export type CanonicalReviewVerdict = "accepted" | "rejected";
export type LegacyReviewVerdict = "needs_changes";
export type ReviewVerdict = CanonicalReviewVerdict | LegacyReviewVerdict;

export type DispatchPacketStatus =
  | "picked_up"
  | "renewed"
  | "executing"
  | "expired"
  | "released"
  | "superseded";

export type DispatchCreatedBy = "agent_pickup" | "auto_on_claim" | "operator_override";

export interface DispatchPacketRow {
  packet_id: string;
  task_id: string;
  assignment_id: string;
  agent_id: string;
  picked_up_at: string;
  lease_expires_at: string;
  heartbeat_at: string | null;
  dispatch_status: DispatchPacketStatus;
  sequence: number;
  created_by: DispatchCreatedBy;
  /** Resolved Kimi CLI session ID for execution targeting */
  target_session_id: string | null;
  /** Advisory human-readable session title */
  target_session_title: string | null;
}

export interface TaskReviewRow {
  review_id: string;
  task_id: string;
  reviewer_agent_id: string;
  verdict: ReviewVerdict;
  findings_json: string | null;
  reviewed_at: string;
}

export interface NewTaskReviewRow extends Omit<TaskReviewRow, "verdict"> {
  verdict: CanonicalReviewVerdict;
}

export type AssignmentIntentKind = "claim" | "roster_assign" | "continue";
export type AssignmentIntentResultStatus = "accepted" | "rejected" | "applied" | "failed";

export interface AssignmentIntentRow {
  request_id: string;
  kind: AssignmentIntentKind;
  task_id: string | null;
  task_number: number;
  agent_id: string;
  requested_by: string;
  requested_at: string;
  reason: string | null;
  no_claim: number;
  status: AssignmentIntentResultStatus;
  rejection_reason: string | null;
  assignment_id: string | null;
  previous_agent_id: string | null;
  lifecycle_status_before: string | null;
  lifecycle_status_after: string | null;
  roster_status_after: string | null;
  confirmation_json: string | null;
  warnings_json: string | null;
  updated_at: string;
}

export interface EvidenceBundleRow {
  bundle_id: string;
  task_id: string;
  task_number: number;
  report_ids_json: string;
  verification_run_ids_json: string;
  acceptance_criteria_json: string;
  review_ids_json: string;
  changed_files_json: string;
  residuals_json: string;
  assembled_at: string;
  assembled_by: string;
}

export interface EvidenceAdmissionResultRow {
  admission_id: string;
  bundle_id: string;
  task_id: string;
  task_number: number;
  verdict: "admitted" | "rejected";
  methods_json: string;
  blockers_json: string;
  lifecycle_eligible_status: TaskStatus | null;
  admitted_at: string;
  admitted_by: string;
  confirmation_json: string;
}

export interface CriteriaProofRow {
  proof_id: string;
  task_id: string;
  task_number: number;
  proved_by: string;
  proved_at: string;
  criteria_json: string;
  verification_binding_json: string;
}

export interface ObservationArtifactRow {
  artifact_id: string;
  artifact_type: string;
  source_operator: string;
  task_id: string | null;
  task_number: number | null;
  agent_id: string | null;
  artifact_uri: string;
  digest: string;
  admitted_view_json: string;
  created_at: string;
}

export interface TaskConflictPolicyEvidenceRow {
  evidence_id: string;
  dependency_id: string;
  required_task_id: string;
  required_outcome_id: string;
  agent_id: string;
  effective_operator_identity: string | null;
  gated_work_operator_identity: string | null;
  conflict_detected: boolean;
  policy_mode: string;
  authorization_required: boolean;
  authorization_basis_json: string | null;
  annotation_recorded: boolean;
  created_at: string;
}

export interface ReconciliationFindingRow {
  finding_id: string;
  task_id: string | null;
  task_number: number | null;
  surfaces_json: string;
  expected_authority: string;
  observed_mismatch_json: string;
  severity: "info" | "warning" | "error";
  proposed_repair_json: string;
  status: "open" | "repaired" | "ignored";
  detected_at: string;
}

export interface ReconciliationRepairRow {
  repair_id: string;
  finding_id: string;
  applied: number;
  changed_surfaces_json: string;
  before_json: string;
  after_json: string;
  verification_json: string;
  repaired_at: string;
  repaired_by: string;
}

export interface ReportRecordRow {
  report_id: string;
  task_id: string;
  assignment_id: string;
  agent_id: string;
  agent_identity_ref_json?: string | null;
  reported_at: string;
  report_json: string;
}

export interface PromotionRecordRow {
  promotion_id: string;
  task_id: string;
  task_number: number | null;
  agent_id: string;
  requested_by: string;
  requested_at: string;
  status: string;
  promotion_json: string;
}

export interface AgentRosterRow {
  agent_id: string;
  role: string;
  capabilities_json: string;
  operator_identity?: string | null;
  first_seen_at: string;
  last_active_at: string;
  status: string;
  task_number: number | null;
  last_done: number | null;
  updated_at: string;
}

export interface TaskNumberReservationRow {
  range_start: number;
  range_end: number;
  purpose: string;
  reserved_by: string;
  reserved_at: string;
  expires_at: string;
  status: "active" | "released" | "expired";
}

export interface TaskSpecRow {
  task_id: string;
  task_number: number;
  title: string;
  chapter_markdown?: string | null;
  goal_markdown?: string | null;
  context_markdown?: string | null;
  required_work_markdown?: string | null;
  non_goals_markdown?: string | null;
  acceptance_criteria_json?: string;
  dependencies_json?: string;
  tags_json?: string | null;
  updated_at?: string;
}

export interface TaskTagUpdateFields {
  task_id: string;
  task_number: number;
  actor_agent_id: string;
  previous_tags: string[];
  tags: string[];
  reason: string;
  updated_at: string;
}

export interface TaskTagUpdateRow extends TaskTagUpdateFields {
  update_id: string;
}

export interface TaskTagUpdateResult extends TaskTagUpdateFields {
  status: 'updated' | 'unchanged';
  update_id: string | null;
}

export interface EnvelopeTaskMappingRow {
  envelope_id: string;
  task_id: string;
  task_number: number;
  materialized_at: string;
}

export interface TaskLifecycleDetailRow extends TaskLifecycleRow {
  title: string | null;
  assigned_agent: string | null;
  target_role: string | null;
  preferred_role: string | null;
  preferred_agent_id: string | null;
}

export type DirectedObligationKind = "dependency_request" | "review_request" | "handoff" | "expectation";
export type DirectedObligationStatus = "open" | "consumed" | "deferred" | "delegated" | "rejected" | "completed";

export interface DirectedObligationRow {
  obligation_id: string;
  source_kind: string;
  source_ref: string;
  source_agent_id: string | null;
  target_agent_id: string | null;
  target_role: string | null;
  target_ref: string | null;
  kind: DirectedObligationKind;
  status: DirectedObligationStatus;
  task_id: string | null;
  task_number: number | null;
  evidence_json: string;
  consumption_rule_json: string;
  created_at: string;
  updated_at: string;
  consumed_at: string | null;
  consumed_by: string | null;
  consumption_ref: string | null;
}

export type TaskDependencyKind = "review" | "verification" | "operator_decision" | "downstream_work";
export type TaskDependencyStatus = "open" | "satisfied" | "blocked" | "deferred";
export type TaskDependencyDispositionKind =
  | "remediation_task"
  | "covered_by_existing_task"
  | "routed_obligation"
  | "operator_decision_required"
  | "operator_deferred"
  | "out_of_scope_or_rejected";
export type TaskDependencyDispositionStatus = "open" | "deferred" | "resolved" | "superseded";

export interface TaskDependencyRow {
  dependency_id: string;
  parent_task_id: string;
  required_task_id: string;
  kind: TaskDependencyKind | string;
  satisfying_outcomes_json: string;
  status: TaskDependencyStatus | string;
  created_by: string;
  created_at: string;
}

export interface TaskOutcomeContractRow {
  contract_id: string;
  task_id: string;
  outcome_type: string;
  allowed_outcomes_json: string;
  satisfying_outcomes_json: string;
  blocking_outcomes_json: string;
  required_fields_json: string;
  capability_requirement: string | null;
  created_by: string;
  created_at: string;
}

export interface TaskOutcomeRow {
  outcome_id: string;
  task_id: string;
  contract_id: string;
  agent_id: string;
  outcome: string;
  summary: string;
  findings_json: string;
  evidence_refs_json: string;
  admitted_at: string;
}

export interface TaskDependencyDispositionRow {
  disposition_id: string;
  dependency_id: string;
  required_outcome_id: string;
  kind: TaskDependencyDispositionKind | string;
  status: TaskDependencyDispositionStatus | string;
  target_task_id: string | null;
  routed_obligation_id: string | null;
  authority_basis_json: string;
  summary: string;
  created_by: string;
  created_at: string;
}

export interface TaskLifecycleStore {
  readonly db: Db;
  initSchema(): void;
  upsertLifecycle(row: TaskLifecycleRow): void;
  getLifecycle(taskId: string): TaskLifecycleRow | undefined;
  getLifecycleByNumber(taskNumber: number): TaskLifecycleRow | undefined;
  getAllLifecycle(): TaskLifecycleRow[];
  getAllLifecycleWithDetails(status?: string | null): TaskLifecycleDetailRow[];
  getAllLifecyclePaginated(options?: { since?: string | null; offset?: number; limit?: number }): TaskLifecycleDetailRow[];
  updateStatus(
    taskId: string,
    status: TaskStatus,
    actor: string,
    updates?: Partial<Omit<TaskLifecycleRow, "task_id" | "task_number" | "status">>,
  ): void;
  insertAssignment(assignment: TaskAssignmentRow): void;
  getActiveAssignment(taskId: string): TaskAssignmentRow | undefined;
  getAssignments(taskId: string): TaskAssignmentRow[];
  getAssignmentRecord(taskId: string): TaskAssignmentRecordRow | undefined;
  upsertAssignmentRecord(record: TaskAssignmentRecordRow): void;
  releaseAssignment(assignmentId: string, releaseReason: string): void;
  upsertAssignmentIntent(intent: AssignmentIntentRow): void;
  getAssignmentIntent(requestId: string): AssignmentIntentRow | undefined;
  listAssignmentIntentsForTask(taskId: string): AssignmentIntentRow[];
  upsertEvidenceBundle(bundle: EvidenceBundleRow): void;
  getEvidenceBundle(bundleId: string): EvidenceBundleRow | undefined;
  listEvidenceBundlesForTask(taskId: string): EvidenceBundleRow[];
  upsertEvidenceAdmissionResult(result: EvidenceAdmissionResultRow): void;
  getEvidenceAdmissionResult(admissionId: string): EvidenceAdmissionResultRow | undefined;
  getLatestEvidenceAdmissionResult(taskId: string): EvidenceAdmissionResultRow | undefined;
  upsertCriteriaProof(proof: CriteriaProofRow): void;
  getLatestCriteriaProof(taskId: string): CriteriaProofRow | undefined;
  upsertObservationArtifact(artifact: ObservationArtifactRow): void;
  getObservationArtifact(artifactId: string): ObservationArtifactRow | undefined;
  listObservationArtifacts(limit: number): ObservationArtifactRow[];
  upsertReconciliationFinding(finding: ReconciliationFindingRow): void;
  getReconciliationFinding(findingId: string): ReconciliationFindingRow | undefined;
  listReconciliationFindings(status?: string): ReconciliationFindingRow[];
  upsertReconciliationRepair(repair: ReconciliationRepairRow): void;
  getReconciliationRepair(repairId: string): ReconciliationRepairRow | undefined;
  insertReport(report: TaskReportRow): void;
  listReports(taskId: string): TaskReportRow[];
  upsertReportRecord(record: ReportRecordRow): void;
  getReportRecord(reportId: string): ReportRecordRow | undefined;
  listReportRecords(taskId: string): ReportRecordRow[];
  upsertPromotionRecord(record: PromotionRecordRow): void;
  getPromotionRecord(promotionId: string): PromotionRecordRow | undefined;
  listPromotionRecords(taskId?: string): PromotionRecordRow[];
  insertReview(review: NewTaskReviewRow): void;
  listReviews(taskId: string): TaskReviewRow[];
  listAllReviews(): TaskReviewRow[];
  upsertTaskDependency(row: TaskDependencyRow): void;
  getTaskDependency(dependencyId: string): TaskDependencyRow | undefined;
  listTaskDependenciesForParent(parentTaskId: string): TaskDependencyRow[];
  listTaskDependenciesForRequired(requiredTaskId: string): TaskDependencyRow[];
  upsertTaskOutcomeContract(row: TaskOutcomeContractRow): void;
  getTaskOutcomeContract(contractId: string): TaskOutcomeContractRow | undefined;
  getLatestTaskOutcomeContract(taskId: string): TaskOutcomeContractRow | undefined;
  listTaskOutcomeContracts(taskId: string): TaskOutcomeContractRow[];
  insertTaskOutcome(row: TaskOutcomeRow): void;
  listTaskOutcomes(taskId: string): TaskOutcomeRow[];
  getLatestTaskOutcome(taskId: string): TaskOutcomeRow | undefined;
  upsertTaskDependencyDisposition(row: TaskDependencyDispositionRow): void;
  listTaskDependencyDispositions(dependencyId: string): TaskDependencyDispositionRow[];
  getLatestTaskDependencyDisposition(dependencyId: string, requiredOutcomeId?: string | null): TaskDependencyDispositionRow | undefined;
  upsertTaskConflictPolicyEvidence(row: TaskConflictPolicyEvidenceRow): void;
  listTaskConflictPolicyEvidence(dependencyId: string): TaskConflictPolicyEvidenceRow[];
  getLatestTaskConflictPolicyEvidence(dependencyId: string, requiredOutcomeId?: string | null): TaskConflictPolicyEvidenceRow | undefined;
  insertDispatchPacket(packet: DispatchPacketRow): void;
  getActiveDispatchPacketForAssignment(assignmentId: string): DispatchPacketRow | undefined;
  getDispatchPacketsForTask(taskId: string): DispatchPacketRow[];
  getDispatchPacketsForAgent(agentId: string): DispatchPacketRow[];
  heartbeatDispatchPacket(packetId: string, extensionMinutes: number, maxLeaseMinutes: number): void;
  updateDispatchStatus(packetId: string, status: DispatchPacketStatus): void;
  allocateTaskNumber(): number;
  getLastAllocated(): number;
  ensureTaskNumberFloor(minValue: number): number;
  // Verification runs (Testing Intent Zone)
  insertVerificationRun(run: VerificationRunRow): void;
  updateVerificationRun(runId: string, updates: Partial<Omit<VerificationRunRow, 'run_id'>>): void;
  getVerificationRun(runId: string): VerificationRunRow | undefined;
  listVerificationRunsForTask(taskId: string): VerificationRunRow[];
  listRecentVerificationRuns(limit: number): VerificationRunRow[];
  hasVerificationRunsForTask(taskId: string): boolean;
  // Command runs (Command Execution Intent Zone)
  insertCommandRun(run: CommandRunRow): void;
  updateCommandRun(runId: string, updates: Partial<Omit<CommandRunRow, 'run_id'>>): void;
  getCommandRun(runId: string): CommandRunRow | undefined;
  listCommandRuns(limit: number, taskId?: string | null, agentId?: string | null): CommandRunRow[];
  // Repository publication intents
  upsertRepoPublication(publication: RepoPublicationRow): void;
  getRepoPublication(publicationId: string): RepoPublicationRow | undefined;
  listRepoPublications(limit: number, status?: RepoPublicationStatus | null): RepoPublicationRow[];
  // Agent roster (Task 611 — SQLite authority)
  getRoster(): AgentRosterRow[];
  getRosterEntry(agentId: string): AgentRosterRow | undefined;
  upsertRosterEntry(entry: AgentRosterRow): void;
  upsertDirectedObligation(entry: DirectedObligationRow): void;
  getDirectedObligation(obligationId: string): DirectedObligationRow | undefined;
  listDirectedObligationsForTarget(targetAgentId: string, targetRole?: string | null, status?: DirectedObligationStatus | null): DirectedObligationRow[];
  listDirectedObligationsForTask(taskId: string, status?: DirectedObligationStatus | null): DirectedObligationRow[];
  transitionDirectedObligation(
    obligationId: string,
    status: DirectedObligationStatus,
    actor: string,
    consumptionRef?: string | null,
  ): void;
  listTaskNumberReservations(): TaskNumberReservationRow[];
  upsertTaskNumberReservation(entry: TaskNumberReservationRow): void;
  upsertTaskSpec(row: TaskSpecRow): void;
  getTaskSpec(taskId: string): TaskSpecRow | undefined;
  getTaskSpecByNumber(taskNumber: number): TaskSpecRow | undefined;
  getAllTaskSpecs(): TaskSpecRow[];
  replaceTaskTags(options: {
    taskId: string;
    tags: string[];
    actorAgentId: string;
    reason: string;
    updateId: string;
    updatedAt?: string;
  }): TaskTagUpdateResult;
  listTaskTagUpdates(taskId: string, limit?: number): TaskTagUpdateRow[];
  upsertEnvelopeTaskMapping(envelopeId: string, taskId: string, taskNumber: number, materializedAt: string): void;
  getTaskByEnvelopeId(envelopeId: string): EnvelopeTaskMappingRow | undefined;
  getEnvelopeMappingsByTaskId(taskId: string): EnvelopeTaskMappingRow[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToLifecycle(row: Record<string, unknown>): TaskLifecycleRow {
  return {
    task_id: String(row.task_id),
    task_number: Number(row.task_number),
    status: String(row.status) as TaskStatus,
    governed_by: row.governed_by ? String(row.governed_by) : null,
    closed_at: row.closed_at ? String(row.closed_at) : null,
    closed_by: row.closed_by ? String(row.closed_by) : null,
    closure_mode: row.closure_mode ? String(row.closure_mode) as TaskClosureMode : null,
    relative_priority: row.relative_priority !== null && row.relative_priority !== undefined ? Number(row.relative_priority) : 0,
    priority_reason: row.priority_reason ? String(row.priority_reason) : null,
    reopened_at: row.reopened_at ? String(row.reopened_at) : null,
    reopened_by: row.reopened_by ? String(row.reopened_by) : null,
    continuation_packet_json: row.continuation_packet_json
      ? String(row.continuation_packet_json)
      : null,
    updated_at: String(row.updated_at),
  };
}

function rowToTaskConflictPolicyEvidence(row: Record<string, unknown>): TaskConflictPolicyEvidenceRow {
  return {
    evidence_id: String(row.evidence_id),
    dependency_id: String(row.dependency_id),
    required_task_id: String(row.required_task_id),
    required_outcome_id: String(row.required_outcome_id),
    agent_id: String(row.agent_id),
    effective_operator_identity: row.effective_operator_identity ? String(row.effective_operator_identity) : null,
    gated_work_operator_identity: row.gated_work_operator_identity ? String(row.gated_work_operator_identity) : null,
    conflict_detected: Number(row.conflict_detected) === 1,
    policy_mode: String(row.policy_mode),
    authorization_required: Number(row.authorization_required) === 1,
    authorization_basis_json: row.authorization_basis_json ? String(row.authorization_basis_json) : null,
    annotation_recorded: Number(row.annotation_recorded) === 1,
    created_at: String(row.created_at),
  };
}

function rowToTaskDependency(row: Record<string, unknown>): TaskDependencyRow {
  return {
    dependency_id: String(row.dependency_id),
    parent_task_id: String(row.parent_task_id),
    required_task_id: String(row.required_task_id),
    kind: String(row.kind),
    satisfying_outcomes_json: String(row.satisfying_outcomes_json),
    status: String(row.status),
    created_by: String(row.created_by),
    created_at: String(row.created_at),
  };
}

function rowToTaskOutcomeContract(row: Record<string, unknown>): TaskOutcomeContractRow {
  return {
    contract_id: String(row.contract_id),
    task_id: String(row.task_id),
    outcome_type: String(row.outcome_type),
    allowed_outcomes_json: String(row.allowed_outcomes_json),
    satisfying_outcomes_json: String(row.satisfying_outcomes_json),
    blocking_outcomes_json: String(row.blocking_outcomes_json),
    required_fields_json: String(row.required_fields_json),
    capability_requirement: row.capability_requirement ? String(row.capability_requirement) : null,
    created_by: String(row.created_by),
    created_at: String(row.created_at),
  };
}

function rowToTaskOutcome(row: Record<string, unknown>): TaskOutcomeRow {
  return {
    outcome_id: String(row.outcome_id),
    task_id: String(row.task_id),
    contract_id: String(row.contract_id),
    agent_id: String(row.agent_id),
    outcome: String(row.outcome),
    summary: String(row.summary),
    findings_json: String(row.findings_json),
    evidence_refs_json: String(row.evidence_refs_json),
    admitted_at: String(row.admitted_at),
  };
}

function rowToTaskDependencyDisposition(row: Record<string, unknown>): TaskDependencyDispositionRow {
  return {
    disposition_id: String(row.disposition_id),
    dependency_id: String(row.dependency_id),
    required_outcome_id: String(row.required_outcome_id),
    kind: String(row.kind),
    status: String(row.status),
    target_task_id: row.target_task_id ? String(row.target_task_id) : null,
    routed_obligation_id: row.routed_obligation_id ? String(row.routed_obligation_id) : null,
    authority_basis_json: String(row.authority_basis_json),
    summary: String(row.summary),
    created_by: String(row.created_by),
    created_at: String(row.created_at),
  };
}

function rowToAssignment(row: Record<string, unknown>): TaskAssignmentRow {
  return {
    assignment_id: String(row.assignment_id),
    task_id: String(row.task_id),
    agent_id: String(row.agent_id),
    agent_identity_ref_json: row.agent_identity_ref_json ? String(row.agent_identity_ref_json) : null,
    claimed_at: String(row.claimed_at),
    released_at: row.released_at ? String(row.released_at) : null,
    release_reason: row.release_reason ? String(row.release_reason) : null,
    intent: String(row.intent) as AssignmentIntent,
  };
}

function rowToReport(row: Record<string, unknown>): TaskReportRow {
  return {
    report_id: String(row.report_id),
    task_id: String(row.task_id),
    agent_id: String(row.agent_id),
    agent_identity_ref_json: row.agent_identity_ref_json ? String(row.agent_identity_ref_json) : null,
    summary: String(row.summary),
    changed_files_json: row.changed_files_json
      ? String(row.changed_files_json)
      : null,
    verification_json: row.verification_json
      ? String(row.verification_json)
      : null,
    directive_id: row.directive_id ? String(row.directive_id) : null,
    submitted_at: String(row.submitted_at),
  };
}

function rowToReview(row: Record<string, unknown>): TaskReviewRow {
  return {
    review_id: String(row.review_id),
    task_id: String(row.task_id),
    reviewer_agent_id: String(row.reviewer_agent_id),
    verdict: String(row.verdict) as ReviewVerdict,
    findings_json: row.findings_json ? String(row.findings_json) : null,
    reviewed_at: String(row.reviewed_at),
  };
}

function rowToAssignmentIntent(row: Record<string, unknown>): AssignmentIntentRow {
  return {
    request_id: String(row.request_id),
    kind: String(row.kind) as AssignmentIntentKind,
    task_id: row.task_id ? String(row.task_id) : null,
    task_number: Number(row.task_number),
    agent_id: String(row.agent_id),
    requested_by: String(row.requested_by),
    requested_at: String(row.requested_at),
    reason: row.reason ? String(row.reason) : null,
    no_claim: Number(row.no_claim),
    status: String(row.status) as AssignmentIntentResultStatus,
    rejection_reason: row.rejection_reason ? String(row.rejection_reason) : null,
    assignment_id: row.assignment_id ? String(row.assignment_id) : null,
    previous_agent_id: row.previous_agent_id ? String(row.previous_agent_id) : null,
    lifecycle_status_before: row.lifecycle_status_before ? String(row.lifecycle_status_before) : null,
    lifecycle_status_after: row.lifecycle_status_after ? String(row.lifecycle_status_after) : null,
    roster_status_after: row.roster_status_after ? String(row.roster_status_after) : null,
    confirmation_json: row.confirmation_json ? String(row.confirmation_json) : null,
    warnings_json: row.warnings_json ? String(row.warnings_json) : null,
    updated_at: String(row.updated_at),
  };
}

function rowToEvidenceBundle(row: Record<string, unknown>): EvidenceBundleRow {
  return {
    bundle_id: String(row.bundle_id),
    task_id: String(row.task_id),
    task_number: Number(row.task_number),
    report_ids_json: String(row.report_ids_json),
    verification_run_ids_json: String(row.verification_run_ids_json),
    acceptance_criteria_json: String(row.acceptance_criteria_json),
    review_ids_json: String(row.review_ids_json),
    changed_files_json: String(row.changed_files_json),
    residuals_json: String(row.residuals_json),
    assembled_at: String(row.assembled_at),
    assembled_by: String(row.assembled_by),
  };
}

function rowToEvidenceAdmissionResult(row: Record<string, unknown>): EvidenceAdmissionResultRow {
  return {
    admission_id: String(row.admission_id),
    bundle_id: String(row.bundle_id),
    task_id: String(row.task_id),
    task_number: Number(row.task_number),
    verdict: String(row.verdict) as EvidenceAdmissionResultRow["verdict"],
    methods_json: String(row.methods_json),
    blockers_json: String(row.blockers_json),
    lifecycle_eligible_status: row.lifecycle_eligible_status ? String(row.lifecycle_eligible_status) as TaskStatus : null,
    admitted_at: String(row.admitted_at),
    admitted_by: String(row.admitted_by),
    confirmation_json: String(row.confirmation_json),
  };
}

function rowToRepoPublication(row: Record<string, unknown>): RepoPublicationRow {
  return {
    publication_id: String(row.publication_id),
    repo_root: String(row.repo_root),
    branch: String(row.branch),
    remote: String(row.remote),
    commit_hash: String(row.commit_hash),
    base_ref: row.base_ref ? String(row.base_ref) : null,
    bundle_path: String(row.bundle_path),
    patch_path: row.patch_path ? String(row.patch_path) : null,
    task_number: row.task_number !== null && row.task_number !== undefined ? Number(row.task_number) : null,
    requester_id: String(row.requester_id),
    requested_at: String(row.requested_at),
    status: String(row.status) as RepoPublicationStatus,
    pushed_at: row.pushed_at ? String(row.pushed_at) : null,
    confirmed_by: row.confirmed_by ? String(row.confirmed_by) : null,
    confirmation_json: row.confirmation_json ? String(row.confirmation_json) : null,
    failure_reason: row.failure_reason ? String(row.failure_reason) : null,
    updated_at: String(row.updated_at),
  };
}

function rowToObservationArtifact(row: Record<string, unknown>): ObservationArtifactRow {
  return {
    artifact_id: String(row.artifact_id),
    artifact_type: String(row.artifact_type),
    source_operator: String(row.source_operator),
    task_id: row.task_id ? String(row.task_id) : null,
    task_number: row.task_number !== null && row.task_number !== undefined ? Number(row.task_number) : null,
    agent_id: row.agent_id ? String(row.agent_id) : null,
    artifact_uri: String(row.artifact_uri),
    digest: String(row.digest),
    admitted_view_json: String(row.admitted_view_json),
    created_at: String(row.created_at),
  };
}

function rowToReconciliationFinding(row: Record<string, unknown>): ReconciliationFindingRow {
  return {
    finding_id: String(row.finding_id),
    task_id: row.task_id ? String(row.task_id) : null,
    task_number: row.task_number !== null && row.task_number !== undefined ? Number(row.task_number) : null,
    surfaces_json: String(row.surfaces_json),
    expected_authority: String(row.expected_authority),
    observed_mismatch_json: String(row.observed_mismatch_json),
    severity: String(row.severity) as ReconciliationFindingRow["severity"],
    proposed_repair_json: String(row.proposed_repair_json),
    status: String(row.status) as ReconciliationFindingRow["status"],
    detected_at: String(row.detected_at),
  };
}

function rowToReconciliationRepair(row: Record<string, unknown>): ReconciliationRepairRow {
  return {
    repair_id: String(row.repair_id),
    finding_id: String(row.finding_id),
    applied: Number(row.applied),
    changed_surfaces_json: String(row.changed_surfaces_json),
    before_json: String(row.before_json),
    after_json: String(row.after_json),
    verification_json: String(row.verification_json),
    repaired_at: String(row.repaired_at),
    repaired_by: String(row.repaired_by),
  };
}

function rowToReportRecord(row: Record<string, unknown>): ReportRecordRow {
  return {
    report_id: String(row.report_id),
    task_id: String(row.task_id),
    assignment_id: String(row.assignment_id),
    agent_id: String(row.agent_id),
    agent_identity_ref_json: row.agent_identity_ref_json ? String(row.agent_identity_ref_json) : null,
    reported_at: String(row.reported_at),
    report_json: String(row.report_json),
  };
}

function rowToPromotionRecord(row: Record<string, unknown>): PromotionRecordRow {
  return {
    promotion_id: String(row.promotion_id),
    task_id: String(row.task_id),
    task_number: row.task_number === null || row.task_number === undefined
      ? null
      : Number(row.task_number),
    agent_id: String(row.agent_id),
    requested_by: String(row.requested_by),
    requested_at: String(row.requested_at),
    status: String(row.status),
    promotion_json: String(row.promotion_json),
  };
}

function rowToDispatchPacket(row: Record<string, unknown>): DispatchPacketRow {
  return {
    packet_id: String(row.packet_id),
    task_id: String(row.task_id),
    assignment_id: String(row.assignment_id),
    agent_id: String(row.agent_id),
    picked_up_at: String(row.picked_up_at),
    lease_expires_at: String(row.lease_expires_at),
    heartbeat_at: row.heartbeat_at ? String(row.heartbeat_at) : null,
    dispatch_status: String(row.dispatch_status) as DispatchPacketStatus,
    sequence: Number(row.sequence),
    created_by: String(row.created_by) as DispatchCreatedBy,
    target_session_id: row.target_session_id ? String(row.target_session_id) : null,
    target_session_title: row.target_session_title ? String(row.target_session_title) : null,
  };
}

function rowToTaskNumberReservation(row: Record<string, unknown>): TaskNumberReservationRow {
  return {
    range_start: Number(row.range_start),
    range_end: Number(row.range_end),
    purpose: String(row.purpose),
    reserved_by: String(row.reserved_by),
    reserved_at: String(row.reserved_at),
    expires_at: String(row.expires_at),
    status: String(row.status) as TaskNumberReservationRow["status"],
  };
}

function rowToTaskSpec(row: Record<string, unknown>): TaskSpecRow {
  return {
    task_id: String(row.task_id),
    task_number: Number(row.task_number),
    title: String(row.title),
    chapter_markdown: row.chapter_markdown ? String(row.chapter_markdown) : null,
    goal_markdown: row.goal_markdown ? String(row.goal_markdown) : null,
    context_markdown: row.context_markdown ? String(row.context_markdown) : null,
    required_work_markdown: row.required_work_markdown ? String(row.required_work_markdown) : null,
    non_goals_markdown: row.non_goals_markdown ? String(row.non_goals_markdown) : null,
    acceptance_criteria_json: String(row.acceptance_criteria_json),
    dependencies_json: String(row.dependencies_json),
    tags_json: typeof row.tags_json === 'string' ? row.tags_json : '[]',
    updated_at: String(row.updated_at),
  };
}

function rowToTaskTagUpdate(row: Record<string, unknown>): TaskTagUpdateRow {
  return {
    update_id: String(row.update_id),
    task_id: String(row.task_id),
    task_number: Number(row.task_number),
    actor_agent_id: String(row.actor_agent_id),
    previous_tags: parseStoredTaskTags(row.previous_tags_json),
    tags: parseStoredTaskTags(row.new_tags_json),
    reason: String(row.reason),
    updated_at: String(row.updated_at),
  };
}

function rowToDirectedObligation(row: Record<string, unknown>): DirectedObligationRow {
  return {
    obligation_id: String(row.obligation_id),
    source_kind: String(row.source_kind),
    source_ref: String(row.source_ref),
    source_agent_id: row.source_agent_id ? String(row.source_agent_id) : null,
    target_agent_id: row.target_agent_id ? String(row.target_agent_id) : null,
    target_role: row.target_role ? String(row.target_role) : null,
    target_ref: row.target_ref ? String(row.target_ref) : null,
    kind: String(row.kind) as DirectedObligationKind,
    status: String(row.status) as DirectedObligationStatus,
    task_id: row.task_id ? String(row.task_id) : null,
    task_number: row.task_number === null || row.task_number === undefined
      ? null
      : Number(row.task_number),
    evidence_json: String(row.evidence_json),
    consumption_rule_json: String(row.consumption_rule_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    consumed_at: row.consumed_at ? String(row.consumed_at) : null,
    consumed_by: row.consumed_by ? String(row.consumed_by) : null,
    consumption_ref: row.consumption_ref ? String(row.consumption_ref) : null,
  };
}

function rowToEnvelopeTaskMapping(row: Record<string, unknown>): EnvelopeTaskMappingRow {
  return {
    envelope_id: String(row.envelope_id),
    task_id: String(row.task_id),
    task_number: Number(row.task_number),
    materialized_at: String(row.materialized_at),
  };
}

function normalizeDirectedObligation(entry: DirectedObligationRow): DirectedObligationRow {
  const duplicateRoleRef = entry.target_role ? `role:${entry.target_role}` : null;
  if (entry.target_agent_id === null && duplicateRoleRef && entry.target_ref === duplicateRoleRef) {
    return { ...entry, target_ref: null };
  }
  return entry;
}

function ensureDirectedObligationTargetRefShape(db: Db): void {
  const table = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'directed_obligations'")
    .get() as { sql?: string } | undefined;
  const columns = db
    .prepare('pragma table_info(directed_obligations)')
    .all() as Array<{ name?: string; notnull?: number }>;
  const targetRef = columns.find((column) => column.name === 'target_ref');
  const current = targetRef && targetRef.notnull !== 1 && table?.sql?.includes('directed_obligations_no_role_ref_dup');
  if (current) {
    db.prepare(`
      update directed_obligations
      set target_ref = null
      where target_agent_id is null
        and target_role is not null
        and target_ref = ('role:' || target_role)
    `).run();
    return;
  }

  db.exec(`
    begin;

    create table directed_obligations_next (
      obligation_id text primary key,
      source_kind text not null,
      source_ref text not null,
      source_agent_id text,
      target_agent_id text,
      target_role text,
      target_ref text,
      kind text not null,
      status text not null,
      task_id text,
      task_number integer,
      evidence_json text not null,
      consumption_rule_json text not null,
      created_at text not null,
      updated_at text not null,
      consumed_at text,
      consumed_by text,
      consumption_ref text,
      constraint directed_obligations_no_role_ref_dup
        check (target_role is null or target_ref is null or target_ref <> ('role:' || target_role)),
      foreign key (task_id) references task_lifecycle(task_id)
    );

    insert into directed_obligations_next (
      obligation_id, source_kind, source_ref, source_agent_id,
      target_agent_id, target_role, target_ref, kind, status, task_id,
      task_number, evidence_json, consumption_rule_json, created_at,
      updated_at, consumed_at, consumed_by, consumption_ref
    )
    select
      obligation_id, source_kind, source_ref, source_agent_id,
      target_agent_id, target_role,
      case
        when target_agent_id is null
          and target_role is not null
          and target_ref = ('role:' || target_role)
        then null
        else target_ref
      end,
      kind, status, task_id, task_number, evidence_json,
      consumption_rule_json, created_at, updated_at, consumed_at,
      consumed_by, consumption_ref
    from directed_obligations;

    drop table directed_obligations;
    alter table directed_obligations_next rename to directed_obligations;

    create index if not exists idx_directed_obligations_target
      on directed_obligations(target_agent_id, target_role, status, created_at);

    create index if not exists idx_directed_obligations_task
      on directed_obligations(task_id, status);

    commit;
  `);
}

function rowToCriteriaProof(row: Record<string, unknown>): CriteriaProofRow {
  return {
    proof_id: String(row.proof_id),
    task_id: String(row.task_id),
    task_number: Number(row.task_number),
    proved_by: String(row.proved_by),
    proved_at: String(row.proved_at),
    criteria_json: String(row.criteria_json),
    verification_binding_json: String(row.verification_binding_json),
  };
}

export interface SqliteTaskLifecycleStoreOptions {
  db: Db;
}

export const TASK_LIFECYCLE_BUSY_TIMEOUT_MS = 30000;
export const TASK_LIFECYCLE_SYNCHRONOUS_MODE = 'normal';
export const TASK_LIFECYCLE_FAST_SQLITE_ENV = 'NARADA_TASK_LIFECYCLE_FAST_SQLITE';

const initializedLifecycleDbPaths = new Set<string>();

const REQUIRED_LIFECYCLE_TABLES = [
  'task_lifecycle',
  'task_assignments',
  'assignment_intents',
  'evidence_bundles',
  'evidence_admission_results',
  'criteria_proofs',
  'observation_artifacts',
  'reconciliation_findings',
  'reconciliation_repairs',
  'task_reports',
  'task_report_records',
  'task_promotion_records',
  'task_reviews',
  'task_dependencies',
  'task_outcome_contracts',
  'task_outcomes',
  'task_dependency_dispositions',
  'task_conflict_policy_evidence',
  'task_number_sequence',
  'dispatch_packets',
  'verification_runs',
  'command_runs',
  'repo_publications',
  'agent_roster',
  'directed_obligations',
  'task_number_reservations',
  'task_specs',
  'task_tag_updates',
  'envelope_task_mappings',
  'narada_andrey_task_role_preferences',
];

function hasCurrentLifecycleSchema(db: Db): boolean {
  const tables = db
    .prepare("select name from sqlite_master where type = 'table'")
    .all() as Array<{ name?: string }>;
  const tableNames = new Set(tables.map((table) => table.name));
  if (REQUIRED_LIFECYCLE_TABLES.some((table) => !tableNames.has(table))) return false;
  const lifecycleColumns = db
    .prepare('pragma table_info(task_lifecycle)')
    .all() as Array<{ name?: string }>;
  if (!lifecycleColumns.some((column) => column.name === 'closure_mode')) return false;
  const reportColumns = db
    .prepare('pragma table_info(task_reports)')
    .all() as Array<{ name?: string }>;
  if (!reportColumns.some((column) => column.name === 'directive_id')) return false;
  const directedColumns = db
    .prepare('pragma table_info(directed_obligations)')
    .all() as Array<{ name?: string; notnull?: number }>;
  const targetRef = directedColumns.find((column) => column.name === 'target_ref');
  if (!targetRef || targetRef.notnull === 1) return false;
  const directedSql = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'directed_obligations'")
    .get() as { sql?: string } | undefined;
  return Boolean(directedSql?.sql?.includes('directed_obligations_no_role_ref_dup'));
}

function ensureTaskReportsDirectiveIdColumn(db: Db): void {
  const reportColumns = db
    .prepare('pragma table_info(task_reports)')
    .all() as Array<{ name?: string }>;
  if (!reportColumns.some((column) => column.name === 'directive_id')) {
    db.exec('alter table task_reports add column directive_id text;');
  }
  db.exec('create index if not exists idx_task_reports_directive_id on task_reports(directive_id);');
}

function ensureIdentityRefColumns(db: Db): void {
  ensureColumn(db, 'task_assignments', 'agent_identity_ref_json', 'text');
  ensureColumn(db, 'task_reports', 'agent_identity_ref_json', 'text');
  ensureColumn(db, 'task_report_records', 'agent_identity_ref_json', 'text');
}

function ensureColumn(db: Db, tableName: string, columnName: string, columnType: string): void {
  const columns = db
    .prepare(`pragma table_info(${tableName})`)
    .all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`alter table ${tableName} add column ${columnName} ${columnType};`);
  }
}

export function openTaskLifecycleStore(cwd: string): SqliteTaskLifecycleStore {
  const runtime = selectSqliteRuntime();
  assertSqliteRuntimeSupported(runtime);
  const dbPath = join(cwd, ".ai", "task-lifecycle.db");
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${TASK_LIFECYCLE_BUSY_TIMEOUT_MS}`);
  if (process.env[TASK_LIFECYCLE_FAST_SQLITE_ENV] === '1') {
    db.pragma('journal_mode = MEMORY');
    db.pragma('synchronous = OFF');
  } else {
    db.pragma('journal_mode = WAL');
    db.pragma(`synchronous = ${TASK_LIFECYCLE_SYNCHRONOUS_MODE}`);
  }
  const store = new SqliteTaskLifecycleStore({ db });
  if (!initializedLifecycleDbPaths.has(dbPath)) {
    if (!hasCurrentLifecycleSchema(db)) {
      store.initSchema();
    }
    ensureColumn(db, 'task_specs', 'tags_json', "text not null default '[]'");
    db.exec(`
      create table if not exists task_tag_updates (
        update_id text primary key,
        task_id text not null,
        task_number integer not null,
        actor_agent_id text not null,
        previous_tags_json text not null,
        new_tags_json text not null,
        reason text not null,
        updated_at text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );
      create index if not exists idx_task_tag_updates_task
        on task_tag_updates(task_id, updated_at desc);
    `);
    ensureIdentityRefColumns(db);
    ensureColumn(db, 'agent_roster', 'operator_identity', 'text');
    initializedLifecycleDbPaths.add(dbPath);
  }
  return store;
}

export class SqliteTaskLifecycleStore implements TaskLifecycleStore {
  readonly db: Db;

  constructor(opts: SqliteTaskLifecycleStoreOptions) {
    this.db = opts.db;
  }

  initSchema(): void {
    this.db.exec('pragma foreign_keys = on;');
    try {
    this.db.exec(`
      begin;

      create table if not exists task_lifecycle (
        task_id text primary key,
        task_number integer not null unique,
        status text not null,
        governed_by text,
        closed_at text,
        closed_by text,
        closure_mode text,
        relative_priority integer default 0,
        priority_reason text,
        reopened_at text,
        reopened_by text,
        continuation_packet_json text,
        updated_at text not null
      );

      create index if not exists idx_task_lifecycle_status
        on task_lifecycle(status);

      create table if not exists task_assignments (
        assignment_id text primary key,
        task_id text not null,
        agent_id text not null,
        agent_identity_ref_json text,
        claimed_at text not null,
        released_at text,
        release_reason text,
        intent text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_task_assignments_task_id
        on task_assignments(task_id);

      create table if not exists assignment_intents (
        request_id text primary key,
        kind text not null,
        task_id text,
        task_number integer not null,
        agent_id text not null,
        requested_by text not null,
        requested_at text not null,
        reason text,
        no_claim integer not null default 0,
        status text not null,
        rejection_reason text,
        assignment_id text,
        previous_agent_id text,
        lifecycle_status_before text,
        lifecycle_status_after text,
        roster_status_after text,
        confirmation_json text,
        warnings_json text,
        updated_at text not null
      );

      create index if not exists idx_assignment_intents_task_id
        on assignment_intents(task_id);

      create index if not exists idx_assignment_intents_requested_at
        on assignment_intents(requested_at);

      create table if not exists evidence_bundles (
        bundle_id text primary key,
        task_id text not null,
        task_number integer not null,
        report_ids_json text not null,
        verification_run_ids_json text not null,
        acceptance_criteria_json text not null,
        review_ids_json text not null,
        changed_files_json text not null,
        residuals_json text not null,
        assembled_at text not null,
        assembled_by text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_evidence_bundles_task_id
        on evidence_bundles(task_id);

      create table if not exists evidence_admission_results (
        admission_id text primary key,
        bundle_id text not null,
        task_id text not null,
        task_number integer not null,
        verdict text not null,
        methods_json text not null,
        blockers_json text not null,
        lifecycle_eligible_status text,
        admitted_at text not null,
        admitted_by text not null,
        confirmation_json text not null,
        foreign key (bundle_id) references evidence_bundles(bundle_id),
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_evidence_admission_results_task_id
        on evidence_admission_results(task_id);

      create table if not exists criteria_proofs (
        proof_id text primary key,
        task_id text not null,
        task_number integer not null,
        proved_by text not null,
        proved_at text not null,
        criteria_json text not null,
        verification_binding_json text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_criteria_proofs_task_id
        on criteria_proofs(task_id);

      create index if not exists idx_evidence_admission_results_admitted_at
        on evidence_admission_results(admitted_at);

      create table if not exists observation_artifacts (
        artifact_id text primary key,
        artifact_type text not null,
        source_operator text not null,
        task_id text,
        task_number integer,
        agent_id text,
        artifact_uri text not null,
        digest text not null,
        admitted_view_json text not null,
        created_at text not null
      );

      create index if not exists idx_observation_artifacts_created_at
        on observation_artifacts(created_at);

      create index if not exists idx_observation_artifacts_source_operator
        on observation_artifacts(source_operator);

      create table if not exists reconciliation_findings (
        finding_id text primary key,
        task_id text,
        task_number integer,
        surfaces_json text not null,
        expected_authority text not null,
        observed_mismatch_json text not null,
        severity text not null,
        proposed_repair_json text not null,
        status text not null,
        detected_at text not null
      );

      create index if not exists idx_reconciliation_findings_status
        on reconciliation_findings(status);

      create table if not exists reconciliation_repairs (
        repair_id text primary key,
        finding_id text not null,
        applied integer not null,
        changed_surfaces_json text not null,
        before_json text not null,
        after_json text not null,
        verification_json text not null,
        repaired_at text not null,
        repaired_by text not null,
        foreign key (finding_id) references reconciliation_findings(finding_id)
      );

      create table if not exists task_reports (
        report_id text primary key,
        task_id text not null,
        agent_id text not null,
        agent_identity_ref_json text,
        summary text not null,
        changed_files_json text,
        verification_json text,
        directive_id text,
        submitted_at text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_task_reports_task_id
        on task_reports(task_id);

      create table if not exists task_report_records (
        report_id text primary key,
        task_id text not null,
        assignment_id text not null,
        agent_id text not null,
        agent_identity_ref_json text,
        reported_at text not null,
        report_json text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_task_report_records_task_id
        on task_report_records(task_id);

      create table if not exists task_promotion_records (
        promotion_id text primary key,
        task_id text not null,
        task_number integer,
        agent_id text not null,
        requested_by text not null,
        requested_at text not null,
        status text not null,
        promotion_json text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_task_promotion_records_task_id
        on task_promotion_records(task_id);

      create index if not exists idx_task_promotion_records_requested_at
        on task_promotion_records(requested_at);

      create table if not exists task_reviews (
        review_id text primary key,
        task_id text not null,
        reviewer_agent_id text not null,
        verdict text not null,
        findings_json text,
        reviewed_at text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_task_reviews_task_id
        on task_reviews(task_id);

      create table if not exists task_dependencies (
        dependency_id text primary key,
        parent_task_id text not null,
        required_task_id text not null,
        kind text not null,
        satisfying_outcomes_json text not null,
        status text not null,
        created_by text not null,
        created_at text not null,
        foreign key (parent_task_id) references task_lifecycle(task_id),
        foreign key (required_task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_task_dependencies_parent
        on task_dependencies(parent_task_id, status);

      create index if not exists idx_task_dependencies_required
        on task_dependencies(required_task_id, status);

      create table if not exists task_outcome_contracts (
        contract_id text primary key,
        task_id text not null,
        outcome_type text not null,
        allowed_outcomes_json text not null,
        satisfying_outcomes_json text not null,
        blocking_outcomes_json text not null,
        required_fields_json text not null,
        capability_requirement text,
        created_by text not null,
        created_at text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_task_outcome_contracts_task
        on task_outcome_contracts(task_id, created_at desc);

      create table if not exists task_outcomes (
        outcome_id text primary key,
        task_id text not null,
        contract_id text not null,
        agent_id text not null,
        outcome text not null,
        summary text not null,
        findings_json text not null,
        evidence_refs_json text not null,
        admitted_at text not null,
        foreign key (task_id) references task_lifecycle(task_id),
        foreign key (contract_id) references task_outcome_contracts(contract_id)
      );

      create index if not exists idx_task_outcomes_task
        on task_outcomes(task_id, admitted_at desc);

      create index if not exists idx_task_outcomes_contract
        on task_outcomes(contract_id, admitted_at desc);

      create table if not exists task_dependency_dispositions (
        disposition_id text primary key,
        dependency_id text not null,
        required_outcome_id text not null,
        kind text not null,
        status text not null,
        target_task_id text,
        routed_obligation_id text,
        authority_basis_json text not null,
        summary text not null,
        created_by text not null,
        created_at text not null,
        foreign key (dependency_id) references task_dependencies(dependency_id),
        foreign key (required_outcome_id) references task_outcomes(outcome_id)
      );

      create index if not exists idx_task_dependency_dispositions_dependency
        on task_dependency_dispositions(dependency_id, required_outcome_id, created_at desc);

      create table if not exists task_conflict_policy_evidence (
        evidence_id text primary key,
        dependency_id text not null,
        required_task_id text not null,
        required_outcome_id text not null,
        agent_id text not null,
        effective_operator_identity text,
        gated_work_operator_identity text,
        conflict_detected integer not null,
        policy_mode text not null,
        authorization_required integer not null,
        authorization_basis_json text,
        annotation_recorded integer not null,
        created_at text not null,
        foreign key (dependency_id) references task_dependencies(dependency_id),
        foreign key (required_task_id) references task_lifecycle(task_id),
        foreign key (required_outcome_id) references task_outcomes(outcome_id)
      );

      create index if not exists idx_task_conflict_policy_evidence_dependency
        on task_conflict_policy_evidence(dependency_id, required_outcome_id, created_at desc);

      create table if not exists task_number_sequence (
        singleton integer primary key check (singleton = 1),
        last_allocated integer not null default 0
      );

      insert or ignore into task_number_sequence (singleton, last_allocated)
      values (1, 0);

      create table if not exists dispatch_packets (
        packet_id text primary key,
        task_id text not null,
        assignment_id text not null,
        agent_id text not null,
        picked_up_at text not null,
        lease_expires_at text not null,
        heartbeat_at text,
        dispatch_status text not null,
        sequence integer not null default 1,
        created_by text not null,
        target_session_id text,
        target_session_title text,
        foreign key (task_id) references task_lifecycle(task_id)
        -- assignment_id FK deferred: assignments are still in JSON files (Task 564 follow-up)
      );

      create index if not exists idx_dispatch_packets_task_id
        on dispatch_packets(task_id);

      create index if not exists idx_dispatch_packets_assignment_id
        on dispatch_packets(assignment_id);

      create index if not exists idx_dispatch_packets_agent_status
        on dispatch_packets(agent_id, dispatch_status);

      create index if not exists idx_dispatch_packets_lease_expires
        on dispatch_packets(lease_expires_at)
        where dispatch_status in ('picked_up', 'renewed');

      create table if not exists verification_runs (
        run_id text primary key,
        request_id text not null,
        task_id text,
        target_command text not null,
        scope text not null,
        timeout_seconds integer not null,
        requester_identity text not null,
        requested_at text not null,
        status text not null,
        exit_code integer,
        duration_ms integer,
        metrics_json text,
        stdout_digest text,
        stderr_digest text,
        stdout_excerpt text,
        stderr_excerpt text,
        completed_at text
      );

      create index if not exists idx_verification_runs_task_id
        on verification_runs(task_id);

      create index if not exists idx_verification_runs_status
        on verification_runs(status);

      create index if not exists idx_verification_runs_requested_at
        on verification_runs(requested_at);

      create table if not exists command_runs (
        run_id text primary key,
        request_id text not null,
        requester_id text not null,
        requester_kind text not null,
        command_argv_json text not null,
        cwd text not null,
        env_policy_json text not null,
        timeout_seconds integer not null,
        stdin_policy_json text not null,
        task_id text,
        task_number integer,
        agent_id text,
        side_effect_class text not null,
        approval_posture text not null,
        output_admission_profile text not null,
        idempotency_key text not null,
        requested_at text not null,
        rationale text,
        status text not null,
        exit_code integer,
        signal text,
        started_at text,
        completed_at text,
        duration_ms integer,
        stdout_digest text,
        stderr_digest text,
        stdout_admitted_excerpt text,
        stderr_admitted_excerpt text,
        full_output_artifact_uri text,
        error_class text,
        approval_outcome text not null,
        telemetry_json text,
        updated_at text not null
      );

      create index if not exists idx_command_runs_task_id
        on command_runs(task_id);

      create index if not exists idx_command_runs_agent_id
        on command_runs(agent_id);

      create index if not exists idx_command_runs_status
        on command_runs(status);

      create index if not exists idx_command_runs_requested_at
        on command_runs(requested_at);

      create table if not exists repo_publications (
        publication_id text primary key,
        repo_root text not null,
        branch text not null,
        remote text not null,
        commit_hash text not null,
        base_ref text,
        bundle_path text not null,
        patch_path text,
        task_number integer,
        requester_id text not null,
        requested_at text not null,
        status text not null,
        pushed_at text,
        confirmed_by text,
        confirmation_json text,
        failure_reason text,
        updated_at text not null
      );

      create index if not exists idx_repo_publications_status
        on repo_publications(status);

      create index if not exists idx_repo_publications_requested_at
        on repo_publications(requested_at);

      create table if not exists agent_roster (
        agent_id text primary key,
        role text not null,
        capabilities_json text not null,
        operator_identity text,
        first_seen_at text not null,
        last_active_at text not null,
        status text not null default 'idle',
        task_number integer,
        last_done integer,
        updated_at text not null
      );

      create index if not exists idx_agent_roster_status
        on agent_roster(status);

      create table if not exists directed_obligations (
        obligation_id text primary key,
        source_kind text not null,
        source_ref text not null,
        source_agent_id text,
        target_agent_id text,
        target_role text,
        target_ref text,
        kind text not null,
        status text not null,
        task_id text,
        task_number integer,
        evidence_json text not null,
        consumption_rule_json text not null,
        created_at text not null,
        updated_at text not null,
        consumed_at text,
        consumed_by text,
        consumption_ref text,
        constraint directed_obligations_no_role_ref_dup
          check (target_role is null or target_ref is null or target_ref <> ('role:' || target_role)),
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_directed_obligations_target
        on directed_obligations(target_agent_id, target_role, status, created_at);

      create index if not exists idx_directed_obligations_task
        on directed_obligations(task_id, status);

      create table if not exists task_number_reservations (
        range_start integer not null,
        range_end integer not null,
        purpose text not null,
        reserved_by text not null,
        reserved_at text not null,
        expires_at text not null,
        status text not null,
        primary key (range_start, range_end)
      );

      create index if not exists idx_task_number_reservations_status
        on task_number_reservations(status);

      create table if not exists task_specs (
        task_id text primary key,
        task_number integer not null unique,
        title text not null,
        chapter_markdown text,
        goal_markdown text,
        context_markdown text,
        required_work_markdown text,
        non_goals_markdown text,
        acceptance_criteria_json text not null,
        dependencies_json text not null,
        tags_json text not null default '[]',
        updated_at text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_task_specs_task_number
        on task_specs(task_number);

      create table if not exists task_tag_updates (
        update_id text primary key,
        task_id text not null,
        task_number integer not null,
        actor_agent_id text not null,
        previous_tags_json text not null,
        new_tags_json text not null,
        reason text not null,
        updated_at text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_task_tag_updates_task
        on task_tag_updates(task_id, updated_at desc);

      create table if not exists envelope_task_mappings (
        envelope_id text primary key,
        task_id text not null,
        task_number integer not null,
        materialized_at text not null,
        foreign key (task_id) references task_lifecycle(task_id)
      );

      create index if not exists idx_envelope_task_mappings_task_id
        on envelope_task_mappings(task_id, materialized_at desc);

      create table if not exists narada_andrey_task_role_preferences (
        task_id text primary key,
        preferred_role text,
        target_role text,
        preferred_agent_id text,
        updated_at text not null
      );

      commit;
    `);
    } catch (error) {
      try {
        this.db.exec('rollback;');
      } catch {
        // Ignore rollback failure; the original schema error is more useful.
      }
      throw error;
    }
    const lifecycleColumns = this.db
      .prepare('pragma table_info(task_lifecycle)')
      .all() as Array<{ name?: string }>;
    if (!lifecycleColumns.some((column) => column.name === 'closure_mode')) {
      this.db.exec('alter table task_lifecycle add column closure_mode text;');
    }
    if (!lifecycleColumns.some((column) => column.name === 'relative_priority')) {
      this.db.exec('alter table task_lifecycle add column relative_priority integer default 0;');
    }
    if (!lifecycleColumns.some((column) => column.name === 'priority_reason')) {
      this.db.exec('alter table task_lifecycle add column priority_reason text;');
    }
    ensureColumn(this.db, 'task_specs', 'tags_json', "text not null default '[]'");
    ensureTaskReportsDirectiveIdColumn(this.db);
    ensureDirectedObligationTargetRefShape(this.db);
  }

  upsertLifecycle(row: TaskLifecycleRow): void {
    const stmt = this.db.prepare(`
      insert into task_lifecycle (
        task_id, task_number, status, governed_by, closed_at, closed_by,
        closure_mode, relative_priority, priority_reason, reopened_at, reopened_by, continuation_packet_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(task_id) do update set
        status = excluded.status,
        governed_by = excluded.governed_by,
        closed_at = excluded.closed_at,
        closed_by = excluded.closed_by,
        closure_mode = excluded.closure_mode,
        relative_priority = excluded.relative_priority,
        priority_reason = excluded.priority_reason,
        reopened_at = excluded.reopened_at,
        reopened_by = excluded.reopened_by,
        continuation_packet_json = excluded.continuation_packet_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      row.task_id,
      row.task_number,
      row.status,
      row.governed_by,
      row.closed_at,
      row.closed_by,
      row.closure_mode ?? null,
      row.relative_priority ?? 0,
      row.priority_reason ?? null,
      row.reopened_at,
      row.reopened_by,
      row.continuation_packet_json,
      row.updated_at,
    );
  }

  getLifecycle(taskId: string): TaskLifecycleRow | undefined {
    const row = this.db
      .prepare("select * from task_lifecycle where task_id = ?")
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToLifecycle(row) : undefined;
  }

  getLifecycleByNumber(taskNumber: number): TaskLifecycleRow | undefined {
    const row = this.db
      .prepare("select * from task_lifecycle where task_number = ?")
      .get(taskNumber) as Record<string, unknown> | undefined;
    return row ? rowToLifecycle(row) : undefined;
  }

  getAllLifecycle(): TaskLifecycleRow[] {
    const rows = this.db
      .prepare("select * from task_lifecycle")
      .all() as Record<string, unknown>[];
    return rows.map(rowToLifecycle);
  }

  getAllLifecycleWithDetails(status?: string | null): TaskLifecycleDetailRow[] {
    const statusClause = status ? 'where l.status = ?' : '';
    const rows = this.db
      .prepare(`
        select
          l.*,
          s.title as title,
          a.agent_id as assigned_agent,
          p.target_role as target_role,
          p.preferred_role as preferred_role,
          p.preferred_agent_id as preferred_agent_id
        from task_lifecycle l
        left join task_specs s on s.task_id = l.task_id
        left join task_assignments a
          on a.assignment_id = (
            select assignment_id
            from task_assignments
            where task_id = l.task_id and released_at is null
            order by claimed_at desc
            limit 1
          )
        left join narada_andrey_task_role_preferences p on p.task_id = l.task_id
        ${statusClause}
        order by l.task_number asc
      `)
      .all(...(status ? [status] : [])) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...rowToLifecycle(row),
      title: row.title ? String(row.title) : null,
      assigned_agent: row.assigned_agent ? String(row.assigned_agent) : null,
      target_role: row.target_role ? String(row.target_role) : null,
      preferred_role: row.preferred_role ? String(row.preferred_role) : null,
      preferred_agent_id: row.preferred_agent_id ? String(row.preferred_agent_id) : null,
    }));
  }

  getAllLifecyclePaginated(options: { since?: string | null; offset?: number; limit?: number } = {}): TaskLifecycleDetailRow[] {
    const where = options.since ? 'where l.updated_at >= ?' : '';
    const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 100;
    const offset = Number.isFinite(options.offset) ? Math.max(0, Number(options.offset)) : 0;
    const params = options.since ? [options.since, limit, offset] : [limit, offset];
    const rows = this.db
      .prepare(`
        select
          l.*,
          s.title as title,
          a.agent_id as assigned_agent,
          p.target_role as target_role,
          p.preferred_role as preferred_role,
          p.preferred_agent_id as preferred_agent_id
        from task_lifecycle l
        left join task_specs s on s.task_id = l.task_id
        left join task_assignments a
          on a.assignment_id = (
            select assignment_id
            from task_assignments
            where task_id = l.task_id and released_at is null
            order by claimed_at desc
            limit 1
          )
        left join narada_andrey_task_role_preferences p on p.task_id = l.task_id
        ${where}
        order by l.updated_at desc, l.task_number desc
        limit ? offset ?
      `)
      .all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...rowToLifecycle(row),
      title: row.title ? String(row.title) : null,
      assigned_agent: row.assigned_agent ? String(row.assigned_agent) : null,
      target_role: row.target_role ? String(row.target_role) : null,
      preferred_role: row.preferred_role ? String(row.preferred_role) : null,
      preferred_agent_id: row.preferred_agent_id ? String(row.preferred_agent_id) : null,
    }));
  }

  updateStatus(
    taskId: string,
    status: TaskStatus,
    actor: string,
    updates?: Partial<Omit<TaskLifecycleRow, "task_id" | "task_number" | "status">>,
  ): void {
    const existing = this.getLifecycle(taskId);
    if (!existing) {
      throw new Error(`Cannot update status: task ${taskId} not found in lifecycle store`);
    }

    const merged: TaskLifecycleRow = {
      ...existing,
      status,
      updated_at: nowIso(),
      governed_by: updates?.governed_by ?? existing.governed_by,
      closed_at: updates?.closed_at ?? existing.closed_at,
      closed_by: updates?.closed_by ?? existing.closed_by,
      closure_mode: updates?.closure_mode ?? existing.closure_mode ?? null,
      reopened_at: updates?.reopened_at ?? existing.reopened_at,
      reopened_by: updates?.reopened_by ?? existing.reopened_by,
      continuation_packet_json: updates?.continuation_packet_json ?? existing.continuation_packet_json,
    };

    this.upsertLifecycle(merged);
  }

  insertAssignment(assignment: TaskAssignmentRow): void {
    const stmt = this.db.prepare(`
      insert into task_assignments (
        assignment_id, task_id, agent_id, agent_identity_ref_json, claimed_at, released_at, release_reason, intent
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      assignment.assignment_id,
      assignment.task_id,
      assignment.agent_id,
      assignment.agent_identity_ref_json ?? null,
      assignment.claimed_at,
      assignment.released_at,
      assignment.release_reason,
      assignment.intent,
    );
  }

  getActiveAssignment(taskId: string): TaskAssignmentRow | undefined {
    const row = this.db
      .prepare(
        `select * from task_assignments
         where task_id = ? and released_at is null
         order by claimed_at desc
         limit 1`,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToAssignment(row) : undefined;
  }

  getAssignments(taskId: string): TaskAssignmentRow[] {
    const rows = this.db
      .prepare(
        `select * from task_assignments
         where task_id = ?
         order by claimed_at desc`,
      )
      .all(taskId) as Record<string, unknown>[];
    if (rows.length > 0) {
      return rows.map(rowToAssignment);
    }
    return [];
  }

  getAssignmentRecord(taskId: string): TaskAssignmentRecordRow | undefined {
    const assignments = this.getAssignments(taskId);
    if (assignments.length === 0) return undefined;
    return {
      task_id: taskId,
      record_json: JSON.stringify({
        task_id: taskId,
        assignments: assignments.map((assignment) => ({
          agent_id: assignment.agent_id,
          claimed_at: assignment.claimed_at,
          claim_context: null,
          released_at: assignment.released_at,
          release_reason: assignment.release_reason,
          intent: assignment.intent,
        })),
        continuations: [],
      }),
      updated_at: assignments[0]?.claimed_at ?? nowIso(),
    };
  }

  upsertAssignmentRecord(record: TaskAssignmentRecordRow): void {
    const parsed = JSON.parse(record.record_json) as {
      assignments?: Array<{
        agent_id?: string;
        claimed_at?: string;
        released_at?: string | null;
        release_reason?: string | null;
        intent?: AssignmentIntent | null;
      }>;
    };
    for (const assignment of parsed.assignments ?? []) {
      if (!assignment.agent_id || !assignment.claimed_at) continue;
      const existing = this.db
        .prepare('select assignment_id from task_assignments where task_id = ? and agent_id = ? and claimed_at = ?')
        .get(record.task_id, assignment.agent_id, assignment.claimed_at) as { assignment_id?: string } | undefined;
      if (!existing?.assignment_id) continue;
      this.db
        .prepare(`update task_assignments
          set released_at = ?, release_reason = ?, intent = ?
          where assignment_id = ?`)
        .run(
          assignment.released_at ?? null,
          assignment.release_reason ?? null,
          assignment.intent ?? 'primary',
          existing.assignment_id,
        );
    }
  }

  releaseAssignment(assignmentId: string, releaseReason: string): void {
    const stmt = this.db.prepare(`
      update task_assignments
      set released_at = ?, release_reason = ?
      where assignment_id = ?
    `);
    const result = stmt.run(nowIso(), releaseReason, assignmentId);
    if (result.changes === 0) {
      throw new Error(`Assignment ${assignmentId} not found`);
    }
  }

  upsertAssignmentIntent(intent: AssignmentIntentRow): void {
    const stmt = this.db.prepare(`
      insert into assignment_intents (
        request_id, kind, task_id, task_number, agent_id, requested_by,
        requested_at, reason, no_claim, status, rejection_reason, assignment_id,
        previous_agent_id, lifecycle_status_before, lifecycle_status_after,
        roster_status_after, confirmation_json, warnings_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(request_id) do update set
        kind = excluded.kind,
        task_id = excluded.task_id,
        task_number = excluded.task_number,
        agent_id = excluded.agent_id,
        requested_by = excluded.requested_by,
        requested_at = excluded.requested_at,
        reason = excluded.reason,
        no_claim = excluded.no_claim,
        status = excluded.status,
        rejection_reason = excluded.rejection_reason,
        assignment_id = excluded.assignment_id,
        previous_agent_id = excluded.previous_agent_id,
        lifecycle_status_before = excluded.lifecycle_status_before,
        lifecycle_status_after = excluded.lifecycle_status_after,
        roster_status_after = excluded.roster_status_after,
        confirmation_json = excluded.confirmation_json,
        warnings_json = excluded.warnings_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      intent.request_id,
      intent.kind,
      intent.task_id,
      intent.task_number,
      intent.agent_id,
      intent.requested_by,
      intent.requested_at,
      intent.reason,
      intent.no_claim,
      intent.status,
      intent.rejection_reason,
      intent.assignment_id,
      intent.previous_agent_id,
      intent.lifecycle_status_before,
      intent.lifecycle_status_after,
      intent.roster_status_after,
      intent.confirmation_json,
      intent.warnings_json,
      intent.updated_at,
    );
  }

  getAssignmentIntent(requestId: string): AssignmentIntentRow | undefined {
    const row = this.db
      .prepare("select * from assignment_intents where request_id = ?")
      .get(requestId) as Record<string, unknown> | undefined;
    return row ? rowToAssignmentIntent(row) : undefined;
  }

  listAssignmentIntentsForTask(taskId: string): AssignmentIntentRow[] {
    const rows = this.db
      .prepare(
        `select * from assignment_intents
         where task_id = ?
         order by requested_at desc`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToAssignmentIntent);
  }

  upsertEvidenceBundle(bundle: EvidenceBundleRow): void {
    const stmt = this.db.prepare(`
      insert into evidence_bundles (
        bundle_id, task_id, task_number, report_ids_json, verification_run_ids_json,
        acceptance_criteria_json, review_ids_json, changed_files_json, residuals_json,
        assembled_at, assembled_by
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(bundle_id) do update set
        task_id = excluded.task_id,
        task_number = excluded.task_number,
        report_ids_json = excluded.report_ids_json,
        verification_run_ids_json = excluded.verification_run_ids_json,
        acceptance_criteria_json = excluded.acceptance_criteria_json,
        review_ids_json = excluded.review_ids_json,
        changed_files_json = excluded.changed_files_json,
        residuals_json = excluded.residuals_json,
        assembled_at = excluded.assembled_at,
        assembled_by = excluded.assembled_by
    `);
    stmt.run(
      bundle.bundle_id,
      bundle.task_id,
      bundle.task_number,
      bundle.report_ids_json,
      bundle.verification_run_ids_json,
      bundle.acceptance_criteria_json,
      bundle.review_ids_json,
      bundle.changed_files_json,
      bundle.residuals_json,
      bundle.assembled_at,
      bundle.assembled_by,
    );
  }

  getEvidenceBundle(bundleId: string): EvidenceBundleRow | undefined {
    const row = this.db
      .prepare("select * from evidence_bundles where bundle_id = ?")
      .get(bundleId) as Record<string, unknown> | undefined;
    return row ? rowToEvidenceBundle(row) : undefined;
  }

  listEvidenceBundlesForTask(taskId: string): EvidenceBundleRow[] {
    const rows = this.db
      .prepare(
        `select * from evidence_bundles
         where task_id = ?
         order by assembled_at desc`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToEvidenceBundle);
  }

  upsertEvidenceAdmissionResult(result: EvidenceAdmissionResultRow): void {
    const stmt = this.db.prepare(`
      insert into evidence_admission_results (
        admission_id, bundle_id, task_id, task_number, verdict, methods_json,
        blockers_json, lifecycle_eligible_status, admitted_at, admitted_by, confirmation_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(admission_id) do update set
        bundle_id = excluded.bundle_id,
        task_id = excluded.task_id,
        task_number = excluded.task_number,
        verdict = excluded.verdict,
        methods_json = excluded.methods_json,
        blockers_json = excluded.blockers_json,
        lifecycle_eligible_status = excluded.lifecycle_eligible_status,
        admitted_at = excluded.admitted_at,
        admitted_by = excluded.admitted_by,
        confirmation_json = excluded.confirmation_json
    `);
    stmt.run(
      result.admission_id,
      result.bundle_id,
      result.task_id,
      result.task_number,
      result.verdict,
      result.methods_json,
      result.blockers_json,
      result.lifecycle_eligible_status,
      result.admitted_at,
      result.admitted_by,
      result.confirmation_json,
    );
  }

  getEvidenceAdmissionResult(admissionId: string): EvidenceAdmissionResultRow | undefined {
    const row = this.db
      .prepare("select * from evidence_admission_results where admission_id = ?")
      .get(admissionId) as Record<string, unknown> | undefined;
    return row ? rowToEvidenceAdmissionResult(row) : undefined;
  }

  getLatestEvidenceAdmissionResult(taskId: string): EvidenceAdmissionResultRow | undefined {
    const row = this.db
      .prepare(
        `select * from evidence_admission_results
         where task_id = ?
         order by admitted_at desc, rowid desc
         limit 1`,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToEvidenceAdmissionResult(row) : undefined;
  }

  upsertCriteriaProof(proof: CriteriaProofRow): void {
    const stmt = this.db.prepare(`
      insert into criteria_proofs (
        proof_id, task_id, task_number, proved_by, proved_at,
        criteria_json, verification_binding_json
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(proof_id) do update set
        task_id = excluded.task_id,
        task_number = excluded.task_number,
        proved_by = excluded.proved_by,
        proved_at = excluded.proved_at,
        criteria_json = excluded.criteria_json,
        verification_binding_json = excluded.verification_binding_json
    `);
    stmt.run(
      proof.proof_id,
      proof.task_id,
      proof.task_number,
      proof.proved_by,
      proof.proved_at,
      proof.criteria_json,
      proof.verification_binding_json,
    );
  }

  getLatestCriteriaProof(taskId: string): CriteriaProofRow | undefined {
    const row = this.db
      .prepare(
        `select * from criteria_proofs
         where task_id = ?
         order by proved_at desc
         limit 1`,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToCriteriaProof(row) : undefined;
  }

  upsertObservationArtifact(artifact: ObservationArtifactRow): void {
    const stmt = this.db.prepare(`
      insert into observation_artifacts (
        artifact_id, artifact_type, source_operator, task_id, task_number, agent_id,
        artifact_uri, digest, admitted_view_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(artifact_id) do update set
        artifact_type = excluded.artifact_type,
        source_operator = excluded.source_operator,
        task_id = excluded.task_id,
        task_number = excluded.task_number,
        agent_id = excluded.agent_id,
        artifact_uri = excluded.artifact_uri,
        digest = excluded.digest,
        admitted_view_json = excluded.admitted_view_json,
        created_at = excluded.created_at
    `);
    stmt.run(
      artifact.artifact_id,
      artifact.artifact_type,
      artifact.source_operator,
      artifact.task_id,
      artifact.task_number,
      artifact.agent_id,
      artifact.artifact_uri,
      artifact.digest,
      artifact.admitted_view_json,
      artifact.created_at,
    );
  }

  getObservationArtifact(artifactId: string): ObservationArtifactRow | undefined {
    const row = this.db
      .prepare("select * from observation_artifacts where artifact_id = ?")
      .get(artifactId) as Record<string, unknown> | undefined;
    return row ? rowToObservationArtifact(row) : undefined;
  }

  listObservationArtifacts(limit: number): ObservationArtifactRow[] {
    const bounded = Math.max(1, Math.min(limit, 100));
    const rows = this.db
      .prepare(
        `select * from observation_artifacts
         order by created_at desc
         limit ?`,
      )
      .all(bounded) as Record<string, unknown>[];
    return rows.map(rowToObservationArtifact);
  }

  upsertReconciliationFinding(finding: ReconciliationFindingRow): void {
    const stmt = this.db.prepare(`
      insert into reconciliation_findings (
        finding_id, task_id, task_number, surfaces_json, expected_authority,
        observed_mismatch_json, severity, proposed_repair_json, status, detected_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(finding_id) do update set
        task_id = excluded.task_id,
        task_number = excluded.task_number,
        surfaces_json = excluded.surfaces_json,
        expected_authority = excluded.expected_authority,
        observed_mismatch_json = excluded.observed_mismatch_json,
        severity = excluded.severity,
        proposed_repair_json = excluded.proposed_repair_json,
        status = excluded.status,
        detected_at = excluded.detected_at
    `);
    stmt.run(
      finding.finding_id,
      finding.task_id,
      finding.task_number,
      finding.surfaces_json,
      finding.expected_authority,
      finding.observed_mismatch_json,
      finding.severity,
      finding.proposed_repair_json,
      finding.status,
      finding.detected_at,
    );
  }

  getReconciliationFinding(findingId: string): ReconciliationFindingRow | undefined {
    const row = this.db
      .prepare("select * from reconciliation_findings where finding_id = ?")
      .get(findingId) as Record<string, unknown> | undefined;
    return row ? rowToReconciliationFinding(row) : undefined;
  }

  listReconciliationFindings(status?: string): ReconciliationFindingRow[] {
    const rows = status
      ? this.db.prepare("select * from reconciliation_findings where status = ? order by detected_at desc").all(status)
      : this.db.prepare("select * from reconciliation_findings order by detected_at desc").all();
    return (rows as Record<string, unknown>[]).map(rowToReconciliationFinding);
  }

  upsertReconciliationRepair(repair: ReconciliationRepairRow): void {
    const stmt = this.db.prepare(`
      insert into reconciliation_repairs (
        repair_id, finding_id, applied, changed_surfaces_json, before_json,
        after_json, verification_json, repaired_at, repaired_by
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(repair_id) do update set
        finding_id = excluded.finding_id,
        applied = excluded.applied,
        changed_surfaces_json = excluded.changed_surfaces_json,
        before_json = excluded.before_json,
        after_json = excluded.after_json,
        verification_json = excluded.verification_json,
        repaired_at = excluded.repaired_at,
        repaired_by = excluded.repaired_by
    `);
    stmt.run(
      repair.repair_id,
      repair.finding_id,
      repair.applied,
      repair.changed_surfaces_json,
      repair.before_json,
      repair.after_json,
      repair.verification_json,
      repair.repaired_at,
      repair.repaired_by,
    );
  }

  getReconciliationRepair(repairId: string): ReconciliationRepairRow | undefined {
    const row = this.db
      .prepare("select * from reconciliation_repairs where repair_id = ?")
      .get(repairId) as Record<string, unknown> | undefined;
    return row ? rowToReconciliationRepair(row) : undefined;
  }

  insertReport(report: TaskReportRow): void {
    ensureTaskReportsDirectiveIdColumn(this.db);
    ensureIdentityRefColumns(this.db);
    const stmt = this.db.prepare(`
      insert into task_reports (
        report_id, task_id, agent_id, agent_identity_ref_json, summary, changed_files_json, verification_json, directive_id, submitted_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(report_id) do update set
        task_id = excluded.task_id,
        agent_id = excluded.agent_id,
        agent_identity_ref_json = excluded.agent_identity_ref_json,
        summary = excluded.summary,
        changed_files_json = excluded.changed_files_json,
        verification_json = excluded.verification_json,
        directive_id = excluded.directive_id,
        submitted_at = excluded.submitted_at
    `);
    stmt.run(
      report.report_id,
      report.task_id,
      report.agent_id,
      report.agent_identity_ref_json ?? null,
      report.summary,
      report.changed_files_json,
      report.verification_json,
      report.directive_id ?? null,
      report.submitted_at,
    );
  }

  listReports(taskId: string): TaskReportRow[] {
    const rows = this.db
      .prepare(
        `select * from task_reports
         where task_id = ?
         order by submitted_at desc`,
      )
      .all(taskId) as Record<string, unknown>[];
    if (rows.length > 0) {
      return rows.map(rowToReport);
    }
    const records = this.listReportRecords(taskId);
    return records.map((record) => {
      try {
        const parsed = JSON.parse(record.report_json) as {
          summary?: string;
          changed_files?: string[];
          verification?: unknown;
        };
        return {
          report_id: record.report_id,
          task_id: record.task_id,
          agent_id: record.agent_id,
          summary: parsed.summary ?? "",
          changed_files_json: Array.isArray(parsed.changed_files)
            ? JSON.stringify(parsed.changed_files)
            : null,
          verification_json: parsed.verification !== undefined
            ? JSON.stringify(parsed.verification)
            : null,
          submitted_at: record.reported_at,
        };
      } catch {
        return {
          report_id: record.report_id,
          task_id: record.task_id,
          agent_id: record.agent_id,
          summary: "",
          changed_files_json: null,
          verification_json: null,
          submitted_at: record.reported_at,
        };
      }
    });
  }

  upsertReportRecord(record: ReportRecordRow): void {
    const stmt = this.db.prepare(`
      insert into task_report_records (
        report_id, task_id, assignment_id, agent_id, agent_identity_ref_json, reported_at, report_json
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(report_id) do update set
        task_id = excluded.task_id,
        assignment_id = excluded.assignment_id,
        agent_id = excluded.agent_id,
        agent_identity_ref_json = excluded.agent_identity_ref_json,
        reported_at = excluded.reported_at,
        report_json = excluded.report_json
    `);
    stmt.run(
      record.report_id,
      record.task_id,
      record.assignment_id,
      record.agent_id,
      record.agent_identity_ref_json ?? null,
      record.reported_at,
      record.report_json,
    );
  }

  getReportRecord(reportId: string): ReportRecordRow | undefined {
    const row = this.db
      .prepare("select * from task_report_records where report_id = ?")
      .get(reportId) as Record<string, unknown> | undefined;
    return row ? rowToReportRecord(row) : undefined;
  }

  listReportRecords(taskId: string): ReportRecordRow[] {
    const rows = this.db
      .prepare(
        `select * from task_report_records
         where task_id = ?
         order by reported_at desc`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToReportRecord);
  }

  upsertPromotionRecord(record: PromotionRecordRow): void {
    const stmt = this.db.prepare(`
      insert into task_promotion_records (
        promotion_id, task_id, task_number, agent_id, requested_by, requested_at, status, promotion_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(promotion_id) do update set
        task_id = excluded.task_id,
        task_number = excluded.task_number,
        agent_id = excluded.agent_id,
        requested_by = excluded.requested_by,
        requested_at = excluded.requested_at,
        status = excluded.status,
        promotion_json = excluded.promotion_json
    `);
    stmt.run(
      record.promotion_id,
      record.task_id,
      record.task_number,
      record.agent_id,
      record.requested_by,
      record.requested_at,
      record.status,
      record.promotion_json,
    );
  }

  getPromotionRecord(promotionId: string): PromotionRecordRow | undefined {
    const row = this.db
      .prepare("select * from task_promotion_records where promotion_id = ?")
      .get(promotionId) as Record<string, unknown> | undefined;
    return row ? rowToPromotionRecord(row) : undefined;
  }

  listPromotionRecords(taskId?: string): PromotionRecordRow[] {
    const rows = taskId
      ? this.db
          .prepare(
            `select * from task_promotion_records
             where task_id = ?
             order by requested_at desc`,
          )
          .all(taskId) as Record<string, unknown>[]
      : this.db
          .prepare(
            `select * from task_promotion_records
             order by requested_at desc`,
          )
          .all() as Record<string, unknown>[];
    return rows.map(rowToPromotionRecord);
  }

  insertReview(review: NewTaskReviewRow): void {
    const stmt = this.db.prepare(`
      insert into task_reviews (
        review_id, task_id, reviewer_agent_id, verdict, findings_json, reviewed_at
      ) values (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      review.review_id,
      review.task_id,
      review.reviewer_agent_id,
      review.verdict,
      review.findings_json,
      review.reviewed_at,
    );
  }

  listReviews(taskId: string): TaskReviewRow[] {
    const rows = this.db
      .prepare(
        `select * from task_reviews
         where task_id = ?
         order by reviewed_at desc, rowid desc`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToReview);
  }

  listAllReviews(): TaskReviewRow[] {
    const rows = this.db
      .prepare(
        `select * from task_reviews
         order by reviewed_at desc, rowid desc`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToReview);
  }

  upsertTaskDependency(row: TaskDependencyRow): void {
    const stmt = this.db.prepare(`
      insert into task_dependencies (
        dependency_id, parent_task_id, required_task_id, kind,
        satisfying_outcomes_json, status, created_by, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(dependency_id) do update set
        parent_task_id = excluded.parent_task_id,
        required_task_id = excluded.required_task_id,
        kind = excluded.kind,
        satisfying_outcomes_json = excluded.satisfying_outcomes_json,
        status = excluded.status
    `);
    stmt.run(
      row.dependency_id,
      row.parent_task_id,
      row.required_task_id,
      row.kind,
      row.satisfying_outcomes_json,
      row.status,
      row.created_by,
      row.created_at,
    );
  }

  getTaskDependency(dependencyId: string): TaskDependencyRow | undefined {
    const row = this.db
      .prepare('select * from task_dependencies where dependency_id = ?')
      .get(dependencyId) as Record<string, unknown> | undefined;
    return row ? rowToTaskDependency(row) : undefined;
  }

  listTaskDependenciesForParent(parentTaskId: string): TaskDependencyRow[] {
    const rows = this.db
      .prepare(
        `select * from task_dependencies
         where parent_task_id = ?
         order by created_at desc, rowid desc`,
      )
      .all(parentTaskId) as Record<string, unknown>[];
    return rows.map(rowToTaskDependency);
  }

  listTaskDependenciesForRequired(requiredTaskId: string): TaskDependencyRow[] {
    const rows = this.db
      .prepare(
        `select * from task_dependencies
         where required_task_id = ?
         order by created_at desc, rowid desc`,
      )
      .all(requiredTaskId) as Record<string, unknown>[];
    return rows.map(rowToTaskDependency);
  }

  upsertTaskOutcomeContract(row: TaskOutcomeContractRow): void {
    const stmt = this.db.prepare(`
      insert into task_outcome_contracts (
        contract_id, task_id, outcome_type, allowed_outcomes_json,
        satisfying_outcomes_json, blocking_outcomes_json, required_fields_json,
        capability_requirement, created_by, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(contract_id) do update set
        task_id = excluded.task_id,
        outcome_type = excluded.outcome_type,
        allowed_outcomes_json = excluded.allowed_outcomes_json,
        satisfying_outcomes_json = excluded.satisfying_outcomes_json,
        blocking_outcomes_json = excluded.blocking_outcomes_json,
        required_fields_json = excluded.required_fields_json,
        capability_requirement = excluded.capability_requirement
    `);
    stmt.run(
      row.contract_id,
      row.task_id,
      row.outcome_type,
      row.allowed_outcomes_json,
      row.satisfying_outcomes_json,
      row.blocking_outcomes_json,
      row.required_fields_json,
      row.capability_requirement,
      row.created_by,
      row.created_at,
    );
  }

  getTaskOutcomeContract(contractId: string): TaskOutcomeContractRow | undefined {
    const row = this.db
      .prepare('select * from task_outcome_contracts where contract_id = ?')
      .get(contractId) as Record<string, unknown> | undefined;
    return row ? rowToTaskOutcomeContract(row) : undefined;
  }

  getLatestTaskOutcomeContract(taskId: string): TaskOutcomeContractRow | undefined {
    const row = this.db
      .prepare(
        `select * from task_outcome_contracts
         where task_id = ?
         order by created_at desc, rowid desc
         limit 1`,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToTaskOutcomeContract(row) : undefined;
  }

  listTaskOutcomeContracts(taskId: string): TaskOutcomeContractRow[] {
    const rows = this.db
      .prepare(
        `select * from task_outcome_contracts
         where task_id = ?
         order by created_at desc, rowid desc`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToTaskOutcomeContract);
  }

  insertTaskOutcome(row: TaskOutcomeRow): void {
    const stmt = this.db.prepare(`
      insert into task_outcomes (
        outcome_id, task_id, contract_id, agent_id, outcome,
        summary, findings_json, evidence_refs_json, admitted_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      row.outcome_id,
      row.task_id,
      row.contract_id,
      row.agent_id,
      row.outcome,
      row.summary,
      row.findings_json,
      row.evidence_refs_json,
      row.admitted_at,
    );
  }

  listTaskOutcomes(taskId: string): TaskOutcomeRow[] {
    const rows = this.db
      .prepare(
        `select * from task_outcomes
         where task_id = ?
         order by admitted_at desc, rowid desc`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToTaskOutcome);
  }

  getLatestTaskOutcome(taskId: string): TaskOutcomeRow | undefined {
    const row = this.db
      .prepare(
        `select * from task_outcomes
         where task_id = ?
         order by admitted_at desc, rowid desc
         limit 1`,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToTaskOutcome(row) : undefined;
  }

  upsertTaskDependencyDisposition(row: TaskDependencyDispositionRow): void {
    const stmt = this.db.prepare(`
      insert into task_dependency_dispositions (
        disposition_id, dependency_id, required_outcome_id, kind, status,
        target_task_id, routed_obligation_id, authority_basis_json,
        summary, created_by, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(disposition_id) do update set
        dependency_id = excluded.dependency_id,
        required_outcome_id = excluded.required_outcome_id,
        kind = excluded.kind,
        status = excluded.status,
        target_task_id = excluded.target_task_id,
        routed_obligation_id = excluded.routed_obligation_id,
        authority_basis_json = excluded.authority_basis_json,
        summary = excluded.summary
    `);
    stmt.run(
      row.disposition_id,
      row.dependency_id,
      row.required_outcome_id,
      row.kind,
      row.status,
      row.target_task_id,
      row.routed_obligation_id,
      row.authority_basis_json,
      row.summary,
      row.created_by,
      row.created_at,
    );
  }

  listTaskDependencyDispositions(dependencyId: string): TaskDependencyDispositionRow[] {
    const rows = this.db
      .prepare(
        `select * from task_dependency_dispositions
         where dependency_id = ?
         order by created_at desc, rowid desc`,
      )
      .all(dependencyId) as Record<string, unknown>[];
    return rows.map(rowToTaskDependencyDisposition);
  }

  getLatestTaskDependencyDisposition(dependencyId: string, requiredOutcomeId?: string | null): TaskDependencyDispositionRow | undefined {
    const query = requiredOutcomeId
      ? `select * from task_dependency_dispositions
         where dependency_id = ? and required_outcome_id = ?
         order by created_at desc, rowid desc
         limit 1`
      : `select * from task_dependency_dispositions
         where dependency_id = ?
         order by created_at desc, rowid desc
         limit 1`;
    const row = requiredOutcomeId
      ? this.db.prepare(query).get(dependencyId, requiredOutcomeId) as Record<string, unknown> | undefined
      : this.db.prepare(query).get(dependencyId) as Record<string, unknown> | undefined;
    return row ? rowToTaskDependencyDisposition(row) : undefined;
  }

  upsertTaskConflictPolicyEvidence(row: TaskConflictPolicyEvidenceRow): void {
    const stmt = this.db.prepare(`
      insert into task_conflict_policy_evidence (
        evidence_id, dependency_id, required_task_id, required_outcome_id,
        agent_id, effective_operator_identity, gated_work_operator_identity,
        conflict_detected, policy_mode, authorization_required,
        authorization_basis_json, annotation_recorded, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(evidence_id) do update set
        dependency_id = excluded.dependency_id,
        required_task_id = excluded.required_task_id,
        required_outcome_id = excluded.required_outcome_id,
        agent_id = excluded.agent_id,
        effective_operator_identity = excluded.effective_operator_identity,
        gated_work_operator_identity = excluded.gated_work_operator_identity,
        conflict_detected = excluded.conflict_detected,
        policy_mode = excluded.policy_mode,
        authorization_required = excluded.authorization_required,
        authorization_basis_json = excluded.authorization_basis_json,
        annotation_recorded = excluded.annotation_recorded
    `);
    stmt.run(
      row.evidence_id,
      row.dependency_id,
      row.required_task_id,
      row.required_outcome_id,
      row.agent_id,
      row.effective_operator_identity,
      row.gated_work_operator_identity,
      row.conflict_detected ? 1 : 0,
      row.policy_mode,
      row.authorization_required ? 1 : 0,
      row.authorization_basis_json,
      row.annotation_recorded ? 1 : 0,
      row.created_at,
    );
  }

  listTaskConflictPolicyEvidence(dependencyId: string): TaskConflictPolicyEvidenceRow[] {
    const rows = this.db
      .prepare(
        `select * from task_conflict_policy_evidence
         where dependency_id = ?
         order by created_at desc, rowid desc`,
      )
      .all(dependencyId) as Record<string, unknown>[];
    return rows.map(rowToTaskConflictPolicyEvidence);
  }

  getLatestTaskConflictPolicyEvidence(dependencyId: string, requiredOutcomeId?: string | null): TaskConflictPolicyEvidenceRow | undefined {
    const query = requiredOutcomeId
      ? `select * from task_conflict_policy_evidence
         where dependency_id = ? and required_outcome_id = ?
         order by created_at desc, rowid desc
         limit 1`
      : `select * from task_conflict_policy_evidence
         where dependency_id = ?
         order by created_at desc, rowid desc
         limit 1`;
    const row = requiredOutcomeId
      ? this.db.prepare(query).get(dependencyId, requiredOutcomeId) as Record<string, unknown> | undefined
      : this.db.prepare(query).get(dependencyId) as Record<string, unknown> | undefined;
    return row ? rowToTaskConflictPolicyEvidence(row) : undefined;
  }

  insertDispatchPacket(packet: DispatchPacketRow): void {
    const stmt = this.db.prepare(`
      insert into dispatch_packets (
        packet_id, task_id, assignment_id, agent_id, picked_up_at, lease_expires_at,
        heartbeat_at, dispatch_status, sequence, created_by, target_session_id, target_session_title
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      packet.packet_id,
      packet.task_id,
      packet.assignment_id,
      packet.agent_id,
      packet.picked_up_at,
      packet.lease_expires_at,
      packet.heartbeat_at,
      packet.dispatch_status,
      packet.sequence,
      packet.created_by,
      packet.target_session_id ?? null,
      packet.target_session_title ?? null,
    );
  }

  getActiveDispatchPacketForAssignment(assignmentId: string): DispatchPacketRow | undefined {
    const row = this.db
      .prepare(
        `select * from dispatch_packets
         where assignment_id = ? and dispatch_status in ('picked_up', 'renewed')
         order by sequence desc
         limit 1`,
      )
      .get(assignmentId) as Record<string, unknown> | undefined;
    return row ? rowToDispatchPacket(row) : undefined;
  }

  getDispatchPacketsForTask(taskId: string): DispatchPacketRow[] {
    const rows = this.db
      .prepare(
        `select * from dispatch_packets
         where task_id = ?
         order by sequence desc`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToDispatchPacket);
  }

  getDispatchPacketsForAgent(agentId: string): DispatchPacketRow[] {
    const rows = this.db
      .prepare(
        `select * from dispatch_packets
         where agent_id = ?
         order by picked_up_at desc`,
      )
      .all(agentId) as Record<string, unknown>[];
    return rows.map(rowToDispatchPacket);
  }

  heartbeatDispatchPacket(packetId: string, extensionMinutes: number, maxLeaseMinutes: number): void {
    const packet = this.db
      .prepare("select * from dispatch_packets where packet_id = ?")
      .get(packetId) as Record<string, unknown> | undefined;
    if (!packet) {
      throw new Error(`Dispatch packet ${packetId} not found`);
    }

    const currentExpiry = new Date(String(packet.lease_expires_at));
    const now = new Date();
    const extensionMs = extensionMinutes * 60 * 1000;
    const maxLeaseMs = maxLeaseMinutes * 60 * 1000;
    const pickedUpAt = new Date(String(packet.picked_up_at));

    // Calculate new expiry: extend from current expiry by extensionMinutes, but cap at maxLeaseMinutes from pickup
    const candidateExpiry = new Date(currentExpiry.getTime() + extensionMs);
    const maxExpiry = new Date(pickedUpAt.getTime() + maxLeaseMs);
    const newExpiry = candidateExpiry > maxExpiry ? maxExpiry : candidateExpiry;

    this.db.prepare(`
      update dispatch_packets
      set heartbeat_at = ?, lease_expires_at = ?
      where packet_id = ?
    `).run(nowIso(), newExpiry.toISOString(), packetId);
  }

  updateDispatchStatus(packetId: string, status: DispatchPacketStatus): void {
    const stmt = this.db.prepare(`
      update dispatch_packets
      set dispatch_status = ?
      where packet_id = ?
    `);
    const result = stmt.run(status, packetId);
    if (result.changes === 0) {
      throw new Error(`Dispatch packet ${packetId} not found`);
    }
  }

  allocateTaskNumber(): number {
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare("select last_allocated from task_number_sequence where singleton = 1")
        .get() as { last_allocated: number } | undefined;
      const current = row?.last_allocated ?? 0;
      const next = current + 1;
      this.db
        .prepare("update task_number_sequence set last_allocated = ? where singleton = 1")
        .run(next);
      return next;
    });
    return txn();
  }

  getLastAllocated(): number {
    const row = this.db
      .prepare("select last_allocated from task_number_sequence where singleton = 1")
      .get() as { last_allocated: number } | undefined;
    return row?.last_allocated ?? 0;
  }

  ensureTaskNumberFloor(minValue: number): number {
    const tx = this.db.transaction((floorValue: number) => {
      const row = this.db
        .prepare("select last_allocated from task_number_sequence where singleton = 1")
        .get() as { last_allocated: number } | undefined;
      const current = row?.last_allocated ?? 0;
      if (current < floorValue) {
        this.db
          .prepare("update task_number_sequence set last_allocated = ? where singleton = 1")
          .run(floorValue);
        return floorValue;
      }
      return current;
    });
    return tx(minValue);
  }

  // Verification runs (Testing Intent Zone)
  insertVerificationRun(run: VerificationRunRow): void {
    const stmt = this.db.prepare(`
      insert into verification_runs (
        run_id, request_id, task_id, target_command, scope, timeout_seconds,
        requester_identity, requested_at, status, exit_code, duration_ms,
        metrics_json, stdout_digest, stderr_digest, stdout_excerpt, stderr_excerpt, completed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      run.run_id,
      run.request_id,
      run.task_id,
      run.target_command,
      run.scope,
      run.timeout_seconds,
      run.requester_identity,
      run.requested_at,
      run.status,
      run.exit_code,
      run.duration_ms,
      run.metrics_json,
      run.stdout_digest,
      run.stderr_digest,
      run.stdout_excerpt,
      run.stderr_excerpt,
      run.completed_at,
    );
  }

  updateVerificationRun(runId: string, updates: Partial<Omit<VerificationRunRow, 'run_id'>>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    values.push(runId);
    const stmt = this.db.prepare(`
      update verification_runs set ${fields.join(', ')} where run_id = ?
    `);
    const result = stmt.run(...values);
    if (result.changes === 0) {
      throw new Error(`Verification run ${runId} not found`);
    }
  }

  getVerificationRun(runId: string): VerificationRunRow | undefined {
    const row = this.db
      .prepare("select * from verification_runs where run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row ? rowToVerificationRun(row) : undefined;
  }

  listVerificationRunsForTask(taskId: string): VerificationRunRow[] {
    const rows = this.db
      .prepare("select * from verification_runs where task_id = ? order by requested_at desc")
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToVerificationRun);
  }

  listRecentVerificationRuns(limit: number): VerificationRunRow[] {
    const rows = this.db
      .prepare("select * from verification_runs order by requested_at desc limit ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToVerificationRun);
  }

  hasVerificationRunsForTask(taskId: string): boolean {
    const row = this.db
      .prepare("select 1 from verification_runs where task_id = ? limit 1")
      .get(taskId) as { 1: number } | undefined;
    return row !== undefined;
  }

  // Command runs (Command Execution Intent Zone)
  insertCommandRun(run: CommandRunRow): void {
    const stmt = this.db.prepare(`
      insert into command_runs (
        run_id, request_id, requester_id, requester_kind, command_argv_json,
        cwd, env_policy_json, timeout_seconds, stdin_policy_json,
        task_id, task_number, agent_id, side_effect_class, approval_posture,
        output_admission_profile, idempotency_key, requested_at, rationale,
        status, exit_code, signal, started_at, completed_at, duration_ms,
        stdout_digest, stderr_digest, stdout_admitted_excerpt, stderr_admitted_excerpt,
        full_output_artifact_uri, error_class, approval_outcome, telemetry_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      run.run_id,
      run.request_id,
      run.requester_id,
      run.requester_kind,
      run.command_argv_json,
      run.cwd,
      run.env_policy_json,
      run.timeout_seconds,
      run.stdin_policy_json,
      run.task_id,
      run.task_number,
      run.agent_id,
      run.side_effect_class,
      run.approval_posture,
      run.output_admission_profile,
      run.idempotency_key,
      run.requested_at,
      run.rationale,
      run.status,
      run.exit_code,
      run.signal,
      run.started_at,
      run.completed_at,
      run.duration_ms,
      run.stdout_digest,
      run.stderr_digest,
      run.stdout_admitted_excerpt,
      run.stderr_admitted_excerpt,
      run.full_output_artifact_uri,
      run.error_class,
      run.approval_outcome,
      run.telemetry_json,
      run.updated_at,
    );
  }

  updateCommandRun(runId: string, updates: Partial<Omit<CommandRunRow, 'run_id'>>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'command_argv' || key === 'env_policy' || key === 'stdin_policy') continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    values.push(runId);
    const result = this.db.prepare(`
      update command_runs set ${fields.join(', ')} where run_id = ?
    `).run(...values);
    if (result.changes === 0) {
      throw new Error(`Command run ${runId} not found`);
    }
  }

  getCommandRun(runId: string): CommandRunRow | undefined {
    const row = this.db
      .prepare("select * from command_runs where run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row ? rowToCommandRun(row) : undefined;
  }

  listCommandRuns(limit: number, taskId?: string | null, agentId?: string | null): CommandRunRow[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const where: string[] = [];
    const values: unknown[] = [];
    if (taskId) {
      where.push("task_id = ?");
      values.push(taskId);
    }
    if (agentId) {
      where.push("agent_id = ?");
      values.push(agentId);
    }
    values.push(boundedLimit);
    const sql = `
      select * from command_runs
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      order by requested_at desc
      limit ?
    `;
    const rows = this.db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map(rowToCommandRun);
  }

  // Repository publication intents
  upsertRepoPublication(publication: RepoPublicationRow): void {
    const stmt = this.db.prepare(`
      insert into repo_publications (
        publication_id, repo_root, branch, remote, commit_hash, base_ref,
        bundle_path, patch_path, task_number, requester_id, requested_at,
        status, pushed_at, confirmed_by, confirmation_json, failure_reason, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(publication_id) do update set
        repo_root = excluded.repo_root,
        branch = excluded.branch,
        remote = excluded.remote,
        commit_hash = excluded.commit_hash,
        base_ref = excluded.base_ref,
        bundle_path = excluded.bundle_path,
        patch_path = excluded.patch_path,
        task_number = excluded.task_number,
        requester_id = excluded.requester_id,
        requested_at = excluded.requested_at,
        status = excluded.status,
        pushed_at = excluded.pushed_at,
        confirmed_by = excluded.confirmed_by,
        confirmation_json = excluded.confirmation_json,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      publication.publication_id,
      publication.repo_root,
      publication.branch,
      publication.remote,
      publication.commit_hash,
      publication.base_ref,
      publication.bundle_path,
      publication.patch_path,
      publication.task_number,
      publication.requester_id,
      publication.requested_at,
      publication.status,
      publication.pushed_at,
      publication.confirmed_by,
      publication.confirmation_json,
      publication.failure_reason,
      publication.updated_at,
    );
  }

  getRepoPublication(publicationId: string): RepoPublicationRow | undefined {
    const row = this.db
      .prepare("select * from repo_publications where publication_id = ?")
      .get(publicationId) as Record<string, unknown> | undefined;
    return row ? rowToRepoPublication(row) : undefined;
  }

  listRepoPublications(limit: number, status?: RepoPublicationStatus | null): RepoPublicationRow[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = status
      ? this.db
        .prepare("select * from repo_publications where status = ? order by requested_at desc limit ?")
        .all(status, boundedLimit) as Record<string, unknown>[]
      : this.db
        .prepare("select * from repo_publications order by requested_at desc limit ?")
        .all(boundedLimit) as Record<string, unknown>[];
    return rows.map(rowToRepoPublication);
  }

  // Agent roster (Task 611 — SQLite authority)
  getRoster(): AgentRosterRow[] {
    const rows = this.db
      .prepare("select * from agent_roster order by agent_id")
      .all() as Record<string, unknown>[];
    return rows.map(rowToRosterEntry);
  }

  getRosterEntry(agentId: string): AgentRosterRow | undefined {
    const row = this.db
      .prepare("select * from agent_roster where agent_id = ?")
      .get(agentId) as Record<string, unknown> | undefined;
    return row ? rowToRosterEntry(row) : undefined;
  }

  upsertRosterEntry(entry: AgentRosterRow): void {
    const stmt = this.db.prepare(`
      insert into agent_roster (
        agent_id, role, capabilities_json, operator_identity, first_seen_at, last_active_at,
        status, task_number, last_done, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(agent_id) do update set
        role = excluded.role,
        capabilities_json = excluded.capabilities_json,
        operator_identity = excluded.operator_identity,
        first_seen_at = excluded.first_seen_at,
        last_active_at = excluded.last_active_at,
        status = excluded.status,
        task_number = excluded.task_number,
        last_done = excluded.last_done,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      entry.agent_id,
      entry.role,
      entry.capabilities_json,
      entry.operator_identity ?? null,
      entry.first_seen_at,
      entry.last_active_at,
      entry.status,
      entry.task_number,
      entry.last_done,
      entry.updated_at,
    );
  }

  upsertDirectedObligation(entry: DirectedObligationRow): void {
    const normalized = normalizeDirectedObligation(entry);
    const stmt = this.db.prepare(`
      insert into directed_obligations (
        obligation_id, source_kind, source_ref, source_agent_id,
        target_agent_id, target_role, target_ref, kind, status, task_id,
        task_number, evidence_json, consumption_rule_json, created_at,
        updated_at, consumed_at, consumed_by, consumption_ref
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(obligation_id) do update set
        source_kind = excluded.source_kind,
        source_ref = excluded.source_ref,
        source_agent_id = excluded.source_agent_id,
        target_agent_id = excluded.target_agent_id,
        target_role = excluded.target_role,
        target_ref = excluded.target_ref,
        kind = excluded.kind,
        status = excluded.status,
        task_id = excluded.task_id,
        task_number = excluded.task_number,
        evidence_json = excluded.evidence_json,
        consumption_rule_json = excluded.consumption_rule_json,
        updated_at = excluded.updated_at,
        consumed_at = excluded.consumed_at,
        consumed_by = excluded.consumed_by,
        consumption_ref = excluded.consumption_ref
    `);
    stmt.run(
      normalized.obligation_id,
      normalized.source_kind,
      normalized.source_ref,
      normalized.source_agent_id,
      normalized.target_agent_id,
      normalized.target_role,
      normalized.target_ref,
      normalized.kind,
      normalized.status,
      normalized.task_id,
      normalized.task_number,
      normalized.evidence_json,
      normalized.consumption_rule_json,
      normalized.created_at,
      normalized.updated_at,
      normalized.consumed_at,
      normalized.consumed_by,
      normalized.consumption_ref,
    );
  }

  getDirectedObligation(obligationId: string): DirectedObligationRow | undefined {
    const row = this.db
      .prepare("select * from directed_obligations where obligation_id = ?")
      .get(obligationId) as Record<string, unknown> | undefined;
    return row ? rowToDirectedObligation(row) : undefined;
  }

  listDirectedObligationsForTarget(
    targetAgentId: string,
    targetRole?: string | null,
    status?: DirectedObligationStatus | null,
  ): DirectedObligationRow[] {
    const rows = this.db
      .prepare(`
        select * from directed_obligations
        where (? is null or status = ?)
          and (
            target_agent_id = ?
            or (target_agent_id is null and target_role is not null and target_role = ?)
          )
        order by created_at asc, obligation_id asc
      `)
      .all(status ?? null, status ?? null, targetAgentId, targetRole ?? '') as Record<string, unknown>[];
    return rows.map(rowToDirectedObligation);
  }

  listDirectedObligationsForTask(taskId: string, status?: DirectedObligationStatus | null): DirectedObligationRow[] {
    const rows = this.db
      .prepare(`
        select * from directed_obligations
        where task_id = ?
          and (? is null or status = ?)
        order by created_at asc, obligation_id asc
      `)
      .all(taskId, status ?? null, status ?? null) as Record<string, unknown>[];
    return rows.map(rowToDirectedObligation);
  }

  transitionDirectedObligation(
    obligationId: string,
    status: DirectedObligationStatus,
    actor: string,
    consumptionRef?: string | null,
  ): void {
    const existing = this.getDirectedObligation(obligationId);
    if (!existing) throw new Error(`Directed obligation ${obligationId} not found`);
    const terminal = status !== "open";
    const now = nowIso();
    const stmt = this.db.prepare(`
      update directed_obligations
      set status = ?,
          updated_at = ?,
          consumed_at = ?,
          consumed_by = ?,
          consumption_ref = ?
      where obligation_id = ?
    `);
    stmt.run(
      status,
      now,
      terminal ? now : null,
      terminal ? actor : null,
      terminal ? consumptionRef ?? null : null,
      obligationId,
    );
  }

  listTaskNumberReservations(): TaskNumberReservationRow[] {
    const rows = this.db
      .prepare(
        `select * from task_number_reservations
         order by range_start asc, range_end asc`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToTaskNumberReservation);
  }

  upsertTaskNumberReservation(entry: TaskNumberReservationRow): void {
    const stmt = this.db.prepare(`
      insert into task_number_reservations (
        range_start, range_end, purpose, reserved_by, reserved_at, expires_at, status
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(range_start, range_end) do update set
        purpose = excluded.purpose,
        reserved_by = excluded.reserved_by,
        reserved_at = excluded.reserved_at,
        expires_at = excluded.expires_at,
        status = excluded.status
    `);
    stmt.run(
      entry.range_start,
      entry.range_end,
      entry.purpose,
      entry.reserved_by,
      entry.reserved_at,
      entry.expires_at,
      entry.status,
    );
  }

  upsertTaskSpec(row: TaskSpecRow): void {
    const commonValues = [
      row.task_id,
      row.task_number,
      row.title,
      row.chapter_markdown ?? null,
      row.goal_markdown ?? null,
      row.context_markdown ?? null,
      row.required_work_markdown ?? null,
      row.non_goals_markdown ?? null,
      row.acceptance_criteria_json ?? '[]',
      row.dependencies_json ?? '[]',
      row.updated_at ?? nowIso(),
    ];
    if (row.tags_json === undefined || row.tags_json === null) {
      this.db.prepare(`
        insert into task_specs (
          task_id, task_number, title, chapter_markdown, goal_markdown,
          context_markdown, required_work_markdown, non_goals_markdown,
          acceptance_criteria_json, dependencies_json, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(task_id) do update set
          task_number = excluded.task_number,
          title = excluded.title,
          chapter_markdown = excluded.chapter_markdown,
          goal_markdown = excluded.goal_markdown,
          context_markdown = excluded.context_markdown,
          required_work_markdown = excluded.required_work_markdown,
          non_goals_markdown = excluded.non_goals_markdown,
          acceptance_criteria_json = excluded.acceptance_criteria_json,
          dependencies_json = excluded.dependencies_json,
          updated_at = excluded.updated_at
      `).run(...commonValues);
      return;
    }
    this.db.prepare(`
      insert into task_specs (
        task_id, task_number, title, chapter_markdown, goal_markdown,
        context_markdown, required_work_markdown, non_goals_markdown,
        acceptance_criteria_json, dependencies_json, tags_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(task_id) do update set
        task_number = excluded.task_number,
        title = excluded.title,
        chapter_markdown = excluded.chapter_markdown,
        goal_markdown = excluded.goal_markdown,
        context_markdown = excluded.context_markdown,
        required_work_markdown = excluded.required_work_markdown,
        non_goals_markdown = excluded.non_goals_markdown,
        acceptance_criteria_json = excluded.acceptance_criteria_json,
        dependencies_json = excluded.dependencies_json,
        tags_json = excluded.tags_json,
        updated_at = excluded.updated_at
    `).run(...commonValues.slice(0, -1), row.tags_json, commonValues.at(-1));
  }

  getTaskSpec(taskId: string): TaskSpecRow | undefined {
    const row = this.db
      .prepare('select * from task_specs where task_id = ?')
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToTaskSpec(row) : undefined;
  }

  getAllTaskSpecs(): TaskSpecRow[] {
    const rows = this.db.prepare('select * from task_specs order by task_number asc').all() as Record<string, unknown>[];
    return rows.map(rowToTaskSpec);
  }

  replaceTaskTags(options: {
    taskId: string;
    tags: string[];
    actorAgentId: string;
    reason: string;
    updateId: string;
    updatedAt?: string;
  }): TaskTagUpdateResult {
    const tags = requireTaskTagsArray(options.tags);
    const updatedAt = options.updatedAt ?? nowIso();
    let lifecycle: TaskLifecycleRow | undefined;
    let previousTags: string[] = [];
    this.db.exec('begin immediate');
    try {
      // Lock before reading the current spec. Otherwise two writers can both
      // observe the same previous tag set and emit contradictory audit rows.
      lifecycle = this.getLifecycle(options.taskId);
      if (!lifecycle) throw new Error(`task_not_found: ${options.taskId}`);
      let spec = this.getTaskSpec(options.taskId);
      if (!spec) {
        // A legacy/lifecycle-only task is still taggable. Materialize the
        // minimal spec inside the same transaction before recording the tag
        // change, preserving one coherent SQLite authority.
        this.db.prepare(`
          insert into task_specs (
            task_id, task_number, title, chapter_markdown, goal_markdown,
            context_markdown, required_work_markdown, non_goals_markdown,
            acceptance_criteria_json, dependencies_json, tags_json, updated_at
          ) values (?, ?, ?, null, null, null, null, null, '[]', '[]', '[]', ?)
        `).run(
          options.taskId,
          lifecycle.task_number,
          `Task ${lifecycle.task_number}`,
          updatedAt,
        );
        spec = this.getTaskSpec(options.taskId);
      }
      if (!spec) throw new Error(`task_spec_not_found: ${options.taskId}`);
      previousTags = parseStoredTaskTags(spec.tags_json);
      if (JSON.stringify(previousTags) === JSON.stringify(tags)) {
        this.db.exec('commit');
        return {
          status: 'unchanged',
          update_id: null,
          task_id: options.taskId,
          task_number: lifecycle.task_number,
          actor_agent_id: options.actorAgentId,
          previous_tags: previousTags,
          tags,
          reason: options.reason,
          updated_at: spec.updated_at ?? updatedAt,
        };
      }
      this.db.prepare('update task_specs set tags_json = ?, updated_at = ? where task_id = ?')
        .run(JSON.stringify(tags), updatedAt, options.taskId);
      this.db.prepare(`
        insert into task_tag_updates (
          update_id, task_id, task_number, actor_agent_id,
          previous_tags_json, new_tags_json, reason, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        options.updateId,
        options.taskId,
        lifecycle.task_number,
        options.actorAgentId,
        JSON.stringify(previousTags),
        JSON.stringify(tags),
        options.reason,
        updatedAt,
      );
      this.db.exec('commit');
    } catch (error) {
      try { this.db.exec('rollback'); } catch { /* preserve original failure */ }
      throw error;
    }
    if (!lifecycle) throw new Error(`task_not_found: ${options.taskId}`);
    return {
      status: 'updated',
      update_id: options.updateId,
      task_id: options.taskId,
      task_number: lifecycle.task_number,
      actor_agent_id: options.actorAgentId,
      previous_tags: previousTags,
      tags,
      reason: options.reason,
      updated_at: updatedAt,
    };
  }

  listTaskTagUpdates(taskId: string, limit = 20): TaskTagUpdateRow[] {
    const rows = this.db.prepare(
      'select * from task_tag_updates where task_id = ? order by updated_at desc, update_id desc limit ?',
    ).all(taskId, Math.max(1, Math.min(limit, 100))) as Record<string, unknown>[];
    return rows.map(rowToTaskTagUpdate);
  }

  getTaskSpecByNumber(taskNumber: number): TaskSpecRow | undefined {
    const row = this.db
      .prepare('select * from task_specs where task_number = ?')
      .get(taskNumber) as Record<string, unknown> | undefined;
    return row ? rowToTaskSpec(row) : undefined;
  }

  upsertEnvelopeTaskMapping(envelopeId: string, taskId: string, taskNumber: number, materializedAt: string): void {
    this.db
      .prepare(`
        insert into envelope_task_mappings (
          envelope_id, task_id, task_number, materialized_at
        ) values (?, ?, ?, ?)
        on conflict(envelope_id) do update set
          task_id = excluded.task_id,
          task_number = excluded.task_number,
          materialized_at = excluded.materialized_at
      `)
      .run(envelopeId, taskId, taskNumber, materializedAt);
  }

  getTaskByEnvelopeId(envelopeId: string): EnvelopeTaskMappingRow | undefined {
    const row = this.db
      .prepare('select * from envelope_task_mappings where envelope_id = ?')
      .get(envelopeId) as Record<string, unknown> | undefined;
    return row ? rowToEnvelopeTaskMapping(row) : undefined;
  }

  getEnvelopeMappingsByTaskId(taskId: string): EnvelopeTaskMappingRow[] {
    const rows = this.db
      .prepare('select * from envelope_task_mappings where task_id = ? order by materialized_at desc')
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToEnvelopeTaskMapping);
  }
}

function rowToVerificationRun(row: Record<string, unknown>): VerificationRunRow {
  return {
    run_id: String(row.run_id),
    request_id: String(row.request_id),
    task_id: row.task_id ? String(row.task_id) : null,
    target_command: String(row.target_command),
    scope: String(row.scope) as VerificationRunRow['scope'],
    timeout_seconds: Number(row.timeout_seconds),
    requester_identity: String(row.requester_identity),
    requested_at: String(row.requested_at),
    status: String(row.status) as VerificationRunRow['status'],
    exit_code: row.exit_code !== null && row.exit_code !== undefined ? Number(row.exit_code) : null,
    duration_ms: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : 0,
    metrics_json: row.metrics_json ? String(row.metrics_json) : null,
    stdout_digest: row.stdout_digest ? String(row.stdout_digest) : null,
    stderr_digest: row.stderr_digest ? String(row.stderr_digest) : null,
    stdout_excerpt: row.stdout_excerpt ? String(row.stdout_excerpt) : null,
    stderr_excerpt: row.stderr_excerpt ? String(row.stderr_excerpt) : null,
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

function rowToCommandRun(row: Record<string, unknown>): CommandRunRow {
  const commandArgv = JSON.parse(String(row.command_argv_json)) as string[];
  const envPolicy = JSON.parse(String(row.env_policy_json)) as CommandEnvPolicy;
  const stdinPolicy = JSON.parse(String(row.stdin_policy_json)) as CommandStdinPolicy;
  return {
    run_id: String(row.run_id),
    request_id: String(row.request_id),
    requester_id: String(row.requester_id),
    requester_kind: String(row.requester_kind) as CommandRunRow['requester_kind'],
    command_argv: commandArgv,
    command_argv_json: String(row.command_argv_json),
    cwd: String(row.cwd),
    env_policy: envPolicy,
    env_policy_json: String(row.env_policy_json),
    timeout_seconds: Number(row.timeout_seconds),
    stdin_policy: stdinPolicy,
    stdin_policy_json: String(row.stdin_policy_json),
    task_id: row.task_id ? String(row.task_id) : null,
    task_number: row.task_number !== null && row.task_number !== undefined ? Number(row.task_number) : null,
    agent_id: row.agent_id ? String(row.agent_id) : null,
    side_effect_class: String(row.side_effect_class) as CommandSideEffectClass,
    approval_posture: String(row.approval_posture) as CommandApprovalPosture,
    output_admission_profile: String(row.output_admission_profile) as CommandOutputAdmissionProfile,
    idempotency_key: String(row.idempotency_key),
    requested_at: String(row.requested_at),
    rationale: row.rationale ? String(row.rationale) : null,
    status: String(row.status) as CommandRunStatus,
    exit_code: row.exit_code !== null && row.exit_code !== undefined ? Number(row.exit_code) : null,
    signal: row.signal ? String(row.signal) : null,
    started_at: row.started_at ? String(row.started_at) : null,
    completed_at: row.completed_at ? String(row.completed_at) : null,
    duration_ms: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
    stdout_digest: row.stdout_digest ? String(row.stdout_digest) : null,
    stderr_digest: row.stderr_digest ? String(row.stderr_digest) : null,
    stdout_admitted_excerpt: row.stdout_admitted_excerpt ? String(row.stdout_admitted_excerpt) : null,
    stderr_admitted_excerpt: row.stderr_admitted_excerpt ? String(row.stderr_admitted_excerpt) : null,
    full_output_artifact_uri: row.full_output_artifact_uri ? String(row.full_output_artifact_uri) : null,
    error_class: row.error_class ? String(row.error_class) : null,
    approval_outcome: String(row.approval_outcome) as CommandApprovalPosture,
    telemetry_json: row.telemetry_json ? String(row.telemetry_json) : null,
    updated_at: String(row.updated_at),
  };
}

function rowToRosterEntry(row: Record<string, unknown>): AgentRosterRow {
  return {
    agent_id: String(row.agent_id),
    role: String(row.role),
    capabilities_json: String(row.capabilities_json),
    operator_identity: row.operator_identity ? String(row.operator_identity) : null,
    first_seen_at: String(row.first_seen_at),
    last_active_at: String(row.last_active_at),
    status: String(row.status),
    task_number: row.task_number !== null && row.task_number !== undefined ? Number(row.task_number) : null,
    last_done: row.last_done !== null && row.last_done !== undefined ? Number(row.last_done) : null,
    updated_at: String(row.updated_at),
  };
}
