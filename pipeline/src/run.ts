import { convertFeed, shapesToGeojson, stopsToGeojson, unzipFeed } from 'gtfs-core';
import type { FeedDescriptor, FeedSource, SourceId } from './sources/types';

/** R2Bucket と構造的に互換な最小インターフェース(テスト差し替え用) */
export interface BucketLike {
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	put(key: string, value: string): Promise<void>;
	list(options: {
		prefix: string;
		cursor?: string;
	}): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
	delete(keys: string[]): Promise<void>;
}

export interface PipelineDeps {
	bucket: BucketLike;
	fetcher: typeof fetch;
	sources: FeedSource[];
}

export interface FeedStatus {
	id: string;
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	source: SourceId;
	status: 'updated' | 'unchanged' | 'error';
	error?: string;
	/** trip の形状ソース内訳(shapes / route / straight)。unchanged 時は meta.json から引き継ぐ */
	shapeSourceCounts?: Record<string, number>;
}

interface FeedsIndex {
	generatedAt: string;
	feeds: FeedStatus[];
}

interface FeedMeta {
	versionId?: string;
	/** 旧形式のキー(fileUid時代)。読み取り時のみ解釈する */
	fileUid?: string;
	shapeSourceCounts?: Record<string, number>;
}

/** R2の一括deleteは1回1000キーまで */
const DELETE_BATCH = 1000;

export async function runPipeline({
	bucket,
	fetcher,
	sources,
}: PipelineDeps): Promise<FeedStatus[]> {
	const prev = await readIndex(bucket);
	const statuses: FeedStatus[] = [];
	let anyListFailed = false;

	for (const source of sources) {
		let descriptors: FeedDescriptor[];
		try {
			descriptors = await source.listFeeds(fetcher);
		} catch (e) {
			// 一覧取得に失敗したソースは前回のエントリをそのまま引き継ぐ(地図からの全消え防止)。
			// 引き継いだエントリの status は前回実行時の値のまま残る点に注意。
			// この実行では掃除もスキップする(全フィードを孤児と誤認した全削除の防止)
			console.error(`source list failed: ${source.sourceId}`, e);
			anyListFailed = true;
			statuses.push(...(prev?.feeds?.filter((f) => f.source === source.sourceId) ?? []));
			continue;
		}
		for (const d of descriptors) {
			statuses.push(await processFeed(bucket, fetcher, d));
		}
	}

	await bucket.put(
		'feeds.json',
		JSON.stringify({ generatedAt: new Date().toISOString(), feeds: statuses }),
	);
	if (!anyListFailed) {
		await cleanupOrphans(bucket, new Set(statuses.map((s) => s.id)));
	}
	return statuses;
}

async function readIndex(bucket: BucketLike): Promise<FeedsIndex | null> {
	const obj = await bucket.get('feeds.json');
	if (!obj) return null;
	try {
		return JSON.parse(await obj.text()) as FeedsIndex;
	} catch {
		return null;
	}
}

async function processFeed(
	bucket: BucketLike,
	fetcher: typeof fetch,
	d: FeedDescriptor,
): Promise<FeedStatus> {
	const base = {
		id: d.id,
		name: d.name,
		orgName: d.orgName,
		license: d.license,
		fromDate: d.fromDate,
		toDate: d.toDate,
		source: d.source,
	};
	try {
		const metaObj = await bucket.get(`feeds/${d.id}/meta.json`);
		const meta = metaObj ? (JSON.parse(await metaObj.text()) as FeedMeta) : null;
		// versionId '' は版数解決に失敗したエラー記述子(ODPT)なので unchanged 扱いにしない
		if (meta && d.versionId !== '' && (meta.versionId ?? meta.fileUid) === d.versionId) {
			return { ...base, status: 'unchanged', shapeSourceCounts: meta.shapeSourceCounts };
		}

		const zip = await d.fetchZip(fetcher);

		// routes.geojson は shapes.txt なしフィードの形状源になるため変換前に取得する。
		// ソースがURLを宣言しているのに取得できない場合は throw してフィード単位のエラーにする:
		// 黙って生成フォールバックすると劣化データ(直線化bundle等)が新versionIdで固定されてしまう
		let routesText: string | null = null;
		if (d.routesGeojsonUrl) {
			const res = await fetcher(d.routesGeojsonUrl);
			if (!res.ok) throw new Error(`routes geojson fetch failed: ${res.status}`);
			routesText = await res.text();
		}

		const files = unzipFeed(zip);
		const bundle = convertFeed(files, routesText ?? undefined);
		await bucket.put(`feeds/${d.id}/bundle.json`, JSON.stringify(bundle));
		await bucket.put(
			`feeds/${d.id}/routes.geojson`,
			routesText ?? JSON.stringify(shapesToGeojson(bundle)),
		);

		let stopsText: string | null = null;
		if (d.stopsGeojsonUrl) {
			const res = await fetcher(d.stopsGeojsonUrl);
			if (!res.ok) throw new Error(`stops geojson fetch failed: ${res.status}`);
			stopsText = await res.text();
		}
		await bucket.put(
			`feeds/${d.id}/stops.geojson`,
			stopsText ?? JSON.stringify(stopsToGeojson(files)),
		);

		// meta.json は必ずこのフィードの最後の書き込みにすること: 更新完了のマーカーであり、
		// 途中でクラッシュしても meta が残らず次回実行時に最初から再処理される(自己修復的な冪等性)。
		// put の順序を入れ替えるとこの保証が静かに壊れる。
		await bucket.put(
			`feeds/${d.id}/meta.json`,
			JSON.stringify({ versionId: d.versionId, shapeSourceCounts: bundle.shapeSourceCounts }),
		);
		return { ...base, status: 'updated', shapeSourceCounts: bundle.shapeSourceCounts };
	} catch (e) {
		return {
			...base,
			status: 'error',
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/** アクティブなフィードIDに属さない feeds/ 配下のキーを削除する */
async function cleanupOrphans(bucket: BucketLike, activeIds: Set<string>): Promise<void> {
	const orphans: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: 'feeds/', cursor });
		for (const obj of page.objects) {
			const feedId = obj.key.split('/')[1];
			if (feedId && !activeIds.has(feedId)) orphans.push(obj.key);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	for (let i = 0; i < orphans.length; i += DELETE_BATCH) {
		await bucket.delete(orphans.slice(i, i + DELETE_BATCH));
	}
}
