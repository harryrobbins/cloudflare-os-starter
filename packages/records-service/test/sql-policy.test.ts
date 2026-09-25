import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTransactionalSql } from '../scripts/sql-policy.ts';

test('publisher owns transaction while PL/pgSQL bodies and comments remain valid', () => {
  assert.doesNotThrow(() => assertTransactionalSql("CREATE FUNCTION x() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN IF true THEN NULL; END IF; END; $fn$; -- COMMIT;\nSELECT 'BEGIN;';"));
  assert.doesNotThrow(() => assertTransactionalSql('/* outer /* COMMIT; */ END; */ SELECT 1;'));
  for (const statement of ['BEGIN;', 'COMMIT;', 'ROLLBACK;', 'END;', 'SELECT 1; START TRANSACTION;', "SELECT 'safe'; /* gap */ COMMIT;"]) assert.throws(() => assertTransactionalSql(statement), /transaction/);
  assert.throws(() => assertTransactionalSql('SELECT $missing$foo'), /Unclosed/);
});
