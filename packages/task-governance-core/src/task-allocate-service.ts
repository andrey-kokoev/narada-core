import { resolve } from 'node:path';
import { ExitCode } from './exit-codes.js';
import { allocateTaskNumbers, previewNextTaskNumbers } from './task-governance.js';

export interface AllocateTaskNumbersServiceOptions {
  cwd?: string;
  count?: number;
  dryRun?: boolean;
}

export interface AllocateTaskNumbersServiceResult {
  status: 'success' | 'dry_run' | 'error';
  allocated_number?: number;
  allocated_numbers?: number[];
  next_number?: number;
  next_numbers?: number[];
  count?: number;
  error?: string;
}

export async function allocateTaskNumbersService(
  options: AllocateTaskNumbersServiceOptions,
): Promise<{ exitCode: ExitCode; result: AllocateTaskNumbersServiceResult }> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const count = options.count ?? 1;

  if (!Number.isInteger(count) || count < 1) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: '--count must be a positive integer' },
    };
  }

  try {
    if (options.dryRun) {
      const numbers = await previewNextTaskNumbers(cwd, count);
      return {
        exitCode: ExitCode.SUCCESS,
        result: {
          status: 'dry_run',
          next_number: numbers[0],
          next_numbers: numbers,
          count,
        },
      };
    }

    const numbers = await allocateTaskNumbers(cwd, count);
    return {
      exitCode: ExitCode.SUCCESS,
      result: {
        status: 'success',
        allocated_number: numbers[0],
        allocated_numbers: numbers,
        count,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: msg },
    };
  }
}
