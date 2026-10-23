/**
 * Format a value for safe SQL insertion.
 * Handles numbers, booleans, strings, nulls, and nested JSON/objects.
 */
export function formatSqlValue(val, dialect = 'postgres') {
  if (val === null || val === undefined || val === '') {
    return 'NULL';
  }

  if (typeof val === 'number') {
    return Number.isFinite(val) ? String(val) : 'NULL';
  }

  if (typeof val === 'boolean') {
    return val ? 'TRUE' : 'FALSE';
  }

  if (typeof val === 'object') {
    // Nested object (e.g. GeoJSON reference)
    const jsonStr = JSON.stringify(val).replace(/'/g, "''");
    return dialect === 'postgres' ? `'${jsonStr}'::jsonb` : `'${jsonStr}'`;
  }

  // String escape
  const str = String(val).replace(/'/g, "''");
  return `'${str}'`;
}

/**
 * Normalizes dataset from either Ron's metadata structure or plain object array
 */
export function parseDataset(rawContent) {
  const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;

  if (parsed.rows && Array.isArray(parsed.rows)) {
    return {
      table: parsed.metadata?.table || null,
      columns: parsed.metadata?.columns || [],
      rows: parsed.rows
    };
  }

  if (Array.isArray(parsed)) {
    return {
      table: null,
      columns: [],
      rows: parsed
    };
  }

  throw new Error('Unsupported dataset structure: expected object with .rows or array of objects');
}

/**
 * Generate PostgreSQL upsert migration script
 */
export function generatePostgresUpsert(table, primaryKeyColumns, rows) {
  if (!rows || rows.length === 0) {
    return `-- No rows to synchronize for ${table}\n`;
  }

  if (!primaryKeyColumns || primaryKeyColumns.length === 0) {
    throw new Error(`Primary key columns are required for upserting into table: ${table}`);
  }

  const pkNormalized = primaryKeyColumns.map(pk => pk.toLowerCase());
  const pkSet = new Set(pkNormalized);

  // Extract columns from the first row keys
  const sampleRow = rows[0];
  const allColumns = Object.keys(sampleRow);
  const updateColumns = allColumns.filter(c => !pkSet.has(c.toLowerCase()));

  const statements = [];

  for (const row of rows) {
    const cols = [];
    const vals = [];

    for (const col of allColumns) {
      cols.push(col.toLowerCase());
      vals.push(formatSqlValue(row[col], 'postgres'));
    }

    let sql = `INSERT INTO ${table.toLowerCase()} (${cols.join(', ')})\nVALUES (${vals.join(', ')})`;

    if (updateColumns.length > 0) {
      const updateSet = updateColumns
        .map(c => `${c.toLowerCase()} = EXCLUDED.${c.toLowerCase()}`)
        .join(', ');
      sql += `\nON CONFLICT (${pkNormalized.join(', ')}) DO UPDATE SET ${updateSet};`;
    } else {
      sql += `\nON CONFLICT (${pkNormalized.join(', ')}) DO NOTHING;`;
    }

    statements.push(sql);
  }

  return statements.join('\n\n');
}

/**
 * Generate Oracle MERGE migration script
 */
export function generateOracleMerge(table, primaryKeyColumns, rows) {
  if (!rows || rows.length === 0) {
    return `-- No rows to synchronize for ${table}\n`;
  }

  if (!primaryKeyColumns || primaryKeyColumns.length === 0) {
    throw new Error(`Primary key columns are required for Oracle MERGE: ${table}`);
  }

  const tableName = table.toUpperCase();
  const pkNormalized = primaryKeyColumns.map(pk => pk.toUpperCase());
  const pkSet = new Set(pkNormalized);

  const sampleRow = rows[0];
  const allColumns = Object.keys(sampleRow).map(c => c.toUpperCase());
  const updateColumns = allColumns.filter(c => !pkSet.has(c));

  const statements = [];

  for (const row of rows) {
    const rowKeys = Object.keys(row);
    const selectPairs = rowKeys.map(k => `${formatSqlValue(row[k], 'oracle')} AS ${k.toUpperCase()}`);

    const joinClause = pkNormalized
      .map(k => `tgt.${k} = src.${k}`)
      .join(' AND ');

    let sql = `MERGE INTO ${tableName} tgt\n`;
    sql += `USING (SELECT ${selectPairs.join(', ')} FROM dual) src\n`;
    sql += `ON (${joinClause})\n`;

    if (updateColumns.length > 0) {
      const updateClause = updateColumns
        .map(c => `tgt.${c} = src.${c}`)
        .join(', ');
      sql += `WHEN MATCHED THEN UPDATE SET ${updateClause}\n`;
    }

    const insertCols = allColumns.join(', ');
    const insertVals = allColumns.map(c => `src.${c}`).join(', ');
    sql += `WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals});`;

    statements.push(sql);
  }

  return statements.join('\n\n');
}
