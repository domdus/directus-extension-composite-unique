import type { Request, Response, Router } from 'express';
import { accountabilityIsAdmin } from '../shared/admin';
import {
	COMPOSITE_UNIQUE_FIELD,
	findEntry,
	readConfig,
	removeEntry,
	upsertEntry,
	writeConfig,
} from '../shared/config';
import {
	applyUniqueConstraint,
	constraintExists,
	dropUniqueConstraint,
	findDuplicateGroups,
	listCollectionCandidates,
} from '../shared/constraints';
import type { CheckResult, CompositeUniqueEntry } from '../shared/types';

type EndpointExtensionContext = {
	services: Record<string, any>;
	database: any;
	getSchema: () => Promise<any>;
	logger: {
		info: (msg: string, ...args: unknown[]) => void;
		warn: (msg: string, ...args: unknown[]) => void;
		error: (msg: string, ...args: unknown[]) => void;
	};
};

function requireAdmin(req: Request, res: Response): boolean {
	if (!accountabilityIsAdmin((req as any).accountability)) {
		res.status(403).json({
			errors: [{ message: 'Admin access required', extensions: { code: 'FORBIDDEN' } }],
		});
		return false;
	}
	return true;
}

function parseFields(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.map((f) => String(f).trim()).filter(Boolean))];
}

async function ensureSettingsField(
	services: any,
	getSchema: () => Promise<any>,
	database: any,
	logger: EndpointExtensionContext['logger'],
): Promise<void> {
	try {
		const hasColumn = await database.schema.hasColumn('directus_settings', COMPOSITE_UNIQUE_FIELD);
		if (hasColumn) {
			const existingMeta = await database('directus_fields')
				.where({ collection: 'directus_settings', field: COMPOSITE_UNIQUE_FIELD })
				.first();
			if (existingMeta) return;
		}

		const schema = await getSchema();
		const { FieldsService } = services;
		const fieldsService = new FieldsService({
			schema,
			accountability: { admin: true },
		});

		await fieldsService.createField('directus_settings', {
			field: COMPOSITE_UNIQUE_FIELD,
			type: 'json',
			meta: {
				collection: 'directus_settings',
				field: COMPOSITE_UNIQUE_FIELD,
				special: ['cast-json'],
				interface: 'input-code',
				hidden: true,
				readonly: false,
				width: 'full',
				note: 'Managed by Composite Unique extension. Do not edit manually.',
			},
			schema: {},
		});

		logger.info('[composite-unique] Created directus_settings.composite_unique');
	} catch (error: any) {
		const message = String(error?.message || error || '');
		if (/already exists|duplicate|SQLITE_ERROR/i.test(message)) return;
		logger.warn(`[composite-unique] Could not ensure settings field: ${message}`);
	}
}

async function resolvePrimaryKey(schema: any, collection: string): Promise<string> {
	return schema?.collections?.[collection]?.primary || 'id';
}

async function buildCheck(
	database: any,
	schema: any,
	collection: string,
	fields: string[],
): Promise<CheckResult> {
	const primaryKey = await resolvePrimaryKey(schema, collection);
	const duplicateGroups = await findDuplicateGroups(database, collection, fields, primaryKey);
	const existing = await constraintExists(database, collection, fields);
	const duplicateRowCount = duplicateGroups.reduce((sum, group) => sum + group.count, 0);

	return {
		collection,
		fields,
		duplicateGroups,
		duplicateRowCount,
		clean: duplicateGroups.length === 0,
		hasConstraint: existing.exists,
		indexName: existing.indexName,
	};
}

export default (router: Router, context: EndpointExtensionContext) => {
	const { services, database, getSchema, logger } = context;

	router.get('/', async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;

		try {
			await ensureSettingsField(services, getSchema, database, logger);
			const schema = await getSchema();
			const config = await readConfig(database);
			const collections = listCollectionCandidates(schema, config);

			res.json({
				data: {
					collections,
					constraints: config.entries,
				},
			});
		} catch (error: any) {
			logger.error(`[composite-unique] list failed: ${error?.message || error}`);
			res.status(500).json({
				errors: [{ message: error?.message || 'Failed to list collections' }],
			});
		}
	});

	router.post('/check', async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;

		try {
			const collection = String(req.body?.collection || '').trim();
			const fields = parseFields(req.body?.fields);

			if (!collection || fields.length < 2) {
				res.status(400).json({
					errors: [{ message: 'collection and at least two fields are required' }],
				});
				return;
			}

			const schema = await getSchema();
			if (!schema.collections?.[collection]) {
				res.status(404).json({ errors: [{ message: `Collection "${collection}" not found` }] });
				return;
			}

			const result = await buildCheck(database, schema, collection, fields);
			res.json({ data: result });
		} catch (error: any) {
			logger.error(`[composite-unique] check failed: ${error?.message || error}`);
			res.status(500).json({
				errors: [{ message: error?.message || 'Check failed' }],
			});
		}
	});

	router.post('/check-batch', async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;

		try {
			const schema = await getSchema();
			const config = await readConfig(database);
			const candidates = listCollectionCandidates(schema, config);

			const items: Array<{ collection: string; fields: string[] }> = Array.isArray(req.body?.items)
				? req.body.items
				: [];

			let targets = items
				.map((item) => ({
					collection: String(item.collection || '').trim(),
					fields: parseFields(item.fields),
				}))
				.filter((item) => item.collection && item.fields.length >= 2);

			if (targets.length === 0) {
				const collectionsFilter: string[] | null = Array.isArray(req.body?.collections)
					? req.body.collections.map((c: unknown) => String(c))
					: null;
				const junctionsOnly = Boolean(req.body?.junctionsOnly);

				targets = candidates
					.filter((c) => !junctionsOnly || c.isJunction)
					.filter((c) => !collectionsFilter || collectionsFilter.includes(c.collection))
					.filter((c) => c.suggestedFields.length >= 2)
					.map((c) => ({ collection: c.collection, fields: c.suggestedFields }));
			}

			const results: CheckResult[] = [];
			for (const target of targets) {
				if (!schema.collections?.[target.collection]) continue;
				results.push(await buildCheck(database, schema, target.collection, target.fields));
			}

			res.json({ data: results });
		} catch (error: any) {
			logger.error(`[composite-unique] check-batch failed: ${error?.message || error}`);
			res.status(500).json({
				errors: [{ message: error?.message || 'Batch check failed' }],
			});
		}
	});

	router.post('/dedupe', async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;

		try {
			const collection = String(req.body?.collection || '').trim();
			const fields = parseFields(req.body?.fields);
			const strategy = String(req.body?.strategy || 'keep_first') as 'keep_first' | 'keep_last';
			const explicitIds = Array.isArray(req.body?.ids)
				? req.body.ids.map((id: unknown) => id as string | number)
				: null;

			if (!collection || fields.length < 2) {
				res.status(400).json({
					errors: [{ message: 'collection and at least two fields are required' }],
				});
				return;
			}

			const schema = await getSchema();
			const primaryKey = await resolvePrimaryKey(schema, collection);
			const { ItemsService } = services;
			const itemsService = new ItemsService(collection, {
				schema,
				accountability: (req as any).accountability,
			});

			let deletedIds: Array<string | number> = [];

			if (explicitIds?.length) {
				await itemsService.deleteMany(explicitIds);
				deletedIds = explicitIds;
			} else {
				const groups = await findDuplicateGroups(database, collection, fields, primaryKey, 500);
				for (const group of groups) {
					const sorted = [...group.ids].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
					const keep = strategy === 'keep_last' ? sorted[sorted.length - 1] : sorted[0];
					const toDelete = sorted.filter((id) => id !== keep);
					if (toDelete.length === 0) continue;
					await itemsService.deleteMany(toDelete);
					deletedIds.push(...toDelete);
				}
			}

			const check = await buildCheck(database, schema, collection, fields);

			res.json({
				data: {
					deletedCount: deletedIds.length,
					deletedIds,
					check,
				},
			});
		} catch (error: any) {
			logger.error(`[composite-unique] dedupe failed: ${error?.message || error}`);
			res.status(500).json({
				errors: [{ message: error?.message || 'Dedupe failed' }],
			});
		}
	});

	router.post('/apply', async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;

		try {
			await ensureSettingsField(services, getSchema, database, logger);

			const collection = String(req.body?.collection || '').trim();
			const fields = parseFields(req.body?.fields);

			if (!collection || fields.length < 2) {
				res.status(400).json({
					errors: [{ message: 'collection and at least two fields are required' }],
				});
				return;
			}

			const schema = await getSchema();
			if (!schema.collections?.[collection]) {
				res.status(404).json({ errors: [{ message: `Collection "${collection}" not found` }] });
				return;
			}

			const check = await buildCheck(database, schema, collection, fields);
			if (!check.clean) {
				res.status(409).json({
					errors: [
						{
							message: `Cannot apply constraint: ${check.duplicateGroups.length} duplicate combination(s) remain`,
							extensions: { code: 'DUPLICATES_REMAIN', check },
						},
					],
				});
				return;
			}

			const { indexName } = await applyUniqueConstraint(database, collection, fields);
			const entry: CompositeUniqueEntry = {
				collection,
				fields,
				indexName,
				appliedAt: new Date().toISOString(),
			};

			const config = await readConfig(database);
			const next = upsertEntry(config, entry);
			await writeConfig(database, next);

			res.json({
				data: {
					entry,
					check: { ...check, hasConstraint: true, indexName },
				},
			});
		} catch (error: any) {
			logger.error(`[composite-unique] apply failed: ${error?.message || error}`);
			res.status(500).json({
				errors: [{ message: error?.message || 'Apply failed' }],
			});
		}
	});

	router.post('/apply-batch', async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;

		try {
			await ensureSettingsField(services, getSchema, database, logger);

			const items: Array<{ collection: string; fields: string[] }> = Array.isArray(req.body?.items)
				? req.body.items.map((item: any) => ({
						collection: String(item.collection || '').trim(),
						fields: parseFields(item.fields),
					}))
				: [];

			const targets = items.filter((item) => item.collection && item.fields.length >= 2);
			if (targets.length === 0) {
				res.status(400).json({ errors: [{ message: 'items with collection and fields are required' }] });
				return;
			}

			const schema = await getSchema();
			let config = await readConfig(database);
			const applied: CompositeUniqueEntry[] = [];
			const skipped: Array<{ collection: string; fields: string[]; reason: string }> = [];

			for (const target of targets) {
				if (!schema.collections?.[target.collection]) {
					skipped.push({ ...target, reason: 'collection_not_found' });
					continue;
				}

				const check = await buildCheck(database, schema, target.collection, target.fields);
				if (!check.clean) {
					skipped.push({ ...target, reason: 'duplicates_remain' });
					continue;
				}

				try {
					const { indexName } = await applyUniqueConstraint(database, target.collection, target.fields);
					const entry: CompositeUniqueEntry = {
						collection: target.collection,
						fields: target.fields,
						indexName,
						appliedAt: new Date().toISOString(),
					};
					config = upsertEntry(config, entry);
					applied.push(entry);
				} catch (error: any) {
					skipped.push({ ...target, reason: error?.message || 'apply_failed' });
				}
			}

			await writeConfig(database, config);

			res.json({ data: { applied, skipped, constraints: config.entries } });
		} catch (error: any) {
			logger.error(`[composite-unique] apply-batch failed: ${error?.message || error}`);
			res.status(500).json({
				errors: [{ message: error?.message || 'Batch apply failed' }],
			});
		}
	});

	router.post('/remove', async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;

		try {
			const collection = String(req.body?.collection || '').trim();
			const fields = parseFields(req.body?.fields);
			const dropConstraint = req.body?.dropConstraint !== false;

			if (!collection || fields.length < 2) {
				res.status(400).json({
					errors: [{ message: 'collection and at least two fields are required' }],
				});
				return;
			}

			const config = await readConfig(database);
			const entry = findEntry(config, collection, fields);

			if (dropConstraint) {
				try {
					await dropUniqueConstraint(database, collection, fields, entry?.indexName);
				} catch (error: any) {
					logger.warn(`[composite-unique] drop constraint: ${error?.message || error}`);
				}
			}

			const next = removeEntry(config, collection, fields);
			await writeConfig(database, next);

			res.json({ data: { removed: true, constraints: next.entries } });
		} catch (error: any) {
			logger.error(`[composite-unique] remove failed: ${error?.message || error}`);
			res.status(500).json({
				errors: [{ message: error?.message || 'Remove failed' }],
			});
		}
	});

	router.get('/config', async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			await ensureSettingsField(services, getSchema, database, logger);
			const config = await readConfig(database);
			res.json({ data: config });
		} catch (error: any) {
			res.status(500).json({ errors: [{ message: error?.message || 'Failed to read config' }] });
		}
	});
};
