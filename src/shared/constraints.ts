import { fieldsMatch } from './config';
import type { CollectionCandidate, CompositeUniqueConfig, DuplicateGroup } from './types';

type SchemaLike = {
	collections?: Record<
		string,
		{
			collection?: string;
			primary?: string;
			fields?: Record<
				string,
				{
					field?: string;
					type?: string | null;
					schema?: { max_length?: number | null; data_type?: string | null } | null;
				}
			>;
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

const INDEX_NAME_LIMIT = 63;

function sanitizeIndexName(raw: string): string {
	return raw.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Stable short suffix so two long names that share a prefix stay distinct. */
function hashIndexName(raw: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < raw.length; i++) {
		hash ^= raw.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildIndexName(collection: string, fields: string[]): string {
	const raw = sanitizeIndexName(`uq_${collection}_${fields.join('_')}`);
	if (raw.length <= INDEX_NAME_LIMIT) return raw;
	const suffix = hashIndexName(raw);
	return `${raw.slice(0, INDEX_NAME_LIMIT - suffix.length - 1)}_${suffix}`;
}

/** v1.0.2 and earlier sliced long names with no hash. Still recognized on lookup. */
function buildTruncatedIndexName(collection: string, fields: string[]): string {
	return sanitizeIndexName(`uq_${collection}_${fields.join('_')}`).slice(0, INDEX_NAME_LIMIT);
}

/** Legacy prefix from earlier builds — still recognized for exists/drop. */
export function buildLegacyIndexName(collection: string, fields: string[]): string {
	return sanitizeIndexName(`cu_${collection}_${fields.join('_')}`).slice(0, INDEX_NAME_LIMIT);
}

function knownIndexNames(collection: string, fields: string[]): Set<string> {
	return new Set([
		buildIndexName(collection, fields),
		buildLegacyIndexName(collection, fields),
		buildTruncatedIndexName(collection, fields),
	]);
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
	const names = knownIndexNames(collection, fields);

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
				if (names.has(name) || uniqueDefMatchesFields(def, fields)) {
					return { exists: true, indexName: name };
				}
			}
			return { exists: false, indexName: null };
		}

		if (client.includes('mysql') || client.includes('maria')) {
			const result = await database.raw(`SHOW INDEX FROM ?? WHERE Non_unique = 0`, [collection]);
			const rows = mysqlRows(result);
			const byKey = new Map<string, string[]>();
			for (const row of rows) {
				const keyName = String(rowValue(row, 'Key_name') || '');
				if (!keyName || keyName === 'PRIMARY') continue;
				if (!byKey.has(keyName)) byKey.set(keyName, []);
				byKey.get(keyName)!.push(String(rowValue(row, 'Column_name') || ''));
			}
			for (const [name, cols] of byKey) {
				if (names.has(name) || fieldsMatch(cols.filter(Boolean), fields)) {
					return { exists: true, indexName: name };
				}
			}
			return { exists: false, indexName: null };
		}

		if (client.includes('sqlite')) {
			const result = await database.raw(`PRAGMA index_list(??)`, [collection]);
			const indexes = Array.isArray(result) ? result : [];
			for (const index of indexes) {
				if (!index.unique) continue;
				const name = String(index.name || '');
				const info = await database.raw(`PRAGMA index_info(??)`, [name]);
				const infoRows = Array.isArray(info) ? info : [];
				const cols = infoRows.map((r: any) => String(r.name));
				if (names.has(name) || fieldsMatch(cols, fields)) {
					return { exists: true, indexName: name };
				}
			}
			return { exists: false, indexName: null };
		}

		if (client.includes('mssql') || client.includes('tedious')) {
			const result = await database.raw(
				`
				SELECT i.name AS index_name, col.name AS column_name
				FROM sys.indexes i
				INNER JOIN sys.index_columns ic
					ON ic.object_id = i.object_id AND ic.index_id = i.index_id
				INNER JOIN sys.columns col
					ON col.object_id = ic.object_id AND col.column_id = ic.column_id
				WHERE i.object_id = OBJECT_ID(?)
				  AND i.is_unique = 1
				  AND i.is_primary_key = 0
				  AND ic.is_included_column = 0
				  AND ic.key_ordinal > 0
				ORDER BY i.name, ic.key_ordinal
				`,
				[collection],
			);
			const byKey = new Map<string, string[]>();
			for (const row of result || []) {
				const keyName = String(rowValue(row, 'index_name') || '');
				if (!keyName) continue;
				if (!byKey.has(keyName)) byKey.set(keyName, []);
				byKey.get(keyName)!.push(String(rowValue(row, 'column_name') || ''));
			}
			for (const [name, cols] of byKey) {
				if (names.has(name) || fieldsMatch(cols.filter(Boolean), fields)) {
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

function mysqlRows(result: any): any[] {
	if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
	if (Array.isArray(result)) return result;
	return [];
}

function rowValue(row: any, key: string): unknown {
	if (!row || typeof row !== 'object') return undefined;
	if (row[key] != null) return row[key];
	const found = Object.keys(row).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
	return found ? row[found] : undefined;
}

function uniqueDefMatchesFields(indexDef: string, fields: string[]): boolean {
	// Partial unique indexes do not cover every row.
	if (/\swhere\s/i.test(indexDef)) return false;
	const match = indexDef.match(/\(([^()]*)\)\s*(?:storing\s*\([^()]*\))?\s*$/i);
	if (!match?.[1]) return false;
	const cols = match[1]
		.split(',')
		.map(columnFromIndexExpr)
		.filter(Boolean);
	return fieldsMatch(cols, fields);
}

/** `item ASC`, `"item" DESC NULLS LAST`, `item text_pattern_ops` → `item`. */
function columnFromIndexExpr(part: string): string {
	let expr = part.trim().replace(/\s+nulls\s+(first|last)$/i, '').replace(/\s+(asc|desc)$/i, '');
	const quoted = expr.match(/^"([^"]+)"|^`([^`]+)`|^\[([^\]]+)\]/);
	if (quoted) return quoted[1] || quoted[2] || quoted[3] || '';
	return expr.split(/\s+/)[0] || '';
}

const MYSQL_UNINDEXABLE = new Set(['text', 'json', 'csv', 'alias', 'geometry']);
/** InnoDB index prefix limit with utf8mb4 (4 bytes per character). */
const MYSQL_INDEX_BYTE_LIMIT = 3072;

/**
 * MySQL/MariaDB reject unique indexes on text-like columns, and on varchar
 * combinations that exceed the InnoDB key length. Fail with that reason
 * before Knex surfaces a raw server error.
 */
export function assertFieldsFitUniqueIndex(
	database: any,
	schema: SchemaLike | undefined,
	collection: string,
	fields: string[],
): void {
	const client = getClientName(database);
	if (!client.includes('mysql') && !client.includes('maria')) return;

	const colFields = schema?.collections?.[collection]?.fields;
	const blocked: string[] = [];
	let bytes = 0;

	for (const field of fields) {
		const meta = colFields?.[field];
		const type = meta?.type ?? null;
		const dataType = String(meta?.schema?.data_type || '').toLowerCase();
		const dataTypeBlocked = /text|blob|json|geometry/.test(dataType) && !/varchar|character/.test(dataType);
		if ((type && MYSQL_UNINDEXABLE.has(type)) || dataTypeBlocked) {
			blocked.push(type ? `${field} (${type})` : field);
			continue;
		}
		bytes += mysqlColumnBytes(type, meta?.schema?.max_length ?? null);
	}

	if (blocked.length) {
		throw new Error(
			`MySQL cannot unique-index ${blocked.join(', ')}. Choose shorter string columns instead of text, json, or csv.`,
		);
	}

	if (bytes > MYSQL_INDEX_BYTE_LIMIT) {
		throw new Error(
			`These columns are too wide for a MySQL unique index (about ${bytes} bytes; InnoDB's limit is ${MYSQL_INDEX_BYTE_LIMIT} with utf8mb4).`,
		);
	}
}

function mysqlColumnBytes(type: string | null, maxLength: number | null): number {
	if (type === 'string') return (maxLength && maxLength > 0 ? maxLength : 255) * 4;
	if (type === 'uuid') return (maxLength && maxLength > 0 ? maxLength : 36) * 4;
	return 8;
}

export async function applyUniqueConstraint(
	database: any,
	collection: string,
	fields: string[],
	schema?: SchemaLike,
): Promise<{ indexName: string }> {
	const indexName = buildIndexName(collection, fields);
	const existing = await constraintExists(database, collection, fields);
	if (existing.exists) {
		return { indexName: existing.indexName || indexName };
	}

	assertFieldsFitUniqueIndex(database, schema, collection, fields);

	await database.schema.alterTable(collection, (table: any) => {
		table.unique(fields, { indexName });
	});

	return { indexName };
}

/** Drop failed because the index/constraint is already gone. Safe to untrack. */
export function isMissingConstraintError(error: unknown): boolean {
	const message = String((error as { message?: string })?.message || error || '');
	return /does not exist|doesn't exist|no such index|check that column\/key exists/i.test(message);
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
