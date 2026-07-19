import { describe, expect, it } from 'vitest';
import {
  TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
  TASK_EXECUTABILITY_DECLARED_ENVIRONMENT_SCHEMA,
  TASK_EXECUTABILITY_FINDING_SCHEMA,
  TASK_EXECUTABILITY_OVERRIDE_SCHEMA,
  TASK_EXECUTABILITY_POLICY_SCHEMA,
  TASK_EXECUTABILITY_PRODUCT_DEFAULTS,
  canonicalizeForDigest,
  declaredEnvironmentDigest,
  deriveTaskExecutabilityVerdict,
  isAssessmentCurrent,
  resolveTaskExecutabilityPolicy,
  taskExecutabilityDispatchFingerprint,
  taskExecutabilityOverrideId,
  taskExecutabilityPolicyPath,
  taskExecutabilityRequestId,
  taskSpecDigest,
  validateTaskExecutabilityAssessment,
  validateTaskExecutabilityEvaluatorProvenance,
  validateTaskExecutabilityFinding,
  validateTaskExecutabilityOverride,
  validateTaskExecutabilityPolicy,
  type TaskExecutabilityAssessment,
  type TaskExecutabilityFinding,
} from '../../src/task-executability-contract.js';

function finding(kind: TaskExecutabilityFinding['kind'], severity: TaskExecutabilityFinding['severity']): TaskExecutabilityFinding {
  return { schema: TASK_EXECUTABILITY_FINDING_SCHEMA, kind, severity, code: `${kind}:x`, message: 'm' };
}

const SPEC = {
  title: 'Do the thing',
  goal: 'goal',
  context: 'context',
  required_work: '1. step',
  non_goals: '- no',
  acceptance_criteria: ['a', 'b'],
  dependencies: [1, 2],
};

const ENV = {
  site_id: 'andrey-user',
  substrate: 'windows',
  variant: 'native',
  declared_tools: ['task_lifecycle_show'],
  declared_authority: ['read'],
};

function validAssessment(): TaskExecutabilityAssessment {
  return {
    schema: TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
    assessment_id: 'texa_1',
    request_id: 'texr_1',
    task_id: '20260719-1-x',
    task_number: 1,
    task_spec_digest: taskSpecDigest(SPEC),
    environment_digest: declaredEnvironmentDigest(ENV),
    verdict: 'executable',
    findings: [],
    evaluator: {
      schema: 'narada.task_executability_evaluator_provenance.v1',
      profile: 'shoshin-v1',
      profile_version: '1.0.0',
      cognition: 'low',
      provider: 'openai-api',
      model: 'gpt-5.6-sol',
    },
    created_at: '2026-07-19T00:00:00.000Z',
  };
}

describe('policy validation', () => {
  it('accepts an empty overlay and partial overlays', () => {
    expect(validateTaskExecutabilityPolicy({ schema: TASK_EXECUTABILITY_POLICY_SCHEMA })).toEqual([]);
    expect(
      validateTaskExecutabilityPolicy({ schema: TASK_EXECUTABILITY_POLICY_SCHEMA, trigger: 'on_create', enforcement: 'warn' }),
    ).toEqual([]);
  });

  it('rejects malformed documents and invalid enum values', () => {
    expect(validateTaskExecutabilityPolicy(null)).toEqual(['policy_not_an_object']);
    expect(validateTaskExecutabilityPolicy({ schema: 'wrong' })).toContain('policy_schema_mismatch');
    expect(validateTaskExecutabilityPolicy({ schema: TASK_EXECUTABILITY_POLICY_SCHEMA, trigger: 'sometimes' })).toContain(
      'policy_trigger_invalid',
    );
    expect(validateTaskExecutabilityPolicy({ schema: TASK_EXECUTABILITY_POLICY_SCHEMA, enforcement: 'hard' })).toContain(
      'policy_enforcement_invalid',
    );
    expect(validateTaskExecutabilityPolicy({ schema: TASK_EXECUTABILITY_POLICY_SCHEMA, evaluator_profile: '' })).toContain(
      'policy_evaluator_profile_invalid',
    );
  });

  it('rejects provider/model selection in Task Lifecycle policy', () => {
    const errors = validateTaskExecutabilityPolicy({ schema: TASK_EXECUTABILITY_POLICY_SCHEMA, provider: 'openai-api', model: 'x' });
    expect(errors).toContain('policy_field_forbidden:provider');
    expect(errors).toContain('policy_field_forbidden:model');
  });
});

describe('policy resolution cascade', () => {
  const target = '/target';
  const user = '/user';
  const host = '/host';

  function reader(files: Record<string, unknown>) {
    return (path: string) => {
      const hit = Object.entries(files).find(([key]) => path === key);
      return hit ? JSON.stringify(hit[1]) : null;
    };
  }

  it('falls back to product defaults when no locus has a policy file', () => {
    const resolved = resolveTaskExecutabilityPolicy({ targetSiteRoot: target, userSiteRoot: user, hostSiteRoot: host, readFile: () => null });
    expect(resolved.trigger).toBe(TASK_EXECUTABILITY_PRODUCT_DEFAULTS.trigger);
    expect(resolved.enforcement).toBe(TASK_EXECUTABILITY_PRODUCT_DEFAULTS.enforcement);
    expect(resolved.evaluator_profile).toBe(TASK_EXECUTABILITY_PRODUCT_DEFAULTS.evaluator_profile);
    expect(resolved.provenance.every((entry) => entry.source === 'product_default')).toBe(true);
  });

  it('resolves target Site over User Site over Host Site over defaults per field', () => {
    const files = {
      [taskExecutabilityPolicyPath(host)]: {
        schema: TASK_EXECUTABILITY_POLICY_SCHEMA,
        trigger: 'on_create',
        enforcement: 'strict',
        evaluator_profile: 'host-profile',
      },
      [taskExecutabilityPolicyPath(user)]: { schema: TASK_EXECUTABILITY_POLICY_SCHEMA, enforcement: 'warn' },
      [taskExecutabilityPolicyPath(target)]: { schema: TASK_EXECUTABILITY_POLICY_SCHEMA, trigger: 'manual' },
    };
    const resolved = resolveTaskExecutabilityPolicy({ targetSiteRoot: target, userSiteRoot: user, hostSiteRoot: host, readFile: reader(files) });
    expect(resolved.trigger).toBe('manual');
    expect(resolved.enforcement).toBe('warn');
    expect(resolved.evaluator_profile).toBe('host-profile');
    const byField = Object.fromEntries(resolved.provenance.map((entry) => [entry.field, entry]));
    expect(byField.trigger.source).toBe('target_site');
    expect(byField.trigger.source_ref).toBe(taskExecutabilityPolicyPath(target));
    expect(byField.enforcement.source).toBe('user_site');
    expect(byField.evaluator_profile.source).toBe('host_site');
  });

  it('resolves with only a target locus when user/host roots are absent', () => {
    const resolved = resolveTaskExecutabilityPolicy({ targetSiteRoot: target, readFile: () => null });
    expect(resolved.provenance).toHaveLength(3);
    expect(resolved.trigger).toBe('manual');
  });

  it('throws on malformed policy files instead of silently falling back', () => {
    const files = { [taskExecutabilityPolicyPath(target)]: '{not json' };
    expect(() =>
      resolveTaskExecutabilityPolicy({
        targetSiteRoot: target,
        readFile: (path) => (path === taskExecutabilityPolicyPath(target) ? (files as never)[path] : null),
      }),
    ).toThrow(/task_executability_policy_invalid:target_site:not_json/);
  });
});

describe('digests', () => {
  it('canonicalizes with sorted keys so key order does not matter', () => {
    expect(canonicalizeForDigest({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalizeForDigest({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('is deterministic for the same spec and changes on material edits', () => {
    const base = taskSpecDigest(SPEC);
    expect(taskSpecDigest({ ...SPEC })).toBe(base);
    expect(taskSpecDigest({ ...SPEC, required_work: '1. different' })).not.toBe(base);
    expect(taskSpecDigest({ ...SPEC, acceptance_criteria: ['a'] })).not.toBe(base);
    expect(taskSpecDigest({ ...SPEC, dependencies: [2, 1] })).not.toBe(base);
  });

  it('sorts declared environment capabilities so declaration order does not matter', () => {
    const a = declaredEnvironmentDigest({ ...ENV, declared_tools: ['x', 'y'] });
    const b = declaredEnvironmentDigest({ ...ENV, declared_tools: ['y', 'x'] });
    expect(a).toBe(b);
    expect(declaredEnvironmentDigest({ ...ENV, site_id: 'other' })).not.toBe(a);
  });
});

describe('assessment currency', () => {
  it('is current only when both digests match', () => {
    const assessment = validAssessment();
    expect(
      isAssessmentCurrent({
        assessment,
        currentTaskSpecDigest: assessment.task_spec_digest,
        currentEnvironmentDigest: assessment.environment_digest,
      }),
    ).toBe(true);
    expect(
      isAssessmentCurrent({ assessment, currentTaskSpecDigest: 'changed', currentEnvironmentDigest: assessment.environment_digest }),
    ).toBe(false);
  });
});

describe('verdict derivation', () => {
  it('derives executable when nothing blocks', () => {
    expect(deriveTaskExecutabilityVerdict([])).toBe('executable');
    expect(deriveTaskExecutabilityVerdict([finding('evaluator_note', 'warning')])).toBe('executable');
  });

  it('derives needs_revision for blocking spec-level findings', () => {
    expect(deriveTaskExecutabilityVerdict([finding('unresolved_reference', 'blocking')])).toBe('needs_revision');
    expect(deriveTaskExecutabilityVerdict([finding('undecided_choice', 'blocking')])).toBe('needs_revision');
    expect(deriveTaskExecutabilityVerdict([finding('unmapped_acceptance_criterion', 'blocking')])).toBe('needs_revision');
  });

  it('derives not_executable for blocking environment findings and lets them dominate', () => {
    expect(deriveTaskExecutabilityVerdict([finding('unavailable_authority', 'blocking')])).toBe('not_executable');
    expect(deriveTaskExecutabilityVerdict([finding('unavailable_tool', 'blocking')])).toBe('not_executable');
    expect(
      deriveTaskExecutabilityVerdict([finding('unresolved_reference', 'blocking'), finding('unavailable_tool', 'blocking')]),
    ).toBe('not_executable');
  });
});

describe('contract validators', () => {
  it('accepts a valid assessment', () => {
    expect(validateTaskExecutabilityAssessment(validAssessment())).toEqual([]);
  });

  it('rejects malformed assessments, findings, evaluator provenance, and overrides', () => {
    expect(validateTaskExecutabilityAssessment({})).toContain('assessment_schema_mismatch');
    expect(validateTaskExecutabilityAssessment({ ...validAssessment(), verdict: 'maybe' })).toContain('assessment_verdict_invalid');
    expect(
      validateTaskExecutabilityAssessment({ ...validAssessment(), findings: [{ schema: TASK_EXECUTABILITY_FINDING_SCHEMA }] }),
    ).toContain('assessment_finding_invalid:finding_kind_invalid');
    expect(validateTaskExecutabilityFinding({ schema: TASK_EXECUTABILITY_FINDING_SCHEMA, kind: 'nope', severity: 'blocking', code: 'c', message: 'm' })).toContain(
      'finding_kind_invalid',
    );
    expect(
      validateTaskExecutabilityEvaluatorProvenance({
        schema: 'narada.task_executability_evaluator_provenance.v1',
        profile: 'shoshin-v1',
        profile_version: '1.0.0',
        cognition: 'high',
      }),
    ).toContain('evaluator_cognition_must_be_low');
    expect(
      validateTaskExecutabilityOverride({
        schema: TASK_EXECUTABILITY_OVERRIDE_SCHEMA,
        override_id: 'texo_1',
        task_id: 't',
        task_spec_digest: 'd',
        dispatch_fingerprint: 'texd_1',
        actor: 'op',
        reason: 'r',
        created_at: '2026-07-19T00:00:00.000Z',
        consumed_at: null,
      }),
    ).toContain('override_authority_basis_required');
  });
});

describe('deterministic ids and fingerprints', () => {
  it('derives stable request ids for the same logical request', () => {
    const args = {
      task_id: 't',
      task_spec_digest: taskSpecDigest(SPEC),
      environment_digest: declaredEnvironmentDigest(ENV),
      evaluator_profile: 'shoshin-v1',
      evaluator_profile_version: '1.0.0',
    };
    expect(taskExecutabilityRequestId(args)).toBe(taskExecutabilityRequestId({ ...args }));
    expect(taskExecutabilityRequestId(args)).toMatch(/^texr_[0-9a-f]{32}$/);
    expect(taskExecutabilityRequestId({ ...args, task_spec_digest: 'other' })).not.toBe(taskExecutabilityRequestId(args));
  });

  it('scopes dispatch fingerprints to the concrete envelope', () => {
    const args = {
      task_id: 't',
      task_spec_digest: 'd1',
      environment_digest: 'e1',
      workflow: 'implement',
      site_id: 'andrey-user',
    };
    expect(taskExecutabilityDispatchFingerprint(args)).toBe(taskExecutabilityDispatchFingerprint({ ...args }));
    expect(taskExecutabilityDispatchFingerprint({ ...args, site_id: 'other' })).not.toBe(taskExecutabilityDispatchFingerprint(args));
    expect(
      taskExecutabilityOverrideId({ task_id: 't', dispatch_fingerprint: 'texd_1', actor: 'op', created_at: '2026-07-19T00:00:00Z' }),
    ).toMatch(/^texo_[0-9a-f]{32}$/);
  });
});
