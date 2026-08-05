import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  DatabaseAdapter,
  type DatabaseOptions,
  type NativeDatabase,
  type NativeStatement,
} from "./database-adapter.js";

interface BunNativeStatement extends NativeStatement {
  finalize(): void;
}

interface BunNativeDatabase {
  close(throwOnError?: boolean): void;
  exec(sql: string): void;
  prepare(sql: string): BunNativeStatement;
}

interface BunSqliteModule {
  Database: new (path: string, options?: { readonly?: boolean }) => BunNativeDatabase;
}

const require = createRequire(import.meta.url);
let bunSqliteModule: BunSqliteModule | null = null;

function loadBunSqlite(): BunSqliteModule {
  bunSqliteModule ??= require("bun:sqlite") as BunSqliteModule;
  return bunSqliteModule;
}

export default class Database extends DatabaseAdapter {
  constructor(path: string, options: DatabaseOptions = {}) {
    if (options.fileMustExist && !existsSync(path)) {
      throw new Error(`sqlite_database_not_found: ${path}`);
    }
    const { Database: BunDatabase } = loadBunSqlite();
    const readOnly = options.readOnly === true || options.readonly === true;
    const database = readOnly ? new BunDatabase(path, { readonly: true }) : new BunDatabase(path);
    super(new BunDatabaseHandle(database));
  }
}

class BunDatabaseHandle implements NativeDatabase {
  private readonly statements = new Set<BunStatementHandle>();

  constructor(private readonly database: BunNativeDatabase) {}

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): BunNativeStatement {
    const statement = new BunStatementHandle(this.database.prepare(sql));
    this.statements.add(statement);
    return statement;
  }

  close(): void {
    for (const statement of this.statements) statement.finalize();
    this.statements.clear();
    this.database.close(true);
  }
}

class BunStatementHandle implements BunNativeStatement {
  constructor(private readonly statement: BunNativeStatement) {}

  all(...args: unknown[]): unknown[] {
    return this.statement.all(...normalizeBunBindArgs(args));
  }

  get(...args: unknown[]): unknown {
    return this.statement.get(...normalizeBunBindArgs(args));
  }

  *iterate(...args: unknown[]): IterableIterator<unknown> {
    yield* this.statement.iterate(...normalizeBunBindArgs(args));
  }

  run(...args: unknown[]) {
    return this.statement.run(...normalizeBunBindArgs(args));
  }

  finalize(): void {
    this.statement.finalize();
  }
}

function normalizeBunBindArgs(args: unknown[]): unknown[] {
  return args.map((arg) => isPlainRecord(arg) ? expandBareNamedParameters(arg) : arg);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expandBareNamedParameters(bindings: Record<string, unknown>): Record<string, unknown> {
  const expanded = { ...bindings };
  for (const [key, value] of Object.entries(bindings)) {
    if (/^[$:@]/.test(key)) continue;
    for (const prefix of ["$", ":", "@"]) {
      const prefixed = `${prefix}${key}`;
      if (!(prefixed in expanded)) expanded[prefixed] = value;
    }
  }
  return expanded;
}
