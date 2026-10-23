# How Application Teams Consume Corporate Reference Data

This guide explains how to automatically synchronize corporate reference data (such as `ORG_UNIT` or `TREE_SPECIES_CODE`) directly into your application's PostgreSQL database using standard Flyway database migrations.

---

## 1. The Problem This Solves

In the legacy Oracle monolith, all applications lived in the same database and shared code tables (like `THE.ORG_UNIT`). 

When your application moves to its own dedicated PostgreSQL database in OpenShift:
- You no longer have access to the shared Oracle tables.
- If you manually copy SQL dumps into your project, your database goes stale the moment Data Administration (DA) adds or updates a code.
- If an application queries an obsolete or missing code, users get errors.

**This tool automates that pipeline**: Whenever DA updates data in `bcgov/nr-mof-data`, an automated Pull Request is opened in your repo with a ready-to-deploy Flyway SQL migration.

---

## 2. How It Works (The 30-Second Mental Model)

```
[ bcgov/nr-mof-data ]
       │
       ▼ (DA updates a code in `corp/`)
[ Your App Repository ]
       │
       ├── Scheduled GitHub Action runs (e.g. daily)
       ├── Checks: "Did nr-mof-data change since our last sync?"
       │     ├── NO  ──> Exits in 2 seconds. No noise, no PRs.
       │     └── YES ──> Generates `migrations/sql/V<timestamp>__sync_corporate_reference_data.sql`
       │
       └── Opens a Pull Request in your repository with the SQL diff
             │
             ▼ (Developer reviews and clicks Merge)
[ Standard OpenShift Deployment ]
       │
       └── Your existing Flyway container runs the migration into PostgreSQL!
```

---

## 3. Step-by-Step Setup for Your Application

Adding automated reference data sync to your repository takes two files.

### Step 1: Create Your Subscription Config

Create a file named `.github/code-sync.yml` in your application repository. 

List only the tables your application needs, along with the primary key column:

```yaml
# .github/code-sync.yml
version: 1

source:
  repo: "bcgov/nr-mof-data"
  branch: "main"
  path: "corp"

mappings:
  # Ministry organizational units and district offices
  - file: "org_unit.json"
    table: "org_unit"
    primary_key: ["org_unit_no"]
    dialect: "postgres"

  # Standard tree species codes and descriptions
  - file: "tree_species_code.json"
    table: "tree_species_code"
    primary_key: ["tree_species_code"]
    dialect: "postgres"
```

#### Configuration Fields:
- `file`: The dataset filename in `nr-mof-data/corp/` (e.g., `org_unit.json`, `tree_species_code.json`, `unit_of_measure_code.json`).
- `table`: The name of the table in your local PostgreSQL database.
- `primary_key`: The column(s) used to detect existing rows (e.g., `["org_unit_no"]`).
- `dialect`: Set to `"postgres"`.

---

### Step 2: Add the Automated GitHub Action Workflow

Create a workflow file in your repo at `.github/workflows/sync-reference-data.yml`:

```yaml
# .github/workflows/sync-reference-data.yml
name: Sync Corporate Reference Data

on:
  schedule:
    # Run every weekday morning at 4:00 AM UTC (8:00 PM PST)
    - cron: '0 4 * * 1-5'
  # Allow manual trigger from the GitHub Actions tab
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  sync:
    name: Check & Sync Reference Data
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout Application Repo
        uses: actions/checkout@v4

      - name: Checkout Reference Data Tool
        uses: actions/checkout@v4
        with:
          repository: bcgov/nr-mof-data
          path: .ref-data-engine

      - name: Generate Flyway Migrations
        uses: ./.ref-data-engine
        with:
          config_path: .github/code-sync.yml
          output_dir: migrations/sql

      - name: Clean up Tool Directory
        run: rm -rf .ref-data-engine

      - name: Create Pull Request if Changes Detected
        uses: peter-evans/create-pull-request@v7
        with:
          commit-message: 'chore(data): sync corporate reference tables'
          title: 'chore(data): sync corporate reference tables'
          branch: 'chore/sync-reference-data'
          delete-branch: true
          body: |
            Automated synchronization of corporate reference tables from `bcgov/nr-mof-data`.
            
            This PR includes newly generated Flyway SQL migrations with idempotent `ON CONFLICT` statements. Merging this PR will deploy the updates via your standard OpenShift deployment pipeline.
```

> **Note on `output_dir`**: Set `output_dir` to wherever your project stores Flyway SQL scripts. In standard BC Gov templates (like `quickstart-openshift`), this is `migrations/sql`.

---

## 4. What Happens in Practice

### The First Run (Onboarding)
1. The Action runs for the first time.
2. It reads `org_unit.json` and `tree_species_code.json` from `bcgov/nr-mof-data`.
3. It generates a single Flyway migration file:
   `migrations/sql/V20261022194500__sync_corporate_reference_data.sql`
4. It creates a state watermark file: `.corp-sync.json` (recording the commit SHA from `nr-mof-data`).
5. It opens a Pull Request in your repository with a clear summary table of all rows.
6. A developer clicks **Merge**.
7. Your app's standard deployment pipeline builds your Flyway container and applies the migration into your PostgreSQL database.

### Daily Runs (When Nothing Changed)
1. The Action runs on schedule.
2. It compares the latest commit of `bcgov/nr-mof-data` with `.corp-sync.json`.
3. The commits match.
4. **The Action exits in under 2 seconds**. Zero files are created, and zero Pull Requests are opened.

### When DA Updates a Code (3 Months Later)
1. Data Administration updates a code (e.g., adding a new office or company type) in `nr-mof-data`.
2. The next scheduled run detects the new commit.
3. It generates a new migration file containing only the updated rows.
4. It opens a Pull Request in your repo:
   ```
   chore(data): sync corporate reference tables [a1b2c3d4]
   ```
5. Your team reviews the PR, sees the exact SQL diff, and merges it.

---

## 5. What the Generated SQL Looks Like

The generated Flyway migration file uses PostgreSQL's native `ON CONFLICT` clause so it can be executed safely without duplicate-key errors:

```sql
-- Corporate Reference Data Migration
-- Source: bcgov/nr-mof-data@1b6513f1
-- Generated at: 2026-10-22T21:46:26.000Z

BEGIN;

-- ========================================================
-- Table: tree_species_code (from tree_species_code.json)
-- ========================================================
INSERT INTO tree_species_code (tree_species_code, description, effective_date, expiry_date, update_timestamp)
VALUES ('A', 'Aspen, Cottonwood or Poplar', '1905-01-01T00:00:00', '2010-06-13T00:00:00', '2010-06-14T11:46:32')
ON CONFLICT (tree_species_code) DO UPDATE SET 
  description = EXCLUDED.description, 
  effective_date = EXCLUDED.effective_date, 
  expiry_date = EXCLUDED.expiry_date, 
  update_timestamp = EXCLUDED.update_timestamp;

INSERT INTO tree_species_code (tree_species_code, description, effective_date, expiry_date, update_timestamp)
VALUES ('AC', 'poplar', '1905-01-01T00:00:00', '9999-12-31T00:00:00', '2010-06-14T11:46:32')
ON CONFLICT (tree_species_code) DO UPDATE SET 
  description = EXCLUDED.description, 
  effective_date = EXCLUDED.effective_date, 
  expiry_date = EXCLUDED.expiry_date, 
  update_timestamp = EXCLUDED.update_timestamp;

COMMIT;
```

---

## 6. Testing Locally on Your Machine

You do not need to wait for GitHub Actions to test this. You can run the generator locally against your application repo:

```bash
# In your application repository:
node path/to/nr-mof-data/src/cli.js \
  --config .github/code-sync.yml \
  --source-dir path/to/nr-mof-data/corp \
  --output-dir migrations/sql \
  --dry-run
```

The `--dry-run` flag prints the generated SQL to your terminal without modifying any files.
