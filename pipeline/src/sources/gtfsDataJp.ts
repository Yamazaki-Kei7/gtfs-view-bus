import type { FeedDescriptor, FeedSource } from './types';

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

interface FilesResponse {
	code: number;
	body: GtfsFileEntry[];
}

const API_BASE = 'https://api.gtfs-data.jp/v2';

/** GTFSデータリポジトリ(gtfs-data.jp)の県別一覧APIをFeedSourceへ適合させる */
export function createGtfsDataJpSource(prefId: string): FeedSource {
	return {
		sourceId: 'gtfs-data.jp',
		async listFeeds(fetcher) {
			const listRes = await fetcher(`${API_BASE}/files?pref=${prefId}`);
			if (!listRes.ok) throw new Error(`feed list fetch failed: ${listRes.status}`);
			const list = (await listRes.json()) as FilesResponse;
			return list.body.map((entry): FeedDescriptor => ({
				id: `${entry.organization_id}~${entry.feed_id}~${entry.file_from_date}`,
				name: entry.feed_name,
				orgName: entry.organization_name,
				license: entry.feed_license_id,
				fromDate: entry.file_from_date,
				toDate: entry.file_to_date,
				source: 'gtfs-data.jp',
				versionId: entry.file_uid,
				stopsGeojsonUrl: entry.file_stop_url ?? undefined,
				routesGeojsonUrl: entry.file_route_url ?? undefined,
				async fetchZip(f) {
					const zipRes = await f(entry.file_url);
					if (!zipRes.ok) throw new Error(`zip fetch failed: ${zipRes.status}`);
					return new Uint8Array(await zipRes.arrayBuffer());
				},
			}));
		},
	};
}
