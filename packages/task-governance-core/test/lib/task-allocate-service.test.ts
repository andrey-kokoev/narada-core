import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateTaskNumbersService } from '../../src/task-allocate-service.js';
import { openTaskLifecycleStore } from '../../src/task-lifecycle-store.js';
import { ExitCode } from '../../src/exit-codes.js';

describe('task allocation service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-task-allocate-service-'));
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-100-existing.md'),
      '---\nstatus: opened\n---\n\n# Existing\n',
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('allocates one task number', async () => {
    const result = await allocateTaskNumbersService({ cwd: tempDir });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result).toMatchObject({
      status: 'success',
      allocated_number: 101,
      allocated_numbers: [101],
      count: 1,
    });
  });

  it('allocates a sequential range atomically', async () => {
    const result = await allocateTaskNumbersService({ cwd: tempDir, count: 3 });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result).toMatchObject({
      status: 'success',
      allocated_number: 101,
      allocated_numbers: [101, 102, 103],
      count: 3,
    });
    const store = openTaskLifecycleStore(tempDir);
    try {
      expect(store.getLastAllocated()).toBe(103);
    } finally {
      store.db.close();
    }
  });

  it('previews a range without mutation', async () => {
    const result = await allocateTaskNumbersService({ cwd: tempDir, count: 3, dryRun: true });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result).toMatchObject({
      status: 'dry_run',
      next_number: 101,
      next_numbers: [101, 102, 103],
      count: 3,
    });
    const store = openTaskLifecycleStore(tempDir);
    try {
      expect(store.getLastAllocated()).toBe(0);
    } finally {
      store.db.close();
    }
  });

  it('rejects invalid count', async () => {
    const result = await allocateTaskNumbersService({ cwd: tempDir, count: 0 });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.result).toEqual({ status: 'error', error: '--count must be a positive integer' });
  });
});
