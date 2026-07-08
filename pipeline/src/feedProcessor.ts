import {
	buildTimetableIndex,
	centroidOf,
	convertFeed,
	shapesToGeojson,
	stopRouteIds,
	stopsToGeojson,
	unzipFeed,
} from 'gtfs-core';
import { resolvePrefId } from 'gtfs-core/prefectureGeometry';
import type { FeedStatus } from './jobState';
import type { BucketLike } from './storage';
import type { FeedTarget } from './sources/types';

interface FeedMeta {
	versionId?: string;
	/** 旧形式のキー(fileUid時代)。読み取り時のみ解釈する */
	fileUid?: string;
	/** 生成物の出力スキーマ版。無い(旧meta)場合は 0 とみなす */
	schemaVersion?: number;
	shapeSourceCounts?: Record<string, number>;
	prefId?: number | null;
}

interface FeedArtifacts {
	bundleJson: string;
	routesGeojson: string;
	stopsGeojson: string;
	timetableJson: string;
	metaJson: string;
	shapeSourceCounts: Record<string, number>;
	prefId: number | null;
}

export interface ProcessFeedTargetDeps {
	bucket: BucketLike;
	fetcher: typeof fetch;
	target: FeedTarget;
}

/** 生成物(bundle.json / stops.geojson など)の出力スキーマ版。出力フォーマットを変えたら上げる。
 * versionId が同じ(=ソースのGTFSは無変更)でも meta のスキーマ版が古ければ再処理し、
 * 既存フィードを新フォーマットへ移行させる。version 2 で停留所に routeIds を付与した。
 * version 3 で shapes.txt の明らかな外れ値座標を除外する。
 * version 4 で停留所別時刻表(timetable.json)を追加する。 */
const OUTPUT_SCHEMA_VERSION = 4;

function statusBase(target: FeedTarget): Omit<FeedStatus, 'status'> {
	return {
		id: target.id,
		name: target.name,
		orgName: target.orgName,
		license: target.license,
		fromDate: target.fromDate,
		toDate: target.toDate,
		source: target.source,
	};
}

async function fetchBytes(fetcher: typeof fetch, url: string): Promise<Uint8Array> {
	const res = await fetcher(url);
	if (!res.ok) throw new Error(`zip fetch failed: ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

async function fetchRoutesGeojson(fetcher: typeof fetch, url: string): Promise<string> {
	const res = await fetcher(url);
	if (!res.ok) throw new Error(`routes geojson fetch failed: ${res.status}`);
	return res.text();
}

async function buildFeedArtifacts(
	fetcher: typeof fetch,
	target: FeedTarget,
): Promise<FeedArtifacts> {
	const zip = await fetchBytes(fetcher, target.zipUrl);

	// routes.geojson は shapes.txt なしフィードの形状源になるため変換前に取得する。
	// ソースがURLを宣言しているのに取得できない場合はフィード単位のエラーにする。
	const routesText = target.routesGeojsonUrl
		? await fetchRoutesGeojson(fetcher, target.routesGeojsonUrl)
		: null;

	const files = unzipFeed(zip);
	const bundle = convertFeed(files, routesText ?? undefined);
	const stops = stopsToGeojson(files, stopRouteIds(files));
	const centroid = centroidOf(stops.features.map((f) => f.geometry.coordinates));
	const prefId = target.prefId ?? (centroid ? resolvePrefId(centroid[0], centroid[1]) : null);
	return {
		bundleJson: JSON.stringify(bundle),
		routesGeojson: routesText ?? JSON.stringify(shapesToGeojson(bundle)),
		stopsGeojson: JSON.stringify(stops),
		timetableJson: JSON.stringify(buildTimetableIndex(files)),
		metaJson: JSON.stringify({
			versionId: target.versionId,
			schemaVersion: OUTPUT_SCHEMA_VERSION,
			shapeSourceCounts: bundle.shapeSourceCounts,
			prefId,
		}),
		shapeSourceCounts: bundle.shapeSourceCounts,
		prefId,
	};
}

export async function processFeedTarget({
	bucket,
	fetcher,
	target,
}: ProcessFeedTargetDeps): Promise<FeedStatus> {
	const base = statusBase(target);
	const metaObj = await bucket.get(`feeds/${target.id}/meta.json`);
	const metaText = metaObj ? await metaObj.text() : null;
	let artifacts: FeedArtifacts;
	try {
		const meta = metaText ? (JSON.parse(metaText) as FeedMeta) : null;
		// versionId '' は版数解決に失敗したエラー記述子(ODPT)なので unchanged 扱いにしない。
		// versionId が一致していても出力スキーマ版が古ければ再処理する(既存フィードの移行)。
		// prefId が権威値(target)でも計算済み(meta、null含む)でも得られない場合は、
		// prefId導入前の旧metaなので一度再処理して停留所重心から解決する(unchangedスキップ
		// するとどの県にも属さず不可視になる)。再処理後のmetaにはprefIdキーが必ず入る
		if (
			meta &&
			target.versionId !== '' &&
			(meta.versionId ?? meta.fileUid) === target.versionId &&
			(meta.schemaVersion ?? 0) >= OUTPUT_SCHEMA_VERSION &&
			(target.prefId ?? meta.prefId) !== undefined
		) {
			return {
				...base,
				status: 'unchanged',
				prefId: target.prefId ?? meta.prefId ?? null,
				shapeSourceCounts: meta.shapeSourceCounts,
			};
		}

		artifacts = await buildFeedArtifacts(fetcher, target);
	} catch (error) {
		return {
			...base,
			status: 'error',
			prefId: target.prefId ?? null,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	await bucket.put(`feeds/${target.id}/bundle.json`, artifacts.bundleJson);
	await bucket.put(`feeds/${target.id}/routes.geojson`, artifacts.routesGeojson);

	// 停留所レイヤは常に stops.txt から生成し、各停留所に routeIds(通る路線)を付与する。
	await bucket.put(`feeds/${target.id}/stops.geojson`, artifacts.stopsGeojson);

	// 停留所別の時刻表インデックス。アプリは停留所クリック時に遅延ロードする。
	await bucket.put(`feeds/${target.id}/timetable.json`, artifacts.timetableJson);

	// meta.json はこのフィードの最後の書き込みにし、更新完了マーカーとして扱う。
	await bucket.put(`feeds/${target.id}/meta.json`, artifacts.metaJson);
	return {
		...base,
		status: 'updated',
		prefId: artifacts.prefId,
		shapeSourceCounts: artifacts.shapeSourceCounts,
	};
}
