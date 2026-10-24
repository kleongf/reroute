import { DatabaseSync } from 'node:sqlite';

/** Opens (or creates) the SQLite database and applies the schema idempotently. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT    NOT NULL,
      source      TEXT    NOT NULL,
      event       TEXT    NOT NULL,
      payload     TEXT    NOT NULL
    );
  `);
  return db;
}
