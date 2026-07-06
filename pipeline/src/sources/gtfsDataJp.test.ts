import { describe, expect, it } from 'vitest';
import { createGtfsDataJpSource, type GtfsFileEntry } from './gtfsDataJp';

function entry(overrides: Partial<GtfsFileEntry>): GtfsFileEntry {
	return {
		organization_id: 'testorg',
		organization_name: 'テスト協議会',
		feed_id: 'testfeed',
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

function fetcherFor(entries: GtfsFileEntry[]): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = String(input);
		if (url.includes('/v2/files')) {
			return new Response(JSON.stringify({ code: 200, message: 'ok', body: entries }));
		}
		if (url.endsWith('feed.zip')) return new Response(new Uint8Array([1, 2, 3]));
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

describe('createGtfsDataJpSource', () => {
	it('一覧APIのエントリをFeedDescriptorへ変換する', async () => {
		const feeds = await createGtfsDataJpSource('10').listFeeds(fetcherFor([entry({})]));
		expect(feeds).toHaveLength(1);
		const d = feeds[0];
		expect(d.id).toBe('testorg~testfeed~2026-04-01');
		expect(d.versionId).toBe('uid-1');
		expect(d.source).toBe('gtfs-data.jp');
		expect(d.license).toBe('CC BY 4.0');
		expect(d.routesGeojsonUrl).toBe('https://example.com/routes.geojson');
		expect(await d.fetchZip(fetcherFor([]))).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('一覧APIの失敗でthrowする', async () => {
		const impl = async (): Promise<Response> => new Response('error', { status: 500 });
		await expect(createGtfsDataJpSource('10').listFeeds(impl as typeof fetch)).rejects.toThrow(
			'feed list fetch failed',
		);
	});

	it('route URLがnullならundefinedになる', async () => {
		const feeds = await createGtfsDataJpSource('10').listFeeds(
			fetcherFor([entry({ file_stop_url: null, file_route_url: null })]),
		);
		expect(feeds[0].routesGeojsonUrl).toBeUndefined();
	});
});
