import { convertFeed, unzipFeed } from 'gtfs-core';

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

/** R2Bucket と構造的に互換な最小インターフェース(テスト差し替え用) */
export interface BucketLike {
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	put(key: string, value: string): Promise<void>;
}

export interface PipelineDeps {
	bucket: BucketLike;
	fetcher: typeof fetch;
	prefId: string;
}

export interface FeedStatus {
	id: string;
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	status: 'updated' | 'unchanged' | 'error';
	error?: string;
	/** trip の形状ソース内訳(shapes / route / straight)。updated 時のみ */
	shapeSourceCounts?: Record<string, number>;
}

const API_BASE = 'https://api.gtfs-data.jp/v2';

export async function runPipeline({
	bucket,
	fetcher,
	prefId,
}: PipelineDeps): Promise<FeedStatus[]> {
	const listRes = await fetcher(`${API_BASE}/files?pref=${prefId}`);
	if (!listRes.ok) throw new Error(`feed list fetch failed: ${listRes.status}`);
	const list = (await listRes.json()) as FilesResponse;

	const statuses: FeedStatus[] = [];
	for (const entry of list.body) {
		const id = `${entry.organization_id}~${entry.feed_id}~${entry.file_from_date}`;
		const base = {
			id,
			name: entry.feed_name,
			orgName: entry.organization_name,
			license: entry.feed_license_id,
			fromDate: entry.file_from_date,
			toDate: entry.file_to_date,
		};
		try {
			const metaObj = await bucket.get(`feeds/${id}/meta.json`);
			const meta = metaObj ? (JSON.parse(await metaObj.text()) as { fileUid: string }) : null;
			if (meta && meta.fileUid === entry.file_uid) {
				statuses.push({ ...base, status: 'unchanged' });
				continue;
			}

			const zipRes = await fetcher(entry.file_url);
			if (!zipRes.ok) throw new Error(`zip fetch failed: ${zipRes.status}`);

			// routes.geojson は shapes.txt なしフィードの形状源になるため変換前に取得する
			let routesText: string | null = null;
			if (entry.file_route_url) {
				const res = await fetcher(entry.file_route_url);
				if (res.ok) routesText = await res.text();
			}

			const bundle = convertFeed(
				unzipFeed(new Uint8Array(await zipRes.arrayBuffer())),
				routesText ?? undefined,
			);
			await bucket.put(`feeds/${id}/bundle.json`, JSON.stringify(bundle));
			if (routesText) await bucket.put(`feeds/${id}/routes.geojson`, routesText);
			if (entry.file_stop_url) {
				const res = await fetcher(entry.file_stop_url);
				if (res.ok) await bucket.put(`feeds/${id}/stops.geojson`, await res.text());
			}

			await bucket.put(
				`feeds/${id}/meta.json`,
				JSON.stringify({ fileUid: entry.file_uid, lastUpdatedAt: entry.file_last_updated_at }),
			);
			statuses.push({ ...base, status: 'updated', shapeSourceCounts: bundle.shapeSourceCounts });
		} catch (e) {
			statuses.push({
				...base,
				status: 'error',
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	await bucket.put(
		'feeds.json',
		JSON.stringify({ generatedAt: new Date().toISOString(), feeds: statuses }),
	);
	return statuses;
}
