export const COMPOSITE_UNIQUE_FIELD = 'composite_unique';

export type CompositeUniqueEntry = {
	collection: string;
	fields: string[];
	/** DB index / constraint name when known */
	indexName?: string | null;
	appliedAt?: string | null;
};

export type CompositeUniqueConfig = {
	version: 1;
	entries: CompositeUniqueEntry[];
};

export type DuplicateGroup = {
	values: Record<string, unknown>;
	count: number;
	ids: Array<string | number>;
};

export type CollectionCandidate = {
	collection: string;
	primaryKey: string;
	isJunction: boolean;
	suggestedFields: string[];
	fields: Array<{ field: string; type: string | null; isPrimary: boolean }>;
	constraints: CompositeUniqueEntry[];
	hasCompositeUnique: boolean;
};

export type CheckResult = {
	collection: string;
	fields: string[];
	duplicateGroups: DuplicateGroup[];
	duplicateRowCount: number;
	clean: boolean;
	hasConstraint: boolean;
	indexName: string | null;
};
