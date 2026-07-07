import { collectOdptManifest } from '../src/sources/odptCkan';
import type { OdptManifestFile } from '../src/sources/odptManifestTypes';

const OUTPUT_PATH = new URL('../src/sources/odptManifest.json', import.meta.url);

interface FileSystemPromises {
	readFile(path: URL, encoding: 'utf8'): Promise<string>;
	writeFile(path: URL, data: string): Promise<void>;
}

interface NodeProcess {
	getBuiltinModule(name: 'node:fs/promises'): FileSystemPromises;
}

declare const process: NodeProcess;

const { readFile, writeFile } = process.getBuiltinModule('node:fs/promises');

function isMissingFile(error: object): boolean {
	return 'code' in error && error.code === 'ENOENT';
}

async function readExisting(): Promise<OdptManifestFile | null> {
	try {
		return JSON.parse(await readFile(OUTPUT_PATH, 'utf8')) as OdptManifestFile;
	} catch (error) {
		if (error && typeof error === 'object' && isMissingFile(error)) return null;
		throw error;
	}
}

function feedKey(feed: OdptManifestFile['feeds'][number]): string {
	return `${feed.operator}\u0000${feed.feed}`;
}

function hasDuplicateFeedKeys(manifest: OdptManifestFile): boolean {
	const seen = new Set<string>();
	for (const feed of manifest.feeds) {
		const key = feedKey(feed);
		if (seen.has(key)) return true;
		seen.add(key);
	}
	return false;
}

function hasPrivateZipUrls(manifest: OdptManifestFile): boolean {
	return manifest.feeds.some((feed) => new URL(feed.zipUrl).hostname !== 'api-public.odpt.org');
}

async function main(): Promise<void> {
	const existing = await readExisting();
	const manifest = await collectOdptManifest(fetch, new Date());
	if (manifest.feeds.length === 0) {
		throw new Error('ODPT manifest update produced zero feeds');
	}
	if (
		existing &&
		manifest.feeds.length < existing.feeds.length &&
		!hasDuplicateFeedKeys(existing) &&
		!hasPrivateZipUrls(existing)
	) {
		throw new Error(
			`ODPT manifest shrank from ${existing.feeds.length} to ${manifest.feeds.length}; keep existing file`,
		);
	}

	await writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, '\t')}\n`);
	console.log(`updated ${OUTPUT_PATH.pathname}: ${manifest.feeds.length} feeds`);
}

await main();
