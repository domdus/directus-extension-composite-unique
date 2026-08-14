import {
	COMPOSITE_UNIQUE_FIELD,
	type CompositeUniqueConfig,
	type CompositeUniqueEntry,
} from './types';

export function normalizeConfig(raw: unknown): CompositeUniqueConfig {
	if (!raw || typeof raw !== 'object') {
		return { version: 1, entries: [] };
	}

	const record = raw as { version?: unknown; entries?: unknown };
	const entries = Array.isArray(record.entries)
		? record.entries
				.map((entry) => normalizeEntry(entry))
				.filter((entry): entry is CompositeUniqueEntry => Boolean(entry))
		: [];

	return { version: 1, entries };
}

function normalizeEntry(raw: unknown): CompositeUniqueEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	const collection = typeof record.collection === 'string' ? record.collection.trim() : '';
	const fields = Array.isArray(record.fields)
		? record.fields.map((f) => String(f).trim()).filter(Boolean)
		: [];

	if (!collection || fields.length < 2) return null;

	return {
		collection,
		fields,
		indexName: typeof record.indexName === 'string' ? record.indexName : null,
		appliedAt: typeof record.appliedAt === 'string' ? record.appliedAt : null,
	};
}

export function entryKey(collection: string, fields: string[]): string {
	return `${collection}::${[...fields].sort().join(',')}`;
}

export function fieldsMatch(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sa = [...a].sort();
	const sb = [...b].sort();
	return sa.every((field, i) => field === sb[i]);
}

export function findEntry(
	config: CompositeUniqueConfig,
	collection: string,
	fields: string[],
): CompositeUniqueEntry | undefined {
	return config.entries.find((entry) => entry.collection === collection && fieldsMatch(entry.fields, fields));
}

export function upsertEntry(config: CompositeUniqueConfig, entry: CompositeUniqueEntry): CompositeUniqueConfig {
	const next = config.entries.filter(
		(existing) => !(existing.collection === entry.collection && fieldsMatch(existing.fields, entry.fields)),
	);
	next.push(entry);
	next.sort((a, b) => a.collection.localeCompare(b.collection));
	return { version: 1, entries: next };
}

export function removeEntry(
	config: CompositeUniqueConfig,
	collection: string,
	fields: string[],
): CompositeUniqueConfig {
	return {
		version: 1,
		entries: config.entries.filter(
			(entry) => !(entry.collection === collection && fieldsMatch(entry.fields, fields)),
		),
	};
}

export async function readConfig(database: any): Promise<CompositeUniqueConfig> {
	try {
		const hasColumn = await database.schema.hasColumn('directus_settings', COMPOSITE_UNIQUE_FIELD);
		if (!hasColumn) return { version: 1, entries: [] };

		const row = await database('directus_settings').select(COMPOSITE_UNIQUE_FIELD).first();
		let raw = row?.[COMPOSITE_UNIQUE_FIELD];
		if (typeof raw === 'string') {
			try {
				raw = JSON.parse(raw);
			} catch {
				raw = null;
			}
		}
		return normalizeConfig(raw);
	} catch {
		return { version: 1, entries: [] };
	}
}

export async function writeConfig(database: any, config: CompositeUniqueConfig): Promise<void> {
	const existing = await database('directus_settings').select('id').first();
	const payload = { [COMPOSITE_UNIQUE_FIELD]: JSON.stringify(config) };

	if (existing?.id != null) {
		await database('directus_settings').where({ id: existing.id }).update(payload);
	} else {
		await database('directus_settings').insert(payload);
	}
}

export { COMPOSITE_UNIQUE_FIELD };
