import { useStores } from '@directus/extensions-sdk';
import { computed, type ComputedRef } from 'vue';

function parseVersion(version: unknown): { major: number; minor: number } | null {
	if (typeof version !== 'string' || !version) return null;
	const cleaned = version.trim().replace(/^v/i, '');
	const [majorRaw, minorRaw] = cleaned.split('.');
	const major = Number.parseInt(majorRaw || '', 10);
	const minor = Number.parseInt(minorRaw || '', 10);
	if (!Number.isFinite(major)) return null;
	return { major, minor: Number.isFinite(minor) ? minor : 0 };
}

function hasSplitPanelLayout(): boolean {
	if (typeof document === 'undefined') return false;
	// 11.14+ / 12 private-view (vue-split-panel)
	if (document.querySelector('.root-split, .main-split')) return true;
	// 11.14+ module bar: `#navigation.module-bar` (early v11 used `#navigation` without that class)
	if (document.querySelector('#navigation.module-bar')) return true;
	if (document.querySelector('aside.module-nav:not(#navigation)')) return true;
	return false;
}

/**
 * Early Directus v11 (pre–SplitPanel, < 11.14) already spaces content below the
 * header, so full `--content-padding` on top looks oversized.
 *
 * From 11.14+ (e.g. 11.17.4) and on v9/v10/v12, keep the normal top padding.
 * SplitPanel / modern nav in the DOM always wins over a missing version string.
 */
function needsReducedTopPadding(version: unknown): boolean {
	if (hasSplitPanelLayout()) return false;

	const parsed = parseVersion(version);
	if (parsed) {
		return parsed.major === 11 && parsed.minor < 14;
	}

	if (typeof document === 'undefined') return false;
	return Boolean(document.querySelector('#navigation:not(.module-bar)'));
}

export function usePageClass(): ComputedRef<string[]> {
	const { useServerStore } = useStores() as {
		useServerStore: () => { info?: { version?: string } };
	};
	const serverStore = useServerStore();

	return computed(() => {
		const classes = ['page'];
		const version = serverStore?.info?.version;
		if (needsReducedTopPadding(version)) {
			classes.push('page--flush-top');
		}
		return classes;
	});
}
