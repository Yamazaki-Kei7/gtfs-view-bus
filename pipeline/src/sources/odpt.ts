import manifestJson from './odptManifest.json';
import type { OdptManifestEntry, OdptManifestFile } from './odptManifestTypes';
import type { FeedSource, FeedTarget } from './types';

const ODPT_MANIFEST = manifestJson as OdptManifestFile;

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function resolveVersion(fetcher: typeof fetch, entry: OdptManifestEntry): Promise<string> {
	const res = await fetcher(entry.zipUrl, { redirect: 'manual' });
	if (res.status >= 300 && res.status < 400) {
		const loc = res.headers.get('location');
		if (!loc) throw new Error(`redirect without location: ${entry.operator}/${entry.feed}`);
		return new URL(loc, entry.zipUrl).pathname;
	}
	if (res.ok) {
		return sha256Hex(new Uint8Array(await res.arrayBuffer()));
	}
	throw new Error(`odpt zip fetch failed: ${res.status} (${entry.operator}/${entry.feed})`);
}

function targetBase(entry: OdptManifestEntry): Omit<FeedTarget, 'versionId'> {
	return {
		id: `odpt~${entry.operator}~${entry.feed}`,
		name: entry.name,
		orgName: entry.orgName,
		license: entry.license,
		fromDate: entry.fromDate,
		toDate: entry.toDate,
		source: 'odpt',
		zipUrl: entry.zipUrl,
	};
}

/** 公共交通オープンデータセンター(ODPT)の静的マニフェストをFeedSourceへ適合させる */
export function createOdptSource(manifest: OdptManifestFile = ODPT_MANIFEST): FeedSource {
	return {
		sourceId: 'odpt',
		async listTargets(fetcher) {
			const targets: FeedTarget[] = [];
			for (const entry of manifest.feeds) {
				const base = targetBase(entry);
				try {
					targets.push({ ...base, versionId: await resolveVersion(fetcher, entry) });
				} catch {
					targets.push({ ...base, versionId: '' });
				}
			}
			return targets;
		},
	};
}
