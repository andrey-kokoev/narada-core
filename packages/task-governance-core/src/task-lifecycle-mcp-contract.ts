export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: string[];
};

export type TaskLifecycleTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export const TASK_LIFECYCLE_TOOL_ALIASES: Record<string, string> = {
  task_lifecycle_closeout: 'task_lifecycle_disposition_closeout',
  task_lifecycle_record_observation: 'task_lifecycle_submit_observation',
  task_lifecycle_submit_report: 'task_lifecycle_finish',
  task_lifecycle_d_af077406ea2f: 'task_lifecycle_disposition_closeout',
  task_lifecycle_s_f5e0b1532dcf: 'task_lifecycle_submit_observation',
  task_mcp_doctor: 'task_lifecycle_doctor',
  task_mcp_restart: 'task_lifecycle_restart',
  task_mcp_list: 'task_lifecycle_list',
  task_mcp_show: 'task_lifecycle_show',
  task_mcp_roster: 'task_lifecycle_roster',
  task_mcp_roster_admit: 'task_lifecycle_roster_admit',
  task_mcp_claim: 'task_lifecycle_claim',
  task_mcp_continue: 'task_lifecycle_continue',
  task_mcp_unclaim: 'task_lifecycle_unclaim',
  task_mcp_next: 'task_lifecycle_next',
  task_mcp_workboard_snapshot: 'task_lifecycle_workboard_snapshot',
  task_mcp_obligations: 'task_lifecycle_obligations',
  task_mcp_inspect: 'task_lifecycle_inspect',
  task_mcp_evidence_preflight: 'task_lifecycle_evidence_preflight',
  task_mcp_admit_evidence: 'task_lifecycle_admit_evidence',
  task_mcp_prove_criteria: 'task_lifecycle_prove_criteria',
  task_mcp_audit: 'task_lifecycle_audit',
  task_mcp_finish: 'task_lifecycle_finish',
  task_mcp_close: 'task_lifecycle_close',
  task_mcp_search: 'task_lifecycle_search',
  task_mcp_defer: 'task_lifecycle_defer',
  task_mcp_un_defer: 'task_lifecycle_un_defer',
  task_mcp_undefer: 'task_lifecycle_un_defer',
  task_mcp_reopen: 'task_lifecycle_reopen',
  task_mcp_review: 'task_lifecycle_review',
  task_mcp_submit_observation: 'task_lifecycle_submit_observation',
  task_mcp_bridge_poll: 'task_lifecycle_bridge_poll',
  task_mcp_inbox_target: 'task_lifecycle_inbox_target',
  task_mcp_create: 'task_lifecycle_create',
  task_mcp_set_routing: 'task_lifecycle_set_routing',
  task_mcp_test_tool: 'task_lifecycle_test_mcp_tool',
  task_mcp_run_tests: 'task_lifecycle_run_tests',
};

export function normalizeTaskLifecycleToolName(name: string): string {
  return TASK_LIFECYCLE_TOOL_ALIASES[name] ?? name;
}

export function taskLifecycleDomainTools(): TaskLifecycleTool[] {
  const tools = [
    tool('task_lifecycle_doctor', 'Inspect Task Lifecycle MCP readiness without mutating.', objectSchema({})),
    tool('task_lifecycle_restart', 'Request, inspect, or acknowledge an external restart of the task-lifecycle stdio MCP server. Does not self-restart the current process.', objectSchema({
      mode: stringSchema('request, status, acknowledge, or clear. Default request.'),
      reason: stringSchema('Optional reason for the restart request or acknowledgement.'),
    })),
    tool('task_lifecycle_list', 'List tasks with optional status and agent filters.', objectSchema({
      status: stringSchema('Filter by status: draft, opened, claimed, in_review, closed, confirmed, etc.'),
      agent_id: stringSchema('Filter by assigned agent_id.'),
      limit: numberSchema('Maximum results; defaults to 50.'),
    })),
    tool('task_lifecycle_show', 'Show full task details: lifecycle, spec, assignment, and observations.', objectSchema({ task_number: numberSchema('Task number to inspect.') }, ['task_number'])),
    tool('task_lifecycle_roster', 'List the agent roster.', objectSchema({})),
    tool('task_lifecycle_roster_admit', 'Append an admitted roster identity event and project it into the agent_roster read model.', objectSchema({
      agent_id: stringSchema('Canonical agent identity to admit into task lifecycle roster authority.'),
      role: stringSchema('Canonical role for the agent.'),
      actor_agent_id: stringSchema('Verified session agent recording the roster admission.'),
      capabilities: arraySchema(stringSchema('Capability name.'), 'Capabilities to project for this roster identity.'),
      operator_identity: stringSchema('Optional operator identity associated with the agent.'),
      authority_basis: authorityBasisSchema('Required authority basis for roster admission.'),
      reason: stringSchema('Optional admission reason.'),
      dry_run: booleanSchema('Plan only; do not append event or project roster.'),
    }, ['agent_id', 'role', 'actor_agent_id', 'authority_basis'])),
    tool('task_lifecycle_claim', 'Claim an unassigned task for an agent. If the claiming agent differs from preferred_agent_id, include authority_basis { kind, summary }.', objectSchema({
      task_number: numberSchema('Task number to claim.'),
      agent_id: stringSchema('Agent id claiming the task.'),
      authority_basis: authorityBasisSchema('Required when the task has a different preferred_agent_id.'),
    }, ['task_number', 'agent_id'])),
    tool('task_lifecycle_continue', 'Continue a task that is in needs_continuation or evidence_repair state.', objectSchema({
      task_number: numberSchema('Task number to continue.'),
      agent_id: stringSchema('Agent id continuing the task.'),
      reason: stringSchema('Continuation reason: evidence_repair, review_fix, handoff, blocked_agent, operator_override.'),
    }, ['task_number', 'agent_id', 'reason'])),
    tool('task_lifecycle_unclaim', 'Release an active task assignment.', objectSchema({
      task_number: numberSchema('Task number to unclaim.'),
      agent_id: stringSchema('Optional agent_id guard; must match current claimant.'),
      reason: stringSchema('Release reason.'),
    }, ['task_number'])),
    tool('task_lifecycle_next', 'Get the next recommended action for an agent: active work, review obligations, or claimable tasks.', objectSchema({
      agent_id: stringSchema('Agent id to query workboard for.'),
      limit: numberSchema('Maximum results per category; defaults to 8.'),
      last_workboard_check_at: stringSchema("ISO timestamp of the agent's last workboard check. Enables state_freshness computation."),
      view: stringSchema('Optional output view. Use "concise" for a small next-action packet without full workboard sections.'),
      concise: booleanSchema('When true, return only the concise next-action packet.'),
    }, ['agent_id'])),
    tool('task_lifecycle_workboard_snapshot', 'Return a read-only, trace-ready workboard evidence packet for IS movement. Does not claim, route, rank, or reconcile tasks.', objectSchema({
      agent_id: stringSchema('Agent id to query workboard evidence for.'),
      limit: numberSchema('Maximum sample items per category; defaults to 8.'),
      last_workboard_check_at: stringSchema("ISO timestamp of the agent's last workboard check. Enables freshness evidence."),
      previous_snapshot: { type: 'object', description: 'Optional prior snapshot payload for drift comparison.', additionalProperties: true },
    }, ['agent_id'])),
    tool('task_lifecycle_obligations', 'List directed obligations for an agent (review requests, etc.).', objectSchema({
      agent_id: stringSchema('Agent id to query obligations for.'),
      status: stringSchema('Filter by status: open, completed, rejected. Defaults to open.'),
    }, ['agent_id'])),
    tool('task_lifecycle_inspect', 'Deep-inspect a task: lifecycle state, evidence summary, assignment, obligations, and reports.', objectSchema({ task_number: numberSchema('Task number to inspect.') }, ['task_number'])),
    tool('task_lifecycle_evidence_preflight', 'Report finish/admission requirements and exact remediation before closeout. Does not mutate task state.', objectSchema({ task_number: numberSchema('Task number to check before finish.') }, ['task_number'])),
    tool('task_lifecycle_self_certification_preflight', 'Validate self-certification guard metadata for task/CAPA/evidence/chapter/final-summary surfaces without mutating authority state.', objectSchema({
      self_certification: { type: 'object', description: 'Self-certification guard packet. Fields include target_category, subject_principal, actor_principal, requires_independent_review, reviewer_eligibility_ref, independent_review_ref, operator_acceptance_ref, misleading_completion_answer, allowed_pending_state, closure_state.', additionalProperties: true },
      surface: stringSchema('Surface being checked, e.g. task_lifecycle_finish, task_lifecycle_review, task_lifecycle_close, evidence_admission, capa_closeout, operator_final_summary.'),
      summary: stringSchema('Optional summary/final text to include in target and terminal-claim detection.'),
      body: stringSchema('Optional body/chapter/packet text to include in target and terminal-claim detection.'),
      actor_principal: stringSchema('Optional actor/closer/reviewer principal if not already in the packet.'),
      terminal_correction_claim: booleanSchema('Set true when the surface would assert terminal correction/closure.'),
    }, ['self_certification'])),
    tool('task_lifecycle_admit_evidence', 'Admit evidence for a task through the admission gate (report, verification, criteria).', objectSchema({
      task_number: numberSchema('Task number to admit evidence for.'),
      agent_id: stringSchema('Agent id performing the admission.'),
      self_certification: { type: 'object', description: 'Optional self-certification guard packet for closure-sensitive architect-failure/deception/trust evidence.', additionalProperties: true },
    }, ['task_number', 'agent_id'])),
    tool('task_lifecycle_prove_criteria', 'Auto-check all acceptance criteria in the task body and run evidence admission. This tool does not accept a summary; use task_lifecycle_disposition_closeout or task_lifecycle_submit_report for summary/report evidence.', objectSchema({
      task_number: numberSchema('Task number to prove criteria for.'),
      agent_id: stringSchema('Agent id performing the proof.'),
    }, ['task_number', 'agent_id'])),
    tool('task_lifecycle_closeout', 'Readable alias for task_lifecycle_disposition_closeout. Mutates task notes, inbox disposition evidence, criteria, and finish state only when requested by arguments.', dispositionCloseoutSchema()),
    tool('task_lifecycle_disposition_closeout', 'Prepare or complete a lightweight inbox-disposition close-out: resolve envelope status, write execution/verification notes, optionally prove criteria and finish, and return task-owned changed files.', dispositionCloseoutSchema()),
    tool('task_lifecycle_audit', 'Timeline of recent task lifecycle events: claims, reports, reviews, admissions, closes.', objectSchema({
      since: stringSchema('ISO timestamp start. Defaults to 24 hours ago.'),
      until: stringSchema('ISO timestamp end. Defaults to now.'),
    })),
    tool('task_lifecycle_submit_report', 'Readable alias for task_lifecycle_finish. For claimed tasks, submit a finish report without verdict using summary plus changed_files or no_files_changed. Review verdicts belong on task_lifecycle_review. Use payload_ref only for long companion fields; top-level task_number and agent_id remain authoritative.', finishSchema()),
    tool('task_lifecycle_finish', 'Finish a claimed task by submitting a report without verdict using summary plus changed_files or no_files_changed. Review verdicts belong on task_lifecycle_review. Use payload_ref only for long companion fields; top-level task_number and agent_id remain authoritative.', finishSchema()),
    tool('task_lifecycle_close', 'Close a task. Requires the task to be in a closable state.', objectSchema({
      task_number: numberSchema('Task number to close.'),
      agent_id: stringSchema('Agent id closing the task.'),
      mode: stringSchema('Closure mode: operator_direct, peer_reviewed, agent_finish, emergency. Defaults to agent_finish.'),
      no_continuation_needed: stringSchema('Rationale for closing without a continuation task (for design-only/spike tasks).'),
      self_certification: { type: 'object', description: 'Optional self-certification guard packet for architect-failure/deception/trust closeout.', additionalProperties: true },
    }, ['task_number', 'agent_id'])),
    tool('task_lifecycle_search', 'Search tasks by title or content.', objectSchema({
      query: stringSchema('Search query string.'),
      status: stringSchema('Optional status filter.'),
      limit: numberSchema('Maximum results; defaults to 20.'),
    }, ['query'])),
    tool('task_lifecycle_related', 'Find tasks related to a given task by tag overlap. Returns semantically similar tasks based on shared terms extracted from title, goal, and context.', objectSchema({
      task_number: numberSchema('Task number to find related tasks for.'),
      limit: numberSchema('Maximum results; defaults to 8.'),
    }, ['task_number'])),
    tool('task_lifecycle_defer', 'Defer a task. Only valid from opened or in_review status.', objectSchema({
      task_number: numberSchema('Task number to defer.'),
      agent_id: stringSchema('Agent id deferring the task.'),
      reason: stringSchema('Optional reason for deferral.'),
    }, ['task_number', 'agent_id'])),
    tool('task_lifecycle_un_defer', 'Un-defer a deferred task. Restores unassigned tasks to opened and actively assigned tasks to claimed without changing the assignment.', objectSchema({
      task_number: numberSchema('Task number to un-defer.'),
      agent_id: stringSchema('Agent id performing the un-defer action.'),
      reason: stringSchema('Optional reason for un-deferral.'),
      authority_basis: authorityBasisSchema('Required when the active assignment belongs to a different agent.'),
    }, ['task_number', 'agent_id'])),
    tool('task_lifecycle_reopen', 'Reopen a closed or confirmed task.', objectSchema({
      task_number: numberSchema('Task number to reopen.'),
      agent_id: stringSchema('Agent id reopening the task.'),
      reason: stringSchema('Optional reason for reopening.'),
    }, ['task_number', 'agent_id'])),
    tool('task_lifecycle_review', 'Review a task in_review: accept, accept_with_notes, or reject. Response includes close_blocked when evidence admission blocks closure despite accepted review.', objectSchema({
      task_number: numberSchema('Task number to review.'),
      agent_id: stringSchema('Reviewer agent id.'),
      verdict: enumStringSchema(['accepted', 'accepted_with_notes', 'rejected'], 'Verdict: accepted, accepted_with_notes, rejected.'),
      findings: { type: 'array', description: 'Array of finding objects: {severity, description, location?}' },
      single_operator_review: booleanSchema('Set to true to allow and annotate a same-operator review (reviewer and finisher share operator_identity).'),
      self_certification: { type: 'object', description: 'Optional self-certification guard packet for architect-failure/deception/trust review.', additionalProperties: true },
    }, ['task_number', 'agent_id', 'verdict'])),
    tool('task_lifecycle_record_observation', 'Readable alias for task_lifecycle_submit_observation. Writes a structured observation artifact; observation artifacts are context and do not satisfy verification gates by themselves.', submitObservationSchema()),
    tool('task_lifecycle_submit_observation', 'Submit an observation artifact attached to a task or as a general observation.', submitObservationSchema()),
    tool('task_lifecycle_bridge_poll', 'Poll the inbox-to-task-lifecycle bridge: evaluate unprocessed envelopes and auto-materialize high-severity tasks.', objectSchema({
      dry_run: booleanSchema('If true, evaluate without creating tasks.'),
      threshold: numberSchema('Minimum severity to auto-materialize. Defaults to 50.'),
      limit: numberSchema('Maximum envelopes to evaluate. Defaults to 20.'),
    })),
    tool('task_lifecycle_inbox_target', 'Target one inbox envelope by envelope_id for bridge preview/materialization or explicit disposition without relying on broad bridge polling order.', objectSchema({
      envelope_id: stringSchema('Inbox envelope ID to inspect or disposition.'),
      dry_run: booleanSchema('If true, preview the targeted action without mutation.'),
      disposition: stringSchema('Disposition: materialize, acknowledge, already_routed, dismiss, defer, or preview. Defaults to materialize.'),
      principal: stringSchema('Principal recorded on disposition evidence.'),
      agent_id: stringSchema('Agent id used as fallback disposition principal.'),
      reason: stringSchema('Disposition reason; required for dismiss.'),
    }, ['envelope_id'])),
    tool('task_lifecycle_create', 'Create a new task from an immutable payload_ref carrying title, goal, context, required work, non-goals, acceptance criteria, and optional preferred/target roles.', objectSchema({
      payload_ref: stringSchema('Required immutable transient payload ref such as mcp_payload:<id>@v1. Payload must contain the task definition.'),
    }, ['payload_ref'], { payloadRef: false })),
    ...recurringTools(),
    tool('task_lifecycle_set_routing', 'Route an opened task to a target role, preferred agent, and/or relative priority without claiming it as that agent.', objectSchema({
      task_number: numberSchema('Task number to route. Must currently be opened.'),
      actor_agent_id: stringSchema('Architect/operator agent id performing the routing mutation.'),
      target_role: nullableStringSchema('Optional target role. Pass null to clear.'),
      preferred_agent_id: nullableStringSchema('Optional preferred agent id. Pass null to clear.'),
      relative_priority: numberSchema('Optional relative priority for workboard ranking.'),
      reason: stringSchema('Reason/authority basis for the routing change.'),
    }, ['task_number', 'actor_agent_id', 'reason'])),
    tool('task_lifecycle_test_mcp_tool', 'Spawn a fresh MCP server process and invoke a single tool to verify code changes without restarting the live session server.', objectSchema({
      server_path: stringSchema('Path to the MCP server script relative to site root (e.g., "tools/task-lifecycle/task-mcp-server.mjs").'),
      tool_name: stringSchema('Tool name to invoke on the spawned server.'),
      arguments: { type: 'object', additionalProperties: true, description: 'Tool arguments object.' },
      timeout_seconds: numberSchema('Fresh server invocation timeout in seconds. Defaults to 10, max 300.'),
    }, ['server_path', 'tool_name'])),
    tool('task_lifecycle_run_tests', 'Run an approved test selector through Test MCP and record structured test evidence on a task.', objectSchema({
      selector: stringSchema('Test selector: task-lifecycle, typed-mcp, operator-surface, or all. Defaults to task-lifecycle.'),
      task_number: numberSchema('Task number to attach structured test evidence to.'),
      agent_id: stringSchema('Agent id running the tests.'),
      timeout_seconds: numberSchema('Per-test timeout in seconds. Defaults to 120, max 300.'),
    }, ['agent_id'])),
  ];
  const names = new Set<string>();
  for (const item of tools) {
    if (names.has(item.name)) throw new Error(`duplicate_task_lifecycle_tool:${item.name}`);
    names.add(item.name);
  }
  return tools;
}

export const taskLifecycleTools = taskLifecycleDomainTools;

function recurringTools(): TaskLifecycleTool[] {
  return [
    tool('task_lifecycle_recurring_create', 'Create a recurring task definition. Manual trigger remains the default; scheduled daily trigger metadata can be enabled for due-run automation.', objectSchema({
      title: stringSchema('Recurring task title.'),
      actor_agent_id: stringSchema('Architect/operator agent id creating the recurrence.'),
      authority_basis: authorityBasisSchema('Authority basis for creating the recurrence definition.'),
      goal: stringSchema('Task goal markdown used for generated instances.'),
      context: stringSchema('Task context markdown used for generated instances.'),
      required_work: stringSchema('Required work markdown used for generated instances.'),
      non_goals: stringSchema('Non-goals markdown used for generated instances.'),
      acceptance_criteria: arraySchema(stringSchema('Acceptance criterion template.'), 'Acceptance criteria template for generated task instances.'),
      evidence_requirements: arraySchema(stringSchema('Evidence requirement.'), 'Evidence expected from each generated run.'),
      target_role: stringSchema('Target role for generated task instances.'),
      preferred_role: stringSchema('Preferred role for generated task instances.'),
      trigger_description: stringSchema('Human-readable trigger condition.'),
      trigger_mode: stringSchema('Trigger mode: manual or schedule. Defaults to manual.'),
      schedule_kind: stringSchema('Schedule kind for trigger_mode=schedule. V1 supports daily.'),
      schedule_timezone: stringSchema('Schedule timezone metadata. V1 due calculation uses UTC; defaults to UTC.'),
      initial_status: stringSchema('Initial status: draft or active. Defaults to active.'),
    }, ['title', 'actor_agent_id', 'authority_basis'])),
    tool('task_lifecycle_recurring_run_due', 'Create due scheduled recurring task runs idempotently. V1 supports active daily UTC definitions and must be invoked by a sanctioned MCP/workloop surface.', objectSchema({
      actor_agent_id: stringSchema('Architect/operator agent id invoking due-run automation.'),
      authority_basis: authorityBasisSchema('Authority basis for the automated due-run sweep.'),
      current_time: stringSchema('Optional ISO timestamp used for due calculation. Defaults to now.'),
      limit: numberSchema('Maximum due runs to create. Defaults to 20.'),
    }, ['actor_agent_id', 'authority_basis'])),
    tool('task_lifecycle_recurring_show', 'Show a recurring task definition and recent generated runs.', objectSchema({
      recurrence_id: stringSchema('Recurring task definition id.'),
      include_runs: booleanSchema('Include generated runs. Defaults true.'),
    }, ['recurrence_id'])),
    tool('task_lifecycle_recurring_list', 'List recurring task definitions.', objectSchema({
      status: stringSchema('Optional status filter: draft, active, suspended, retired.'),
      limit: numberSchema('Maximum definitions to return. Defaults to 50.'),
    })),
    tool('task_lifecycle_recurring_suspend', 'Suspend an active or draft recurring task definition.', objectSchema({
      recurrence_id: stringSchema('Recurring task definition id.'),
      actor_agent_id: stringSchema('Architect/operator agent id suspending the recurrence.'),
      authority_basis: authorityBasisSchema('Authority basis for suspending the recurrence definition.'),
      reason: stringSchema('Suspension reason.'),
    }, ['recurrence_id', 'actor_agent_id', 'authority_basis', 'reason'])),
    tool('task_lifecycle_recurring_retire', 'Retire a recurring task definition.', objectSchema({
      recurrence_id: stringSchema('Recurring task definition id.'),
      actor_agent_id: stringSchema('Architect/operator agent id retiring the recurrence.'),
      authority_basis: authorityBasisSchema('Authority basis for retiring the recurrence definition.'),
      reason: stringSchema('Retirement reason.'),
    }, ['recurrence_id', 'actor_agent_id', 'authority_basis', 'reason'])),
    tool('task_lifecycle_recurring_trigger', 'Manually trigger a recurring task definition and create one normal opened task instance.', objectSchema({
      recurrence_id: stringSchema('Recurring task definition id.'),
      actor_agent_id: stringSchema('Architect/operator agent id triggering the recurrence.'),
      authority_basis: authorityBasisSchema('Authority basis for manually triggering the recurrence.'),
      run_reason: stringSchema('Reason for this run.'),
    }, ['recurrence_id', 'actor_agent_id', 'authority_basis', 'run_reason'])),
    tool('task_lifecycle_recurring_runs', 'List generated runs for a recurring task definition.', objectSchema({
      recurrence_id: stringSchema('Recurring task definition id.'),
      limit: numberSchema('Maximum runs to return. Defaults to 20.'),
    }, ['recurrence_id'])),
  ];
}

function dispositionCloseoutSchema(): JsonSchema {
  return objectSchema({
    task_number: numberSchema('Task number to close out.'),
    agent_id: stringSchema('Agent id performing the close-out.'),
    envelope_id: stringSchema('Optional envelope id. If omitted, the task body is scanned for env_<id>.'),
    disposition: stringSchema('Optional disposition label, e.g. already_promoted, acknowledged, dismissed, no_code.'),
    summary: stringSchema('Optional close-out summary.'),
    dry_run: booleanSchema('Plan without writing task notes or finishing.'),
    prove_criteria: booleanSchema('Auto-check criteria after writing notes. Default false.'),
    finish: booleanSchema('Finish the task after writing/proving. Default false.'),
    changed_files: arraySchema(stringSchema('Repo-relative changed file path.'), 'Explicit changed-file evidence for the optional finish report.'),
    no_files_changed: booleanSchema('Explicitly declare that the optional finish legitimately changed no files.'),
  }, ['task_number', 'agent_id']);
}

function finishSchema(): JsonSchema {
  return objectSchema({
    task_number: numberSchema('Task number to finish.'),
    agent_id: stringSchema('Agent id finishing the task.'),
    summary: stringSchema('Finish summary.'),
    directive_id: stringSchema('Optional first-class directive id that caused this report. Prefer this structured field over summary tokens.'),
    verdict: stringSchema('Review-state verdict only: accepted, accepted_with_notes, or rejected. Omit for claimed-state finish/report submission; claimed tasks should use summary plus changed_files or no_files_changed. Invalid values are reported by the finish handler.'),
    reviewer: stringSchema('Optional admitted reviewer agent id or unique reviewer role alias for the generated review obligation.'),
    changed_files: arraySchema(stringSchema('Repo-relative changed file path.'), 'Explicit changed-file evidence for this finish report.'),
    no_files_changed: booleanSchema('Explicitly declare that this finish legitimately changed no files.'),
    recovery_truthfulness: { type: 'object', description: 'Required for serious-failure recovery finish/report claims. Fields: known_facts, inferences, uncertainty, changed, not_changed, remaining_work, evidence_limits, capa_open_status, state. terminal_corrected additionally requires repository_durability / commit-push state plus no open residual work.', additionalProperties: true },
    self_certification: { type: 'object', description: 'Required for architect-failure/deception/trust same-subject terminal correction claims. Fields: target_category, subject_principal, requires_independent_review, misleading_completion_answer, allowed_pending_state, plus independent_review_ref/reviewer_eligibility_ref or operator_acceptance_ref for terminal same-subject correction.', additionalProperties: true },
    payload_ref: stringSchema('Optional immutable payload ref carrying long finish/report companion fields such as summary, changed_files, recovery_truthfulness, or self_certification. Payload fields are merged with top-level arguments; top-level task_number and agent_id win.'),
  }, ['task_number', 'agent_id']);
}

function submitObservationSchema(): JsonSchema {
  return objectSchema({
    task_number: numberSchema('Optional task number to attach to.'),
    artifact_uri: { type: 'string' },
    content: { type: 'object', additionalProperties: true },
    source_operator: stringSchema('Source operator name.'),
    agent_id: stringSchema('Agent id.'),
  }, ['artifact_uri']);
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  options: { payloadRef?: boolean } = { payloadRef: true },
): JsonSchema {
  const finalProperties = { ...properties };
  if (options.payloadRef !== false && !finalProperties.payload_ref) {
    finalProperties.payload_ref = stringSchema('Optional immutable payload ref for long arguments such as summaries, evidence packets, or changed_files.');
  }
  return {
    type: 'object',
    properties: finalProperties,
    required,
    additionalProperties: false,
  };
}

function authorityBasisSchema(description: string): JsonSchema {
  return {
    type: 'object',
    description,
    properties: {
      kind: stringSchema('Authority basis kind.'),
      summary: stringSchema('Short authority basis summary.'),
    },
    required: ['kind', 'summary'],
    additionalProperties: true,
  };
}

function arraySchema(items: JsonSchema, description: string): JsonSchema {
  return { type: 'array', items, description };
}

function booleanSchema(description: string): JsonSchema {
  return { type: 'boolean', description };
}

function enumStringSchema(values: string[], description: string): JsonSchema {
  return { type: 'string', enum: values, description };
}

function nullableStringSchema(description: string): JsonSchema {
  return { type: ['string', 'null'], description };
}

function numberSchema(description: string): JsonSchema {
  return { type: 'number', description };
}

function stringSchema(description: string): JsonSchema {
  return { type: 'string', description };
}

function tool(name: string, description: string, inputSchema: JsonSchema): TaskLifecycleTool {
  return { name, description, inputSchema };
}
