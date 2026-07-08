export interface OdptManifestEntry {
	datasetId: string;
	resourceId: string;
	operator: string;
	feed: string;
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	zipUrl: string;
	/** 任意。手動で県を上書きする場合のみ設定(通常はconsumerが停留所重心で解決) */
	prefId?: number | null;
	/** api.odpt.org 配布(取得に acl:consumerKey が必要)。public 配布は未設定 */
	requiresKey?: boolean;
}

export interface OdptManifestFile {
	generatedAt: string;
	feeds: OdptManifestEntry[];
}
