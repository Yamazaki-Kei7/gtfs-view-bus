import { collectOdptManifest } from '../src/sources/odptCkan';
import type { OdptManifestFile } from '../src/sources/odptManifestTypes';

const OUTPUT_PATH = new URL('../src/sources/odptManifest.json', import.meta.url);

interface FileSystemPromises {
	readFile(path: URL, encoding: 'utf8'): Promise<string>;
	writeFile(path: URL, data: string): Promise<void>;
}

interface NodeProcess {
	getBuiltinModule(name: 'node:fs/promises'): FileSystemPromises;
	argv: string[];
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

async function main(): Promise<void> {
	const existing = await readExisting();
	const manifest = await collectOdptManifest(fetch, new Date());
	if (manifest.feeds.length === 0) {
		throw new Error('ODPT manifest update produced zero feeds');
	}
	// 件数減はHTML構造変化による抽出漏れの兆候として既定で拒否する。
	// 意図した削減(データセット廃止など)は --force で上書きする。
	if (
		existing &&
		manifest.feeds.length < existing.feeds.length &&
		!process.argv.includes('--force')
	) {
		throw new Error(
			`ODPT manifest shrank from ${existing.feeds.length} to ${manifest.feeds.length}; rerun with --force to accept`,
		);
	}

	await writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, '\t')}\n`);
	console.log(`updated ${OUTPUT_PATH.pathname}: ${manifest.feeds.length} feeds`);
}

await main();
