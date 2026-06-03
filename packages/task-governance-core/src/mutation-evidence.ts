import { createHash } from 'node:crypto';

export type MutationEvidenceFamily = 'task_lifecycle' | 'inbox';
export type MutationEvidenceAuthorityClass = 'claim' | 'execute' | 'resolve' | 'confirm' | 'admin';

export interface MutationEvidenceSubject {
  kind: string;
  id: string;
  number?: number | null;
}

export interface MutationEvidenceConfirmation {
  kind: 'read_back' | 'self_certifying' | 'review' | 'operator_confirmation' | 'import_replay';
  status: 'confirmed' | 'pending' | 'not_applicable';
  detail?: string | null;
}

export interface MutationEvidenceRecord {
  schema: 'https://narada.dev/schemas/mutation-evidence/v1';
  version: 1;
  operation_id: string;
  family: MutationEvidenceFamily;
  authority_class: MutationEvidenceAuthorityClass;
  command: string;
  locus: string;
  principal: string;
  subject: MutationEvidenceSubject;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurred_at: string;
  confirmation: MutationEvidenceConfirmation;
  replay_payload: Record<string, unknown>;
}

export interface BuildMutationEvidenceInput {
  family: MutationEvidenceFamily;
  authority_class: MutationEvidenceAuthorityClass;
  command: string;
  locus: string;
  principal: string;
  subject: MutationEvidenceSubject;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurred_at: string;
  confirmation: MutationEvidenceConfirmation;
  replay_payload: Record<string, unknown>;
}

export interface MutationEvidenceValidationError {
  field: string;
  message: string;
}

export function buildMutationEvidenceRecord(input: BuildMutationEvidenceInput): MutationEvidenceRecord {
  const operationPayload = {
    family: input.family,
    authority_class: input.authority_class,
    command: input.command,
    locus: input.locus,
    principal: input.principal,
    subject: input.subject,
    before: input.before,
    after: input.after,
    occurred_at: input.occurred_at,
    confirmation: input.confirmation,
    replay_payload: input.replay_payload,
  };
  return {
    schema: 'https://narada.dev/schemas/mutation-evidence/v1',
    version: 1,
    operation_id: `mev_${sha256(stableStringify(operationPayload)).slice(0, 32)}`,
    ...operationPayload,
  };
}

export function validateMutationEvidenceRecord(value: unknown): MutationEvidenceValidationError[] {
  const errors: MutationEvidenceValidationError[] = [];
  const record = isRecord(value) ? value : null;
  if (!record) return [{ field: '$', message: 'record must be an object' }];

  requireLiteral(errors, record, 'schema', 'https://narada.dev/schemas/mutation-evidence/v1');
  requireLiteral(errors, record, 'version', 1);
  requireString(errors, record, 'operation_id');
  requireEnum(errors, record, 'family', ['task_lifecycle', 'inbox']);
  requireEnum(errors, record, 'authority_class', ['claim', 'execute', 'resolve', 'confirm', 'admin']);
  requireString(errors, record, 'command');
  requireString(errors, record, 'locus');
  requireString(errors, record, 'principal');
  if (!isRecord(record.subject)) {
    errors.push({ field: 'subject', message: 'subject must be an object' });
  } else {
    requireString(errors, record.subject, 'kind', 'subject.kind');
    requireString(errors, record.subject, 'id', 'subject.id');
    if ('number' in record.subject && record.subject.number !== null && typeof record.subject.number !== 'number') {
      errors.push({ field: 'subject.number', message: 'subject.number must be a number or null' });
    }
  }
  if (record.before !== null && !isRecord(record.before)) errors.push({ field: 'before', message: 'before must be object or null' });
  if (record.after !== null && !isRecord(record.after)) errors.push({ field: 'after', message: 'after must be object or null' });
  requireString(errors, record, 'occurred_at');
  if (!isRecord(record.confirmation)) {
    errors.push({ field: 'confirmation', message: 'confirmation must be an object' });
  } else {
    requireEnum(errors, record.confirmation, 'kind', ['read_back', 'self_certifying', 'review', 'operator_confirmation', 'import_replay'], 'confirmation.kind');
    requireEnum(errors, record.confirmation, 'status', ['confirmed', 'pending', 'not_applicable'], 'confirmation.status');
  }
  if (!isRecord(record.replay_payload)) errors.push({ field: 'replay_payload', message: 'replay_payload must be an object' });

  return errors;
}

export function serializeMutationEvidenceRecord(record: MutationEvidenceRecord): string {
  return `${stableStringify(record)}\n`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableStringify);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortForStableStringify(value[key]);
  }
  return sorted;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(errors: MutationEvidenceValidationError[], record: Record<string, unknown>, key: string, field = key): void {
  if (typeof record[key] !== 'string' || String(record[key]).trim().length === 0) {
    errors.push({ field, message: `${field} must be a non-empty string` });
  }
}

function requireLiteral(
  errors: MutationEvidenceValidationError[],
  record: Record<string, unknown>,
  key: string,
  expected: string | number,
): void {
  if (record[key] !== expected) {
    errors.push({ field: key, message: `${key} must be ${JSON.stringify(expected)}` });
  }
}

function requireEnum(
  errors: MutationEvidenceValidationError[],
  record: Record<string, unknown>,
  key: string,
  allowed: string[],
  field = key,
): void {
  if (typeof record[key] !== 'string' || !allowed.includes(String(record[key]))) {
    errors.push({ field, message: `${field} must be one of: ${allowed.join(', ')}` });
  }
}
