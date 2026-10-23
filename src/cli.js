import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDataset, generatePostgresUpsert, generateOracleMerge } from './engine.js';

function parseArgs(args) {
  const options = {
    config: '.github/code-sync.yml',
    sourceDir: 'corp',
    outputDir: 'db/migrations',
    watermark: '.corp-sync.json',
    dryRun: false,
    commitSha: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && args[i + 1]) options.config = args[++i];
    else if (arg === '--source-dir' && args[i + 1]) options.sourceDir = args[++i];
    else if (arg === '--output-dir' && args[i + 1]) options.outputDir = args[++i];
    else if (arg === '--watermark' && args[i + 1]) options.watermark = args[++i];
    else if (arg === '--commit-sha' && args[i + 1]) options.commitSha = args[++i];
    else if (arg === '--dry-run') options.dryRun = true;
  }
  return options;
}

/**
 * Basic YAML/JSON parser for code-sync configuration
 */
async function loadConfig(configPath) {
  const content = await fs.readFile(configPath, 'utf8');
  try {
    return JSON.parse(content);
  } catch {
    // Basic regex extraction for simple yaml without adding heavy dependencies
    const mappings = [];
    const blocks = content.split(/-\s+file:\s*/);

    for (const block of blocks.slice(1)) {
      const fileMatch = block.match(/^["']?([^"'\n\r]+)["']?/);
      const tableMatch = block.match(/table:\s*["']?([^"'\n\r]+)["']?/);
      const pkMatch = block.match(/primary_key:\s*\[?([^\]\n\r]+)\]?/);
      const dialectMatch = block.match(/dialect:\s*["']?([^"'\n\r]+)["']?/);

      if (fileMatch && tableMatch && pkMatch) {
        const pks = pkMatch[1]
          .split(',')
          .map(k => k.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);

        mappings.push({
          file: fileMatch[1].trim(),
          table: tableMatch[1].trim(),
          primary_key: pks,
          dialect: dialectMatch ? dialectMatch[1].trim().toLowerCase() : 'postgres'
        });
      }
    }

    const repoMatch = content.match(/repo:\s*["']?([^"'\n\r]+)["']?/);
    return {
      source: { repo: repoMatch ? repoMatch[1].trim() : 'bcgov/nr-mof-data' },
      mappings
    };
  }
}

export async function run() {
  const options = parseArgs(process.argv.slice(2));
  console.log('=== BC GOV CORPORATE REFERENCE DATA SYNC ===\n');

  let config;
  try {
    config = await loadConfig(options.config);
  } catch (err) {
    console.error(`Failed to load configuration from ${options.config}:`, err.message);
    process.exit(1);
  }

  console.log(`Loaded configuration (${config.mappings.length} tables subscribed)`);

  // Read Watermark
  let watermark = null;
  try {
    const raw = await fs.readFile(options.watermark, 'utf8');
    watermark = JSON.parse(raw);
    console.log(`Current watermark: commit ${watermark.last_synced_commit?.slice(0, 8)} (${watermark.last_synced_at})`);
  } catch {
    console.log('No watermark found (first run / onboarding)');
  }

  // Check if up-to-date
  if (options.commitSha && watermark && watermark.last_synced_commit === options.commitSha) {
    console.log(`\nCommit ${options.commitSha.slice(0, 8)} already synchronized. Exiting cleanly.`);
    return;
  }

  const generatedBlocks = [];
  const summaryReport = [];

  for (const mapping of config.mappings) {
    const filePath = path.join(options.sourceDir, mapping.file);
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      console.warn(`[WARNING] Could not read source file ${filePath}: ${err.message}`);
      continue;
    }

    const { table, rows } = parseDataset(raw);
    const targetTable = mapping.table || table;
    const dialect = mapping.dialect || 'postgres';

    console.log(`Processing ${mapping.file} -> ${targetTable} (${rows.length} rows, dialect: ${dialect})`);

    const sql = dialect === 'oracle'
      ? generateOracleMerge(targetTable, mapping.primary_key, rows)
      : generatePostgresUpsert(targetTable, mapping.primary_key, rows);

    generatedBlocks.push(`-- ========================================================\n-- Table: ${targetTable} (from ${mapping.file})\n-- ========================================================\n${sql}`);
    summaryReport.push(`| \`${targetTable}\` | \`${mapping.file}\` | ${rows.length} | \`${mapping.primary_key.join(', ')}\` |`);
  }

  if (generatedBlocks.length === 0) {
    console.log('No SQL generated.');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const migrationName = `V${timestamp}__sync_corporate_reference_data.sql`;
  const migrationPath = path.join(options.outputDir, migrationName);

  const fullSql = `-- Corporate Reference Data Migration
-- Source: ${config.source?.repo || 'bcgov/nr-mof-data'}
-- Generated at: ${new Date().toISOString()}

BEGIN;

${generatedBlocks.join('\n\n')}

COMMIT;
`;

  if (!options.dryRun) {
    await fs.mkdir(options.outputDir, { recursive: true });
    await fs.writeFile(migrationPath, fullSql, 'utf8');
    console.log(`\nEmitted migration file: ${migrationPath}`);

    const newWatermark = {
      source_repo: config.source?.repo || 'bcgov/nr-mof-data',
      last_synced_commit: options.commitSha || 'latest',
      last_synced_at: new Date().toISOString(),
      tables: config.mappings.map(m => m.table)
    };
    await fs.writeFile(options.watermark, JSON.stringify(newWatermark, null, 2), 'utf8');
    console.log(`Updated watermark in ${options.watermark}`);
  } else {
    console.log('\n[DRY RUN] Skipped writing migration file and watermark.');
  }

  console.log('\nPR Summary:');
  console.log('| Target Table | Source File | Records | Primary Key |');
  console.log('| :--- | :--- | :--- | :--- |');
  console.log(summaryReport.join('\n'));
}

if (process.argv[1] && process.argv[1].endsWith('cli.js')) {
  run().catch(err => {
    console.error('Sync failed:', err);
    process.exit(1);
  });
}
