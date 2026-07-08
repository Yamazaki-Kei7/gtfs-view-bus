/** フィードの取得元レジストリ */
export type SourceId = 'gtfs-data.jp' | 'odpt' | 'hoda';

/** QueueメッセージとR2 manifestに保存できる、関数を持たないフィード処理対象 */
export interface FeedTarget {
	/** R2キー用の一意ID */
	id: string;
	/** フィード名(フッター表示用) */
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	source: SourceId;
	/** 差分検出キー。前回metaと一致すれば再処理をスキップする */
	versionId: string;
	/** GTFS zip本体の取得URL */
	zipUrl: string;
	/** ソースがルート形状のGeoJSONを別配布している場合のみ設定 */
	routesGeojsonUrl?: string;
	/** JIS 都道府県コード(1〜47)。未解決は null / 未設定。ソースが権威値を持つ場合に設定する */
	prefId?: number | null;
}

export interface FeedSource {
	sourceId: SourceId;
	listTargets(fetcher: typeof fetch): Promise<FeedTarget[]>;
}
