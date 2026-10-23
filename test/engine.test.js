import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  formatSqlValue,
  parseDataset,
  generatePostgresUpsert,
  generateOracleMerge
} from '../src/engine.js';

describe('formatSqlValue', () => {
  test('formats null and empty strings as NULL', () => {
    assert.equal(formatSqlValue(null), 'NULL');
    assert.equal(formatSqlValue(undefined), 'NULL');
    assert.equal(formatSqlValue(''), 'NULL');
  });

  test('formats numbers as numeric literals', () => {
    assert.equal(formatSqlValue(42), '42');
    assert.equal(formatSqlValue(123.456), '123.456');
  });

  test('formats booleans as TRUE/FALSE', () => {
    assert.equal(formatSqlValue(true), 'TRUE');
    assert.equal(formatSqlValue(false), 'FALSE');
  });

  test('escapes single quotes in strings', () => {
    assert.equal(formatSqlValue("Prince George's Office"), "'Prince George''s Office'");
  });

  test('formats objects as jsonb in postgres and string in oracle', () => {
    const obj = { rel: 'geometry', href: 'https://example.com' };
    assert.equal(formatSqlValue(obj, 'postgres'), '\'{"rel":"geometry","href":"https://example.com"}\'::jsonb');
    assert.equal(formatSqlValue(obj, 'oracle'), '\'{"rel":"geometry","href":"https://example.com"}\'');
  });
});

describe('parseDataset', () => {
  test('parses Ron\'s { metadata, rows } structure', () => {
    const raw = JSON.stringify({
      metadata: { table: 'TEST_TABLE', columns: [{ name: 'ID' }] },
      rows: [{ id: 1 }]
    });
    const parsed = parseDataset(raw);
    assert.equal(parsed.table, 'TEST_TABLE');
    assert.equal(parsed.rows.length, 1);
  });

  test('parses raw array of objects', () => {
    const raw = [{ id: 1 }, { id: 2 }];
    const parsed = parseDataset(raw);
    assert.equal(parsed.rows.length, 2);
  });
});

describe('generatePostgresUpsert', () => {
  test('generates valid ON CONFLICT DO UPDATE for single PK', () => {
    const rows = [
      { code: 'A', description: 'Aspen', active: true }
    ];
    const sql = generatePostgresUpsert('tree_species', ['code'], rows);

    assert.match(sql, /INSERT INTO tree_species \(code, description, active\)/);
    assert.match(sql, /VALUES \('A', 'Aspen', TRUE\)/);
    assert.match(sql, /ON CONFLICT \(code\) DO UPDATE SET description = EXCLUDED\.description, active = EXCLUDED\.active;/);
  });

  test('generates valid ON CONFLICT for composite PK', () => {
    const rows = [
      { org_id: 10, role_code: 'ADM', notes: 'Administrator' }
    ];
    const sql = generatePostgresUpsert('org_roles', ['org_id', 'role_code'], rows);

    assert.match(sql, /ON CONFLICT \(org_id, role_code\) DO UPDATE SET notes = EXCLUDED\.notes;/);
  });

  test('generates ON CONFLICT DO NOTHING when table only has PK columns', () => {
    const rows = [
      { code: 'BC' }
    ];
    const sql = generatePostgresUpsert('provinces', ['code'], rows);

    assert.match(sql, /ON CONFLICT \(code\) DO NOTHING;/);
  });
});

describe('generateOracleMerge', () => {
  test('generates valid MERGE statement for Oracle compatibility', () => {
    const rows = [
      { code: 'LLC', description: 'Limited Liability' }
    ];
    const sql = generateOracleMerge('company_types', ['code'], rows);

    assert.match(sql, /MERGE INTO COMPANY_TYPES tgt/);
    assert.match(sql, /USING \(SELECT 'LLC' AS CODE, 'Limited Liability' AS DESCRIPTION FROM dual\) src/);
    assert.match(sql, /ON \(tgt\.CODE = src\.CODE\)/);
    assert.match(sql, /WHEN MATCHED THEN UPDATE SET tgt\.DESCRIPTION = src\.DESCRIPTION/);
    assert.match(sql, /WHEN NOT MATCHED THEN INSERT/);
  });
});

describe('Live corp/ Data Ingestion Verification', () => {
  const corpDir = path.join(import.meta.dirname, '..', 'corp');

  test('parses and generates SQL for corp/unit_of_measure_code.json', async () => {
    const content = await fs.readFile(path.join(corpDir, 'unit_of_measure_code.json'), 'utf8');
    const { rows } = parseDataset(content);
    assert.equal(rows.length, 34);

    const sql = generatePostgresUpsert('unit_of_measure_code', ['unit_of_measure_code'], rows);
    assert.ok(sql.includes('INSERT INTO unit_of_measure_code'));
    assert.ok(sql.includes('ON CONFLICT (unit_of_measure_code) DO UPDATE'));
  });

  test('parses and generates SQL for corp/tree_species_code.json', async () => {
    const content = await fs.readFile(path.join(corpDir, 'tree_species_code.json'), 'utf8');
    const { rows } = parseDataset(content);
    assert.equal(rows.length, 101);

    const sql = generatePostgresUpsert('tree_species_code', ['tree_species_code'], rows);
    assert.ok(sql.includes("VALUES ('A', 'Aspen, Cottonwood or Poplar'"));
  });

  test('parses and generates SQL for corp/org_unit.json (1,285 rows)', async () => {
    const content = await fs.readFile(path.join(corpDir, 'org_unit.json'), 'utf8');
    const { rows } = parseDataset(content);
    assert.equal(rows.length, 1285);

    const sql = generatePostgresUpsert('org_unit', ['org_unit_no'], rows);
    assert.ok(sql.includes('INSERT INTO org_unit'));
    assert.ok(sql.includes('ON CONFLICT (org_unit_no) DO UPDATE'));
  });

  test('parses and generates SQL for corp/forest_district_poly.json (with JSON objects)', async () => {
    const content = await fs.readFile(path.join(corpDir, 'forest_district_poly.json'), 'utf8');
    const { rows } = parseDataset(content);
    assert.equal(rows.length, 23);

    const sql = generatePostgresUpsert('forest_district_poly', ['feature_id'], rows);
    assert.ok(sql.includes('::jsonb'));
  });
});
