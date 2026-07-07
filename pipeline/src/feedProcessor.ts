import {
	buildTimetableIndex,
	convertFeed,
	shapesToGeojson,
	stopRouteIds,
	stopsToGeojson,
	unzipFeed,
} from 'gtfs-core';
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

export async function processFeedTarget({
	bucket,
	fetcher,
	target,
}: ProcessFeedTargetDeps): Promise<FeedStatus> {
	const base = statusBase(target);
	try {
		const metaObj = await bucket.get(`feeds/${target.id}/meta.json`);
		const meta = metaObj ? (JSON.parse(await metaObj.text()) as FeedMeta) : null;
		// versionId '' は版数解決に失敗したエラー記述子(ODPT)なので unchanged 扱いにしない。
		// versionId が一致していても出力スキーマ版が古ければ再処理する(既存フィードの移行)
		if (
			meta &&
			target.versionId !== '' &&
			(meta.versionId ?? meta.fileUid) === target.versionId &&
			(meta.schemaVersion ?? 0) >= OUTPUT_SCHEMA_VERSION
		) {
			return { ...base, status: 'unchanged', shapeSourceCounts: meta.shapeSourceCounts };
		}

		const zip = await fetchBytes(fetcher, target.zipUrl);

		// routes.geojson は shapes.txt なしフィードの形状源になるため変換前に取得する。
		// ソースがURLを宣言しているのに取得できない場合はフィード単位のエラーにする。
		const routesText = target.routesGeojsonUrl
			? await fetchRoutesGeojson(fetcher, target.routesGeojsonUrl)
			: null;

		const files = unzipFeed(zip);
		const bundle = convertFeed(files, routesText ?? undefined);
		await bucket.put(`feeds/${target.id}/bundle.json`, JSON.stringify(bundle));
		await bucket.put(
			`feeds/${target.id}/routes.geojson`,
			routesText ?? JSON.stringify(shapesToGeojson(bundle)),
		);

		// 停留所レイヤは常に stops.txt から生成し、各停留所に routeIds(通る路線)を付与する。
		await bucket.put(
			`feeds/${target.id}/stops.geojson`,
			JSON.stringify(stopsToGeojson(files, stopRouteIds(files))),
		);

		// 停留所別の時刻表インデックス。アプリは停留所クリック時に遅延ロードする。
		await bucket.put(
			`feeds/${target.id}/timetable.json`,
			JSON.stringify(buildTimetableIndex(files)),
		);

		// meta.json はこのフィードの最後の書き込みにし、更新完了マーカーとして扱う。
		await bucket.put(
			`feeds/${target.id}/meta.json`,
			JSON.stringify({
				versionId: target.versionId,
				schemaVersion: OUTPUT_SCHEMA_VERSION,
				shapeSourceCounts: bundle.shapeSourceCounts,
			}),
		);
		return { ...base, status: 'updated', shapeSourceCounts: bundle.shapeSourceCounts };
	} catch (error) {
		return {
			...base,
			status: 'error',
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
