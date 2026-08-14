/**
 * Admin detection across Directus majors:
 * - v11+: `admin_access` is on the user (from policies)
 * - v9/v10: `admin_access` lives on the role object
 */
export function userHasAdminAccess(user: unknown): boolean {
	if (!user || typeof user !== 'object') return false;

	const record = user as {
		admin_access?: boolean | null;
		role?: string | { admin_access?: boolean | null } | null;
	};

	if (record.admin_access === true) return true;

	const role = record.role;
	if (role && typeof role === 'object' && role.admin_access === true) return true;

	return false;
}

export function accountabilityIsAdmin(accountability: unknown): boolean {
	if (!accountability || typeof accountability !== 'object') return false;
	return (accountability as { admin?: boolean }).admin === true;
}
