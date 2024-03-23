import path from "node:path";
import Database from "better-sqlite3";
import { BlossomSQLite } from "blossom-sqlite";
import { config } from "../config.js";

export const db = new Database(config.databasePath);
export const blobDB = new BlossomSQLite(db);

db.prepare(
  `CREATE TABLE IF NOT EXISTS accessed (
		blob TEXT(64) PRIMARY KEY,
		timestamp INTEGER NOT NULL
	)`,
).run();

db.prepare("CREATE INDEX IF NOT EXISTS accessed_timestamp ON accessed (timestamp)").run();

db.prepare(
  `CREATE TABLE IF NOT EXISTS tokens (
		id TEXT(64) PRIMARY KEY,
		type TEXT NOT NULL,
		pubkey TEXT(64) NOT NULL,
		expiration INTEGER NOT NULL,
		event TEXT NOT NULL
	)`,
).run();

export default db;
