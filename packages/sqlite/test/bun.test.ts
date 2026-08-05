import { test } from "bun:test";
import { DatabaseSync } from "@narada-core/sqlite";
import { runDatabaseContract } from "./database-contract.ts";

test("Bun backend satisfies the Narada SQLite contract", () => {
  runDatabaseContract(DatabaseSync);
});
