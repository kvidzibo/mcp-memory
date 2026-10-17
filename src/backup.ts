import { backup, DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, openSync, unlinkSync } from 'node:fs';
import { APPLICATION_ID, SCHEMA_VERSION } from './schema.js';

/** Online backup includes committed WAL data; never overwrites an existing destination. */
export async function backupDatabase(source: string, destination: string): Promise<void> {
  if (!lstatSync(source).isFile()) throw new Error('Source must be a regular database file');
  const db = new DatabaseSync(source, { readOnly: true });
  let created = false;
  try {
    if (db.prepare('PRAGMA application_id').get()!.application_id !== APPLICATION_ID ||
        db.prepare('PRAGMA user_version').get()!.user_version !== SCHEMA_VERSION) throw new Error('Unsupported backup source');
    closeSync(openSync(destination,'wx',0o600)); created = true;
    await backup(db,destination);
    const check = new DatabaseSync(destination, { readOnly: true });
    try {
      if (check.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new Error('Backup integrity check failed');
    } finally { check.close(); }
  } catch (error) {
    if (created) unlinkSync(destination);
    throw error;
  } finally { db.close(); }
}
