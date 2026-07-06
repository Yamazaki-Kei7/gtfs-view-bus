import { describe, expect, it } from 'vitest';
import { createOdptSource, ODPT_FEEDS } from './odpt';

/** 実際のODPT APIを模す: manual redirect時は302+Location、follow時はzip本体 */
function redirectFetcher(): typeof fetch {
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const m = url.match(/files\/odpt\/([^/]+)\/([^.]+)\.zip/);
		if (!m) return new Response('not found', { status: 404 });
		if (init?.redirect === 'manual') {
			return new Response(null, {
				status: 302,
				headers: {
					location: `https://blob.example.com/files-open/odpt/${m[1]}/${m[2]}-20260421.zip?st=xxx&sig=yyy`,
				},
			});
		}
		return new Response(new Uint8Array([9, 9, 9]));
	};
	return impl as typeof fetch;
}

describe('createOdptSource', () => {
	it('302のLocationパスをversionIdにする(SASクエリは含めない)', async () => {
		const feeds = await createOdptSource().listFeeds(redirectFetcher());
		expect(feeds).toHaveLength(ODPT_FEEDS.length);
		const yosii = feeds.find((f) => f.id === 'odpt~TakasakiCity~yosiibus');
		expect(yosii?.versionId).toBe('/files-open/odpt/TakasakiCity/yosiibus-20260421.zip');
		expect(yosii?.source).toBe('odpt');
		expect(yosii?.license).toBe('CC BY 4.0');
		expect(yosii?.stopsGeojsonUrl).toBeUndefined();
		expect(yosii?.routesGeojsonUrl).toBeUndefined();
	});

	it('fetchZipはリダイレクト追従でzip本体を取得する', async () => {
		const feeds = await createOdptSource().listFeeds(redirectFetcher());
		expect(await feeds[0].fetchZip(redirectFetcher())).toEqual(new Uint8Array([9, 9, 9]));
	});

	it('200直返しの場合はbodyのSHA-256をversionIdにし、bodyを再利用する', async () => {
		const impl = async (): Promise<Response> => new Response(new Uint8Array([1, 2, 3]));
		const feeds = await createOdptSource().listFeeds(impl as typeof fetch);
		const d = feeds[0];
		expect(d.versionId).toMatch(/^[0-9a-f]{64}$/);
		// fetchZipは追加フェッチせずbodyを返す(必ず失敗するfetcherを渡して確認)
		const failing = (async (): Promise<Response> =>
			new Response('x', { status: 500 })) as typeof fetch;
		expect(await d.fetchZip(failing)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('版数解決に失敗したフィードは一覧に残り、fetchZipが失敗する', async () => {
		const impl = async (): Promise<Response> => new Response('down', { status: 503 });
		const feeds = await createOdptSource().listFeeds(impl as typeof fetch);
		expect(feeds).toHaveLength(ODPT_FEEDS.length);
		expect(feeds[0].versionId).toBe('');
		await expect(feeds[0].fetchZip(impl as typeof fetch)).rejects.toThrow('503');
	});
});
