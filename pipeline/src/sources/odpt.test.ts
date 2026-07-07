import { describe, expect, it } from 'vitest';
import { createOdptSource } from './odpt';
import type { OdptManifestFile } from './odptManifestTypes';

const MANIFEST: OdptManifestFile = {
	generatedAt: '2026-07-07T00:00:00.000Z',
	feeds: [
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
			zipUrl: 'https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=current',
		},
	],
};

function redirectFetcher(): typeof fetch {
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (!url.includes('/files/odpt/TakasakiCity/yosiibus.zip')) {
			return new Response('not found', { status: 404 });
		}
		if (init?.redirect === 'manual') {
			return new Response(null, {
				status: 302,
				headers: {
					location:
						'https://blob.example.com/files-open/odpt/TakasakiCity/yosiibus-20260421.zip?st=xxx&sig=yyy',
				},
			});
		}
		return new Response(new Uint8Array([9, 9, 9]));
	};
	return impl as typeof fetch;
}

describe('createOdptSource', () => {
	it('manifestからFeedTargetを生成し、既存ID互換を保つ', async () => {
		const targets = await createOdptSource(MANIFEST).listTargets(redirectFetcher());
		expect(targets).toHaveLength(1);
		expect(targets[0]).toEqual({
			id: 'odpt~TakasakiCity~yosiibus',
			name: 'よしいバス',
			orgName: '高崎市',
			license: 'CC BY 4.0',
			fromDate: '',
			toDate: '',
			source: 'odpt',
			versionId: '/files-open/odpt/TakasakiCity/yosiibus-20260421.zip',
			zipUrl: 'https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=current',
		});
	});

	it('200直返しの場合はbodyのSHA-256をversionIdにする', async () => {
		const impl = async (): Promise<Response> => new Response(new Uint8Array([1, 2, 3]));
		const targets = await createOdptSource(MANIFEST).listTargets(impl as typeof fetch);
		expect(targets[0].versionId).toMatch(/^[0-9a-f]{64}$/);
	});

	it('版数解決に失敗したフィードはversionId空文字で一覧に残す', async () => {
		const impl = async (): Promise<Response> => new Response('down', { status: 503 });
		const targets = await createOdptSource(MANIFEST).listTargets(impl as typeof fetch);
		expect(targets).toHaveLength(1);
		expect(targets[0].versionId).toBe('');
		expect(targets[0].zipUrl).toContain('/files/odpt/TakasakiCity/yosiibus.zip');
	});
});
