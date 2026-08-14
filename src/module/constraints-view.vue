<template>
	<private-view title="Constraints" icon="verified">
		<template #headline>
			<v-breadcrumb :items="[{ name: 'Composite Unique', to: '/composite-unique' }]" />
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #actions>
			<v-button secondary :loading="loading" @click="reload">Refresh</v-button>
		</template>

		<template #sidebar>
			<sidebar-detail id="about" icon="info" title="About">
				<p class="sidebar-text">
					Constraints applied through this extension are tracked in
					<code>directus_settings.composite_unique</code>. Removing an entry also drops the database
					constraint.
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
				<template #icon><v-icon name="verified" /></template>
				Constraints
			</v-divider>

			<p class="page-intro">
				Composite unique constraints applied by this extension. The database enforces uniqueness; the hook
				returns clear API errors on create/update.
			</p>

			<v-notice v-if="error" type="danger" class="notice">{{ error }}</v-notice>
			<v-notice v-if="notice" :type="notice.type" class="notice">{{ notice.text }}</v-notice>

			<v-progress-circular v-if="loading" indeterminate />

			<template v-else>
				<div v-if="constraints.length === 0" class="empty">
					<p>No constraints applied yet.</p>
					<v-button to="/composite-unique">Open Wizard</v-button>
				</div>

				<div v-else class="table">
					<div class="row head">
						<span>Collection</span>
						<span>Fields</span>
						<span>Index Name</span>
						<span>Applied</span>
						<span></span>
					</div>
					<div v-for="entry in constraints" :key="entryKey(entry)" class="row">
						<code>{{ entry.collection }}</code>
						<code>{{ entry.fields.join(', ') }}</code>
						<span class="muted">{{ entry.indexName || '—' }}</span>
						<span class="muted">{{ formatDate(entry.appliedAt) }}</span>
						<v-button
							small
							kind="danger"
							secondary
							:loading="busyKey === entryKey(entry)"
							@click="confirmRemove(entry)"
						>
							Remove
						</v-button>
					</div>
				</div>
			</template>
		</div>

		<v-dialog v-model="confirmOpen" @esc="confirmOpen = false">
			<v-card v-if="pending">
				<v-card-title>Remove Constraint?</v-card-title>
				<v-card-text>
					<p>
						This drops the database unique constraint on
						<code>{{ pending.collection }}</code>
						(<code>{{ pending.fields.join(', ') }}</code>)
						and removes it from this list.
					</p>
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="confirmOpen = false">Cancel</v-button>
					<v-button kind="danger" :loading="Boolean(busyKey)" @click="doRemove">Remove</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</private-view>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import ModuleNavigation from './navigation.vue';
import { useCompositeUnique } from './composables/use-composite-unique';
import { usePageClass } from './composables/use-page-class';
import type { CompositeUniqueEntry } from '../../shared/types';

const pageClass = usePageClass();
const { loading, error, constraints, load, remove } = useCompositeUnique();

const notice = ref<{ type: 'success' | 'danger'; text: string } | null>(null);
const busyKey = ref<string | null>(null);
const confirmOpen = ref(false);
const pending = ref<CompositeUniqueEntry | null>(null);

function entryKey(entry: CompositeUniqueEntry) {
	return `${entry.collection}::${entry.fields.join(',')}`;
}

function formatDate(value?: string | null) {
	if (!value) return '—';
	try {
		return new Date(value).toLocaleString();
	} catch {
		return value;
	}
}

function confirmRemove(entry: CompositeUniqueEntry) {
	pending.value = entry;
	confirmOpen.value = true;
}

async function doRemove() {
	if (!pending.value) return;
	const entry = pending.value;
	busyKey.value = entryKey(entry);
	notice.value = null;
	try {
		await remove(entry.collection, entry.fields, true);
		notice.value = { type: 'success', text: `Removed constraint on ${entry.collection}` };
		confirmOpen.value = false;
		pending.value = null;
		await load();
	} catch (err: any) {
		notice.value = {
			type: 'danger',
			text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Remove failed',
		};
	} finally {
		busyKey.value = null;
	}
}

async function reload() {
	notice.value = null;
	await load();
}

onMounted(load);
</script>

<style scoped>
.page {
	padding: var(--content-padding);
	padding-block-end: var(--content-padding-bottom, var(--content-padding));
	max-width: 1000px;
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

.sidebar-text code,
.v-card-text code {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 0.9em;
}

.muted {
	color: var(--theme--foreground-subdued);
	line-height: 1.5;
}

.notice {
	margin-bottom: 16px;
}

.empty {
	padding: 40px 0;
	text-align: center;
	display: flex;
	flex-direction: column;
	gap: 16px;
	align-items: center;
	color: var(--theme--foreground-subdued);
}

.table {
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
	overflow: hidden;
}

.row {
	display: grid;
	grid-template-columns: 1.2fr 1.4fr 1fr 1fr auto;
	gap: 10px;
	align-items: center;
	padding: 12px 14px;
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
</style>
