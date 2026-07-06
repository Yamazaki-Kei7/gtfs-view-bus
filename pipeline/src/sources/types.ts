/** フィードの取得元レジストリ */
export type SourceId = 'gtfs-data.jp' | 'odpt';

/** ソース非依存のフィード記述子。メインループはこれだけを見て処理する */
export interface FeedDescriptor {
	/** R2キー用の一意ID */
	id: string;
	/** フィード名(フッター表示用) */
	name: string;
	orgName: string;
	license: string | null;
	/** fromDate/toDate はODPTでは提供されないため空文字(アプリ未使用) */
	fromDate: string;
	toDate: string;
	source: SourceId;
	/** 差分検出キー。前回metaと一致すれば再処理をスキップする */
	versionId: string;
	fetchZip(fetcher: typeof fetch): Promise<Uint8Array>;
	/** ソースがルート形状のGeoJSONを別配布している場合のみ設定。無ければGTFSのshapesから生成する */
	routesGeojsonUrl?: string;
}

export interface FeedSource {
	sourceId: SourceId;
	listFeeds(fetcher: typeof fetch): Promise<FeedDescriptor[]>;
}
