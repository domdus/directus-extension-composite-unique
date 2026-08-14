<template>
	<private-view title="Composite Unique" icon="key">
		<template #headline>
			<v-breadcrumb :items="[{ name: 'Composite Unique', to: '/composite-unique' }]" />
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #actions>
			<v-button v-if="step === 0" secondary :loading="loading" @click="reload">
				Refresh
			</v-button>
		</template>

		<template #sidebar>
			<sidebar-detail id="about" icon="info" title="About">
				<p class="sidebar-text">
					Composite unique constraints are not supported natively in Directus Studio. This wizard finds
					duplicate field combinations, helps you clean them up, then applies a real database unique
					constraint. Afterwards the API hook returns clear validation errors on write.
				</p>
			</sidebar-detail>
			<sidebar-detail id="filters" icon="filter_alt" title="Filters">
				<p class="sidebar-text">
					By default only collections with a usable field pair are listed (usually M2M junctions).
					Choose <strong>M2M Junctions</strong>, <strong>With Field Pairs</strong>, or
					<strong>All Collections</strong>. Simple tables that already rely on a unique primary key
					usually need no composite constraint.
				</p>
			</sidebar-detail>
		</template>

		<div :class="pageClass">
			<v-divider
				class="section-divider"
				large
				:inline-title="false"
				:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
			>
				<template #icon><v-icon name="auto_fix_high" /></template>
				Wizard
			</v-divider>

			<p class="page-intro">
				Select collections, check for duplicate combinations, clean them up, then apply composite unique
				constraints. Nothing is changed until you confirm.
			</p>

			<div class="steps">
				<div class="step" :class="{ active: step === 0, done: step > 0 }">1. Select</div>
				<div class="step" :class="{ active: step === 1, done: step > 1 }">2. Check</div>
				<div class="step" :class="{ active: step === 2, done: step > 2 }">3. Clean</div>
				<div class="step" :class="{ active: step === 3 }">4. Apply</div>
			</div>

			<v-notice v-if="error" type="danger" class="notice">{{ error }}</v-notice>
			<v-notice v-if="notice" :type="notice.type" class="notice">{{ notice.text }}</v-notice>

			<!-- Step 0: Select -->
			<template v-if="step === 0">
				<div class="toolbar">
					<v-input v-model="search" class="search" placeholder="Filter Collections…" />
					<div class="scope-radios">
						<v-radio v-model="collectionScope" value="junctions" label="M2M Junctions" />
						<v-radio v-model="collectionScope" value="candidates" label="With Field Pairs" />
						<v-radio v-model="collectionScope" value="all" label="All Collections" />
					</div>
					<v-checkbox v-model="hideConstrained" label="Hide Already Constrained" />
					<div class="toolbar-actions">
						<v-button secondary small :disabled="filtered.length === 0" @click="selectFiltered">
							Select Filtered
						</v-button>
						<v-button secondary small :disabled="selected.size === 0" @click="selected.clear()">
							Clear
						</v-button>
					</div>
				</div>

				<v-notice v-if="collectionScope === 'junctions'" type="info" class="notice">
					Showing M2M junction collections with a suggested field pair — where composite uniques are needed
					most often.
				</v-notice>
				<v-notice v-else-if="collectionScope === 'candidates'" type="info" class="notice">
					Showing collections that have at least two relation fields suitable for a composite unique
					(system/audit FKs like user_created are ignored).
				</v-notice>
				<v-notice v-else type="warning" class="notice">
					All collections are listed. Entries without a field pair (or with only a unique primary key)
					typically need no composite unique — there is usually no action required.
				</v-notice>

				<v-progress-circular v-if="loading" indeterminate />

				<div v-else class="table">
					<div class="row head">
						<span class="col check"></span>
						<span class="col name">Collection</span>
						<span class="col badge">Type</span>
						<span class="col fields">Unique On</span>
						<span class="col status">Status</span>
					</div>
					<div v-for="item in filtered" :key="item.collection" class="row">
						<span class="col check">
							<v-checkbox
								:model-value="selected.has(item.collection)"
								@update:model-value="toggle(item.collection, $event)"
							/>
						</span>
						<span class="col name">
							<code>{{ item.collection }}</code>
						</span>
						<span class="col badge">
							<v-chip v-if="item.isJunction" small>Junction</v-chip>
							<span v-else class="muted">—</span>
						</span>
						<span class="col fields">
							<template v-if="fieldOverrides[item.collection]">
								<code>{{ fieldOverrides[item.collection]!.join(', ') }}</code>
								<v-button x-small secondary class="edit-fields" @click="editFields(item)">Edit</v-button>
							</template>
							<template v-else-if="item.suggestedFields.length >= 2">
								<code>{{ item.suggestedFields.join(', ') }}</code>
								<v-button x-small secondary class="edit-fields" @click="editFields(item)">Edit</v-button>
							</template>
							<span v-else class="muted">
								No Field Pair
								<v-button x-small secondary class="edit-fields" @click="editFields(item)">Pick</v-button>
							</span>
						</span>
						<span class="col status">
							<span v-if="item.hasCompositeUnique" class="ok">Constrained</span>
							<span v-else class="muted">Open</span>
						</span>
					</div>
					<p v-if="filtered.length === 0" class="empty">
						No collections match the current filters.
						<template v-if="collectionScope !== 'all'">
							Try <strong>All Collections</strong> if you expected more rows.
						</template>
					</p>
				</div>

				<div class="footer">
					<span class="muted">{{ selected.size }} Selected</span>
					<v-button :disabled="selectedReady.length === 0" @click="runCheck">
						Check Selected
					</v-button>
				</div>
			</template>

			<!-- Step 1: Check results -->
			<template v-else-if="step === 1">
				<div class="results">
					<div v-for="result in checkResults" :key="resultKey(result)" class="result-card">
						<div class="result-head">
							<code>{{ result.collection }}</code>
							<code class="fields-code">({{ result.fields.join(', ') }})</code>
							<v-chip v-if="result.clean" small class="ok-chip">Clean</v-chip>
							<v-chip v-else small class="bad-chip">{{ result.duplicateGroups.length }} Duplicate Group(s)</v-chip>
							<v-chip v-if="result.hasConstraint" small>Constraint Exists</v-chip>
						</div>
						<div v-if="!result.clean" class="dupes">
							<div v-for="(group, idx) in result.duplicateGroups.slice(0, 8)" :key="idx" class="dupe-row">
								<span>{{ formatValues(group.values) }}</span>
								<span class="muted">×{{ group.count }} — ids: {{ group.ids.slice(0, 12).join(', ') }}{{ group.ids.length > 12 ? '…' : '' }}</span>
							</div>
							<p v-if="result.duplicateGroups.length > 8" class="muted">
								…and {{ result.duplicateGroups.length - 8 }} more groups
							</p>
						</div>
					</div>
				</div>

				<div class="footer">
					<v-button secondary @click="step = 0">Back</v-button>
					<v-button v-if="hasDuplicates" @click="step = 2">Clean Duplicates</v-button>
					<v-button v-else :disabled="checkResults.length === 0" @click="step = 3">Continue To Apply</v-button>
				</div>
			</template>

			<!-- Step 2: Clean -->
			<template v-else-if="step === 2">
				<v-notice type="warning" class="notice">
					Dedupe keeps one row per duplicate combination and deletes the rest. Prefer
					<strong>Keep First</strong> (lowest primary key) unless you know you need the newest row.
				</v-notice>

				<div class="toolbar">
					<label class="muted">Strategy</label>
					<v-select v-model="dedupeStrategy" :items="strategyItems" />
				</div>

				<div class="results">
					<div
						v-for="result in checkResults.filter((r) => !r.clean)"
						:key="resultKey(result)"
						class="result-card"
					>
						<div class="result-head">
							<code>{{ result.collection }}</code>
							<span class="muted">{{ result.duplicateRowCount }} rows in {{ result.duplicateGroups.length }} groups</span>
							<v-button
								small
								secondary
								:loading="busyKey === resultKey(result)"
								@click="dedupeOne(result)"
							>
								Dedupe
							</v-button>
						</div>
					</div>
				</div>

				<div class="footer">
					<v-button secondary @click="step = 1">Back</v-button>
					<v-button secondary :loading="busyKey === 'all-dedupe'" @click="dedupeAll">
						Dedupe All Dirty
					</v-button>
					<v-button :disabled="hasDuplicates" @click="step = 3">Continue To Apply</v-button>
				</div>
			</template>

			<!-- Step 3: Apply -->
			<template v-else>
				<v-notice type="info" class="notice">
					Applying creates a database unique constraint. Directus will not show it in the data model UI, but
					the database will enforce it and this extension will validate writes.
				</v-notice>

				<div class="results">
					<div
						v-for="result in checkResults.filter((r) => r.clean)"
						:key="resultKey(result)"
						class="result-card"
					>
						<div class="result-head">
							<code>{{ result.collection }}</code>
							<code class="fields-code">({{ result.fields.join(', ') }})</code>
							<span v-if="result.hasConstraint" class="ok">Constrained</span>
							<span v-else class="muted">Ready</span>
						</div>
					</div>
				</div>

				<div class="footer">
					<v-button secondary @click="step = hasDuplicates ? 2 : 1">Back</v-button>
					<v-button :loading="busyKey === 'apply'" :disabled="readyToApply.length === 0" @click="applySelected">
						Apply {{ readyToApply.length }} Constraint(s)
					</v-button>
				</div>
			</template>
		</div>

		<v-dialog v-model="fieldDialogOpen" @esc="fieldDialogOpen = false">
			<v-card v-if="fieldDialogCollection">
				<v-card-title>Fields for {{ fieldDialogCollection.collection }}</v-card-title>
				<v-card-text>
					<p class="muted">Select at least two fields that must be unique together.</p>
					<div class="field-picks">
						<v-checkbox
							v-for="field in fieldDialogCollection.fields.filter((f) => !f.isPrimary)"
							:key="field.field"
							:model-value="fieldDialogSelection.includes(field.field)"
							:label="field.field"
							@update:model-value="toggleFieldPick(field.field, $event)"
						/>
					</div>
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="fieldDialogOpen = false">Cancel</v-button>
					<v-button :disabled="fieldDialogSelection.length < 2" @click="saveFieldPicks">Save</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</private-view>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import ModuleNavigation from './navigation.vue';
import { useCompositeUnique } from './composables/use-composite-unique';
import { usePageClass } from './composables/use-page-class';
import type { CheckResult, CollectionCandidate } from '../../shared/types';

const pageClass = usePageClass();

const {
	loading,
	error,
	collections,
	load,
	checkBatch,
	dedupe,
	applyBatch,
} = useCompositeUnique();

const step = ref(0);
const search = ref('');
type CollectionScope = 'junctions' | 'candidates' | 'all';
const collectionScope = ref<CollectionScope>('junctions');
const hideConstrained = ref(false);
const selected = reactive(new Set<string>());
const fieldOverrides = reactive<Record<string, string[]>>({});
const checkResults = ref<CheckResult[]>([]);
const dedupeStrategy = ref<'keep_first' | 'keep_last'>('keep_first');
const strategyItems = [
	{ text: 'Keep First (Lowest PK)', value: 'keep_first' },
	{ text: 'Keep Last (Highest PK)', value: 'keep_last' },
];
const busyKey = ref<string | null>(null);
const notice = ref<{ type: 'success' | 'warning' | 'info' | 'danger'; text: string } | null>(null);

const fieldDialogOpen = ref(false);
const fieldDialogCollection = ref<CollectionCandidate | null>(null);
const fieldDialogSelection = ref<string[]>([]);

function hasCompositeCandidate(item: CollectionCandidate): boolean {
	const fields = fieldOverrides[item.collection] || item.suggestedFields;
	return fields.length >= 2;
}

const filtered = computed(() => {
	const q = search.value.trim().toLowerCase();
	return collections.value.filter((item) => {
		if (collectionScope.value === 'junctions') {
			if (!item.isJunction || !hasCompositeCandidate(item)) return false;
		} else if (collectionScope.value === 'candidates') {
			if (!hasCompositeCandidate(item)) return false;
		}
		if (hideConstrained.value && item.hasCompositeUnique) return false;
		if (q && !item.collection.toLowerCase().includes(q)) return false;
		return true;
	});
});

function fieldsFor(item: CollectionCandidate): string[] {
	return fieldOverrides[item.collection] || item.suggestedFields;
}

const selectedReady = computed(() =>
	collections.value
		.filter((item) => selected.has(item.collection))
		.map((item) => ({ collection: item.collection, fields: fieldsFor(item) }))
		.filter((item) => item.fields.length >= 2),
);

const hasDuplicates = computed(() => checkResults.value.some((r) => !r.clean));

const readyToApply = computed(() =>
	checkResults.value.filter((r) => r.clean && !r.hasConstraint),
);

function resultKey(result: CheckResult) {
	return `${result.collection}::${result.fields.join(',')}`;
}

function formatValues(values: Record<string, unknown>) {
	return Object.entries(values)
		.map(([k, v]) => `${k}=${v == null ? 'null' : String(v)}`)
		.join(', ');
}

function toggle(collection: string, value: boolean) {
	if (value) selected.add(collection);
	else selected.delete(collection);
}

function selectFiltered() {
	for (const item of filtered.value) {
		if (fieldsFor(item).length >= 2) selected.add(item.collection);
	}
}

function editFields(item: CollectionCandidate) {
	fieldDialogCollection.value = item;
	fieldDialogSelection.value = [...fieldsFor(item)];
	fieldDialogOpen.value = true;
}

function toggleFieldPick(field: string, value: boolean) {
	if (value) {
		if (!fieldDialogSelection.value.includes(field)) fieldDialogSelection.value.push(field);
	} else {
		fieldDialogSelection.value = fieldDialogSelection.value.filter((f) => f !== field);
	}
}

function saveFieldPicks() {
	if (!fieldDialogCollection.value || fieldDialogSelection.value.length < 2) return;
	fieldOverrides[fieldDialogCollection.value.collection] = [...fieldDialogSelection.value];
	fieldDialogOpen.value = false;
}

async function reload() {
	notice.value = null;
	await load();
}

async function runCheck() {
	notice.value = null;
	busyKey.value = 'check';
	try {
		checkResults.value = await checkBatch({ items: selectedReady.value });
		step.value = 1;
	} catch (err: any) {
		notice.value = {
			type: 'danger',
			text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Check failed',
		};
	} finally {
		busyKey.value = null;
	}
}

async function dedupeOne(result: CheckResult) {
	const key = resultKey(result);
	busyKey.value = key;
	notice.value = null;
	try {
		const data = await dedupe({
			collection: result.collection,
			fields: result.fields,
			strategy: dedupeStrategy.value,
		});
		const next = data.check as CheckResult;
		checkResults.value = checkResults.value.map((r) => (resultKey(r) === key ? next : r));
		notice.value = { type: 'success', text: `Deleted ${data.deletedCount} duplicate row(s) in ${result.collection}` };
	} catch (err: any) {
		notice.value = {
			type: 'danger',
			text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Dedupe failed',
		};
	} finally {
		busyKey.value = null;
	}
}

async function dedupeAll() {
	busyKey.value = 'all-dedupe';
	notice.value = null;
	try {
		const dirty = checkResults.value.filter((r) => !r.clean);
		let deleted = 0;
		for (const result of dirty) {
			const data = await dedupe({
				collection: result.collection,
				fields: result.fields,
				strategy: dedupeStrategy.value,
			});
			deleted += data.deletedCount || 0;
			const next = data.check as CheckResult;
			checkResults.value = checkResults.value.map((r) =>
				resultKey(r) === resultKey(result) ? next : r,
			);
		}
		notice.value = { type: 'success', text: `Deleted ${deleted} duplicate row(s)` };
	} catch (err: any) {
		notice.value = {
			type: 'danger',
			text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Dedupe failed',
		};
	} finally {
		busyKey.value = null;
	}
}

async function applySelected() {
	busyKey.value = 'apply';
	notice.value = null;
	try {
		const items = readyToApply.value.map((r) => ({ collection: r.collection, fields: r.fields }));
		const data = await applyBatch(items);
		const appliedCount = data.applied?.length || 0;
		const skippedCount = data.skipped?.length || 0;
		notice.value = {
			type: skippedCount ? 'warning' : 'success',
			text: `Applied ${appliedCount} constraint(s)${skippedCount ? `, skipped ${skippedCount}` : ''}.`,
		};
		await load();
		checkResults.value = await checkBatch({ items });
	} catch (err: any) {
		notice.value = {
			type: 'danger',
			text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Apply failed',
		};
	} finally {
		busyKey.value = null;
	}
}

onMounted(load);
</script>

<style scoped>
.page {
	padding: var(--content-padding);
	padding-block-end: var(--content-padding-bottom, var(--content-padding));
	max-width: 1100px;
}

.page--flush-top {
	padding-block-start: 0;
}

.section-divider {
	margin-bottom: 12px;
}

.page-intro,
.sidebar-text {
	margin: 0 0 24px;
	line-height: 1.55;
	color: var(--theme--foreground);
}

.sidebar-text code {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 0.9em;
}

.steps {
	display: flex;
	gap: 8px;
	margin: 20px 0;
	flex-wrap: wrap;
}

.step {
	padding: 6px 12px;
	border-radius: var(--theme--border-radius);
	background: var(--theme--background-normal);
	color: var(--theme--foreground-subdued);
	font-size: 13px;
}

.step.active {
	background: var(--theme--primary);
	color: var(--foreground-inverted, #fff);
}

.step.done {
	background: var(--theme--background-accent);
	color: var(--theme--foreground);
}

.toolbar {
	display: flex;
	flex-wrap: wrap;
	gap: 12px 16px;
	align-items: center;
	margin-bottom: 16px;
}

.toolbar .search {
	max-width: 240px;
	flex: 0 1 240px;
}

.scope-radios {
	display: flex;
	flex-wrap: wrap;
	gap: 4px 16px;
	align-items: center;
}

.toolbar-actions {
	display: flex;
	gap: 8px;
	margin-left: auto;
}

.table {
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
	overflow: hidden;
}

.row {
	display: grid;
	grid-template-columns: 40px minmax(140px, 1.2fr) 100px minmax(180px, 1.6fr) 90px;
	gap: 8px;
	align-items: center;
	padding: 10px 12px;
	border-bottom: 1px solid var(--theme--border-color-subdued);
}

.row.head {
	background: var(--theme--background-normal);
	font-size: 12px;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--theme--foreground-subdued);
}

.row:last-child {
	border-bottom: none;
}

.fields-code,
code {
	font-size: 13px;
}

.edit-fields {
	margin-left: 8px;
}

.muted {
	color: var(--theme--foreground-subdued);
}

.ok {
	color: var(--theme--success);
}

.empty {
	padding: 24px;
	text-align: center;
	color: var(--theme--foreground-subdued);
}

.footer {
	display: flex;
	justify-content: flex-end;
	align-items: center;
	gap: 12px;
	margin-top: 20px;
}

.notice {
	margin-bottom: 16px;
}

.results {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.result-card {
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
	padding: 12px 14px;
}

.result-head {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	align-items: center;
}

.ok-chip {
	--v-chip-color: var(--theme--success);
}

.bad-chip {
	--v-chip-color: var(--theme--danger);
}

.dupes {
	margin-top: 10px;
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 13px;
}

.dupe-row {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 6px 8px;
	background: var(--theme--background-normal);
	border-radius: var(--theme--border-radius);
}

.field-picks {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
	gap: 8px;
	margin-top: 12px;
}
</style>
