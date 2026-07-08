import { describe, expect, it } from 'vitest';
import { createOdptSource, withOdptConsumerKey } from './odpt';
import type { OdptManifestEntry, OdptManifestFile } from './odptManifestTypes';

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
			zipUrl:
				'https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=current',
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
			zipUrl:
				'https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=current',
			prefId: null,
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

	it('マニフェストのprefIdをtargetへ通す', async () => {
		const source = createOdptSource({
			generatedAt: '2026-07-08T00:00:00.000Z',
			feeds: [
				{
					datasetId: 'd',
					resourceId: 'r',
					operator: 'AkaiwaCity',
					feed: 'AllLines',
					name: 'テスト',
					orgName: 'テスト市',
					license: null,
					fromDate: '',
					toDate: '',
					zipUrl: 'https://example.com/a.zip',
					prefId: 33,
				},
			],
		});
		const fetcher = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
		const targets = await source.listTargets(fetcher);
		expect(targets[0].prefId).toBe(33);
	});

	it('requiresKeyフィードは既定で除外し、includeKeyRequired時のみ含める', async () => {
		const keyedEntry: OdptManifestEntry = {
			datasetId: 'seibu_bus__b-bus_gtfs',
			resourceId: 'r-seibu',
			operator: 'SeibuBus',
			feed: 'SeibuBus-GTFS',
			name: '西武バス',
			orgName: '西武バス',
			license: 'CC BY 4.0',
			fromDate: '',
			toDate: '',
			zipUrl: 'https://api.odpt.org/api/v4/files/SeibuBus/data/SeibuBus-GTFS.zip',
			requiresKey: true,
		};
		const manifest: OdptManifestFile = {
			generatedAt: '2026-07-08T00:00:00.000Z',
			feeds: [...MANIFEST.feeds, keyedEntry],
		};
		const fetcher = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch;

		const withoutKey = await createOdptSource(manifest).listTargets(fetcher);
		expect(withoutKey.map((t) => t.id)).toEqual(['odpt~TakasakiCity~yosiibus']);

		const withKey = await createOdptSource(manifest, { includeKeyRequired: true }).listTargets(
			fetcher,
		);
		expect(withKey.map((t) => t.id)).toEqual([
			'odpt~TakasakiCity~yosiibus',
			'odpt~SeibuBus~SeibuBus-GTFS',
		]);
	});
});

describe('withOdptConsumerKey', () => {
	function recordingFetcher(calls: string[]): typeof fetch {
		const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			calls.push(`${String(input)}|redirect=${init?.redirect ?? 'none'}`);
			return new Response('ok');
		};
		return impl as typeof fetch;
	}

	it('api.odpt.orgへのリクエストにだけacl:consumerKeyを付与しinitを維持する', async () => {
		const calls: string[] = [];
		const fetcher = withOdptConsumerKey(recordingFetcher(calls), 'SECRET');
		await fetcher('https://api.odpt.org/api/v4/files/SeibuBus/data/SeibuBus-GTFS.zip?date=1', {
			redirect: 'manual',
		});
		await fetcher('https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip');
		await fetcher('https://api.gtfs-data.jp/v2/files');
		expect(calls).toEqual([
			'https://api.odpt.org/api/v4/files/SeibuBus/data/SeibuBus-GTFS.zip?date=1&acl:consumerKey=SECRET|redirect=manual',
			'https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip|redirect=none',
			'https://api.gtfs-data.jp/v2/files|redirect=none',
		]);
	});

	it('キー未設定なら元のfetcherをそのまま返す', () => {
		const base = recordingFetcher([]);
		expect(withOdptConsumerKey(base, undefined)).toBe(base);
		expect(withOdptConsumerKey(base, '')).toBe(base);
	});
});
