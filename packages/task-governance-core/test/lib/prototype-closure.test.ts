import { describe, expect, it } from 'vitest';
import {
  analyzePrototypeClosure,
  validateTaskClosurePosture,
  type PrototypeClosurePosture,
} from '../../src/prototype-closure.js';

describe('TaskClosurePosture state machine', () => {
  it('maps ordinary completion to capability_complete', () => {
    const posture = analyzePrototypeClosure({ title: 'Implement usable delivery' }, '## Execution Notes\nDone.\n');

    expect(posture).toMatchObject({
      closure_posture: 'capability_complete',
      residual_crossing_required: false,
      residual_crossing: 'none',
      capability_complete: true,
      transition_complete: true,
    });
    expect(validateTaskClosurePosture(posture)).toEqual({ valid: true, invalid_transition_reason: null });
  });

  it('maps prototype completion with continuation to scope_complete_with_continuation', () => {
    const posture = analyzePrototypeClosure(
      { title: 'Build MCP facade prototype' },
      'Continuation Task: task 123 implements the usable runtime.\n',
    );

    expect(posture).toMatchObject({
      closure_posture: 'scope_complete_with_continuation',
      residual_crossing_required: true,
      residual_crossing: 'continuation_task',
      capability_complete: true,
      transition_complete: true,
    });
    expect(validateTaskClosurePosture(posture)).toEqual({ valid: true, invalid_transition_reason: null });
  });

  it('maps prototype completion with rationale to scope_complete_with_deferral', () => {
    const posture = analyzePrototypeClosure(
      { title: 'Design-only spike', no_continuation_needed_rationale: 'Discardable decision record only.' },
      '## Execution Notes\nDone.\n',
    );

    expect(posture).toMatchObject({
      closure_posture: 'scope_complete_with_deferral',
      residual_crossing_required: true,
      residual_crossing: 'deferral_rationale',
      capability_complete: true,
      transition_complete: true,
    });
    expect(validateTaskClosurePosture(posture)).toEqual({ valid: true, invalid_transition_reason: null });
  });

  it('keeps prototype completion without residual handling non-transition-complete', () => {
    const posture = analyzePrototypeClosure({ title: 'MCP facade prototype' }, '## Execution Notes\nDone.\n');

    expect(posture).toMatchObject({
      closure_posture: 'scope_complete_with_continuation',
      residual_crossing_required: true,
      residual_crossing: 'continuation_task',
      capability_complete: false,
      transition_complete: false,
    });
    expect(validateTaskClosurePosture(posture)).toEqual({ valid: true, invalid_transition_reason: null });
  });

  it('rejects invalid posture transitions', () => {
    const invalid: PrototypeClosurePosture = {
      applies: true,
      terms: ['prototype'],
      closure_posture: 'scope_complete_with_deferral',
      has_continuation_relation: false,
      no_continuation_needed_rationale: null,
      residual_crossing_required: true,
      residual_crossing: 'deferral_rationale',
      scope_complete: true,
      capability_complete: true,
      doctrine_complete: false,
      transition_complete: true,
    };

    expect(validateTaskClosurePosture(invalid)).toEqual({
      valid: false,
      invalid_transition_reason: 'scope_complete_with_deferral requires a no-continuation-needed rationale',
    });
  });
});
