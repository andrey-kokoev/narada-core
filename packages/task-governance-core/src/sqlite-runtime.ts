import { builtinModules, createRequire } from 'node:module';

export const SQLITE_BACKEND_ENV = 'NARADA_SQLITE_BACKEND';

export type SqliteBackendPreference = 'auto' | 'better-sqlite3' | 'node:sqlite';
export type SqliteBackendKind = 'better-sqlite3' | 'node:sqlite';

export interface SqliteRuntimePosture {
  preference: SqliteBackendPreference;
  selected: SqliteBackendKind;
  supported: boolean;
  node_version: string;
  node_major: number;
  node_sqlite_available: boolean;
  better_sqlite3_available: boolean;
  reason: string;
  remediation?: string;
}

export interface SelectSqliteRuntimeOptions {
  preference?: string | null;
  nodeVersion?: string;
  nodeSqliteAvailable?: boolean;
  betterSqlite3Available?: boolean;
}

const VALID_PREFERENCES = new Set<SqliteBackendPreference>([
  'auto',
  'better-sqlite3',
  'node:sqlite',
]);

export function parseSqliteBackendPreference(value: string | null | undefined): SqliteBackendPreference {
  const normalized = (value ?? 'auto').trim();
  if (VALID_PREFERENCES.has(normalized as SqliteBackendPreference)) {
    return normalized as SqliteBackendPreference;
  }
  throw new Error(
    `${SQLITE_BACKEND_ENV} must be one of: auto, better-sqlite3, node:sqlite; received ${JSON.stringify(value)}`,
  );
}

export function detectNodeSqliteAvailability(): boolean {
  const builtins = new Set<string>();
  for (const name of builtinModules) {
    builtins.add(name);
    builtins.add(`node:${name}`);
  }
  if (builtins.has('sqlite') || builtins.has('node:sqlite')) return true;
  try {
    createRequire(import.meta.url).resolve('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

export function detectBetterSqlite3Availability(rootPackageJsonPath = process.cwd()): boolean {
  try {
    const requireFromRoot = createRequire(rootPackageJsonPath.endsWith('package.json')
      ? rootPackageJsonPath
      : `${rootPackageJsonPath}/package.json`);
    requireFromRoot.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

export function selectSqliteRuntime(options: SelectSqliteRuntimeOptions = {}): SqliteRuntimePosture {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0] ?? '0');
  const preference = parseSqliteBackendPreference(
    options.preference ?? process.env[SQLITE_BACKEND_ENV] ?? 'auto',
  );
  const nodeSqliteAvailable = options.nodeSqliteAvailable ?? detectNodeSqliteAvailability();
  const betterSqlite3Available = options.betterSqlite3Available ?? true;

  if (preference === 'node:sqlite') {
    const supported = nodeMajor >= 22 && nodeSqliteAvailable;
    return {
      preference,
      selected: 'node:sqlite',
      supported,
      node_version: nodeVersion,
      node_major: nodeMajor,
      node_sqlite_available: nodeSqliteAvailable,
      better_sqlite3_available: betterSqlite3Available,
      reason: supported
        ? 'node:sqlite is the authoritative Narada SQLite runtime'
        : 'node:sqlite is unavailable in this Node runtime',
      remediation: supported
        ? undefined
        : 'Use Node 22+ with node:sqlite, or explicitly set NARADA_SQLITE_BACKEND=better-sqlite3 in an installation that still carries that native addon.',
    };
  }

  if (preference === 'better-sqlite3') {
    return {
      preference,
      selected: 'better-sqlite3',
      supported: false,
      node_version: nodeVersion,
      node_major: nodeMajor,
      node_sqlite_available: nodeSqliteAvailable,
      better_sqlite3_available: betterSqlite3Available,
      reason: 'better-sqlite3 has been retired from the Narada task lifecycle runtime',
      remediation: 'Unset NARADA_SQLITE_BACKEND or set it to node:sqlite under Node 22+.',
    };
  }

  return {
    preference,
    selected: nodeSqliteAvailable && nodeMajor >= 22 ? 'node:sqlite' : 'better-sqlite3',
    supported: (nodeSqliteAvailable && nodeMajor >= 22) || betterSqlite3Available,
    node_version: nodeVersion,
    node_major: nodeMajor,
    node_sqlite_available: nodeSqliteAvailable,
    better_sqlite3_available: betterSqlite3Available,
    reason: nodeSqliteAvailable && nodeMajor >= 22
      ? 'auto selects node:sqlite on Node 22+'
      : 'auto keeps better-sqlite3 because node:sqlite is not available on this runtime',
    remediation: (nodeSqliteAvailable && nodeMajor >= 22) || betterSqlite3Available
      ? undefined
      : 'Use Node 22+ with node:sqlite, or install and rebuild better-sqlite3.',
  };
}

export function assertSqliteRuntimeSupported(posture: SqliteRuntimePosture): void {
  if (posture.supported) return;
  throw new Error(`${SQLITE_BACKEND_ENV}=${posture.preference} is not supported: ${posture.reason}. ${posture.remediation ?? ''}`.trim());
}
