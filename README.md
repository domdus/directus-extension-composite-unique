# Composite Unique

Find duplicate field combinations, clean them up, and apply **composite unique constraints** in Directus — especially for M2M junction tables.

> **Important:** Directus Studio does **not** natively support composite unique / foreign / primary keys. This extension does **not** change the Data Model UI. It adds a real database `UNIQUE` constraint on the chosen columns (after you confirm), tracks applied constraints for the Studio wizard, and validates creates/updates with clear API errors.

## Overview

Directus requires a **single** primary key per collection. That works well for most tables, but junction tables and many real-world models need uniqueness across **two or more fields together** (for example `item` + `related`, or `slug` + `locale`).

You can add such a constraint in SQL yourself, but Directus will not show it in the Data Model, will not guide cleanup of existing duplicates, and often surfaces raw database errors on conflict.

**Composite Unique** gives admins a Studio wizard to:

1. Select the right collections (junctions by default)
2. Check for duplicate combinations
3. Clean duplicates when needed
4. Apply the database constraint **only when you confirm**
5. Keep enforcing uniqueness for Studio, REST, GraphQL, and SDK writes

Open **Composite Unique** from the left bar (**admins only**).

<img alt="Composite Unique wizard — select M2M junctions and field pairs" src="https://raw.githubusercontent.com/domdus/directus-extension-composite-unique/main/docs/composite_unique_wizard.png" width="800" />

## What this is (and is not)

| This extension **does** | This extension **does not** |
| --- | --- |
| Apply a composite **unique** constraint on 2+ columns | Add composite **primary** keys |
| Work on collections that already have a normal single PK (`id`, …) | Make Directus treat `(a,b)` as the item URL / PK |
| Enforce uniqueness in the database | Show the constraint in Settings → Data Model |
| Validate writes with clearer API errors (hook) | Replace Access Control / permissions |

Studio’s per-field **“Value has to be unique”** is a **single-field** unique flag. That is **not** the same as a composite unique across multiple fields.

## Features

### Wizard

Four steps — nothing is written to the database until **Apply**:

1. **Select** — pick collections and field combinations  
2. **Check** — find duplicate combinations  
3. **Clean** — optional dedupe (keep first / keep last primary key)  
4. **Apply** — create the database unique constraint

Filters on the select step:

| Filter | Default | Purpose |
| --- | --- | --- |
| **Scope** | M2M Junctions | `M2M Junctions` · `With Field Pairs` · `All Collections` |
| **Hide Already Constrained** | Off | Hide constraints already applied by this extension |

Default scope lists junction tables with a usable relation field pair (e.g. `item` + `related`). Audit/system FKs (`user_created`, `directus_files`, …) are never auto-picked. **All Collections** includes simple tables whose primary key is already unique — those usually need **no** composite constraint.

The **Unique On** column shows which fields would be constrained (auto-detected or manually picked).

Status in the list:

| Status | Meaning |
| --- | --- |
| **Open** | No composite unique from this extension yet |
| **Constrained** | Constraint already applied |

### Constraints

- See every constraint applied through this extension (`/composite-unique/constraints`)  
- Columns: collection, fields, **index name**, applied time  
- **Remove** drops the database unique index/constraint **and** removes it from this list (always)

<img alt="Composite Unique constraints — applied indexes with remove" src="https://raw.githubusercontent.com/domdus/directus-extension-composite-unique/main/docs/composite_unique_constraints.png" width="800" />

### API validation (hook)

After a constraint is applied, create/update through Directus is checked server-side. Violations return a clear payload error instead of only a raw SQL failure.

Example when creating a duplicate `test_categories` row (`test_id` + `categories_id` already exist):

```json
{
    "errors": [
        {
            "message": "Composite unique violation on \"test_categories\": (test_id, categories_id) must be unique",
            "extensions": {
                "code": "INTERNAL_SERVER_ERROR"
            }
        }
    ]
}
```

Enforcement does **not** depend on the module being open:

| Layer | When it runs | Who it covers |
| --- | --- | --- |
| **Module (UI)** | Admin opens the wizard | Setup only |
| **Hook** | Every Directus `items.create` / `items.update` | All users, roles, REST, GraphQL, SDK |
| **Database constraint** | Every write that hits the table | Full integrity, including races |

## Constraint vs index

Applying a composite unique **constraint** (the rule) creates a **unique index** in the database. That is how SQL vendors implement uniqueness — not a second optional feature.

- One **Apply** = one unique rule on those columns  
- The **Index Name** (e.g. `uq_articles_tags_articles_id_tags_id`) is the name of that database unique index  
- Prefix: `uq_` (unique). Older installs may still show `cu_` — both are recognized  
- PostgreSQL, MySQL/MariaDB, SQLite (and other Directus SQL vendors via Knex) are supported the same way

In the UI, status and navigation say **Constrained** / **Constraints** (the feature). The technical column shows **Index Name** (the DB object).

## How configuration is stored

Applied constraints are tracked in `directus_settings.composite_unique` so the wizard, Constraints page, and hook know which ones this extension owns.

| Concern | Source of truth |
| --- | --- |
| “These values must be unique” | Database unique constraint |
| “Which ones did this extension apply?” | `directus_settings.composite_unique` |

The settings JSON is **not** a second constraint. Integrity lives in the database.

## Getting started

1. Open **Composite Unique** as an admin.  
2. Keep scope on **M2M Junctions** (recommended).  
3. Select collections (or **Select Filtered**), adjust fields if needed.  
4. **Check Selected** — review duplicate groups.  
5. If dirty: **Clean Duplicates** (keep first / keep last), then continue.  
6. On step 4, confirm **Apply … Constraint(s)**.  
7. Optionally open **Constraints** to review or remove them later.

> Creating a unique constraint **fails** if duplicates already exist. The wizard blocks Apply until the combination is clean. Applying never silently deletes rows — cleanup is an explicit step.

## Uninstall / remove behaviour

| Action | Database constraint | Constraints list / hook |
| --- | --- | --- |
| **Remove** on Constraints | Dropped | Removed |
| Uninstall extension without Remove | **Remains** (still enforced by DB) | Hook/UI gone; API errors may become raw DB errors |
| Reinstall later | Still present in DB | Re-apply / re-track as needed via the wizard |

You can uninstall the extension after applying if you only care about database enforcement. Keep it installed if you want the wizard, Constraints list, and clearer API validation errors.

## Installation

Requires **Directus 9.26+ through 12.x**.

### npm

```bash
npm install directus-extension-composite-unique
```

Place the package in your Directus `extensions` folder (or install into a project that loads extensions from `node_modules`), then restart Directus.

### Marketplace

Search for **Composite Unique** in **Settings → Marketplace**. This bundle includes API parts (endpoint + hook), so some environments only allow App extensions from the Marketplace — use npm or manual install if install is blocked.

### Manual installation

1. Install and build:

```bash
cd directus-extension-composite-unique
npm install
npm run build
```

2. Copy the built package into your Directus `extensions` folder (include `package.json` and the `dist` folder).

3. Restart Directus.

4. In the Data Studio:

   1. Open **Settings → Project Settings → Modules**  
   2. Enable **Composite Unique**  
   3. Open **Composite Unique** from the left bar  

## Bundle contents

| Entry | Role |
| --- | --- |
| **Module** | Wizard + Constraints UI (admins) |
| **Endpoint** | `check` / `dedupe` / `apply` / `remove` (admin API) |
| **Hook** | Create/update validation for applied constraints |

Constraints are **never** applied automatically on extension install or Directus startup. Only an admin Apply (or Remove) changes the database schema for these uniques.

## License

MIT
