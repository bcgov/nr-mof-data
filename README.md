# Corporate Reference Data (`nr-mof-data`)

Single source of truth for corporate reference data (codes, lookups, and boundary references) across the Ministry of Forests, with automated GitOps synchronization for downstream PostgreSQL and Oracle applications.

## Overview

When applications modernize from monolithic databases to isolated databases (such as dedicated PostgreSQL instances in OpenShift), they lose direct access to shared reference tables (like `ORG_UNIT` or `TREE_SPECIES_CODE`). 

This repository solves distribution without 24/7 server infrastructure, centralized database dependencies, or cross-network tunnels into OpenShift:
- **Reference Data as Code**: Published as structured datasets under [`corp/`](./corp/).
- **Zero-Infrastructure Distribution**: Downstream applications consume updates via a reusable GitHub Action that generates idempotent database migrations (Flyway / Alembic) as Pull Requests.
- **Git Watermarking**: State tracking uses commit hashes and GitHub Actions caching—no external tracking database required.

---

## Published Datasets

Datasets live in the [`corp/`](./corp/) folder. Each file includes schema metadata and structured rows:

| File | Table Name | Description |
| :--- | :--- | :--- |
| [`org_unit.json`](./corp/org_unit.json) | `ORG_UNIT` | Ministry organizational units, district offices, and regional rollups. |
| [`tree_species_code.json`](./corp/tree_species_code.json) | `TREE_SPECIES_CODE` | Standard tree species abbreviations and descriptions. |
| [`unit_of_measure_code.json`](./corp/unit_of_measure_code.json) | `UNIT_OF_MEASURE_CODE` | Measurement units (%, meters, cubic meters, etc.). |
| [`forest_district_poly.json`](./corp/forest_district_poly.json) | `ADM_NR_DISTRICTS_SPG` | Natural resource district boundaries with BC Geographic Warehouse WFS links. |
| [`forest_region_poly.json`](./corp/forest_region_poly.json) | `ADM_NR_REGIONS_SPG` | Natural resource region boundaries with BC Geographic Warehouse WFS links. |

---

## Consuming in an Application

> **Looking for the complete step-by-step setup guide?** See [How Application Teams Consume Corporate Reference Data](./docs/CONSUMING.md) for full instructions, copy-pasteable GitHub Actions workflows, and runtime walkthroughs.

Applications subscribe to the tables they care about by adding a configuration file and a GitHub Action workflow.

### 1. Add Configuration: `.github/code-sync.yml`

In your application's repository, specify the tables and primary keys your app requires:

```yaml
version: 1

source:
  repo: "bcgov/nr-mof-data"
  branch: "main"
  path: "corp"

mappings:
  - file: "org_unit.json"
    table: "org_unit"
    primary_key: ["org_unit_no"]
    dialect: "postgres"

  - file: "tree_species_code.json"
    table: "tree_species_code"
    primary_key: ["tree_species_code"]
    dialect: "postgres"
```

### 2. Add Workflow: `.github/workflows/code-sync.yml`

Run the sync on a schedule (e.g. daily) or via manual trigger:

```yaml
name: Sync Corporate Reference Data

on:
  schedule:
    - cron: '0 4 * * 1-5' # Weekdays at 4 AM UTC
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

      - name: Checkout Reference Data
        uses: actions/checkout@v4
        with:
          repository: bcgov/nr-mof-data
          path: .ref-data-engine

      - name: Generate Migrations
        uses: ./.ref-data-engine
        with:
          config_path: .github/code-sync.yml
          output_dir: db/migrations

      - name: Create Pull Request if Changes Detected
        uses: peter-evans/create-pull-request@v7
        with:
          commit-message: 'chore(data): sync corporate reference tables'
          title: 'chore(data): sync corporate reference tables'
          branch: 'chore/sync-reference-data'
          body: 'Automated synchronization of corporate reference tables from `bcgov/nr-mof-data`.'
```

---

## CLI Usage & Local Development

The engine is built on standard Node.js (>=20) with zero external dependencies.

```bash
# Clone the repository
git clone https://github.com/bcgov/nr-mof-data.git
cd nr-mof-data

# Run tests
npm test

# Run a dry-run migration generation
node src/cli.js --config examples/code-sync.yml --dry-run
```

### License

Apache-2.0
