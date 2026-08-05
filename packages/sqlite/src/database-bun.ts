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
  private readonly statements = new Set<BunNativeStatement>();

  constructor(private readonly database: BunNativeDatabase) {}

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): BunNativeStatement {
    const statement = this.database.prepare(sql);
    this.statements.add(statement);
    return statement;
  }

  close(): void {
    for (const statement of this.statements) statement.finalize();
    this.statements.clear();
    this.database.close(true);
  }
}
