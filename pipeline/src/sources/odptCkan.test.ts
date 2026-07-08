import { describe, expect, it } from 'vitest';
import {
	odptEntryMode,
	parseCatalogPage,
	parseDatasetPage,
	parseDatasetResourceUrls,
	parseResourcePage,
	sortManifestEntries,
} from './odptCkan';
import type { OdptManifestEntry } from './odptManifestTypes';

interface NodeFileSystem {
	readFileSync(path: URL, encoding: 'utf8'): string;
}

interface NodeProcess {
	getBuiltinModule(name: 'node:fs'): NodeFileSystem;
}

declare const process: NodeProcess;

const { readFileSync } = process.getBuiltinModule('node:fs');
const catalogHtml = readFileSync(
	new URL('./fixtures/odpt-catalog-page.html', import.meta.url),
	'utf8',
);
const datasetHtml = readFileSync(
	new URL('./fixtures/odpt-dataset-page.html', import.meta.url),
	'utf8',
);
const resourceHtml = readFileSync(
	new URL('./fixtures/odpt-resource-page.html', import.meta.url),
	'utf8',
);

describe('odptCkan parser', () => {
	it('catalogページからdataset URLとnext URLを抽出する', () => {
		const page = parseCatalogPage(
			catalogHtml,
			'https://ckan.odpt.org/dataset/?res_format=GTFS%2FGTFS-JP',
		);
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

		const entries = parseResourcePage(resourceHtml, resourceUrls[0], {
			datasetId: 'takasaki_city_yosiibus',
			name: 'よしいバス',
			orgName: '高崎市',
			license: 'CC BY 4.0',
		});
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

	it('resource URLはGTFS/GTFS-JPに絞ってDOM順を維持する', () => {
		const resourceUrls = parseDatasetResourceUrls(
			`
				<li class="resource-item">
					<a class="heading" href="/dataset/example/resource/gtfs-z">GTFS/GTFS-JP</a>
				</li>
				<li class="resource-item">
					<a class="heading" href="/dataset/example/resource/rt-a">GTFS-RT</a>
				</li>
				<li class="resource-item">
					<a class="heading" href="/dataset/example/resource/gtfs-a">GTFS/GTFS-JP</a>
				</li>
			`,
			'https://ckan.odpt.org/dataset/example',
		);
		expect(resourceUrls).toEqual([
			'https://ckan.odpt.org/dataset/example/resource/gtfs-z?inner_span=True',
			'https://ckan.odpt.org/dataset/example/resource/gtfs-a?inner_span=True',
		]);
	});

	it('認証トークンが必要なzip URLはrequiresKey付きentryにし、プレースホルダキーを除去する', () => {
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
				zipUrl: 'https://api.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=20260421',
				requiresKey: true,
			},
		]);
	});

	it('/files/<Operator>/data/ 形式のzip URLからoperatorとfeedを導出する(都営バス等)', () => {
		const entries = parseResourcePage(
			'<a href="https://api-public.odpt.org/api/v4/files/Toei/data/ToeiBus-GTFS.zip">download</a>',
			'https://ckan.odpt.org/dataset/b_bus_gtfs_jp-toei/resource/res-toei?inner_span=True',
			{
				datasetId: 'b_bus_gtfs_jp-toei',
				name: '都営バス',
				orgName: '東京都交通局',
				license: 'CC BY 4.0',
			},
		);
		expect(entries).toEqual([
			{
				datasetId: 'b_bus_gtfs_jp-toei',
				resourceId: 'res-toei',
				operator: 'Toei',
				feed: 'ToeiBus-GTFS',
				name: '都営バス',
				orgName: '東京都交通局',
				license: 'CC BY 4.0',
				fromDate: '',
				toDate: '',
				zipUrl: 'https://api-public.odpt.org/api/v4/files/Toei/data/ToeiBus-GTFS.zip',
			},
		]);
	});

	it('日本語ファイル名のzipはfeedをデコードして導出する', () => {
		const entries = parseResourcePage(
			'<a href="https://api-public.odpt.org/api/v4/files/ShodoshimaTown/data/gtfs-町営バス三都西線2022v01.zip">download</a>',
			'https://ckan.odpt.org/dataset/x/resource/res-shodo?inner_span=True',
			{ datasetId: 'x', name: '小豆島町営バス', orgName: '小豆島町', license: null },
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].operator).toBe('ShodoshimaTown');
		expect(entries[0].feed).toBe('gtfs-町営バス三都西線2022v01');
	});

	it('api-challenge.odpt.org(Challenge限定配布)はentryにしない', () => {
		const entries = parseResourcePage(
			'<a href="https://api-challenge.odpt.org/api/v4/files/Keio/data/Keio-Train-GTFS.zip?acl:consumerKey=[Access_Token_for_Challenge2026]">download</a>',
			'https://ckan.odpt.org/dataset/keio_train/resource/res-keio?inner_span=True',
			{ datasetId: 'keio_train', name: '京王電鉄', orgName: '京王電鉄', license: null },
		);
		expect(entries).toEqual([]);
	});

	it('同一operator~feedでpublicとキー必要が両方あればpublicを優先する', () => {
		const entries = parseResourcePage(
			`
				<a href="https://api.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=20260421&amp;acl:consumerKey=[TOKEN]">keyed</a>
				<a href="https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=20260421">public</a>
			`,
			'https://ckan.odpt.org/dataset/takasaki_city_yosiibus/resource/res-yosii?inner_span=True',
			{ datasetId: 'takasaki_city_yosiibus', name: 'よしいバス', orgName: '高崎市', license: null },
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].requiresKey).toBeUndefined();
		expect(new URL(entries[0].zipUrl).hostname).toBe('api-public.odpt.org');
	});

	it('odptEntryModeで鉄道・フェリーを判別しバスを既定にする(バス表記は他キーワードより優先)', () => {
		const entry = (over: Partial<OdptManifestEntry>): OdptManifestEntry => ({
			datasetId: 'x',
			resourceId: 'r',
			operator: 'Op',
			feed: 'AllLines',
			name: 'x',
			orgName: 'org',
			license: null,
			fromDate: '',
			toDate: '',
			zipUrl: 'https://api-public.odpt.org/api/v4/files/odpt/Op/AllLines.zip',
			...over,
		});
		// バス(既定・バス表記優先)
		expect(odptEntryMode(entry({ name: '秋葉バス' }))).toBe('bus');
		// 船木鉄道は「鉄道」を社名に含むバス事業者(datasetIdのbusが勝つ)
		expect(
			odptEntryMode(entry({ datasetId: 'sentetsu_bus_all_lines', name: '船木鉄道株式会社' })),
		).toBe('bus');
		expect(
			odptEntryMode(
				entry({ operator: 'KyotoMunicipalTransportation', feed: 'Kyoto_City_Bus_GTFS' }),
			),
		).toBe('bus');
		// 鉄道
		expect(odptEntryMode(entry({ datasetId: 'train-toei', name: '都営地下鉄' }))).toBe('train');
		expect(
			odptEntryMode(
				entry({ operator: 'KyotoMunicipalTransportation', feed: 'Kyoto_City_Subway_GTFS' }),
			),
		).toBe('train');
		expect(odptEntryMode(entry({ datasetId: 'jrfreight_container', name: 'JR貨物' }))).toBe(
			'train',
		);
		expect(
			odptEntryMode(entry({ operator: 'TamaMonorail', feed: 'TamaMonorail-Train-GTFS' })),
		).toBe('train');
		// フェリー(英名・和名キーワード)
		expect(
			odptEntryMode(
				entry({ operator: 'UwajimaUnyu', name: '宇和島運輸株式会社 / Uwajima Unyu Ferries' }),
			),
		).toBe('ferry');
		expect(odptEntryMode(entry({ name: '三和商船株式会社' }))).toBe('ferry');
		expect(odptEntryMode(entry({ operator: 'TokaiKisen', name: '東海汽船' }))).toBe('ferry');
		expect(
			odptEntryMode(
				entry({ operator: 'KagoshimaCityMaritimeBureau', name: '桜島フェリー定期航路' }),
			),
		).toBe('ferry');
		expect(odptEntryMode(entry({ operator: 'TaneyakuKousokusen', name: '種子屋久高速船' }))).toBe(
			'ferry',
		);
		expect(odptEntryMode(entry({ operator: 'ShimizuCruise', name: '清水クルーズ' }))).toBe('ferry');
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
