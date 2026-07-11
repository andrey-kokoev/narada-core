export const TASK_AGENT_IDENTITY_REF_SCHEMA = 'narada.agent_identity_ref.v2' as const;

export interface TaskAgentIdentityScope {
  readonly kind: 'narada_site' | 'unscoped';
  readonly site_id?: string;
}

export interface TaskAgentIdentityRef {
  readonly schema: typeof TASK_AGENT_IDENTITY_REF_SCHEMA;
  readonly identity_scope: TaskAgentIdentityScope;
  readonly local_agent_id: string;
  readonly role: string | null;
  readonly canonical_agent_id: string;
  readonly display: string;
  readonly legacy_agent_id: string;
}

export interface BuildTaskAgentIdentityRefOptions {
  readonly siteId?: string | null;
  readonly role?: string | null;
}

export function buildTaskAgentIdentityRef(agentId: string, options: BuildTaskAgentIdentityRefOptions = {}): TaskAgentIdentityRef {
  const trimmedAgentId = agentId.trim();
  if (!trimmedAgentId) {
    throw new Error('agent_id_required_for_identity_ref');
  }

  const explicitSiteId = normalizeOptional(options.siteId);
  const prefixed = splitPrefixedAgentId(trimmedAgentId);
  const siteId = explicitSiteId ?? prefixed?.siteId ?? null;
  const localAgentId = prefixed?.localAgentId ?? trimmedAgentId;
  const canonicalAgentId = siteId ? `${siteId}.${localAgentId}` : localAgentId;

  return {
    schema: TASK_AGENT_IDENTITY_REF_SCHEMA,
    identity_scope: siteId ? { kind: 'narada_site', site_id: siteId } : { kind: 'unscoped' },
    local_agent_id: localAgentId,
    role: normalizeOptional(options.role),
    canonical_agent_id: canonicalAgentId,
    display: canonicalAgentId,
    legacy_agent_id: trimmedAgentId,
  };
}

export function taskAgentIdentityRefJson(agentId: string, options: BuildTaskAgentIdentityRefOptions = {}): string {
  return JSON.stringify(buildTaskAgentIdentityRef(agentId, options));
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function splitPrefixedAgentId(agentId: string): { siteId: string; localAgentId: string } | null {
  const dotIndex = agentId.indexOf('.');
  if (dotIndex <= 0 || dotIndex === agentId.length - 1) return null;
  return {
    siteId: agentId.slice(0, dotIndex),
    localAgentId: agentId.slice(dotIndex + 1),
  };
}
