import * as cheerio from 'cheerio';
import type { OdptManifestEntry, OdptManifestFile } from './odptManifestTypes';

export interface CatalogPage {
	datasetUrls: string[];
	nextUrl: string | null;
}

export interface DatasetMetadata {
	datasetId: string;
	name: string;
	orgName: string;
	license: string | null;
}

const CATALOG_START_URL = 'https://ckan.odpt.org/dataset/?res_format=GTFS%2FGTFS-JP';
const ODPT_ZIP_PATTERN = /\/files\/odpt\/([^/]+)\/([^/?]+)\.zip/;

function absoluteUrl(href: string, baseUrl: string): string {
	return new URL(href, baseUrl).toString();
}

function resourceFetchUrl(href: string, baseUrl: string): string {
	const url = new URL(href, baseUrl);
	url.searchParams.set('inner_span', 'True');
	return url.toString();
}

function text(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function datasetIdFromUrl(url: string): string {
	const pathname = new URL(url).pathname;
	const id = pathname.split('/').filter(Boolean).at(-1);
	if (!id) throw new Error(`dataset id not found: ${url}`);
	return id;
}

function resourceIdFromHref(href: string): string {
	const parts = new URL(href, 'https://ckan.odpt.org/').pathname.split('/').filter(Boolean);
	return parts.at(-1) ?? '';
}

function isOrganizationLink(href: string | undefined): boolean {
	return href !== undefined && href.startsWith('/organization/') && href !== '/organization/';
}

function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function isGtfsFormat(format: string | undefined, labelText: string): boolean {
	return format?.toLowerCase() === 'gtfs/gtfs-jp' || text(labelText).toLowerCase() === 'gtfs/gtfs-jp';
}

function containsGtfsFormat(value: string): boolean {
	return text(value).toLowerCase().includes('gtfs/gtfs-jp');
}

function isPublicZipUrl(zipUrl: string): boolean {
	return new URL(zipUrl).hostname === 'api-public.odpt.org';
}

function datasetMetadata($: cheerio.CheerioAPI, datasetUrl: string): DatasetMetadata {
	const datasetId = datasetIdFromUrl(datasetUrl);
	const name = text($('h1').first().text()) || datasetId;
	const orgLink = $('a[href^="/organization/"]')
		.toArray()
		.find((link) => isOrganizationLink($(link).attr('href')));
	const orgName = orgLink ? text($(orgLink).text()) : '';
	const licenseText = text($('[property="dc:license"]').first().text());
	return {
		datasetId,
		name,
		orgName,
		license: licenseText || null,
	};
}

function sanitizedZipUrl(zipUrl: string): string {
	const url = new URL(zipUrl);
	url.searchParams.delete('acl:consumerKey');
	return url.toString();
}

function entryFromZipUrl(
	zipUrl: string,
	resourceId: string,
	metadata: DatasetMetadata,
): OdptManifestEntry | null {
	const cleanZipUrl = sanitizedZipUrl(zipUrl);
	if (!isPublicZipUrl(cleanZipUrl)) return null;
	const match = cleanZipUrl.match(ODPT_ZIP_PATTERN);
	if (!match) return null;
	return {
		datasetId: metadata.datasetId,
		resourceId,
		operator: match[1],
		feed: match[2],
		name: metadata.name,
		orgName: metadata.orgName,
		license: metadata.license,
		fromDate: '',
		toDate: '',
		zipUrl: cleanZipUrl,
	};
}

function manifestEntryKey(entry: OdptManifestEntry): string {
	return `${entry.operator}\u0000${entry.feed}`;
}

function isPublicZip(entry: OdptManifestEntry): boolean {
	return new URL(entry.zipUrl).hostname === 'api-public.odpt.org';
}

function preferEntry(current: OdptManifestEntry, candidate: OdptManifestEntry): OdptManifestEntry {
	if (isPublicZip(candidate) && !isPublicZip(current)) return candidate;
	if (!isPublicZip(candidate) && isPublicZip(current)) return current;
	return compareStrings(current.zipUrl, candidate.zipUrl) <= 0 ? current : candidate;
}

function dedupeManifestEntries(entries: OdptManifestEntry[]): OdptManifestEntry[] {
	const byFeed = new Map<string, OdptManifestEntry>();
	for (const entry of entries) {
		const key = manifestEntryKey(entry);
		const current = byFeed.get(key);
		byFeed.set(key, current ? preferEntry(current, entry) : entry);
	}
	return [...byFeed.values()];
}

export function parseCatalogPage(html: string, pageUrl: string): CatalogPage {
	const $ = cheerio.load(html);
	const urls = new Set<string>();

	$('.dataset-item').each((_, item) => {
		const hasGtfs = $(item)
			.find('[data-format], .label')
			.toArray()
			.some((label) => isGtfsFormat($(label).attr('data-format'), $(label).text()));
		const href = $(item).find('.dataset-heading a').attr('href');
		if (hasGtfs && href) urls.add(absoluteUrl(href, pageUrl));
	});

	let nextUrl: string | null = null;
	$('.pagination a').each((_, anchor) => {
		const href = $(anchor).attr('href');
		const label = text($(anchor).text());
		const rel = $(anchor).attr('rel');
		if (href && href !== '#' && (label === '»' || rel === 'next')) {
			nextUrl = absoluteUrl(href, pageUrl);
		}
	});

	return { datasetUrls: [...urls].sort(compareStrings), nextUrl };
}

export function parseDatasetPage(html: string, datasetUrl: string): OdptManifestEntry[] {
	const $ = cheerio.load(html);
	const metadata = datasetMetadata($, datasetUrl);
	const entries: OdptManifestEntry[] = [];

	$('a[href*="/files/odpt/"]').each((_, link) => {
		const href = $(link).attr('href');
		if (!href) return;

		const zipUrl = absoluteUrl(href, datasetUrl);
		const resource = $(link).closest('.resource-item');
		const resourceHref = resource.find('a[href*="/resource/"]').first().attr('href') ?? '';
		const entry = entryFromZipUrl(
			zipUrl,
			resource.attr('data-id') ?? resourceIdFromHref(resourceHref),
			metadata,
		);
		if (entry) entries.push(entry);
	});

	return entries;
}

export function parseDatasetResourceUrls(html: string, datasetUrl: string): string[] {
	const $ = cheerio.load(html);
	const urls = new Set<string>();
	$('.resource-item').each((_, item) => {
		const resource = $(item);
		const hasGtfs = resource
			.find('[data-format], .label')
			.toArray()
			.some((label) => isGtfsFormat($(label).attr('data-format'), $(label).text()));
		if (!hasGtfs && !containsGtfsFormat(resource.text())) return;

		const href = resource.find('a[href*="/resource/"]').first().attr('href');
		if (href) urls.add(resourceFetchUrl(href, datasetUrl));
	});
	return [...urls];
}

export function parseResourcePage(
	html: string,
	resourceUrl: string,
	metadata: DatasetMetadata,
): OdptManifestEntry[] {
	const $ = cheerio.load(html);
	const resourceId = resourceIdFromHref(resourceUrl);
	const entries: OdptManifestEntry[] = [];
	$('a[href*="/files/odpt/"]').each((_, link) => {
		const href = $(link).attr('href');
		if (!href) return;
		const entry = entryFromZipUrl(absoluteUrl(href, resourceUrl), resourceId, metadata);
		if (entry) entries.push(entry);
	});
	return dedupeManifestEntries(entries);
}

export function sortManifestEntries(entries: OdptManifestEntry[]): OdptManifestEntry[] {
	return [...entries].sort((a, b) => {
		const operator = compareStrings(a.operator, b.operator);
		if (operator !== 0) return operator;

		const feed = compareStrings(a.feed, b.feed);
		if (feed !== 0) return feed;

		const datasetId = compareStrings(a.datasetId, b.datasetId);
		if (datasetId !== 0) return datasetId;

		return compareStrings(a.resourceId, b.resourceId);
	});
}

export async function collectOdptManifest(fetcher: typeof fetch, now: Date): Promise<OdptManifestFile> {
	const datasetUrls = new Set<string>();
	let nextUrl: string | null = CATALOG_START_URL;

	while (nextUrl) {
		const res = await fetcher(nextUrl);
		if (!res.ok) throw new Error(`ODPT catalog fetch failed: ${res.status}`);

		const page = parseCatalogPage(await res.text(), nextUrl);
		for (const datasetUrl of page.datasetUrls) datasetUrls.add(datasetUrl);
		nextUrl = page.nextUrl;
	}

	const entries: OdptManifestEntry[] = [];
	for (const datasetUrl of [...datasetUrls].sort(compareStrings)) {
		const res = await fetcher(datasetUrl);
		if (!res.ok) throw new Error(`ODPT dataset fetch failed: ${res.status} ${datasetUrl}`);
		const html = await res.text();
		entries.push(...parseDatasetPage(html, datasetUrl));
		const $ = cheerio.load(html);
		const metadata = datasetMetadata($, datasetUrl);
		for (const resourceUrl of parseDatasetResourceUrls(html, datasetUrl)) {
			const resourceRes = await fetcher(resourceUrl);
			if (!resourceRes.ok) continue;
			const resourceEntries = parseResourcePage(await resourceRes.text(), resourceUrl, metadata);
			if (resourceEntries.length === 0) continue;
			entries.push(...resourceEntries);
			break;
		}
	}

	const feeds = sortManifestEntries(dedupeManifestEntries(entries));
	if (feeds.length === 0) throw new Error('ODPT manifest has no feeds');

	return { generatedAt: now.toISOString(), feeds };
}
