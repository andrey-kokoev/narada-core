import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  DatabaseAdapter,
  type DatabaseOptions,
  type NativeDatabase,
} from "./database-adapter.js";

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NativeDatabase;
}

const require = createRequire(import.meta.url);
let nodeSqliteModule: NodeSqliteModule | null = null;

function loadNodeSqlite(): NodeSqliteModule {
  nodeSqliteModule ??= require("node:sqlite") as NodeSqliteModule;
  return nodeSqliteModule;
}

export default class Database extends DatabaseAdapter {
  constructor(path: string, options: DatabaseOptions = {}) {
    if (options.fileMustExist && !existsSync(path)) {
      throw new Error(`sqlite_database_not_found: ${path}`);
    }
    const { DatabaseSync } = loadNodeSqlite();
    super(new DatabaseSync(path, {
      readOnly: options.readOnly === true || options.readonly === true,
    }));
  }
}

export type { DatabaseOptions, RunResult, Statement } from "./database-adapter.js";

export namespace Database {
  export type Database = import("./database.js").default;
  export type Statement = import("./database-adapter.js").Statement;
  export type RunResult = import("./database-adapter.js").RunResult;
}
