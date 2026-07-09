import type { FeedSource, FeedTarget, SourceId } from './types';

export interface CkanPackageSourceConfig {
	sourceId: SourceId;
	baseUrl: string;
	packageId: string;
	prefId?: number | null;
	excludedNamePatterns?: RegExp[];
}

interface CkanPackageResponse {
	success: boolean;
	result?: CkanPackage;
	error?: {
		message?: string;
	};
}

interface CkanPackage {
	title?: string;
	license_title?: string | null;
	organization?: {
		title?: string;
	};
	resources?: CkanResource[];
}

interface CkanResource {
	id?: string;
	name?: string;
	format?: string | null;
	mimetype?: string | null;
	state?: string;
	url?: string | null;
	last_modified?: string | null;
	revision_id?: string | null;
	size?: number | null;
}

function packageShowUrl(baseUrl: string, packageId: string): string {
	const url = new URL('/api/3/action/package_show', baseUrl);
	url.searchParams.set('id', packageId);
	return url.toString();
}

function cleanText(value: string | null | undefined): string {
	return (value ?? '').trim();
}

function normalized(value: string | null | undefined): string {
	return cleanText(value).toLowerCase();
}

function isZipResource(resource: CkanResource): boolean {
	const format = normalized(resource.format);
	const mimetype = normalized(resource.mimetype);
	return format === 'zip' || mimetype.includes('zip');
}

function isDirectPackageZip(resourceUrl: string | null | undefined, baseUrl: string): boolean {
	const rawUrl = cleanText(resourceUrl);
	if (!rawUrl) return false;

	try {
		const url = new URL(rawUrl);
		const base = new URL(baseUrl);
		return (
			url.protocol === base.protocol &&
			url.hostname === base.hostname &&
			url.pathname.includes('/download/') &&
			url.pathname.toLowerCase().endsWith('.zip')
		);
	} catch {
		return false;
	}
}

function isExcluded(resource: CkanResource, patterns: RegExp[] | undefined): boolean {
	const name = cleanText(resource.name);
	return patterns?.some((pattern) => pattern.test(name)) ?? false;
}

function isTargetResource(resource: CkanResource, config: CkanPackageSourceConfig): boolean {
	return (
		resource.state === 'active' &&
		Boolean(resource.id) &&
		isZipResource(resource) &&
		isDirectPackageZip(resource.url, config.baseUrl) &&
		!isExcluded(resource, config.excludedNamePatterns)
	);
}

function versionId(resource: CkanResource): string {
	return [
		cleanText(resource.id),
		cleanText(resource.last_modified),
		cleanText(resource.revision_id),
		resource.size == null ? '' : String(resource.size),
	].join(':');
}

function targetFromResource(
	resource: CkanResource,
	pkg: CkanPackage,
	config: CkanPackageSourceConfig,
): FeedTarget | null {
	if (!isTargetResource(resource, config) || !resource.id || !resource.url) return null;

	return {
		id: `${config.sourceId}~${resource.id}`,
		name: cleanText(resource.name) || resource.id,
		orgName: cleanText(pkg.organization?.title) || cleanText(pkg.title) || config.sourceId,
		license: cleanText(pkg.license_title) || null,
		fromDate: '',
		toDate: '',
		source: config.sourceId,
		versionId: versionId(resource),
		zipUrl: resource.url,
		prefId: config.prefId ?? null,
	};
}

/** CKAN package_show API のリソース一覧を FeedSource へ適合させる。 */
export function createCkanPackageSource(config: CkanPackageSourceConfig): FeedSource {
	return {
		sourceId: config.sourceId,
		async listTargets(fetcher) {
			const response = await fetcher(packageShowUrl(config.baseUrl, config.packageId));
			if (!response.ok) {
				throw new Error(`ckan package fetch failed: ${response.status}`);
			}

			const body: CkanPackageResponse = await response.json();
			if (!body.success) {
				throw new Error(`ckan package fetch failed: ${body.error?.message ?? 'success false'}`);
			}
			const pkg = body.result;
			const resources = pkg?.resources;
			if (!pkg || !Array.isArray(resources)) {
				throw new Error('ckan package response malformed');
			}

			return resources
				.map((resource) => targetFromResource(resource, pkg, config))
				.filter((target): target is FeedTarget => target !== null);
		},
	};
}
