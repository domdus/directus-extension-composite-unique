import { fieldsMatch } from './config';
import type { CollectionCandidate, CompositeUniqueConfig, DuplicateGroup } from './types';

type SchemaLike = {
	collections?: Record<
		string,
		{
			collection?: string;
			primary?: string;
			fields?: Record<string, { field?: string; type?: string | null }>;
		}
	>;
	relations?: Array<{
		collection?: string;
		field?: string;
		related_collection?: string | null;
		meta?: { junction_field?: string | null; one_field?: string | null } | null;
		schema?: { table?: string; column?: string; foreign_key_table?: string | null } | null;
	}>;
};

export function getClientName(database: any): string {
	const client = database?.client?.config?.client ?? database?.client?.driverName ?? '';
	return String(client).toLowerCase();
}

export function buildIndexName(collection: string, fields: string[]): string {
	const raw = `uq_${collection}_${fields.join('_')}`.replace(/[^a-zA-Z0-9_]/g, '_');
	return raw.slice(0, 63);
}

/** Legacy prefix from earlier builds — still recognized for exists/drop. */
export function buildLegacyIndexName(collection: string, fields: string[]): string {
	const raw = `cu_${collection}_${fields.join('_')}`.replace(/[^a-zA-Z0-9_]/g, '_');
	return raw.slice(0, 63);
}

export function getJunctionCollections(schema: SchemaLike): Set<string> {
	const junctions = new Set<string>();
	for (const relation of schema.relations || []) {
		if (relation.meta?.junction_field) {
			if (relation.collection) junctions.add(relation.collection);
		}
	}
	return junctions;
}

const AUDIT_FIELDS = new Set([
	'user_created',
	'user_updated',
	'date_created',
	'date_updated',
]);

function relatedCollectionOf(relation: NonNullable<SchemaLike['relations']>[number]): string | null {
	return relation.related_collection || relation.schema?.foreign_key_table || null;
}

function isSystemRelated(related: string | null): boolean {
	if (!related) return false;
	return related.startsWith('directus_');
}

/**
 * Suggest columns for a composite unique — only meaningful relation FKs.
 * Skips PK/sort, audit fields, and FKs into Directus system collections
 * (e.g. user_created → directus_users, image → directus_files).
 */
export function suggestFieldsForCollection(schema: SchemaLike, collection: string): string[] {
	const col = schema.collections?.[collection];
	const primary = col?.primary || 'id';
	const skip = new Set([primary, 'sort', 'id', ...AUDIT_FIELDS]);

	const fkFields: string[] = [];
	for (const relation of schema.relations || []) {
		if (relation.collection !== collection) continue;
		if (!relation.field || skip.has(relation.field)) continue;

		const related = relatedCollectionOf(relation);
		// Many-to-one / FK on this collection, but not into system tables
		if (!related || isSystemRelated(related)) continue;
		if (!relation.related_collection && !relation.schema?.foreign_key_table) continue;

		if (!fkFields.includes(relation.field)) fkFields.push(relation.field);
	}

	return fkFields;
}

export function listCollectionCandidates(
	schema: SchemaLike,
	config: CompositeUniqueConfig,
): CollectionCandidate[] {
	const junctions = getJunctionCollections(schema);
	const collections = Object.keys(schema.collections || {}).filter((name) => !name.startsWith('directus_'));

	return collections
		.map((collection) => {
			const col = schema.collections![collection]!;
			const primaryKey = col.primary || 'id';
			const fields = Object.values(col.fields || {}).map((field) => ({
				field: field.field || '',
				type: field.type ?? null,
				isPrimary: (field.field || '') === primaryKey,
			})).filter((f) => f.field);

			const appliedConstraints = config.entries.filter((entry) => entry.collection === collection);
			const suggestedFields = suggestFieldsForCollection(schema, collection);

			return {
				collection,
				primaryKey,
				isJunction: junctions.has(collection),
				suggestedFields,
				fields,
				constraints: appliedConstraints,
				hasCompositeUnique: appliedConstraints.length > 0,
			} satisfies CollectionCandidate;
		})
		.sort((a, b) => {
			if (a.isJunction !== b.isJunction) return a.isJunction ? -1 : 1;
			return a.collection.localeCompare(b.collection);
		});
}

export async function findDuplicateGroups(
	database: any,
	collection: string,
	fields: string[],
	primaryKey: string,
	limitGroups = 100,
): Promise<DuplicateGroup[]> {
	if (fields.length < 2) return [];

	const grouped = await database(collection)
		.select(fields)
		.count({ count: '*' })
		.groupBy(fields)
		.havingRaw('count(*) > 1')
		.limit(limitGroups);

	const groups: DuplicateGroup[] = [];

	for (const row of grouped || []) {
		const values: Record<string, unknown> = {};
		for (const field of fields) {
			values[field] = row[field];
		}

		const count = Number(row.count ?? row.COUNT ?? row['count(*)'] ?? 0);
		const where: Record<string, unknown> = {};
		let hasNull = false;

		for (const field of fields) {
			if (values[field] == null) {
				hasNull = true;
				break;
			}
			where[field] = values[field];
		}

		let idsQuery = database(collection).select(primaryKey);
		if (hasNull) {
			for (const field of fields) {
				if (values[field] == null) idsQuery = idsQuery.whereNull(field);
				else idsQuery = idsQuery.where(field, values[field]);
			}
		} else {
			idsQuery = idsQuery.where(where);
		}

		const idRows = await idsQuery.limit(500);
		const ids = (idRows || []).map((r: Record<string, unknown>) => r[primaryKey] as string | number);

		groups.push({
			values,
			count: count || ids.length,
			ids,
		});
	}

	return groups;
}

export async function constraintExists(
	database: any,
	collection: string,
	fields: string[],
): Promise<{ exists: boolean; indexName: string | null }> {
	const client = getClientName(database);
	const expected = buildIndexName(collection, fields);
	const legacy = buildLegacyIndexName(collection, fields);

	try {
		if (client.includes('pg') || client.includes('postgres') || client.includes('cockroach')) {
			const result = await database.raw(
				`
				SELECT indexname, indexdef
				FROM pg_indexes
				WHERE schemaname = current_schema()
				  AND tablename = ?
				`,
				[collection],
			);
			const rows = result?.rows || result || [];
			for (const row of rows) {
				const name = String(row.indexname || '');
				const def = String(row.indexdef || '');
				if (!/^CREATE UNIQUE INDEX /i.test(def)) continue;
				if (name === expected || name === legacy || uniqueDefMatchesFields(def, fields)) {
					return { exists: true, indexName: name };
				}
			}
			return { exists: false, indexName: null };
		}

		if (client.includes('mysql') || client.includes('maria')) {
			const result = await database.raw(`SHOW INDEX FROM ?? WHERE Non_unique = 0`, [collection]);
			const rows = Array.isArray(result) ? result[0] || result : result;
			const byKey = new Map<string, string[]>();
			for (const row of rows || []) {
				const keyName = String(row.Key_name || '');
				if (keyName === 'PRIMARY') continue;
				if (!byKey.has(keyName)) byKey.set(keyName, []);
				byKey.get(keyName)!.push(String(row.Column_name));
			}
			for (const [name, cols] of byKey) {
				if (name === expected || name === legacy || fieldsMatch(cols, fields)) {
					return { exists: true, indexName: name };
				}
			}
			return { exists: false, indexName: null };
		}

		if (client.includes('sqlite')) {
			const result = await database.raw(`PRAGMA index_list(??)`, [collection]);
			const indexes = result || [];
			for (const index of indexes) {
				if (!index.unique) continue;
				const name = String(index.name || '');
				const info = await database.raw(`PRAGMA index_info(??)`, [name]);
				const cols = (info || []).map((r: any) => String(r.name));
				if (name === expected || name === legacy || fieldsMatch(cols, fields)) {
					return { exists: true, indexName: name };
				}
			}
			return { exists: false, indexName: null };
		}
	} catch {
		// Fall through — treat as unknown / not exists for apply attempt
	}

	return { exists: false, indexName: null };
}

function uniqueDefMatchesFields(indexDef: string, fields: string[]): boolean {
	const match = indexDef.match(/\(([^)]+)\)\s*$/);
	if (!match?.[1]) return false;
	const cols = match[1]
		.split(',')
		.map((part) => part.trim().replace(/^"|"$/g, '').replace(/^`|`$/g, ''))
		.filter(Boolean);
	return fieldsMatch(cols, fields);
}

export async function applyUniqueConstraint(
	database: any,
	collection: string,
	fields: string[],
): Promise<{ indexName: string }> {
	const indexName = buildIndexName(collection, fields);
	const existing = await constraintExists(database, collection, fields);
	if (existing.exists) {
		return { indexName: existing.indexName || indexName };
	}

	await database.schema.alterTable(collection, (table: any) => {
		table.unique(fields, { indexName });
	});

	return { indexName };
}

export async function dropUniqueConstraint(
	database: any,
	collection: string,
	fields: string[],
	indexName?: string | null,
): Promise<void> {
	const resolved = indexName || (await constraintExists(database, collection, fields)).indexName || buildIndexName(collection, fields);

	await database.schema.alterTable(collection, (table: any) => {
		table.dropUnique(fields, resolved);
	});
}

export { fieldsMatch };
