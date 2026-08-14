import { ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import type { CheckResult, CollectionCandidate, CompositeUniqueEntry } from '../../shared/types';

export function useCompositeUnique() {
	const api = useApi();
	const loading = ref(false);
	const error = ref<string | null>(null);
	const collections = ref<CollectionCandidate[]>([]);
	const constraints = ref<CompositeUniqueEntry[]>([]);

	async function load() {
		loading.value = true;
		error.value = null;
		try {
			const { data } = await api.get('/composite-unique-endpoint');
			collections.value = data?.data?.collections || [];
			constraints.value = data?.data?.constraints || data?.data?.managed || [];
		} catch (err: any) {
			error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Failed to load';
		} finally {
			loading.value = false;
		}
	}

	async function check(collection: string, fields: string[]): Promise<CheckResult> {
		const { data } = await api.post('/composite-unique-endpoint/check', { collection, fields });
		return data.data as CheckResult;
	}

	async function checkBatch(payload: {
		items?: Array<{ collection: string; fields: string[] }>;
		collections?: string[];
		junctionsOnly?: boolean;
	}): Promise<CheckResult[]> {
		const { data } = await api.post('/composite-unique-endpoint/check-batch', payload);
		return (data.data || []) as CheckResult[];
	}

	async function dedupe(payload: {
		collection: string;
		fields: string[];
		strategy?: 'keep_first' | 'keep_last';
		ids?: Array<string | number>;
	}) {
		const { data } = await api.post('/composite-unique-endpoint/dedupe', payload);
		return data.data;
	}

	async function apply(collection: string, fields: string[]) {
		const { data } = await api.post('/composite-unique-endpoint/apply', { collection, fields });
		return data.data;
	}

	async function applyBatch(items: Array<{ collection: string; fields: string[] }>) {
		const { data } = await api.post('/composite-unique-endpoint/apply-batch', { items });
		return data.data;
	}

	async function remove(collection: string, fields: string[], dropConstraint = true) {
		const { data } = await api.post('/composite-unique-endpoint/remove', {
			collection,
			fields,
			dropConstraint,
		});
		constraints.value = data?.data?.constraints || data?.data?.managed || [];
		return data.data;
	}

	return {
		loading,
		error,
		collections,
		constraints,
		load,
		check,
		checkBatch,
		dedupe,
		apply,
		applyBatch,
		remove,
	};
}
