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
		const targets = await createOdptSource().listTargets(redirectFetcher());
		expect(targets).toHaveLength(ODPT_FEEDS.length);
		const yosii = targets.find((f) => f.id === 'odpt~TakasakiCity~yosiibus');
		expect(yosii?.versionId).toBe('/files-open/odpt/TakasakiCity/yosiibus-20260421.zip');
		expect(yosii?.source).toBe('odpt');
		expect(yosii?.license).toBe('CC BY 4.0');
		expect(yosii?.routesGeojsonUrl).toBeUndefined();
	});

	it('zipUrlはODPTダウンロードAPIを指す', async () => {
		const targets = await createOdptSource().listTargets(redirectFetcher());
		const zipRes = await redirectFetcher()(targets[0].zipUrl);
		expect(await zipRes.arrayBuffer()).toEqual(new Uint8Array([9, 9, 9]).buffer);
	});

	it('200直返しの場合はbodyのSHA-256をversionIdにする', async () => {
		const impl = async (): Promise<Response> => new Response(new Uint8Array([1, 2, 3]));
		const targets = await createOdptSource().listTargets(impl as typeof fetch);
		const d = targets[0];
		expect(d.versionId).toMatch(/^[0-9a-f]{64}$/);
		const zipRes = await impl();
		expect(await zipRes.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
	});

	it('版数解決に失敗したフィードはversionId空文字を残す', async () => {
		const impl = async (): Promise<Response> => new Response('down', { status: 503 });
		const targets = await createOdptSource().listTargets(impl as typeof fetch);
		expect(targets).toHaveLength(ODPT_FEEDS.length);
		expect(targets[0].versionId).toBe('');
	});
});
