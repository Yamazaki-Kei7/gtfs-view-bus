import type { FeedSource, FeedTarget } from './types';

export interface GtfsFileEntry {
	organization_id: string;
	organization_name: string;
	feed_id: string;
	feed_name: string;
	feed_license_id: string | null;
	file_uid: string;
	file_from_date: string;
	file_to_date: string;
	file_url: string;
	file_stop_url: string | null;
	file_route_url: string | null;
	file_last_updated_at: string;
}

export interface GtfsDataJpSourceOptions {
	prefIds?: number[];
}

interface FilesResponse {
	code: number;
	body: GtfsFileEntry[];
}

const API_BASE = 'https://api.gtfs-data.jp/v2';

function filesUrl(prefId?: number): string {
	return prefId === undefined ? `${API_BASE}/files` : `${API_BASE}/files?pref=${prefId}`;
}

async function fetchEntries(fetcher: typeof fetch, url: string): Promise<GtfsFileEntry[]> {
	const listRes = await fetcher(url);
	if (!listRes.ok) throw new Error(`feed list fetch failed: ${listRes.status}`);
	const list = (await listRes.json()) as FilesResponse;
	if (!Array.isArray(list.body)) throw new Error('feed list response malformed');
	return list.body;
}

function toTarget(entry: GtfsFileEntry): FeedTarget {
	return {
		id: `${entry.organization_id}~${entry.feed_id}~${entry.file_from_date}`,
		name: entry.feed_name,
		orgName: entry.organization_name,
		license: entry.feed_license_id,
		fromDate: entry.file_from_date,
		toDate: entry.file_to_date,
		source: 'gtfs-data.jp',
		versionId: entry.file_uid,
		zipUrl: entry.file_url,
		routesGeojsonUrl: entry.file_route_url ?? undefined,
	};
}

/** GTFSデータリポジトリ(gtfs-data.jp)の一覧APIをFeedSourceへ適合させる */
export function createGtfsDataJpSource(options: GtfsDataJpSourceOptions = {}): FeedSource {
	return {
		sourceId: 'gtfs-data.jp',
		async listTargets(fetcher) {
			const prefIds = options.prefIds;
			const urls = prefIds && prefIds.length > 0 ? prefIds.map(filesUrl) : [filesUrl()];
			const entries: GtfsFileEntry[] = [];
			for (const url of urls) {
				entries.push(...(await fetchEntries(fetcher, url)));
			}
			return entries.map(toTarget);
		},
	};
}
