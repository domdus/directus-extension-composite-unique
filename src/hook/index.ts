import { defineHook } from '@directus/extensions-sdk';
import { readConfig } from '../shared/config';
import type { CompositeUniqueConfig, CompositeUniqueEntry } from '../shared/types';

function isEmptyValue(value: unknown): boolean {
	return value === undefined || value === null || value === '';
}

/**
 * Directus relation payloads may be:
 * - scalar id
 * - `{ id }` when linking an existing item
 * - nested create object (`{ status: 'published', ... }`) with no id yet
 *
 * Only scalar / `{ id }` can be checked against UUID/integer FK columns.
 */
function resolveRelationValue(value: unknown): string | number | boolean | null | undefined {
	if (value === undefined) return undefined;
	if (value === null || value === '') return null;

	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}

	if (typeof value === 'object' && !Array.isArray(value) && value !== null && 'id' in value) {
		const id = (value as { id: unknown }).id;
		if (typeof id === 'string' || typeof id === 'number') return id;
		if (id === null || id === '') return null;
	}

	// Nested create / array / unusable shape — skip hook check for this write
	return undefined;
}

async function assertUniqueCombination(
	database: any,
	entry: CompositeUniqueEntry,
	payload: Record<string, unknown>,
	primaryKey: string,
	currentId: string | number | null,
	InvalidPayloadException: any,
): Promise<void> {
	const values: Record<string, string | number | boolean | null> = {};

	for (const field of entry.fields) {
		if (!(field in payload)) return; // partial update without these fields — skip

		const resolved = resolveRelationValue(payload[field]);
		if (resolved === undefined) return; // nested create etc. — DB constraint still enforces later

		values[field] = resolved;
	}

	// If any composite field is null/empty, skip app-level check (DB NULL semantics vary)
	if (entry.fields.some((field) => isEmptyValue(values[field]))) return;

	let query = database(entry.collection);
	for (const field of entry.fields) {
		query = query.where(field, values[field]);
	}

	if (currentId != null) {
		query = query.whereNot(primaryKey, currentId);
	}

	const existing = await query.first();
	if (existing) {
		throw new InvalidPayloadException(
			`Composite unique violation on "${entry.collection}": (${entry.fields.join(', ')}) must be unique`,
		);
	}
}

export default defineHook(({ filter }, { database, getSchema, exceptions }) => {
	const InvalidPayloadException =
		(exceptions as any)?.InvalidPayloadException ||
		class InvalidPayloadException extends Error {
			status = 400;
			code = 'INVALID_PAYLOAD';
			constructor(message: string) {
				super(message);
			}
		};

	let cachedConfig: CompositeUniqueConfig | null = null;
	let cacheAt = 0;
	const CACHE_MS = 5000;

	const getConfig = async () => {
		const now = Date.now();
		if (cachedConfig && now - cacheAt < CACHE_MS) return cachedConfig;
		cachedConfig = await readConfig(database);
		cacheAt = now;
		return cachedConfig;
	};

	const invalidate = () => {
		cachedConfig = null;
		cacheAt = 0;
	};

	filter('settings.update', async (payload: any) => {
		if (payload && typeof payload === 'object' && 'composite_unique' in payload) {
			invalidate();
		}
		return payload;
	});

	filter('items.create', async (payload: any, meta: any) => {
		const collection = meta?.collection as string | undefined;
		if (!collection || collection.startsWith('directus_')) return payload;

		const config = await getConfig();
		const entries = config.entries.filter((entry) => entry.collection === collection);
		if (!entries.length) return payload;

		const schema = await getSchema();
		const primaryKey = schema?.collections?.[collection]?.primary || 'id';

		for (const entry of entries) {
			await assertUniqueCombination(database, entry, payload || {}, primaryKey, null, InvalidPayloadException);
		}

		return payload;
	});

	filter('items.update', async (payload: any, meta: any) => {
		const collection = meta?.collection as string | undefined;
		if (!collection || collection.startsWith('directus_')) return payload;

		const config = await getConfig();
		const entries = config.entries.filter((entry) => entry.collection === collection);
		if (!entries.length) return payload;

		const schema = await getSchema();
		const primaryKey = schema?.collections?.[collection]?.primary || 'id';
		const keys: Array<string | number> = Array.isArray(meta?.keys) ? meta.keys : [];

		for (const entry of entries) {
			const touchesComposite = entry.fields.some((field) => payload && field in payload);
			if (!touchesComposite) continue;

			for (const key of keys) {
				const existing = await database(collection).where({ [primaryKey]: key }).first();
				const merged = { ...(existing || {}), ...(payload || {}) };
				await assertUniqueCombination(
					database,
					entry,
					merged,
					primaryKey,
					key,
					InvalidPayloadException,
				);
			}
		}

		return payload;
	});
});
