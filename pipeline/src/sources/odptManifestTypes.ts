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
}

export interface OdptManifestFile {
	generatedAt: string;
	feeds: OdptManifestEntry[];
}
