import { describe, expect, it } from 'vitest';
import { createGtfsDataJpSource, type GtfsFileEntry } from './gtfsDataJp';

function entry(overrides: Partial<GtfsFileEntry>): GtfsFileEntry {
	return {
		organization_id: 'testorg',
		organization_name: 'テスト協議会',
		feed_id: 'testfeed',
		feed_pref_id: 10,
		feed_name: 'テストバス',
		feed_license_id: 'CC BY 4.0',
		file_uid: 'uid-1',
		file_from_date: '2026-04-01',
		file_to_date: '2027-03-31',
		file_url: 'https://example.com/feed.zip',
		file_stop_url: 'https://example.com/stops.geojson',
		file_route_url: 'https://example.com/routes.geojson',
		file_last_updated_at: '2026-06-01T00:00:00+09:00',
		...overrides,
	};
}

function fetcherFor(entries: GtfsFileEntry[], calls: string[]): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = String(input);
		calls.push(url);
		if (url.includes('/v2/files')) {
			return new Response(JSON.stringify({ code: 200, message: 'ok', body: entries }));
		}
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

describe('createGtfsDataJpSource', () => {
	it('prefIds未指定なら全国全件APIを呼びFeedTargetへ変換する', async () => {
		const calls: string[] = [];
		const targets = await createGtfsDataJpSource().listTargets(fetcherFor([entry({})], calls));
		expect(calls).toEqual(['https://api.gtfs-data.jp/v2/files']);
		expect(targets).toHaveLength(1);
		expect(targets[0]).toEqual({
			id: 'testorg~testfeed~2026-04-01',
			name: 'テストバス',
			orgName: 'テスト協議会',
			license: 'CC BY 4.0',
			fromDate: '2026-04-01',
			toDate: '2027-03-31',
			source: 'gtfs-data.jp',
			versionId: 'uid-1',
			zipUrl: 'https://example.com/feed.zip',
			routesGeojsonUrl: 'https://example.com/routes.geojson',
			prefId: 10,
		});
	});

	it('prefIds指定時は県別APIを順に呼ぶ', async () => {
		const calls: string[] = [];
		const targets = await createGtfsDataJpSource({ prefIds: [10, 11] }).listTargets(
			fetcherFor([entry({})], calls),
		);
		expect(targets).toHaveLength(2);
		expect(calls).toEqual([
			'https://api.gtfs-data.jp/v2/files?pref=10',
			'https://api.gtfs-data.jp/v2/files?pref=11',
		]);
	});

	it('一覧APIの失敗でthrowする', async () => {
		const impl = async (): Promise<Response> => new Response('error', { status: 500 });
		await expect(createGtfsDataJpSource().listTargets(impl as typeof fetch)).rejects.toThrow(
			'feed list fetch failed',
		);
	});

	it('route URLがnullならundefinedになる', async () => {
		const calls: string[] = [];
		const targets = await createGtfsDataJpSource().listTargets(
			fetcherFor([entry({ file_stop_url: null, file_route_url: null })], calls),
		);
		expect(targets[0].routesGeojsonUrl).toBeUndefined();
	});

	it('feed_pref_idをprefIdへ変換する', async () => {
		const calls: string[] = [];
		const targets = await createGtfsDataJpSource().listTargets(
			fetcherFor([entry({ feed_pref_id: 13 })], calls),
		);
		expect(targets[0].prefId).toBe(13);
	});
});
