import type { TaskConflictPolicyEvidenceRow, TaskDependencyDispositionRow, TaskDependencyRow, TaskLifecycleStore, TaskOutcomeContractRow, TaskOutcomeRow } from './task-lifecycle-store.js';

export type TaskDependencySatisfactionState = 'satisfied' | 'missing_outcome' | 'blocking_outcome' | 'unsatisfying_outcome';

export interface TaskDependencyRemediationOption {
  option: 'create_remediation_task' | 'route_existing_task' | 'defer_parent_with_authority' | 'report_parent_blocked';
  description: string;
  tool: string;
  example_args: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

function summarizeConflictPolicyEvidence(evidence: TaskConflictPolicyEvidenceRow): TaskConflictPolicyEvidenceSummary {
  return {
    evidence_id: evidence.evidence_id,
    agent_id: evidence.agent_id,
    effective_operator_identity: evidence.effective_operator_identity,
    gated_work_operator_identity: evidence.gated_work_operator_identity,
    conflict_detected: evidence.conflict_detected,
    policy_mode: evidence.policy_mode,
    authorization_required: evidence.authorization_required,
    authorization_satisfied: isConflictPolicySatisfied(evidence),
    annotation_recorded: evidence.annotation_recorded,
    created_at: evidence.created_at,
  };
}

function isConflictPolicySatisfied(evidence: TaskConflictPolicyEvidenceRow | undefined): boolean {
  if (!evidence) return true;
  if (!evidence.conflict_detected) return true;
  return Boolean(evidence.authorization_basis_json && evidence.annotation_recorded);
}

export interface TaskDependencySatisfactionItem {
  dependency_id: string;
  parent_task_id: string;
  required_task_id: string;
  required_outcome_id: string | null;
  dependency_kind: string;
  satisfying_outcomes: string[];
  blocking_outcomes: string[];
  latest_outcome: string | null;
  satisfied: boolean;
  state: TaskDependencySatisfactionState;
  disposition_required: boolean;
  latest_disposition: TaskDependencyDispositionSummary | null;
  conflict_policy_evidence: TaskConflictPolicyEvidenceSummary | null;
  blocking_reason: string | null;
  remediation_options: TaskDependencyRemediationOption[];
  evaluated_at: string;
}

export interface TaskDependencyDispositionSummary {
  disposition_id: string;
  kind: string;
  status: string;
  target_task_id: string | null;
  routed_obligation_id: string | null;
  summary: string;
  created_by: string;
  created_at: string;
}

export interface TaskConflictPolicyEvidenceSummary {
  evidence_id: string;
  agent_id: string;
  effective_operator_identity: string | null;
  gated_work_operator_identity: string | null;
  conflict_detected: boolean;
  policy_mode: string;
  authorization_required: boolean;
  authorization_satisfied: boolean;
  annotation_recorded: boolean;
  created_at: string;
}

export interface TaskDependencySatisfactionSummary {
  schema: 'narada.task.dependency_satisfaction.v0';
  parent_task_id: string;
  evaluated_at: string;
  dependency_count: number;
  satisfied_count: number;
  unsatisfied_count: number;
  all_satisfied: boolean;
  dependencies: TaskDependencySatisfactionItem[];
}

export function evaluateTaskDependencySatisfaction(store: TaskLifecycleStore, parentTaskId: string): TaskDependencySatisfactionSummary {
  const evaluatedAt = new Date().toISOString();
  const dependencies = store.listTaskDependenciesForParent(parentTaskId).map((dependency) => {
    const satisfyingOutcomes = parseStringArray(dependency.satisfying_outcomes_json);
    const latestOutcome = store.getLatestTaskOutcome(dependency.required_task_id);
    const outcomeContract = latestOutcome
      ? store.getTaskOutcomeContract(latestOutcome.contract_id)
      : store.getLatestTaskOutcomeContract(dependency.required_task_id);
    const latestDisposition = latestOutcome
      ? store.getLatestTaskDependencyDisposition(dependency.dependency_id, latestOutcome.outcome_id)
      : undefined;
    const conflictPolicyEvidence = latestOutcome
      ? store.getLatestTaskConflictPolicyEvidence(dependency.dependency_id, latestOutcome.outcome_id)
      : undefined;
    return evaluateOneDependency(dependency, latestOutcome, outcomeContract, latestDisposition, conflictPolicyEvidence, satisfyingOutcomes, evaluatedAt);
  });
  const satisfiedCount = dependencies.filter((dependency) => dependency.satisfied).length;
  return {
    schema: 'narada.task.dependency_satisfaction.v0',
    parent_task_id: parentTaskId,
    evaluated_at: evaluatedAt,
    dependency_count: dependencies.length,
    satisfied_count: satisfiedCount,
    unsatisfied_count: dependencies.length - satisfiedCount,
    all_satisfied: dependencies.every((dependency) => dependency.satisfied),
    dependencies,
  };
}

function evaluateOneDependency(
  dependency: TaskDependencyRow,
  latestOutcome: TaskOutcomeRow | undefined,
  outcomeContract: TaskOutcomeContractRow | undefined,
  latestDisposition: TaskDependencyDispositionRow | undefined,
  conflictPolicyEvidence: TaskConflictPolicyEvidenceRow | undefined,
  satisfyingOutcomes: string[],
  evaluatedAt: string,
): TaskDependencySatisfactionItem {
  const latestOutcomeValue = latestOutcome?.outcome ?? null;
  const blockingOutcomes = parseStringArray(outcomeContract?.blocking_outcomes_json);
  const conflictSatisfied = isConflictPolicySatisfied(conflictPolicyEvidence);
  const outcomeSatisfied = Boolean(latestOutcomeValue && satisfyingOutcomes.includes(latestOutcomeValue));
  const state = dependencySatisfactionState({ latestOutcomeValue, satisfyingOutcomes, blockingOutcomes });
  const dispositionAccepted = isAcceptedBlockingOutcomeDisposition(latestDisposition);
  const dispositionSatisfied = state === 'blocking_outcome' && dispositionAccepted;
  const satisfied = (outcomeSatisfied || dispositionSatisfied) && conflictSatisfied;
  const dispositionRequired = state === 'blocking_outcome' && !dispositionAccepted;
  const blockingReason = buildBlockingReason({ dependency, latestOutcomeValue, state, dispositionAccepted, conflictPolicyEvidence });
  return {
    dependency_id: dependency.dependency_id,
    parent_task_id: dependency.parent_task_id,
    required_task_id: dependency.required_task_id,
    required_outcome_id: latestOutcome?.outcome_id ?? null,
    dependency_kind: dependency.kind,
    satisfying_outcomes: satisfyingOutcomes,
    blocking_outcomes: blockingOutcomes,
    latest_outcome: latestOutcomeValue,
    satisfied,
    state,
    disposition_required: dispositionRequired,
    latest_disposition: latestDisposition ? summarizeDisposition(latestDisposition) : null,
    conflict_policy_evidence: conflictPolicyEvidence ? summarizeConflictPolicyEvidence(conflictPolicyEvidence) : null,
    blocking_reason: blockingReason,
    remediation_options: dispositionRequired ? buildBlockingOutcomeRemediationOptions(dependency, latestOutcomeValue) : [],
    evaluated_at: evaluatedAt,
  };
}

function dependencySatisfactionState(args: {
  latestOutcomeValue: string | null;
  satisfyingOutcomes: string[];
  blockingOutcomes: string[];
}): TaskDependencySatisfactionState {
  if (!args.latestOutcomeValue) return 'missing_outcome';
  if (args.satisfyingOutcomes.includes(args.latestOutcomeValue)) return 'satisfied';
  if (args.blockingOutcomes.includes(args.latestOutcomeValue)) return 'blocking_outcome';
  return 'unsatisfying_outcome';
}

function buildBlockingReason(args: {
  dependency: TaskDependencyRow;
  latestOutcomeValue: string | null;
  state: TaskDependencySatisfactionState;
  dispositionAccepted: boolean;
  conflictPolicyEvidence: TaskConflictPolicyEvidenceRow | undefined;
}): string | null {
  if (args.conflictPolicyEvidence && !isConflictPolicySatisfied(args.conflictPolicyEvidence)) {
    return `dependency '${args.dependency.dependency_id}' has unresolved conflict-of-interest policy evidence`;
  }
  if (args.state === 'satisfied') return null;
  if (args.state === 'missing_outcome') return `dependency '${args.dependency.dependency_id}' has no admitted outcome`;
  if (args.state === 'blocking_outcome') {
    if (args.dispositionAccepted) {
      return null;
    }
    return `latest outcome '${args.latestOutcomeValue}' blocks dependency '${args.dependency.dependency_id}' and requires explicit disposition`;
  }
  return `latest outcome '${args.latestOutcomeValue}' does not satisfy dependency '${args.dependency.dependency_id}'`;
}

function isAcceptedBlockingOutcomeDisposition(disposition: TaskDependencyDispositionRow | undefined): boolean {
  if (!disposition) return false;
  if (disposition.status === 'superseded') return false;
  if (disposition.kind === 'operator_deferred') return disposition.status === 'deferred' || disposition.status === 'resolved';
  if (disposition.kind === 'out_of_scope_or_rejected') return disposition.status === 'deferred' || disposition.status === 'resolved';
  return disposition.status === 'open' || disposition.status === 'resolved';
}

function summarizeDisposition(disposition: TaskDependencyDispositionRow): TaskDependencyDispositionSummary {
  return {
    disposition_id: disposition.disposition_id,
    kind: disposition.kind,
    status: disposition.status,
    target_task_id: disposition.target_task_id,
    routed_obligation_id: disposition.routed_obligation_id,
    summary: disposition.summary,
    created_by: disposition.created_by,
    created_at: disposition.created_at,
  };
}

function buildBlockingOutcomeRemediationOptions(
  dependency: TaskDependencyRow,
  latestOutcomeValue: string | null,
): TaskDependencyRemediationOption[] {
  const reason = `Dependency '${dependency.dependency_id}' for parent task ${dependency.parent_task_id} has blocking outcome '${latestOutcomeValue ?? 'unknown'}' on required task ${dependency.required_task_id}.`;
  return [
    {
      option: 'create_remediation_task',
      description: 'Create explicit follow-up work that resolves the blocking outcome before the parent can close.',
      tool: 'task_lifecycle_create',
      example_args: { payload_ref: 'mcp_payload:<remediation-task>@v1' },
      payload: {
        title: 'Resolve blocking dependency outcome',
        goal: reason,
        context: 'Created as explicit disposition for a blocking dependency outcome.',
        required_work: ['Address the blocking outcome.', 'Record verification evidence.', 'Finish with an outcome that satisfies the parent dependency.'],
        acceptance_criteria: ['Blocking dependency has an explicit satisfying outcome or authorized disposition.'],
      },
    },
    {
      option: 'route_existing_task',
      description: 'Route an already-opened task that covers the blocking outcome to the appropriate role or preferred agent.',
      tool: 'task_lifecycle_set_routing',
      example_args: {
        task_number: '<existing-opened-task-number>',
        actor_agent_id: '<current-agent-id>',
        target_role: '<role-that-can-resolve-blocker>',
        preferred_agent_id: null,
        reason,
      },
    },
    {
      option: 'defer_parent_with_authority',
      description: 'Defer the parent task when an explicit authority decides the blocking outcome should not be resolved now.',
      tool: 'task_lifecycle_defer',
      example_args: {
        task_number: '<parent-task-number>',
        agent_id: '<current-agent-id>',
        reason: `${reason} Authority basis: <operator/directive/defer decision>.`,
      },
    },
    {
      option: 'report_parent_blocked',
      description: 'Record the parent as blocked with concrete blockers and next action when no immediate disposition is authorized.',
      tool: 'task_lifecycle_report_blocked',
      example_args: {
        task_number: '<parent-task-number>',
        agent_id: '<current-agent-id>',
        reason: 'Blocking dependency outcome needs disposition.',
        blockers: [reason],
        next_action: 'Choose create_remediation_task, route_existing_task, or defer_parent_with_authority.',
      },
    },
  ];
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
