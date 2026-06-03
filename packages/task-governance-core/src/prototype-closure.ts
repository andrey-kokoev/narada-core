import type { TaskFrontMatter } from './task-governance.js';

export interface PrototypeClosurePosture {
  applies: boolean;
  terms: string[];
  closure_posture: ClosurePostureKind;
  has_continuation_relation: boolean;
  no_continuation_needed_rationale: string | null;
  residual_crossing_required: boolean;
  residual_crossing: 'continuation_task' | 'deferral_rationale' | 'none';
  scope_complete: boolean;
  capability_complete: boolean;
  doctrine_complete: boolean;
  transition_complete: boolean;
  warning?: string;
}

export type ClosurePostureKind =
  | 'capability_complete'
  | 'scope_complete_with_continuation'
  | 'scope_complete_with_deferral'
  | 'repair_required'
  | 'blocked';

export const TASK_CLOSURE_POSTURE_STATES: readonly ClosurePostureKind[] = [
  'capability_complete',
  'scope_complete_with_continuation',
  'scope_complete_with_deferral',
  'repair_required',
  'blocked',
] as const;

export function isTerminalClosurePosture(posture: ClosurePostureKind): boolean {
  return posture === 'capability_complete'
    || posture === 'scope_complete_with_continuation'
    || posture === 'scope_complete_with_deferral';
}

export function validateTaskClosurePosture(posture: PrototypeClosurePosture): {
  valid: boolean;
  invalid_transition_reason: string | null;
} {
  if (!TASK_CLOSURE_POSTURE_STATES.includes(posture.closure_posture)) {
    return { valid: false, invalid_transition_reason: `unknown closure posture: ${String(posture.closure_posture)}` };
  }
  if (posture.closure_posture === 'capability_complete' && !posture.capability_complete) {
    return { valid: false, invalid_transition_reason: 'capability_complete posture requires capability_complete=true' };
  }
  if (posture.closure_posture === 'scope_complete_with_continuation' && posture.applies && !posture.has_continuation_relation && posture.capability_complete) {
    return { valid: false, invalid_transition_reason: 'scope_complete_with_continuation capability completion requires a continuation relation' };
  }
  if (posture.closure_posture === 'scope_complete_with_deferral' && !posture.no_continuation_needed_rationale) {
    return { valid: false, invalid_transition_reason: 'scope_complete_with_deferral requires a no-continuation-needed rationale' };
  }
  if ((posture.closure_posture === 'repair_required' || posture.closure_posture === 'blocked') && posture.transition_complete) {
    return { valid: false, invalid_transition_reason: `${posture.closure_posture} cannot be transition_complete` };
  }
  return { valid: true, invalid_transition_reason: null };
}

const PROTOTYPE_TERMS = [
  'facade',
  'prototype',
  'spike',
  'design-only',
  'design only',
  'proof of concept',
  'poc',
];

function textIncludesTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function hasContinuationRelation(frontMatter: TaskFrontMatter, body: string): boolean {
  const continuationTasks = frontMatter.continuation_tasks;
  if (Array.isArray(continuationTasks) && continuationTasks.length > 0) return true;
  if (typeof continuationTasks === 'string' && continuationTasks.trim().length > 0) return true;
  return /\b(continuation|follow[- ]?up|implementation)\s+task\b[^\n]*\b\d+\b/i.test(body) ||
    /\btask\s+#?\d+\b[^\n]*\b(continuation|follow[- ]?up|implementation)\b/i.test(body);
}

export function analyzePrototypeClosure(frontMatter: TaskFrontMatter, body: string): PrototypeClosurePosture {
  const text = `${String(frontMatter.title ?? '')}\n${body}`;
  const terms = PROTOTYPE_TERMS.filter((term) => textIncludesTerm(text, term));
  const noContinuation = typeof frontMatter.no_continuation_needed_rationale === 'string'
    ? frontMatter.no_continuation_needed_rationale.trim()
    : '';
  const applies = terms.length > 0;
  const continuation = hasContinuationRelation(frontMatter, body);
  const capabilityComplete = applies ? continuation || noContinuation.length > 0 : true;
  const doctrineRelevant = /\b(doctrine|law|semantic|contract)\b/i.test(text);
  const transitionComplete = !applies || capabilityComplete;
  const closurePosture: ClosurePostureKind = !applies
    ? 'capability_complete'
    : continuation
      ? 'scope_complete_with_continuation'
      : noContinuation.length > 0
        ? 'scope_complete_with_deferral'
        : 'scope_complete_with_continuation';
  return {
    applies,
    terms,
    closure_posture: closurePosture,
    has_continuation_relation: continuation,
    no_continuation_needed_rationale: noContinuation || null,
    residual_crossing_required: applies,
    residual_crossing: continuation
      ? 'continuation_task'
      : noContinuation.length > 0
        ? 'deferral_rationale'
        : applies
          ? 'continuation_task'
          : 'none',
    scope_complete: true,
    capability_complete: capabilityComplete,
    doctrine_complete: doctrineRelevant ? transitionComplete : false,
    transition_complete: transitionComplete,
    ...(applies && !capabilityComplete
      ? { warning: 'Scope may be complete, but facade/prototype/spike/design-only language requires continuation evidence or a no-continuation-needed rationale before capability-complete closure.' }
      : {}),
  };
}
