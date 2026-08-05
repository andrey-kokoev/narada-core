import { test } from "node:test";
import { DatabaseSync } from "@narada-core/sqlite";
import { runDatabaseContract } from "./database-contract.ts";

test("Node backend satisfies the Narada SQLite contract", () => {
  runDatabaseContract(DatabaseSync);
});
