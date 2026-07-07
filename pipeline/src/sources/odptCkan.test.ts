import { describe, expect, it } from 'vitest';
import {
	parseCatalogPage,
	parseDatasetPage,
	parseDatasetResourceUrls,
	parseResourcePage,
	sortManifestEntries,
} from './odptCkan';

interface NodeFileSystem {
	readFileSync(path: URL, encoding: 'utf8'): string;
}

interface NodeProcess {
	getBuiltinModule(name: 'node:fs'): NodeFileSystem;
}

declare const process: NodeProcess;

const { readFileSync } = process.getBuiltinModule('node:fs');
const catalogHtml = readFileSync(new URL('./fixtures/odpt-catalog-page.html', import.meta.url), 'utf8');
const datasetHtml = readFileSync(new URL('./fixtures/odpt-dataset-page.html', import.meta.url), 'utf8');
const resourceHtml = readFileSync(new URL('./fixtures/odpt-resource-page.html', import.meta.url), 'utf8');

describe('odptCkan parser', () => {
	it('catalogページからdataset URLとnext URLを抽出する', () => {
		const page = parseCatalogPage(catalogHtml, 'https://ckan.odpt.org/dataset/?res_format=GTFS%2FGTFS-JP');
		expect(page.datasetUrls).toEqual(['https://ckan.odpt.org/dataset/takasaki_city_yosiibus']);
		expect(page.nextUrl).toBe('https://ckan.odpt.org/dataset/?res_format=GTFS%2FGTFS-JP&page=2');
	});

	it('datasetページからmanifest entryを抽出する', () => {
		const entries = parseDatasetPage(
			datasetHtml,
			'https://ckan.odpt.org/dataset/takasaki_city_yosiibus',
		);
		expect(entries).toEqual([
			{
				datasetId: 'takasaki_city_yosiibus',
				resourceId: 'res-yosii',
				operator: 'TakasakiCity',
				feed: 'yosiibus',
				name: 'よしいバス',
				orgName: '高崎市',
				license: 'CC BY 4.0',
				fromDate: '',
				toDate: '',
				zipUrl:
					'https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=current',
			},
		]);
	});

	it('datasetページからresource URLを抽出し、resourceページからmanifest entryを抽出する', () => {
		const datasetUrl = 'https://ckan.odpt.org/dataset/takasaki_city_yosiibus';
		const resourceUrls = parseDatasetResourceUrls(datasetHtml, datasetUrl);
		expect(resourceUrls).toEqual([
			'https://ckan.odpt.org/dataset/takasaki_city_yosiibus/resource/res-yosii?inner_span=True',
		]);

		const entries = parseResourcePage(
			resourceHtml,
			resourceUrls[0],
			{
				datasetId: 'takasaki_city_yosiibus',
				name: 'よしいバス',
				orgName: '高崎市',
				license: 'CC BY 4.0',
			},
		);
		expect(entries).toEqual([
			{
				datasetId: 'takasaki_city_yosiibus',
				resourceId: 'res-yosii',
				operator: 'TakasakiCity',
				feed: 'yosiibus',
				name: 'よしいバス',
				orgName: '高崎市',
				license: 'CC BY 4.0',
				fromDate: '',
				toDate: '',
				zipUrl:
					'https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=20260421',
			},
		]);
	});

	it('resourceページの認証トークンプレースホルダをzip URLから除去する', () => {
		const entries = parseResourcePage(
			'<a href="https://api.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=20260421&amp;acl:consumerKey=[アクセストークン/YOUR_ACCESS_TOKEN]">download</a>',
			'https://ckan.odpt.org/dataset/takasaki_city_yosiibus/resource/res-yosii?inner_span=True',
			{
				datasetId: 'takasaki_city_yosiibus',
				name: 'よしいバス',
				orgName: '高崎市',
				license: 'CC BY 4.0',
			},
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].zipUrl).toBe(
			'https://api.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=20260421',
		);
	});

	it('operator/feed順で安定ソートする', () => {
		const sorted = sortManifestEntries([
			{
				datasetId: 'b',
				resourceId: '2',
				operator: 'B',
				feed: 'AllLines',
				name: 'b',
				orgName: 'b',
				license: null,
				fromDate: '',
				toDate: '',
				zipUrl: 'https://api-public.odpt.org/api/v4/files/odpt/B/AllLines.zip?date=current',
			},
			{
				datasetId: 'a',
				resourceId: '1',
				operator: 'A',
				feed: 'AllLines',
				name: 'a',
				orgName: 'a',
				license: null,
				fromDate: '',
				toDate: '',
				zipUrl: 'https://api-public.odpt.org/api/v4/files/odpt/A/AllLines.zip?date=current',
			},
		]);
		expect(sorted.map((entry) => entry.operator)).toEqual(['A', 'B']);
	});
});
