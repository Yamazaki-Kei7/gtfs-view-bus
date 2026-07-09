import { describe, expect, it } from 'vitest';
import { createCkanPackageSource } from './ckanPackage';

const HODA_RESPONSE = {
	success: true,
	result: {
		title: '公共交通GTFSデータ(Public Transport GTFS Data)',
		license_title: 'クリエイティブ・コモンズ 表示',
		organization: { title: '地方創生モビリティコンソーシアム' },
		resources: [
			{
				id: 'c84abf64-f7ba-4d22-8cc1-acac7adbdc6f',
				name: '網走バス(Abashiri Bus)',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'active',
				url: 'https://ckan.hoda.jp/dataset/24/resource/c84abf64-f7ba-4d22-8cc1-acac7adbdc6f/download/abashiri_bus.zip',
				last_modified: '2026-07-01T00:00:06.572591',
				revision_id: 'rev-bus',
				size: 410309,
			},
			{
				id: '16a31295-1709-4e5e-abcf-fa17ae7853b7',
				name: '青函フェリー(Seikan Ferry)',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'active',
				url: 'https://ckan.hoda.jp/dataset/24/resource/16a31295-1709-4e5e-abcf-fa17ae7853b7/download/seikan_ferry.zip',
				last_modified: '2021-03-23T04:12:48.131468',
				revision_id: 'rev-ferry',
				size: 5328,
			},
			{
				id: 'cf1835a7-6a0e-4483-a6de-6a8dc1f71aca',
				name: '函館市電 運行に関するデータ（GTFS-JP）',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'active',
				url: 'https://ckan.hoda.jp/dataset/24/resource/cf1835a7-6a0e-4483-a6de-6a8dc1f71aca/download/hakodate_tram.zip',
				last_modified: null,
				revision_id: 'rev-tram',
				size: 10240,
			},
			{
				id: 'b9e5c644-23e1-44c3-bad0-4ce364eb6cb6',
				name: '観光データ(sightseeing_spot)',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'active',
				url: 'https://ckan.hoda.jp/dataset/24/resource/b9e5c644-23e1-44c3-bad0-4ce364eb6cb6/download/sightseeing.zip',
				last_modified: '2026-01-01T00:00:00.000000',
				revision_id: 'rev-sightseeing',
				size: 2048,
			},
			{
				id: 'external-page',
				name: '十勝バス(Tokachi Bus)',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'active',
				url: 'https://www.tokachibus.jp/rosenbus/opendata/',
				last_modified: '2021-11-24T07:09:30.851725',
				revision_id: 'rev-external',
				size: 1284210,
			},
			{
				id: 'blank-url',
				name: '美唄市コミュニティ',
				format: '',
				mimetype: null,
				state: 'active',
				url: '',
				last_modified: null,
				revision_id: 'rev-blank',
				size: null,
			},
			{
				id: 'html-link',
				name: '北海道北見バス(Hokkaido Kitami Bus)',
				format: 'HTML',
				mimetype: 'text/html',
				state: 'active',
				url: 'https://ckan.hoda.jp/dataset/24/resource/html-link/download/download.html',
				last_modified: '2026-07-02T02:09:52.733814',
				revision_id: 'rev-html',
				size: 34505,
			},
			{
				id: 'inactive',
				name: '無効リソース',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'deleted',
				url: 'https://ckan.hoda.jp/dataset/24/resource/inactive/download/inactive.zip',
				last_modified: '2026-01-01T00:00:00.000000',
				revision_id: 'rev-inactive',
				size: 1,
			},
		],
	},
};

function jsonFetcher(body: object, status = 200, calls: string[] = []): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		calls.push(String(input));
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		});
	};
	return impl as typeof fetch;
}

function hodaSource() {
	return createCkanPackageSource({
		sourceId: 'hoda',
		baseUrl: 'https://ckan.hoda.jp',
		packageId: 'gtfs-data',
		prefId: 1,
		excludedNamePatterns: [/観光データ/],
	});
}

describe('createCkanPackageSource', () => {
	it('HODAの直接ZIP公共交通GTFSをFeedTargetに変換する', async () => {
		const calls: string[] = [];
		const targets = await hodaSource().listTargets(jsonFetcher(HODA_RESPONSE, 200, calls));

		expect(calls).toEqual(['https://ckan.hoda.jp/api/3/action/package_show?id=gtfs-data']);
		expect(targets.map((target) => target.id)).toEqual([
			'hoda~c84abf64-f7ba-4d22-8cc1-acac7adbdc6f',
			'hoda~16a31295-1709-4e5e-abcf-fa17ae7853b7',
			'hoda~cf1835a7-6a0e-4483-a6de-6a8dc1f71aca',
		]);
		expect(targets[0]).toEqual({
			id: 'hoda~c84abf64-f7ba-4d22-8cc1-acac7adbdc6f',
			name: '網走バス(Abashiri Bus)',
			orgName: '地方創生モビリティコンソーシアム',
			license: 'クリエイティブ・コモンズ 表示',
			fromDate: '',
			toDate: '',
			source: 'hoda',
			versionId: 'c84abf64-f7ba-4d22-8cc1-acac7adbdc6f:2026-07-01T00:00:06.572591:rev-bus:410309',
			zipUrl:
				'https://ckan.hoda.jp/dataset/24/resource/c84abf64-f7ba-4d22-8cc1-acac7adbdc6f/download/abashiri_bus.zip',
			prefId: 1,
		});
		expect(targets[1].name).toContain('フェリー');
		expect(targets[2].name).toContain('市電');
		expect(targets[2].versionId).toBe('cf1835a7-6a0e-4483-a6de-6a8dc1f71aca::rev-tram:10240');
	});

	it('CKAN API失敗をソース一覧失敗としてthrowする', async () => {
		await expect(hodaSource().listTargets(jsonFetcher({ success: false }))).rejects.toThrow(
			'ckan package fetch failed: success false',
		);
		await expect(hodaSource().listTargets(jsonFetcher({ success: true }, 503))).rejects.toThrow(
			'ckan package fetch failed: 503',
		);
		await expect(
			hodaSource().listTargets(jsonFetcher({ success: true, result: { title: 'broken' } })),
		).rejects.toThrow('ckan package response malformed');
	});
});
