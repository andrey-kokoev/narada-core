import type { AgentRoster, AgentRosterEntry } from './task-governance.js';

export const TASK_REVIEW_AUTHORITY_MODEL = {
  model: 'typed_composition',
  review_execution: 'role_capability_authority',
  review_request: 'directed_obligation_routing_signal',
  operator_delegation: 'explicit_task_authority_admission',
  allowed_roles: ['reviewer', 'admin'],
  typed_composition_capabilities: ['review', 'task_review', 'architect_as_reviewer'],
  operator_capabilities: ['review', 'task_review', 'operator_delegation'],
} as const;

export type ReviewAuthorityKind = 'role_capability' | 'typed_composition' | 'operator_delegation';

export type ReviewAuthorityRepairReason =
  | 'missing_reviewer_identity'
  | 'review_authority_not_admitted';

export interface ReviewAuthorityRepair {
  reason: ReviewAuthorityRepairReason;
  commands: string[];
  no_workaround: string;
}

export interface ReviewAuthorityAdmission {
  admitted: boolean;
  authority_kind?: ReviewAuthorityKind;
  rationale: string;
  accepted_capabilities?: string[];
}

export interface ResolvedReviewTarget {
  ok: true;
  requested: string;
  target_agent_id: string | null;
  target_role: string | null;
  resolution: 'agent_id' | 'role_alias';
  review_authority: ReviewAuthorityAdmission & { admitted: true };
}

export type ReviewTargetResolution =
  | null
  | ResolvedReviewTarget
  | { ok: false; error: string; review_authority_repair?: ReviewAuthorityRepair };

const TYPED_REVIEW_CAPABILITIES = new Set<string>(TASK_REVIEW_AUTHORITY_MODEL.typed_composition_capabilities);
const OPERATOR_REVIEW_CAPABILITIES = new Set<string>(TASK_REVIEW_AUTHORITY_MODEL.operator_capabilities);

export function explainTaskReviewAuthority(agent: AgentRosterEntry): ReviewAuthorityAdmission {
  const capabilities = agent.capabilities ?? [];
  if (agent.role === 'reviewer' || agent.role === 'admin') {
    return {
      admitted: true,
      authority_kind: 'role_capability',
      rationale: `role '${agent.role}' carries task review authority`,
      accepted_capabilities: capabilities,
    };
  }
  if (agent.role === 'operator') {
    const admittedCapabilities = capabilities.filter((capability) => OPERATOR_REVIEW_CAPABILITIES.has(capability));
    if (admittedCapabilities.length > 0) {
      return {
        admitted: true,
        authority_kind: 'operator_delegation',
        rationale: `operator identity is explicitly delegated task review capability '${admittedCapabilities[0]}'`,
        accepted_capabilities: admittedCapabilities,
      };
    }
  }
  const admittedCapabilities = capabilities.filter((capability) => TYPED_REVIEW_CAPABILITIES.has(capability));
  if (admittedCapabilities.length > 0) {
    return {
      admitted: true,
      authority_kind: 'typed_composition',
      rationale: `role '${agent.role}' is composed with review capability '${admittedCapabilities[0]}'`,
      accepted_capabilities: admittedCapabilities,
    };
  }
  return {
    admitted: false,
    rationale: `role '${agent.role}' with capabilities [${capabilities.join(', ') || 'none'}] is not admitted for task review`,
    accepted_capabilities: capabilities,
  };
}

export function hasTaskReviewAuthority(agent: AgentRosterEntry): boolean {
  return explainTaskReviewAuthority(agent).admitted;
}

export function reviewerAuthorityRepair(args: {
  taskNumber: string;
  agentId: string;
  reason: ReviewAuthorityRepairReason;
  role?: string;
}): ReviewAuthorityRepair {
  const authorityCommand = args.role === 'operator'
    ? `narada task roster add ${args.agentId} --role operator --capability operator_delegation`
    : `narada task roster add ${args.agentId} --role ${args.role ?? 'reviewer'} --capability review`;
  return {
    reason: args.reason,
    commands: [
      authorityCommand,
      `narada task review ${args.taskNumber} --agent ${args.agentId} --verdict <accepted|accepted_with_notes|rejected>`,
    ],
    no_workaround: 'Do not record this review as operator or another principal unless that principal is the actual admitted reviewer.',
  };
}

export function resolveReviewTargetFromRoster(
  roster: AgentRoster,
  requested: string | undefined,
  options: { taskNumber?: string } = {},
): ReviewTargetResolution {
  const trimmed = requested?.trim();
  if (!trimmed) return null;

  const resolveAgent = (
    agent: AgentRosterEntry,
    resolution: ResolvedReviewTarget['resolution'],
    requestedLabel: string = trimmed,
  ): ResolvedReviewTarget | { ok: false; error: string; review_authority_repair?: ReviewAuthorityRepair } => {
    const authority = explainTaskReviewAuthority(agent);
    if (!authority.admitted) {
      return {
        ok: false,
        error: `Review target '${requestedLabel}' resolves to ${agent.agent_id}, but task review would refuse it: ${authority.rationale}`,
        review_authority_repair: options.taskNumber
          ? reviewerAuthorityRepair({
              taskNumber: options.taskNumber,
              agentId: agent.agent_id,
              reason: 'review_authority_not_admitted',
              role: agent.role,
            })
          : undefined,
      };
    }
    return {
      ok: true,
      requested: requestedLabel,
      target_agent_id: agent.agent_id,
      target_role: agent.role ?? null,
      resolution,
      review_authority: authority as ReviewAuthorityAdmission & { admitted: true },
    };
  };

  const roleMatches = roster.agents.filter((agent) => agent.role === trimmed);
  if (trimmed === 'builder' && roleMatches.length > 0) {
    const admitted = roleMatches
      .map((agent) => ({ agent, authority: explainTaskReviewAuthority(agent) }))
      .filter((entry): entry is { agent: AgentRosterEntry; authority: ReviewAuthorityAdmission & { admitted: true } } =>
        entry.authority.admitted,
      );
    if (admitted.length > 0) {
      return {
        ok: true,
        requested: trimmed,
        target_agent_id: null,
        target_role: trimmed,
        resolution: 'role_alias',
        review_authority: admitted[0]!.authority,
      };
    }
    return {
      ok: false,
      error: `Review target '${trimmed}' matches role agents without admitted review authority: ${roleMatches.map((agent) => agent.agent_id).join(', ')}`,
    };
  }

  const exact = roster.agents.find((agent) => agent.agent_id === trimmed);
  if (exact) return resolveAgent(exact, 'agent_id');

  if (roleMatches.length > 0) {
    const admitted = roleMatches
      .map((agent) => ({ agent, authority: explainTaskReviewAuthority(agent) }))
      .filter((entry): entry is { agent: AgentRosterEntry; authority: ReviewAuthorityAdmission & { admitted: true } } =>
        entry.authority.admitted,
      );
    if (admitted.length > 0) {
      return {
        ok: true,
        requested: trimmed,
        target_agent_id: null,
        target_role: trimmed,
        resolution: 'role_alias',
        review_authority: admitted[0]!.authority,
      };
    }
    return {
      ok: false,
      error: `Review target '${trimmed}' matches role agents without admitted review authority: ${roleMatches.map((agent) => agent.agent_id).join(', ')}`,
    };
  }
  return {
    ok: false,
    error: `Review target '${trimmed}' is not an admitted agent id or unique role alias`,
    review_authority_repair: options.taskNumber
      ? reviewerAuthorityRepair({
          taskNumber: options.taskNumber,
          agentId: trimmed,
          reason: 'missing_reviewer_identity',
        })
      : undefined,
  };
}

export function resolveDefaultReviewerFromRoster(
  roster: AgentRoster,
  defaultRole: string,
): ResolvedReviewTarget | { ok: false; error: string } {
  const roleMatches = roster.agents.filter(
    (agent) => agent.role === defaultRole && hasTaskReviewAuthority(agent),
  );
  if (roleMatches.length === 0) {
    return {
      ok: false,
      error: `Default reviewer role '${defaultRole}' matches no agents with review authority`,
    };
  }
  const agent = roleMatches[0]!;
  const authority = explainTaskReviewAuthority(agent);
  return {
    ok: true,
    requested: defaultRole,
    target_agent_id: null,
    target_role: defaultRole,
    resolution: 'role_alias',
    review_authority: authority as ReviewAuthorityAdmission & { admitted: true },
  };
}
