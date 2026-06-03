import { describe, expect, it } from 'vitest';
import {
  buildMutationEvidenceRecord,
  serializeMutationEvidenceRecord,
  stableStringify,
  validateMutationEvidenceRecord,
} from '../../src/mutation-evidence.js';

const baseInput = {
  family: 'task_lifecycle' as const,
  authority_class: 'claim' as const,
  command: 'narada task claim 123 --agent architect',
  locus: 'site:narada-proper',
  principal: 'architect',
  subject: { kind: 'task', id: '20260427-123-example', number: 123 },
  before: { status: 'opened' },
  after: { status: 'claimed' },
  occurred_at: '2026-04-27T22:00:00.000Z',
  confirmation: { kind: 'read_back' as const, status: 'confirmed' as const, detail: 'status=claimed' },
  replay_payload: { task_id: '20260427-123-example', status: 'claimed' },
};

describe('mutation evidence schema', () => {
  it('builds deterministic operation ids from stable operation payloads', () => {
    const first = buildMutationEvidenceRecord(baseInput);
    const second = buildMutationEvidenceRecord({
      replay_payload: { status: 'claimed', task_id: '20260427-123-example' },
      confirmation: { status: 'confirmed', detail: 'status=claimed', kind: 'read_back' },
      occurred_at: '2026-04-27T22:00:00.000Z',
      after: { status: 'claimed' },
      before: { status: 'opened' },
      subject: { number: 123, id: '20260427-123-example', kind: 'task' },
      principal: 'architect',
      locus: 'site:narada-proper',
      command: 'narada task claim 123 --agent architect',
      authority_class: 'claim',
      family: 'task_lifecycle',
    });

    expect(first.operation_id).toBe(second.operation_id);
    expect(first.operation_id).toMatch(/^mev_[0-9a-f]{32}$/);
  });

  it('validates required schema fields', () => {
    const record = buildMutationEvidenceRecord(baseInput);

    expect(validateMutationEvidenceRecord(record)).toEqual([]);
    expect(validateMutationEvidenceRecord({ ...record, principal: '' })).toEqual([
      { field: 'principal', message: 'principal must be a non-empty string' },
    ]);
    expect(validateMutationEvidenceRecord({ ...record, family: 'unknown' })).toEqual([
      { field: 'family', message: 'family must be one of: task_lifecycle, inbox' },
    ]);
  });

  it('serializes records with sorted keys and final newline', () => {
    const record = buildMutationEvidenceRecord(baseInput);
    const serialized = serializeMutationEvidenceRecord(record);

    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized)).toEqual(record);
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
