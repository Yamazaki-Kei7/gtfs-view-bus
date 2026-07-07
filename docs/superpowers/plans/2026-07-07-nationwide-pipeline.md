# 全国GTFSパイプライン対応 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `gtfs-view-bus-pipeline` を群馬県限定の逐次変換から、gtfs-data.jp 全国全件と ODPT GTFS/GTFS-JP を Cloudflare Queues でフィード単位処理する構成へ移行する。

**Architecture:** `FeedDescriptor.fetchZip()` 中心の逐次処理を、JSON 化可能な `FeedTarget` と `FeedJobMessage` に分ける。Cron は対象一覧とジョブ状態を R2 に保存して Queue へ投入し、consumer は 1 メッセージ 1 フィードを処理して status を保存する。全 status が揃った時だけ `feeds.json` / `summary.json` を冪等に生成し、既存の公開キー形式は維持する。

**Tech Stack:** TypeScript / Cloudflare Workers (Cron, Queues, R2) / Wrangler JSONC / fflate / gtfs-core / Vitest / Cheerio / pnpm workspace

## Global Constraints

- 対象ソースは gtfs-data.jp 全件と ODPT の GTFS/GTFS-JP フィードとする。
- gtfs-data.jp は `GET https://api.gtfs-data.jp/v2/files` で全国全件を取得する。
- ODPT は開発時スクリプトでCKAN HTMLを解析し、静的マニフェストを更新する。Worker実行時にはHTML解析を行わない。
- 全国規模の変換は Cloudflare Queues を使い、Cron はフィード単位メッセージ投入を担当する。
- `feeds.json` は全フィードの処理結果が揃った後に一括差し替えする。処理途中の歯抜け状態は公開しない。
- 本番の全国変換運用は Workers Paid を推奨する。Queues自体は無料枠内に収まる見込みだが、Workers Free のCPU制限ではGTFS変換の安定完走を前提にしない。
- 既存の公開データ形式、R2キー、アプリ側の `/data/*` 読み取り形式は維持する。
- TypeScript で `any` / `unknown` / 不要な `class` を使わない。
- コードコメント、ドキュメント、コミットメッセージ本文は日本語で書く。
- パッケージマネージャは pnpm。pipeline の検証は `pnpm --filter pipeline test` と `pnpm --filter pipeline check` を使う。
- Cloudflare Workers / Queues / Wrangler の API と設定は、Context7 と Cloudflare Docs で確認した現行形に合わせる。`sendBatch` は `{ body }` 配列、consumer は `message.ack()` / `message.retry()` を使う。

---

## File Structure

- Modify: `pipeline/src/sources/types.ts`  
  `FeedDescriptor` を廃止し、Queue メッセージへ載せられる `FeedTarget` と `FeedSource.listTargets()` を定義する。
- Modify: `pipeline/src/sources/gtfsDataJp.ts` / `pipeline/src/sources/gtfsDataJp.test.ts`  
  `prefIds` 未指定時は `/v2/files`、指定時は県 ID ごとに `/v2/files?pref=<id>` を呼ぶ。
- Create: `pipeline/src/sources/odptManifestTypes.ts`  
  ODPT 静的マニフェストの JSON 型を Worker と更新スクリプトで共有する。
- Create: `pipeline/src/sources/odptManifest.json`  
  Worker 実行時の ODPT 入力。最初は既存 8 フィードを入れ、更新スクリプトで全国 ODPT へ拡張する。
- Modify: `pipeline/src/sources/odpt.ts` / `pipeline/src/sources/odpt.test.ts`  
  コード内定数を JSON マニフェストへ移し、versionId 解決と `FeedTarget` 化だけを担当する。
- Create: `pipeline/src/storage.ts`  
  `BucketLike`、R2 JSON 読み書き、R2 bucket の構造的ラッパーを集約する。
- Create: `pipeline/src/jobState.ts`  
  `FeedJobMessage`、manifest/current/status/summary の型、R2 キー、フィード ID エンコードを集約する。
- Create: `pipeline/src/feedProcessor.ts` / `pipeline/src/feedProcessor.test.ts`  
  1 フィードの `meta.json` 比較、zip 取得、変換、成果物書き込み、`meta.json` 最後書き込みを担当する。
- Create: `pipeline/src/finalize.ts` / `pipeline/src/finalize.test.ts`  
  全 status 完了判定、`feeds.json` / `summary.json` 差し替え、孤児掃除を担当する。
- Create: `pipeline/src/jobProducer.ts` / `pipeline/src/jobProducer.test.ts`  
  Cron 側の jobId 生成、manifest/current 保存、Queue `sendBatch` 分割投入を担当する。
- Modify: `pipeline/src/index.ts`  
  `scheduled()` と `queue()` の両ハンドラを持たせる。
- Modify: `pipeline/wrangler.jsonc`  
  Queue producer/consumer/DLQ、保守的な batch/concurrency、observability、CPU limit を設定する。
- Modify: `pipeline/package.json` / `pipeline/tsconfig.json`  
  `wrangler types`、ODPT 更新スクリプト、Cheerio/tsx、scripts の型チェック対象化を追加する。
- Create: `pipeline/src/sources/odptCkan.ts` / `pipeline/src/sources/odptCkan.test.ts` / `pipeline/src/sources/fixtures/*.html`  
  ODPT CKAN HTML 解析をテスト可能な純関数として持つ。
- Create: `pipeline/scripts/update-odpt-manifest.ts`  
  開発時だけ ODPT マニフェスト JSON を更新する薄い CLI にする。

---

### Task 1: FeedTarget 型と gtfs-data.jp 全国一覧

**Files:**
- Modify: `pipeline/src/sources/types.ts`
- Modify: `pipeline/src/sources/gtfsDataJp.ts`
- Modify: `pipeline/src/sources/gtfsDataJp.test.ts`

**Interfaces:**
- Consumes: 既存の gtfs-data.jp `/v2/files` レスポンス形。
- Produces: `FeedTarget`, `FeedSource.listTargets(fetcher): Promise<FeedTarget[]>`, `createGtfsDataJpSource(options?: { prefIds?: number[] }): FeedSource`

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/src/sources/gtfsDataJp.test.ts` を次の形へ更新する。

```ts
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
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/sources/gtfsDataJp.test.ts`

Expected: FAIL。`createGtfsDataJpSource()` が引数なしを受けず、`listTargets` が存在しない。

- [ ] **Step 3: 型定義を `FeedTarget` へ置き換える**

`pipeline/src/sources/types.ts` を次の内容にする。

```ts
/** フィードの取得元レジストリ */
export type SourceId = 'gtfs-data.jp' | 'odpt';

/** QueueメッセージとR2 manifestに保存できる、関数を持たないフィード処理対象 */
export interface FeedTarget {
	/** R2キー用の一意ID */
	id: string;
	/** フィード名(フッター表示用) */
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	source: SourceId;
	/** 差分検出キー。前回metaと一致すれば再処理をスキップする */
	versionId: string;
	/** GTFS zip本体の取得URL */
	zipUrl: string;
	/** ソースがルート形状のGeoJSONを別配布している場合のみ設定 */
	routesGeojsonUrl?: string;
}

export interface FeedSource {
	sourceId: SourceId;
	listTargets(fetcher: typeof fetch): Promise<FeedTarget[]>;
}
```

- [ ] **Step 4: gtfs-data.jp アダプタを実装する**

`pipeline/src/sources/gtfsDataJp.ts` を次の内容にする。

```ts
import type { FeedSource, FeedTarget } from './types';

export interface GtfsFileEntry {
	organization_id: string;
	organization_name: string;
	feed_id: string;
	feed_name: string;
	feed_license_id: string | null;
	file_uid: string;
	file_from_date: string;
	file_to_date: string;
	file_url: string;
	file_stop_url: string | null;
	file_route_url: string | null;
	file_last_updated_at: string;
}

interface FilesResponse {
	code: number;
	body: GtfsFileEntry[];
}

export interface GtfsDataJpSourceOptions {
	prefIds?: number[];
}

const API_BASE = 'https://api.gtfs-data.jp/v2';

function filesUrl(prefId?: number): string {
	return prefId === undefined ? `${API_BASE}/files` : `${API_BASE}/files?pref=${prefId}`;
}

async function fetchEntries(fetcher: typeof fetch, url: string): Promise<GtfsFileEntry[]> {
	const listRes = await fetcher(url);
	if (!listRes.ok) throw new Error(`feed list fetch failed: ${listRes.status}`);
	const list = (await listRes.json()) as FilesResponse;
	if (!Array.isArray(list.body)) throw new Error('feed list response malformed');
	return list.body;
}

function toTarget(entry: GtfsFileEntry): FeedTarget {
	return {
		id: `${entry.organization_id}~${entry.feed_id}~${entry.file_from_date}`,
		name: entry.feed_name,
		orgName: entry.organization_name,
		license: entry.feed_license_id,
		fromDate: entry.file_from_date,
		toDate: entry.file_to_date,
		source: 'gtfs-data.jp',
		versionId: entry.file_uid,
		zipUrl: entry.file_url,
		routesGeojsonUrl: entry.file_route_url ?? undefined,
	};
}

/** GTFSデータリポジトリ(gtfs-data.jp)の一覧APIをFeedSourceへ適合させる */
export function createGtfsDataJpSource(options: GtfsDataJpSourceOptions = {}): FeedSource {
	return {
		sourceId: 'gtfs-data.jp',
		async listTargets(fetcher) {
			const prefIds = options.prefIds;
			const urls = prefIds && prefIds.length > 0 ? prefIds.map(filesUrl) : [filesUrl()];
			const entries: GtfsFileEntry[] = [];
			for (const url of urls) {
				entries.push(...(await fetchEntries(fetcher, url)));
			}
			return entries.map(toTarget);
		},
	};
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm --filter pipeline exec vitest run src/sources/gtfsDataJp.test.ts`

Expected: PASS。4 tests passed。

- [ ] **Step 6: コミット**

```bash
git add pipeline/src/sources/types.ts pipeline/src/sources/gtfsDataJp.ts pipeline/src/sources/gtfsDataJp.test.ts
git commit -m "feat(pipeline): gtfs-data.jp全国一覧をFeedTarget化する"
```

---

### Task 2: ODPT 静的マニフェスト化

**Files:**
- Create: `pipeline/src/sources/odptManifestTypes.ts`
- Create: `pipeline/src/sources/odptManifest.json`
- Modify: `pipeline/src/sources/odpt.ts`
- Modify: `pipeline/src/sources/odpt.test.ts`
- Modify: `pipeline/tsconfig.json`

**Interfaces:**
- Consumes: `OdptManifestFile` JSON。
- Produces: `createOdptSource(manifest?: OdptManifestFile): FeedSource`

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/src/sources/odpt.test.ts` を次の形へ更新する。

```ts
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/sources/odpt.test.ts`

Expected: FAIL。`OdptManifestFile` と `listTargets` が存在しない。

- [ ] **Step 3: JSON import を有効にする**

`pipeline/tsconfig.json` を次の内容にする。

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"strict": true,
		"skipLibCheck": true,
		"noEmit": true,
		"resolveJsonModule": true,
		"types": ["@cloudflare/workers-types"]
	},
	"include": ["src"]
}
```

- [ ] **Step 4: マニフェスト型を追加する**

`pipeline/src/sources/odptManifestTypes.ts` を作成する。

```ts
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
```

- [ ] **Step 5: 既存8フィードを JSON に移す**

`pipeline/src/sources/odptManifest.json` を作成する。

```json
{
	"generatedAt": "2026-07-07T00:00:00.000Z",
	"feeds": [
		{
			"datasetId": "takasaki_city_yosiibus",
			"resourceId": "takasaki_city_yosiibus_gtfs",
			"operator": "TakasakiCity",
			"feed": "yosiibus",
			"name": "よしいバス",
			"orgName": "高崎市",
			"license": "CC BY 4.0",
			"fromDate": "",
			"toDate": "",
			"zipUrl": "https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=current"
		},
		{
			"datasetId": "gunma_bus_all_lines",
			"resourceId": "gunma_bus_all_lines_gtfs",
			"operator": "GunmaBus",
			"feed": "AllLines",
			"name": "群馬バス(全路線)",
			"orgName": "群馬バス",
			"license": "CC BY 4.0",
			"fromDate": "",
			"toDate": "",
			"zipUrl": "https://api-public.odpt.org/api/v4/files/odpt/GunmaBus/AllLines.zip?date=current"
		},
		{
			"datasetId": "gunmachuo_bus_all_lines",
			"resourceId": "gunmachuo_bus_all_lines_gtfs",
			"operator": "GunmachuoBus",
			"feed": "AllLines",
			"name": "群馬中央バス(全路線)",
			"orgName": "群馬中央バス",
			"license": "CC BY 4.0",
			"fromDate": "",
			"toDate": "",
			"zipUrl": "https://api-public.odpt.org/api/v4/files/odpt/GunmachuoBus/AllLines.zip?date=current"
		},
		{
			"datasetId": "joshin_kanko_bus_all_lines",
			"resourceId": "joshin_kanko_bus_all_lines_gtfs",
			"operator": "JoshinKankoBus",
			"feed": "AllLines",
			"name": "上信観光バス(全路線)",
			"orgName": "上信観光バス",
			"license": "CC BY 4.0",
			"fromDate": "",
			"toDate": "",
			"zipUrl": "https://api-public.odpt.org/api/v4/files/odpt/JoshinKankoBus/AllLines.zip?date=current"
		},
		{
			"datasetId": "joshin_hire_all_lines",
			"resourceId": "joshin_hire_all_lines_gtfs",
			"operator": "JoshinHire",
			"feed": "AllLines",
			"name": "上信ハイヤー(全路線)",
			"orgName": "上信ハイヤー",
			"license": "CC BY 4.0",
			"fromDate": "",
			"toDate": "",
			"zipUrl": "https://api-public.odpt.org/api/v4/files/odpt/JoshinHire/AllLines.zip?date=current"
		},
		{
			"datasetId": "kan_etsu_transportation_all_lines",
			"resourceId": "kan_etsu_transportation_all_lines_gtfs",
			"operator": "Kan_etsuTransportation",
			"feed": "AllLines",
			"name": "関越交通(全路線)",
			"orgName": "関越交通",
			"license": "CC BY 4.0",
			"fromDate": "",
			"toDate": "",
			"zipUrl": "https://api-public.odpt.org/api/v4/files/odpt/Kan_etsuTransportation/AllLines.zip?date=current"
		},
		{
			"datasetId": "nippon_chuo_bus_maebashi_area",
			"resourceId": "nippon_chuo_bus_maebashi_area_gtfs",
			"operator": "NipponChuoBus",
			"feed": "Maebashi_Area",
			"name": "日本中央バス(前橋エリア)",
			"orgName": "日本中央バス",
			"license": "CC BY 4.0",
			"fromDate": "",
			"toDate": "",
			"zipUrl": "https://api-public.odpt.org/api/v4/files/odpt/NipponChuoBus/Maebashi_Area.zip?date=current"
		},
		{
			"datasetId": "nagai_transportation_all_lines",
			"resourceId": "nagai_transportation_all_lines_gtfs",
			"operator": "NagaiTransportation",
			"feed": "AllLines",
			"name": "永井運輸(全路線)",
			"orgName": "永井運輸",
			"license": "CC BY 4.0",
			"fromDate": "",
			"toDate": "",
			"zipUrl": "https://api-public.odpt.org/api/v4/files/odpt/NagaiTransportation/AllLines.zip?date=current"
		}
	]
}
```

- [ ] **Step 6: ODPT source を JSON 入力へ移行する**

`pipeline/src/sources/odpt.ts` を次の内容にする。

```ts
import manifestJson from './odptManifest.json';
import type { OdptManifestEntry, OdptManifestFile } from './odptManifestTypes';
import type { FeedSource, FeedTarget } from './types';

const ODPT_MANIFEST = manifestJson as OdptManifestFile;

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function resolveVersion(fetcher: typeof fetch, entry: OdptManifestEntry): Promise<string> {
	const res = await fetcher(entry.zipUrl, { redirect: 'manual' });
	if (res.status >= 300 && res.status < 400) {
		const loc = res.headers.get('location');
		if (!loc) throw new Error(`redirect without location: ${entry.operator}/${entry.feed}`);
		return new URL(loc, entry.zipUrl).pathname;
	}
	if (res.ok) {
		return sha256Hex(new Uint8Array(await res.arrayBuffer()));
	}
	throw new Error(`odpt zip fetch failed: ${res.status} (${entry.operator}/${entry.feed})`);
}

function targetBase(entry: OdptManifestEntry): Omit<FeedTarget, 'versionId'> {
	return {
		id: `odpt~${entry.operator}~${entry.feed}`,
		name: entry.name,
		orgName: entry.orgName,
		license: entry.license,
		fromDate: entry.fromDate,
		toDate: entry.toDate,
		source: 'odpt',
		zipUrl: entry.zipUrl,
	};
}

/** 公共交通オープンデータセンター(ODPT)の静的マニフェストをFeedSourceへ適合させる */
export function createOdptSource(manifest: OdptManifestFile = ODPT_MANIFEST): FeedSource {
	return {
		sourceId: 'odpt',
		async listTargets(fetcher) {
			const targets: FeedTarget[] = [];
			for (const entry of manifest.feeds) {
				const base = targetBase(entry);
				try {
					targets.push({ ...base, versionId: await resolveVersion(fetcher, entry) });
				} catch {
					targets.push({ ...base, versionId: '' });
				}
			}
			return targets;
		},
	};
}
```

- [ ] **Step 7: テストと型チェックが通ることを確認**

Run: `pnpm --filter pipeline exec vitest run src/sources/odpt.test.ts src/sources/gtfsDataJp.test.ts`

Expected: PASS。

Run: `pnpm --filter pipeline check`

Expected: PASS。

- [ ] **Step 8: コミット**

```bash
git add pipeline/tsconfig.json pipeline/src/sources/odptManifestTypes.ts pipeline/src/sources/odptManifest.json pipeline/src/sources/odpt.ts pipeline/src/sources/odpt.test.ts
git commit -m "feat(pipeline): ODPTフィードを静的マニフェスト化する"
```

---

### Task 3: R2 ジョブ状態と Queue 投入

**Files:**
- Create: `pipeline/src/storage.ts`
- Create: `pipeline/src/jobState.ts`
- Create: `pipeline/src/jobProducer.ts`
- Create: `pipeline/src/jobProducer.test.ts`

**Interfaces:**
- Consumes: `FeedSource[]`, `BucketLike`, `QueueLike<FeedJobMessage>`.
- Produces: `createFeedJob(deps): Promise<CreateFeedJobResult>`, R2 `pipeline/jobs/<jobId>/manifest.json`, `pipeline/jobs/current.json`, Queue `FeedJobMessage`.

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/src/jobProducer.test.ts` を作成する。

```ts
import { describe, expect, it } from 'vitest';
import { createFeedJob, type QueueLike } from './jobProducer';
import type { FeedJobMessage, JobCurrent, JobManifest } from './jobState';
import type { BucketLike } from './storage';
import type { FeedSource, FeedTarget } from './sources/types';

function fakeBucket(): BucketLike & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			const v = store.get(key);
			return v === undefined ? null : { text: async () => v };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async list() {
			return { objects: [], truncated: false };
		},
		async delete() {},
	};
}

function fakeQueue(): QueueLike<FeedJobMessage> & { batches: { body: FeedJobMessage }[][] } {
	const batches: { body: FeedJobMessage }[][] = [];
	return {
		batches,
		async sendBatch(messages) {
			batches.push([...messages]);
		},
	};
}

function target(id: string, source: 'gtfs-data.jp' | 'odpt'): FeedTarget {
	return {
		id,
		name: id,
		orgName: 'org',
		license: 'CC BY 4.0',
		fromDate: '',
		toDate: '',
		source,
		versionId: `version-${id}`,
		zipUrl: `https://example.com/${id}.zip`,
	};
}

describe('createFeedJob', () => {
	it('manifest/currentを保存し、Queueへフィード単位メッセージを投入する', async () => {
		const bucket = fakeBucket();
		const queue = fakeQueue();
		const source: FeedSource = {
			sourceId: 'gtfs-data.jp',
			listTargets: async () => [target('a', 'gtfs-data.jp'), target('b', 'gtfs-data.jp')],
		};
		const result = await createFeedJob({
			bucket,
			queue,
			fetcher: fetch,
			sources: [source],
			now: () => new Date('2026-07-07T12:00:00.000Z'),
			randomBytes: () => new Uint8Array([0xa1, 0xb2, 0xc3]),
		});
		expect(result).toEqual({ status: 'queued', jobId: '20260707T120000Z-a1b2c3', total: 2 });
		const manifest = JSON.parse(
			bucket.store.get('pipeline/jobs/20260707T120000Z-a1b2c3/manifest.json') ?? '{}',
		) as JobManifest;
		expect(manifest.targets.map((t) => t.id)).toEqual(['a', 'b']);
		expect(manifest.sources).toEqual({ 'gtfs-data.jp': 2, odpt: 0 });
		const current = JSON.parse(bucket.store.get('pipeline/jobs/current.json') ?? '{}') as JobCurrent;
		expect(current.status).toBe('queued');
		expect(queue.batches).toHaveLength(1);
		expect(queue.batches[0].map((m) => m.body.target.id)).toEqual(['a', 'b']);
	});

	it('Queue投入を100件ずつ分割する', async () => {
		const bucket = fakeBucket();
		const queue = fakeQueue();
		const targets = Array.from({ length: 205 }, (_, i) => target(`feed-${i}`, 'gtfs-data.jp'));
		const source: FeedSource = { sourceId: 'gtfs-data.jp', listTargets: async () => targets };
		await createFeedJob({
			bucket,
			queue,
			fetcher: fetch,
			sources: [source],
			now: () => new Date('2026-07-07T12:00:00.000Z'),
			randomBytes: () => new Uint8Array([1, 2, 3]),
		});
		expect(queue.batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
	});

	it('ソース一覧失敗時はfailed currentを書き、manifestとQueue投入を行わない', async () => {
		const bucket = fakeBucket();
		const queue = fakeQueue();
		const source: FeedSource = {
			sourceId: 'odpt',
			listTargets: () => Promise.reject(new Error('source down')),
		};
		const result = await createFeedJob({
			bucket,
			queue,
			fetcher: fetch,
			sources: [source],
			now: () => new Date('2026-07-07T12:00:00.000Z'),
			randomBytes: () => new Uint8Array([4, 5, 6]),
		});
		expect(result.status).toBe('failed');
		expect(bucket.store.has('pipeline/jobs/20260707T120000Z-040506/manifest.json')).toBe(false);
		const current = JSON.parse(bucket.store.get('pipeline/jobs/current.json') ?? '{}') as JobCurrent;
		expect(current.status).toBe('failed');
		expect(current.error).toBe('source down');
		expect(queue.batches).toHaveLength(0);
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/jobProducer.test.ts`

Expected: FAIL。`jobProducer` / `jobState` / `storage` が存在しない。

- [ ] **Step 3: R2 storage helper を作る**

`pipeline/src/storage.ts` を作成する。

```ts
export interface BucketLike {
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	put(key: string, value: string): Promise<void>;
	list(options: {
		prefix: string;
		cursor?: string;
	}): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
	delete(keys: string[]): Promise<void>;
}

export async function readJson<T extends object>(bucket: BucketLike, key: string): Promise<T | null> {
	const obj = await bucket.get(key);
	if (!obj) return null;
	try {
		return JSON.parse(await obj.text()) as T;
	} catch {
		return null;
	}
}

export async function putJson(bucket: BucketLike, key: string, value: object): Promise<void> {
	await bucket.put(key, JSON.stringify(value));
}

/** R2Bucket の戻り値型をテスト用の最小インターフェースへ合わせる */
export function toBucketLike(bucket: R2Bucket): BucketLike {
	return {
		get: (key) => bucket.get(key),
		put: async (key, value) => {
			await bucket.put(key, value);
		},
		list: async (options) => {
			const res = await bucket.list({ prefix: options.prefix, cursor: options.cursor });
			return {
				objects: res.objects.map((o) => ({ key: o.key })),
				truncated: res.truncated,
				cursor: res.truncated ? res.cursor : undefined,
			};
		},
		delete: async (keys) => {
			await bucket.delete(keys);
		},
	};
}
```

- [ ] **Step 4: ジョブ状態型と R2 キーを作る**

`pipeline/src/jobState.ts` を作成する。

```ts
import type { FeedTarget, SourceId } from './sources/types';

export interface FeedStatus {
	id: string;
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	source: SourceId;
	status: 'updated' | 'unchanged' | 'error';
	error?: string;
	shapeSourceCounts?: Record<string, number>;
}

export interface FeedJobMessage {
	jobId: string;
	target: FeedTarget;
}

export interface JobManifest {
	jobId: string;
	createdAt: string;
	targets: FeedTarget[];
	sources: Record<SourceId, number>;
	previousFeedsGeneratedAt: string | null;
}

export interface JobCurrent {
	jobId: string;
	status: 'queued' | 'failed' | 'completed';
	createdAt: string;
	total: number;
	completed: number;
	error?: string;
}

export interface FeedJobStatus extends FeedStatus {
	jobId: string;
	finishedAt: string;
}

export interface JobSummary {
	jobId: string;
	generatedAt: string;
	total: number;
	updated: number;
	unchanged: number;
	error: number;
	sources: Record<SourceId, number>;
	published: boolean;
}

export const CURRENT_JOB_KEY = 'pipeline/jobs/current.json';

export function jobManifestKey(jobId: string): string {
	return `pipeline/jobs/${jobId}/manifest.json`;
}

export function jobSummaryKey(jobId: string): string {
	return `pipeline/jobs/${jobId}/summary.json`;
}

export function encodedFeedId(feedId: string): string {
	return encodeURIComponent(feedId);
}

export function jobStatusKey(jobId: string, feedId: string): string {
	return `pipeline/jobs/${jobId}/statuses/${encodedFeedId(feedId)}.json`;
}
```

- [ ] **Step 5: Queue job producer を実装する**

`pipeline/src/jobProducer.ts` を作成する。

```ts
import {
	CURRENT_JOB_KEY,
	type FeedJobMessage,
	type JobCurrent,
	type JobManifest,
	jobManifestKey,
} from './jobState';
import type { BucketLike } from './storage';
import { putJson, readJson } from './storage';
import type { FeedSource, FeedTarget, SourceId } from './sources/types';

export interface QueueMessageSend<T> {
	body: T;
}

export interface QueueLike<T> {
	sendBatch(messages: QueueMessageSend<T>[]): Promise<void>;
}

export interface CreateFeedJobDeps {
	bucket: BucketLike;
	queue: QueueLike<FeedJobMessage>;
	fetcher: typeof fetch;
	sources: FeedSource[];
	now(): Date;
	randomBytes(): Uint8Array;
}

export type CreateFeedJobResult =
	| { status: 'queued'; jobId: string; total: number }
	| { status: 'failed'; jobId: string; error: string };

const QUEUE_SEND_BATCH_SIZE = 100;

function jobTimestamp(now: Date): string {
	return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createJobId(now: Date, randomBytes: Uint8Array): string {
	return `${jobTimestamp(now)}-${hex(randomBytes.slice(0, 3))}`;
}

async function collectTargets(
	sources: FeedSource[],
	fetcher: typeof fetch,
): Promise<{ targets: FeedTarget[]; counts: Record<SourceId, number> }> {
	const targets: FeedTarget[] = [];
	const counts: Record<SourceId, number> = { 'gtfs-data.jp': 0, odpt: 0 };
	for (const source of sources) {
		const sourceTargets = await source.listTargets(fetcher);
		targets.push(...sourceTargets);
		counts[source.sourceId] += sourceTargets.length;
	}
	return { targets, counts };
}

function errorMessage(error: Error): string {
	return error.message;
}

export async function createFeedJob(deps: CreateFeedJobDeps): Promise<CreateFeedJobResult> {
	const createdAt = deps.now().toISOString();
	const jobId = createJobId(new Date(createdAt), deps.randomBytes());
	try {
		const { targets, counts } = await collectTargets(deps.sources, deps.fetcher);
		const prev = await readJson<{ generatedAt: string }>(deps.bucket, 'feeds.json');
		const manifest: JobManifest = {
			jobId,
			createdAt,
			targets,
			sources: counts,
			previousFeedsGeneratedAt: prev?.generatedAt ?? null,
		};
		await putJson(deps.bucket, jobManifestKey(jobId), manifest);
		const current: JobCurrent = {
			jobId,
			status: 'queued',
			createdAt,
			total: targets.length,
			completed: 0,
		};
		await putJson(deps.bucket, CURRENT_JOB_KEY, current);
		const messages = targets.map((target): QueueMessageSend<FeedJobMessage> => ({
			body: { jobId, target },
		}));
		for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_SIZE) {
			await deps.queue.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_SIZE));
		}
		return { status: 'queued', jobId, total: targets.length };
	} catch (error) {
		const message = error instanceof Error ? errorMessage(error) : String(error);
		const current: JobCurrent = {
			jobId,
			status: 'failed',
			createdAt,
			total: 0,
			completed: 0,
			error: message,
		};
		await putJson(deps.bucket, CURRENT_JOB_KEY, current);
		return { status: 'failed', jobId, error: message };
	}
}
```

- [ ] **Step 6: テストが通ることを確認**

Run: `pnpm --filter pipeline exec vitest run src/jobProducer.test.ts`

Expected: PASS。

- [ ] **Step 7: コミット**

```bash
git add pipeline/src/storage.ts pipeline/src/jobState.ts pipeline/src/jobProducer.ts pipeline/src/jobProducer.test.ts
git commit -m "feat(pipeline): Queue投入用のジョブ状態を追加する"
```

---

### Task 4: フィード単位処理を Queue consumer 用に切り出す

**Files:**
- Create: `pipeline/src/feedProcessor.ts`
- Create: `pipeline/src/feedProcessor.test.ts`
- Modify: `pipeline/src/run.ts`
- Modify: `pipeline/src/run.test.ts`

**Interfaces:**
- Consumes: `FeedTarget`, `BucketLike`, `fetch`.
- Produces: `processFeedTarget(deps): Promise<FeedStatus>` and `runPipeline(deps): Promise<FeedStatus[]>` direct local fallback.

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/src/feedProcessor.test.ts` を作成する。既存 `run.test.ts` のフィクスチャ生成を移植し、対象を `processFeedTarget` に絞る。

```ts
import { strToU8, zipSync } from 'fflate';
import { FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON } from 'gtfs-core';
import { describe, expect, it } from 'vitest';
import { processFeedTarget } from './feedProcessor';
import type { BucketLike } from './storage';
import type { FeedTarget } from './sources/types';

function fakeBucket(): BucketLike & { store: Map<string, string>; writes: string[] } {
	const store = new Map<string, string>();
	const writes: string[] = [];
	return {
		store,
		writes,
		async get(key: string) {
			const v = store.get(key);
			return v === undefined ? null : { text: async () => v };
		},
		async put(key: string, value: string) {
			writes.push(key);
			store.set(key, value);
		},
		async list() {
			return { objects: [], truncated: false };
		},
		async delete() {},
	};
}

const FIXTURE_ZIP = zipSync(
	Object.fromEntries(Object.entries(FIXTURE_FILES).map(([k, v]) => [k, strToU8(v)])),
);

function target(overrides: Partial<FeedTarget> = {}): FeedTarget {
	return {
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
		...overrides,
	};
}

function fetcher(): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = String(input);
		if (url.endsWith('feed.zip')) return new Response(FIXTURE_ZIP);
		if (url.endsWith('routes.geojson')) return new Response(FIXTURE_ROUTES_GEOJSON);
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

describe('processFeedTarget', () => {
	it('新規フィードを変換し、meta.jsonを最後に書く', async () => {
		const bucket = fakeBucket();
		const status = await processFeedTarget({ bucket, fetcher: fetcher(), target: target() });
		expect(status.status).toBe('updated');
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/bundle.json')).toBe(true);
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/routes.geojson')).toBe(true);
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/stops.geojson')).toBe(true);
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/timetable.json')).toBe(true);
		expect(bucket.writes.at(-1)).toBe('feeds/testorg~testfeed~2026-04-01/meta.json');
		expect(status.shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});

	it('versionIdとschemaVersionが一致すればunchangedで変換をスキップする', async () => {
		const bucket = fakeBucket();
		bucket.store.set(
			'feeds/testorg~testfeed~2026-04-01/meta.json',
			JSON.stringify({
				versionId: 'uid-1',
				schemaVersion: 4,
				shapeSourceCounts: { shapes: 2, route: 0, straight: 0 },
			}),
		);
		const status = await processFeedTarget({ bucket, fetcher: fetcher(), target: target() });
		expect(status.status).toBe('unchanged');
		expect(status.shapeSourceCounts).toEqual({ shapes: 2, route: 0, straight: 0 });
		expect(bucket.writes).toHaveLength(0);
	});

	it('通常のフィード処理失敗はthrowせずerror statusを返す', async () => {
		const bucket = fakeBucket();
		const status = await processFeedTarget({
			bucket,
			fetcher: fetcher(),
			target: target({ zipUrl: 'https://example.com/missing.zip' }),
		});
		expect(status.status).toBe('error');
		expect(status.error).toBe('zip fetch failed: 404');
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/feedProcessor.test.ts`

Expected: FAIL。`feedProcessor` が存在しない。

- [ ] **Step 3: フィード処理を実装する**

`pipeline/src/feedProcessor.ts` を作成する。`OUTPUT_SCHEMA_VERSION` は既存値 `4` のまま移す。

```ts
import {
	buildTimetableIndex,
	convertFeed,
	shapesToGeojson,
	stopRouteIds,
	stopsToGeojson,
	unzipFeed,
} from 'gtfs-core';
import type { FeedStatus } from './jobState';
import type { BucketLike } from './storage';
import type { FeedTarget } from './sources/types';

interface FeedMeta {
	versionId?: string;
	fileUid?: string;
	schemaVersion?: number;
	shapeSourceCounts?: Record<string, number>;
}

export interface ProcessFeedTargetDeps {
	bucket: BucketLike;
	fetcher: typeof fetch;
	target: FeedTarget;
}

const OUTPUT_SCHEMA_VERSION = 4;

function statusBase(target: FeedTarget): Omit<FeedStatus, 'status'> {
	return {
		id: target.id,
		name: target.name,
		orgName: target.orgName,
		license: target.license,
		fromDate: target.fromDate,
		toDate: target.toDate,
		source: target.source,
	};
}

async function fetchBytes(fetcher: typeof fetch, url: string): Promise<Uint8Array> {
	const res = await fetcher(url);
	if (!res.ok) throw new Error(`zip fetch failed: ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

async function fetchRoutesGeojson(fetcher: typeof fetch, url: string): Promise<string> {
	const res = await fetcher(url);
	if (!res.ok) throw new Error(`routes geojson fetch failed: ${res.status}`);
	return res.text();
}

export async function processFeedTarget({
	bucket,
	fetcher,
	target,
}: ProcessFeedTargetDeps): Promise<FeedStatus> {
	const base = statusBase(target);
	try {
		const metaObj = await bucket.get(`feeds/${target.id}/meta.json`);
		const meta = metaObj ? (JSON.parse(await metaObj.text()) as FeedMeta) : null;
		if (
			meta &&
			target.versionId !== '' &&
			(meta.versionId ?? meta.fileUid) === target.versionId &&
			(meta.schemaVersion ?? 0) >= OUTPUT_SCHEMA_VERSION
		) {
			return { ...base, status: 'unchanged', shapeSourceCounts: meta.shapeSourceCounts };
		}

		const zip = await fetchBytes(fetcher, target.zipUrl);
		const routesText = target.routesGeojsonUrl
			? await fetchRoutesGeojson(fetcher, target.routesGeojsonUrl)
			: null;
		const files = unzipFeed(zip);
		const bundle = convertFeed(files, routesText ?? undefined);
		await bucket.put(`feeds/${target.id}/bundle.json`, JSON.stringify(bundle));
		await bucket.put(
			`feeds/${target.id}/routes.geojson`,
			routesText ?? JSON.stringify(shapesToGeojson(bundle)),
		);
		await bucket.put(
			`feeds/${target.id}/stops.geojson`,
			JSON.stringify(stopsToGeojson(files, stopRouteIds(files))),
		);
		await bucket.put(`feeds/${target.id}/timetable.json`, JSON.stringify(buildTimetableIndex(files)));
		await bucket.put(
			`feeds/${target.id}/meta.json`,
			JSON.stringify({
				versionId: target.versionId,
				schemaVersion: OUTPUT_SCHEMA_VERSION,
				shapeSourceCounts: bundle.shapeSourceCounts,
			}),
		);
		return { ...base, status: 'updated', shapeSourceCounts: bundle.shapeSourceCounts };
	} catch (error) {
		return {
			...base,
			status: 'error',
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
```

- [ ] **Step 4: `runPipeline` を direct local fallback として更新する**

`pipeline/src/run.ts` は互換実行用に薄く残し、source list 失敗時はこの direct 実行全体を失敗させる。`feeds.json` の歯抜け公開を避けるため、古い「失敗ソースだけ前回引き継ぎ」は削除する。

```ts
import { processFeedTarget } from './feedProcessor';
import type { FeedStatus } from './jobState';
import type { BucketLike } from './storage';
import { putJson } from './storage';
import type { FeedSource } from './sources/types';

export interface PipelineDeps {
	bucket: BucketLike;
	fetcher: typeof fetch;
	sources: FeedSource[];
}

const DELETE_BATCH = 1000;

export async function runPipeline({ bucket, fetcher, sources }: PipelineDeps): Promise<FeedStatus[]> {
	const targets = [];
	for (const source of sources) {
		targets.push(...(await source.listTargets(fetcher)));
	}
	const statuses: FeedStatus[] = [];
	for (const target of targets) {
		statuses.push(await processFeedTarget({ bucket, fetcher, target }));
	}
	await putJson(bucket, 'feeds.json', { generatedAt: new Date().toISOString(), feeds: statuses });
	await cleanupOrphans(bucket, new Set(targets.map((target) => target.id)));
	return statuses;
}

export async function cleanupOrphans(bucket: BucketLike, activeIds: Set<string>): Promise<void> {
	const orphans: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: 'feeds/', cursor });
		for (const obj of page.objects) {
			const feedId = obj.key.split('/')[1];
			if (feedId && !activeIds.has(feedId)) orphans.push(obj.key);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	for (let i = 0; i < orphans.length; i += DELETE_BATCH) {
		await bucket.delete(orphans.slice(i, i + DELETE_BATCH));
	}
}
```

- [ ] **Step 5: `run.test.ts` を `listTargets` に合わせて更新する**

既存の `stubSource` と `createGtfsDataJpSource('10')` 呼び出しを次の形へ置き換える。

```ts
import { runPipeline } from './run';
import { createGtfsDataJpSource, type GtfsFileEntry } from './sources/gtfsDataJp';
import type { FeedSource, FeedTarget } from './sources/types';

function odptTarget(): FeedTarget {
	return {
		id: 'odpt~TestOp~AllLines',
		name: 'テスト事業者(全路線)',
		orgName: 'テスト事業者',
		license: 'CC BY 4.0',
		fromDate: '',
		toDate: '',
		source: 'odpt',
		versionId: '/files-open/odpt/TestOp/AllLines-20260601.zip',
		zipUrl: 'https://example.com/feed.zip',
	};
}

function stubSource(targets: FeedTarget[]): FeedSource {
	return { sourceId: 'odpt', listTargets: async () => targets };
}
```

`createGtfsDataJpSource('10')` は `createGtfsDataJpSource({ prefIds: [10] })` へ置換する。ソース一覧失敗時の前回引き継ぎを期待していた3テストは削除し、Task 3 の `createFeedJob` 失敗テストで要件を担保する。

- [ ] **Step 6: テストが通ることを確認**

Run: `pnpm --filter pipeline exec vitest run src/feedProcessor.test.ts src/run.test.ts`

Expected: PASS。

Run: `pnpm --filter pipeline test`

Expected: PASS。

- [ ] **Step 7: コミット**

```bash
git add pipeline/src/feedProcessor.ts pipeline/src/feedProcessor.test.ts pipeline/src/run.ts pipeline/src/run.test.ts
git commit -m "feat(pipeline): フィード単位処理をQueue向けに切り出す"
```

---

### Task 5: status 保存と finalize

**Files:**
- Create: `pipeline/src/finalize.ts`
- Create: `pipeline/src/finalize.test.ts`
- Create: `pipeline/src/consumer.ts`
- Create: `pipeline/src/consumer.test.ts`

**Interfaces:**
- Consumes: `JobManifest`, `FeedJobStatus`, `FeedJobMessage`.
- Produces: `writeFeedStatus`, `maybeFinalizeJob`, `processFeedJobMessage`.

- [ ] **Step 1: finalize の失敗テストを書く**

`pipeline/src/finalize.test.ts` を作成する。

```ts
import { describe, expect, it } from 'vitest';
import {
	CURRENT_JOB_KEY,
	type FeedJobStatus,
	type JobManifest,
	type JobSummary,
	jobManifestKey,
	jobStatusKey,
} from './jobState';
import { maybeFinalizeJob } from './finalize';
import type { BucketLike } from './storage';
import type { FeedTarget } from './sources/types';

function fakeBucket(): BucketLike & { store: Map<string, string>; deleted: string[] } {
	const store = new Map<string, string>();
	const deleted: string[] = [];
	return {
		store,
		deleted,
		async get(key: string) {
			const v = store.get(key);
			return v === undefined ? null : { text: async () => v };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async list({ prefix }: { prefix: string }) {
			return {
				objects: [...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
				truncated: false,
			};
		},
		async delete(keys: string[]) {
			deleted.push(...keys);
			for (const key of keys) store.delete(key);
		},
	};
}

function target(id: string, source: 'gtfs-data.jp' | 'odpt'): FeedTarget {
	return {
		id,
		name: id,
		orgName: 'org',
		license: null,
		fromDate: '',
		toDate: '',
		source,
		versionId: `v-${id}`,
		zipUrl: `https://example.com/${id}.zip`,
	};
}

function status(t: FeedTarget, value: 'updated' | 'unchanged' | 'error'): FeedJobStatus {
	return {
		jobId: 'job-1',
		finishedAt: '2026-07-07T12:01:00.000Z',
		id: t.id,
		name: t.name,
		orgName: t.orgName,
		license: t.license,
		fromDate: t.fromDate,
		toDate: t.toDate,
		source: t.source,
		status: value,
		error: value === 'error' ? 'broken feed' : undefined,
	};
}

describe('maybeFinalizeJob', () => {
	it('全statusが揃うまでfeeds.jsonを書かない', async () => {
		const bucket = fakeBucket();
		const targets = [target('a', 'gtfs-data.jp'), target('b', 'odpt')];
		const manifest: JobManifest = {
			jobId: 'job-1',
			createdAt: '2026-07-07T12:00:00.000Z',
			targets,
			sources: { 'gtfs-data.jp': 1, odpt: 1 },
			previousFeedsGeneratedAt: null,
		};
		bucket.store.set(jobManifestKey('job-1'), JSON.stringify(manifest));
		bucket.store.set(jobStatusKey('job-1', 'a'), JSON.stringify(status(targets[0], 'updated')));
		const result = await maybeFinalizeJob({ bucket, jobId: 'job-1' });
		expect(result).toEqual({ finalized: false, missing: 1 });
		expect(bucket.store.has('feeds.json')).toBe(false);
	});

	it('全status完了時だけfeeds.json/summary/currentを書き、孤児掃除する', async () => {
		const bucket = fakeBucket();
		const targets = [target('a', 'gtfs-data.jp'), target('b', 'odpt')];
		const manifest: JobManifest = {
			jobId: 'job-1',
			createdAt: '2026-07-07T12:00:00.000Z',
			targets,
			sources: { 'gtfs-data.jp': 1, odpt: 1 },
			previousFeedsGeneratedAt: '2026-06-01T00:00:00.000Z',
		};
		bucket.store.set(jobManifestKey('job-1'), JSON.stringify(manifest));
		bucket.store.set(jobStatusKey('job-1', 'a'), JSON.stringify(status(targets[0], 'updated')));
		bucket.store.set(jobStatusKey('job-1', 'b'), JSON.stringify(status(targets[1], 'error')));
		bucket.store.set('feeds/orphan/bundle.json', '{}');
		bucket.store.set('feeds/a/bundle.json', '{}');
		const result = await maybeFinalizeJob({ bucket, jobId: 'job-1' });
		expect(result).toEqual({ finalized: true, missing: 0 });
		const index = JSON.parse(bucket.store.get('feeds.json') ?? '{}') as { feeds: { id: string }[] };
		expect(index.generatedAt).toBe('2026-07-07T12:00:00.000Z');
		expect(index.feeds.map((feed) => feed.id)).toEqual(['a', 'b']);
		const summary = JSON.parse(
			bucket.store.get('pipeline/jobs/job-1/summary.json') ?? '{}',
		) as JobSummary;
		expect(summary).toEqual({
			jobId: 'job-1',
			generatedAt: '2026-07-07T12:00:00.000Z',
			total: 2,
			updated: 1,
			unchanged: 0,
			error: 1,
			sources: { 'gtfs-data.jp': 1, odpt: 1 },
			published: true,
		});
		expect(JSON.parse(bucket.store.get(CURRENT_JOB_KEY) ?? '{}')).toMatchObject({
			jobId: 'job-1',
			status: 'completed',
			total: 2,
			completed: 2,
		});
		expect(bucket.deleted).toEqual(['feeds/orphan/bundle.json']);
	});
});
```

- [ ] **Step 2: consumer の失敗テストを書く**

`pipeline/src/consumer.test.ts` を作成する。

```ts
import { strToU8, zipSync } from 'fflate';
import { FIXTURE_FILES } from 'gtfs-core';
import { describe, expect, it } from 'vitest';
import { processFeedJobMessage } from './consumer';
import { type FeedJobMessage, type FeedJobStatus, jobManifestKey, jobStatusKey } from './jobState';
import type { BucketLike } from './storage';

function fakeBucket(): BucketLike & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			const v = store.get(key);
			return v === undefined ? null : { text: async () => v };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async list() {
			return { objects: [], truncated: false };
		},
		async delete() {},
	};
}

const ZIP = zipSync(Object.fromEntries(Object.entries(FIXTURE_FILES).map(([k, v]) => [k, strToU8(v)])));

describe('processFeedJobMessage', () => {
	it('フィード処理結果をstatusへ保存する', async () => {
		const bucket = fakeBucket();
		const message: FeedJobMessage = {
			jobId: 'job-1',
			target: {
				id: 'feed-1',
				name: 'feed-1',
				orgName: 'org',
				license: null,
				fromDate: '',
				toDate: '',
				source: 'gtfs-data.jp',
				versionId: 'v1',
				zipUrl: 'https://example.com/feed.zip',
			},
		};
		bucket.store.set(
			jobManifestKey('job-1'),
			JSON.stringify({
				jobId: 'job-1',
				createdAt: '2026-07-07T12:00:00.000Z',
				targets: [message.target],
				sources: { 'gtfs-data.jp': 1, odpt: 0 },
				previousFeedsGeneratedAt: null,
			}),
		);
		const impl = async (): Promise<Response> => new Response(ZIP);
		await processFeedJobMessage({
			bucket,
			fetcher: impl as typeof fetch,
			message,
			now: () => new Date('2026-07-07T12:01:00.000Z'),
		});
		const saved = JSON.parse(bucket.store.get(jobStatusKey('job-1', 'feed-1')) ?? '{}') as FeedJobStatus;
		expect(saved.jobId).toBe('job-1');
		expect(saved.finishedAt).toBe('2026-07-07T12:01:00.000Z');
		expect(saved.status).toBe('updated');
	});
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/finalize.test.ts src/consumer.test.ts`

Expected: FAIL。`finalize` と `consumer` が存在しない。

- [ ] **Step 4: finalize を実装する**

`pipeline/src/finalize.ts` を作成する。

```ts
import { cleanupOrphans } from './run';
import {
	CURRENT_JOB_KEY,
	type FeedJobStatus,
	type FeedStatus,
	type JobCurrent,
	type JobManifest,
	type JobSummary,
	jobManifestKey,
	jobStatusKey,
	jobSummaryKey,
} from './jobState';
import type { BucketLike } from './storage';
import { putJson, readJson } from './storage';

export interface MaybeFinalizeDeps {
	bucket: BucketLike;
	jobId: string;
}

export interface MaybeFinalizeResult {
	finalized: boolean;
	missing: number;
}

function toPublicStatus(status: FeedJobStatus): FeedStatus {
	const publicStatus: FeedStatus = {
		id: status.id,
		name: status.name,
		orgName: status.orgName,
		license: status.license,
		fromDate: status.fromDate,
		toDate: status.toDate,
		source: status.source,
		status: status.status,
		error: status.error,
		shapeSourceCounts: status.shapeSourceCounts,
	};
	return publicStatus;
}

function buildSummary(manifest: JobManifest, statuses: FeedJobStatus[]): JobSummary {
	return {
		jobId: manifest.jobId,
		generatedAt: manifest.createdAt,
		total: statuses.length,
		updated: statuses.filter((s) => s.status === 'updated').length,
		unchanged: statuses.filter((s) => s.status === 'unchanged').length,
		error: statuses.filter((s) => s.status === 'error').length,
		sources: manifest.sources,
		published: true,
	};
}

export async function maybeFinalizeJob({
	bucket,
	jobId,
}: MaybeFinalizeDeps): Promise<MaybeFinalizeResult> {
	const manifest = await readJson<JobManifest>(bucket, jobManifestKey(jobId));
	if (!manifest) throw new Error(`job manifest not found: ${jobId}`);
	const statuses: FeedJobStatus[] = [];
	let missing = 0;
	for (const target of manifest.targets) {
		const status = await readJson<FeedJobStatus>(bucket, jobStatusKey(jobId, target.id));
		if (!status) {
			missing += 1;
			continue;
		}
		statuses.push(status);
	}
	if (missing > 0) return { finalized: false, missing };
	const feeds = statuses.map(toPublicStatus);
	await putJson(bucket, 'feeds.json', { generatedAt: manifest.createdAt, feeds });
	const summary = buildSummary(manifest, statuses);
	await putJson(bucket, jobSummaryKey(jobId), summary);
	const current: JobCurrent = {
		jobId,
		status: 'completed',
		createdAt: manifest.createdAt,
		total: manifest.targets.length,
		completed: statuses.length,
	};
	await putJson(bucket, CURRENT_JOB_KEY, current);
	await cleanupOrphans(bucket, new Set(manifest.targets.map((target) => target.id)));
	return { finalized: true, missing: 0 };
}
```

- [ ] **Step 5: consumer 処理を実装する**

`pipeline/src/consumer.ts` を作成する。

```ts
import { maybeFinalizeJob } from './finalize';
import { processFeedTarget } from './feedProcessor';
import { type FeedJobMessage, type FeedJobStatus, jobStatusKey } from './jobState';
import type { BucketLike } from './storage';
import { putJson } from './storage';

export interface ProcessFeedJobMessageDeps {
	bucket: BucketLike;
	fetcher: typeof fetch;
	message: FeedJobMessage;
	now(): Date;
}

export async function processFeedJobMessage({
	bucket,
	fetcher,
	message,
	now,
}: ProcessFeedJobMessageDeps): Promise<void> {
	const status = await processFeedTarget({ bucket, fetcher, target: message.target });
	const jobStatus: FeedJobStatus = {
		...status,
		jobId: message.jobId,
		finishedAt: now().toISOString(),
	};
	await putJson(bucket, jobStatusKey(message.jobId, message.target.id), jobStatus);
	await maybeFinalizeJob({ bucket, jobId: message.jobId });
}
```

- [ ] **Step 6: テストが通ることを確認**

Run: `pnpm --filter pipeline exec vitest run src/finalize.test.ts src/consumer.test.ts`

Expected: PASS。

Run: `pnpm --filter pipeline test`

Expected: PASS。

- [ ] **Step 7: コミット**

```bash
git add pipeline/src/finalize.ts pipeline/src/finalize.test.ts pipeline/src/consumer.ts pipeline/src/consumer.test.ts
git commit -m "feat(pipeline): Queue処理結果のfinalizeを追加する"
```

---

### Task 6: Worker handlers と Cloudflare Queues 設定

**Files:**
- Modify: `pipeline/src/index.ts`
- Modify: `pipeline/wrangler.jsonc`
- Modify: `pipeline/package.json`
- Generate: `pipeline/worker-configuration.d.ts`

**Interfaces:**
- Consumes: generated `Env`, `Queue<FeedJobMessage>`, `MessageBatch<FeedJobMessage>`.
- Produces: `scheduled()` producer handler and `queue()` consumer handler.

- [ ] **Step 1: package script を追加する**

`pipeline/package.json` の `scripts` を次の形にする。

```json
{
	"dev": "wrangler dev --test-scheduled --persist-to ../.wrangler/state",
	"deploy": "wrangler deploy",
	"test": "vitest run",
	"check": "tsc --noEmit",
	"cf:check": "wrangler check",
	"cf:types": "wrangler types"
}
```

- [ ] **Step 2: wrangler.jsonc に Queue binding を追加する**

`pipeline/wrangler.jsonc` を次の内容にする。

```jsonc
{
	"$schema": "./node_modules/wrangler/config-schema.json",
	"name": "gtfs-view-bus-pipeline",
	"main": "src/index.ts",
	"compatibility_date": "2026-07-07",
	// 毎月末日 20:00 UTC = 翌月1日 05:00 JST。L記法が拒否されたら "0 0 1 * *" に変更
	"triggers": { "crons": ["0 20 L * *"] },
	"r2_buckets": [{ "binding": "DATA_BUCKET", "bucket_name": "gtfs-view-bus-data" }],
	"queues": {
		"producers": [{ "binding": "FEED_QUEUE", "queue": "gtfs-view-bus-feed-jobs" }],
		"consumers": [
			{
				"queue": "gtfs-view-bus-feed-jobs",
				"max_batch_size": 5,
				"max_batch_timeout": 30,
				"max_retries": 3,
				"dead_letter_queue": "gtfs-view-bus-feed-jobs-dlq",
				"max_concurrency": 2,
				"retry_delay": 120
			}
		]
	},
	"limits": { "cpu_ms": 300000 },
	"observability": { "enabled": true, "head_sampling_rate": 1 }
}
```

- [ ] **Step 3: Worker 型を生成する**

Run: `pnpm --filter pipeline cf:types`

Expected: `pipeline/worker-configuration.d.ts` が生成される。`Env` に `DATA_BUCKET` と `FEED_QUEUE` が含まれる。

- [ ] **Step 4: `index.ts` を producer/consumer 両対応にする**

`pipeline/src/index.ts` を次の内容にする。`Env` は Step 3 の生成型を使い、手書き interface は置かない。

```ts
import { processFeedJobMessage } from './consumer';
import { createFeedJob } from './jobProducer';
import type { FeedJobMessage } from './jobState';
import { toBucketLike } from './storage';
import { createGtfsDataJpSource } from './sources/gtfsDataJp';
import { createOdptSource } from './sources/odpt';

function randomBytes(): Uint8Array {
	const bytes = new Uint8Array(3);
	crypto.getRandomValues(bytes);
	return bytes;
}

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			createFeedJob({
				bucket: toBucketLike(env.DATA_BUCKET),
				queue: env.FEED_QUEUE,
				fetcher: fetch,
				sources: [createGtfsDataJpSource(), createOdptSource()],
				now: () => new Date(),
				randomBytes,
			}),
		);
	},
	async queue(batch: MessageBatch<FeedJobMessage>, env: Env): Promise<void> {
		const bucket = toBucketLike(env.DATA_BUCKET);
		for (const message of batch.messages) {
			try {
				await processFeedJobMessage({
					bucket,
					fetcher: fetch,
					message: message.body,
					now: () => new Date(),
				});
				message.ack();
			} catch (error) {
				console.error(
					JSON.stringify({
						event: 'feed_job_message_failed',
						messageId: message.id,
						attempts: message.attempts,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<Env, FeedJobMessage>;
```

- [ ] **Step 5: 設定と型チェックを検証する**

Run: `pnpm --filter pipeline check`

Expected: PASS。

Run: `pnpm --filter pipeline cf:check`

Expected: PASS。Queue binding と `limits.cpu_ms` が wrangler schema 上有効であること。

- [ ] **Step 6: テストを全件実行する**

Run: `pnpm --filter pipeline test`

Expected: PASS。

- [ ] **Step 7: コミット**

```bash
git add pipeline/src/index.ts pipeline/wrangler.jsonc pipeline/package.json pipeline/worker-configuration.d.ts
git commit -m "feat(pipeline): Cloudflare Queuesで全国変換を起動する"
```

---

### Task 7: ODPT CKAN HTML 解析スクリプト

**Files:**
- Modify: `pipeline/package.json`
- Modify: `pipeline/tsconfig.json`
- Create: `pipeline/src/sources/odptCkan.ts`
- Create: `pipeline/src/sources/odptCkan.test.ts`
- Create: `pipeline/src/sources/fixtures/odpt-catalog-page.html`
- Create: `pipeline/src/sources/fixtures/odpt-dataset-page.html`
- Create: `pipeline/scripts/update-odpt-manifest.ts`

**Interfaces:**
- Consumes: CKAN catalog/dataset/resource HTML.
- Produces: stable sorted `OdptManifestFile`.

- [ ] **Step 1: 依存関係と scripts を追加する**

Run: `pnpm --filter pipeline add -D cheerio tsx`

Expected: `pipeline/package.json` に `cheerio` と `tsx` が `devDependencies` として追加される。

`pipeline/package.json` の `scripts` に次を追加する。

```json
{
	"update:odpt-manifest": "tsx scripts/update-odpt-manifest.ts"
}
```

`pipeline/tsconfig.json` の `include` を次の形にする。

```json
{
	"include": ["src", "scripts"]
}
```

- [ ] **Step 2: 失敗するパーサーテストを書く**

`pipeline/src/sources/fixtures/odpt-catalog-page.html` を作成する。

```html
<!doctype html>
<html lang="ja">
	<body>
		<ul class="dataset-list">
			<li class="dataset-item">
				<h2 class="dataset-heading">
					<a href="/dataset/takasaki_city_yosiibus">よしいバス</a>
				</h2>
				<a class="label" data-format="gtfs/gtfs-jp" href="/dataset/takasaki_city_yosiibus">
					GTFS/GTFS-JP
				</a>
			</li>
		</ul>
		<ul class="pagination">
			<li><a href="/dataset/?res_format=GTFS%2FGTFS-JP&amp;page=2">»</a></li>
		</ul>
	</body>
</html>
```

`pipeline/src/sources/fixtures/odpt-dataset-page.html` を作成する。

```html
<!doctype html>
<html lang="ja">
	<body>
		<section class="module-content">
			<h1>よしいバス</h1>
			<a href="/organization/takasaki_city">高崎市</a>
			<section class="resources">
				<li class="resource-item" data-id="res-yosii">
					<a class="heading" href="/dataset/takasaki_city_yosiibus/resource/res-yosii">
						GTFS/GTFS-JP
					</a>
					<a
						class="resource-url-analytics"
						href="https://api-public.odpt.org/api/v4/files/odpt/TakasakiCity/yosiibus.zip?date=current"
					>
						download
					</a>
				</li>
			</section>
			<span property="dc:license">CC BY 4.0</span>
		</section>
	</body>
</html>
```

`pipeline/src/sources/odptCkan.test.ts` を作成する。

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCatalogPage, parseDatasetPage, sortManifestEntries } from './odptCkan';

const catalogHtml = readFileSync('src/sources/fixtures/odpt-catalog-page.html', 'utf8');
const datasetHtml = readFileSync('src/sources/fixtures/odpt-dataset-page.html', 'utf8');

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
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/sources/odptCkan.test.ts`

Expected: FAIL。`odptCkan` が存在しない。

- [ ] **Step 4: CKAN パーサーを実装する**

`pipeline/src/sources/odptCkan.ts` を作成する。

```ts
import * as cheerio from 'cheerio';
import type { OdptManifestEntry, OdptManifestFile } from './odptManifestTypes';

export interface CatalogPage {
	datasetUrls: string[];
	nextUrl: string | null;
}

const CATALOG_START_URL = 'https://ckan.odpt.org/dataset/?res_format=GTFS%2FGTFS-JP';
const ODPT_ZIP_PATTERN = /\/files\/odpt\/([^/]+)\/([^/?]+)\.zip/;

function absoluteUrl(href: string, baseUrl: string): string {
	return new URL(href, baseUrl).toString();
}

function text(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function datasetIdFromUrl(url: string): string {
	const pathname = new URL(url).pathname;
	const id = pathname.split('/').filter(Boolean).at(-1);
	if (!id) throw new Error(`dataset id not found: ${url}`);
	return id;
}

function resourceIdFromHref(href: string): string {
	const parts = new URL(href, 'https://ckan.odpt.org/').pathname.split('/').filter(Boolean);
	return parts.at(-1) ?? '';
}

export function parseCatalogPage(html: string, pageUrl: string): CatalogPage {
	const $ = cheerio.load(html);
	const urls = new Set<string>();
	$('.dataset-item').each((_, item) => {
		const hasGtfs = $(item).find('[data-format="gtfs/gtfs-jp"]').length > 0;
		const href = $(item).find('.dataset-heading a').attr('href');
		if (hasGtfs && href) urls.add(absoluteUrl(href, pageUrl));
	});
	let nextUrl: string | null = null;
	$('.pagination a').each((_, anchor) => {
		if (text($(anchor).text()) === '»') {
			const href = $(anchor).attr('href');
			if (href && href !== '#') nextUrl = absoluteUrl(href, pageUrl);
		}
	});
	return { datasetUrls: [...urls].sort(), nextUrl };
}

export function parseDatasetPage(html: string, datasetUrl: string): OdptManifestEntry[] {
	const $ = cheerio.load(html);
	const datasetId = datasetIdFromUrl(datasetUrl);
	const name = text($('h1').first().text()) || datasetId;
	const orgName = text($('a[href^="/organization/"]').first().text());
	const licenseText = text($('[property="dc:license"]').first().text());
	const entries: OdptManifestEntry[] = [];
	$('a[href*="/files/odpt/"]').each((_, link) => {
		const zipUrl = $(link).attr('href');
		if (!zipUrl) return;
		const match = zipUrl.match(ODPT_ZIP_PATTERN);
		if (!match) return;
		const resource = $(link).closest('.resource-item');
		const resourceHref = resource.find('a[href*="/resource/"]').first().attr('href') ?? '';
		entries.push({
			datasetId,
			resourceId: resource.attr('data-id') ?? resourceIdFromHref(resourceHref),
			operator: match[1],
			feed: match[2],
			name,
			orgName,
			license: licenseText || null,
			fromDate: '',
			toDate: '',
			zipUrl,
		});
	});
	return entries;
}

export function sortManifestEntries(entries: OdptManifestEntry[]): OdptManifestEntry[] {
	return [...entries].sort((a, b) => {
		const keyA = `${a.operator}\u0000${a.feed}\u0000${a.datasetId}`;
		const keyB = `${b.operator}\u0000${b.feed}\u0000${b.datasetId}`;
		return keyA.localeCompare(keyB);
	});
}

export async function collectOdptManifest(fetcher: typeof fetch, now: Date): Promise<OdptManifestFile> {
	const datasetUrls = new Set<string>();
	let nextUrl: string | null = CATALOG_START_URL;
	while (nextUrl) {
		const res = await fetcher(nextUrl);
		if (!res.ok) throw new Error(`ODPT catalog fetch failed: ${res.status}`);
		const page = parseCatalogPage(await res.text(), nextUrl);
		for (const datasetUrl of page.datasetUrls) datasetUrls.add(datasetUrl);
		nextUrl = page.nextUrl;
	}
	const entries: OdptManifestEntry[] = [];
	for (const datasetUrl of [...datasetUrls].sort()) {
		const res = await fetcher(datasetUrl);
		if (!res.ok) throw new Error(`ODPT dataset fetch failed: ${res.status} ${datasetUrl}`);
		entries.push(...parseDatasetPage(await res.text(), datasetUrl));
	}
	const feeds = sortManifestEntries(entries);
	if (feeds.length === 0) throw new Error('ODPT manifest has no feeds');
	return { generatedAt: now.toISOString(), feeds };
}
```

- [ ] **Step 5: 更新 CLI を実装する**

`pipeline/scripts/update-odpt-manifest.ts` を作成する。

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { collectOdptManifest } from '../src/sources/odptCkan';
import type { OdptManifestFile } from '../src/sources/odptManifestTypes';

const OUTPUT_PATH = new URL('../src/sources/odptManifest.json', import.meta.url);

async function readExisting(): Promise<OdptManifestFile | null> {
	try {
		return JSON.parse(await readFile(OUTPUT_PATH, 'utf8')) as OdptManifestFile;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const existing = await readExisting();
	const manifest = await collectOdptManifest(fetch, new Date());
	if (manifest.feeds.length === 0) {
		throw new Error('ODPT manifest update produced zero feeds');
	}
	if (existing && manifest.feeds.length < existing.feeds.length) {
		throw new Error(
			`ODPT manifest shrank from ${existing.feeds.length} to ${manifest.feeds.length}; keep existing file`,
		);
	}
	await writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, '\t')}\n`);
	console.log(`updated ${OUTPUT_PATH.pathname}: ${manifest.feeds.length} feeds`);
}

await main();
```

- [ ] **Step 6: パーサーテストと型チェックを通す**

Run: `pnpm --filter pipeline exec vitest run src/sources/odptCkan.test.ts`

Expected: PASS。

Run: `pnpm --filter pipeline check`

Expected: PASS。`scripts/update-odpt-manifest.ts` も型チェック対象になる。

- [ ] **Step 7: マニフェストを更新する**

Run: `pnpm --filter pipeline update:odpt-manifest`

Expected: `pipeline/src/sources/odptManifest.json` が全国 ODPT GTFS/GTFS-JP の件数へ更新される。件数は 2026-07-07 の事前調査では 106 件前後。

- [ ] **Step 8: 差分を確認してコミット**

Run: `git diff -- pipeline/src/sources/odptManifest.json`

Expected: JSON が `operator` / `feed` 順に安定ソートされ、既存 8 フィードの `operator` / `feed` は維持されている。

```bash
git add pipeline/package.json pipeline/tsconfig.json pipeline/src/sources/odptCkan.ts pipeline/src/sources/odptCkan.test.ts pipeline/src/sources/fixtures/odpt-catalog-page.html pipeline/src/sources/fixtures/odpt-dataset-page.html pipeline/scripts/update-odpt-manifest.ts pipeline/src/sources/odptManifest.json pnpm-lock.yaml
git commit -m "feat(pipeline): ODPTマニフェスト更新スクリプトを追加する"
```

---

### Task 8: 全体検証と運用手順

**Files:**
- Modify: `pipeline/README.md` if it exists; otherwise create `pipeline/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed pipeline implementation.
- Produces: repeatable verification commands and first-run operational note.

- [ ] **Step 1: pipeline README を作成する**

`pipeline/README.md` が無い場合は作成し、ある場合は次の節を追加する。

```md
# gtfs-view-bus-pipeline

## 全国GTFS Queue pipeline

月次 Cron は GTFS 変換を直接実行せず、gtfs-data.jp 全国全件と ODPT 静的マニフェストから `FeedTarget` 一覧を作成して Cloudflare Queues へ投入する。Queue consumer は 1 メッセージ 1 フィードを処理し、全 status が R2 に揃った時だけ `feeds.json` を差し替える。

## R2 keys

- `feeds.json`
- `feeds/<feedId>/bundle.json`
- `feeds/<feedId>/routes.geojson`
- `feeds/<feedId>/stops.geojson`
- `feeds/<feedId>/timetable.json`
- `feeds/<feedId>/meta.json`
- `pipeline/jobs/<jobId>/manifest.json`
- `pipeline/jobs/<jobId>/statuses/<encodedFeedId>.json`
- `pipeline/jobs/<jobId>/summary.json`
- `pipeline/jobs/current.json`

## Verification

```bash
pnpm --filter pipeline test
pnpm --filter pipeline check
pnpm --filter pipeline cf:check
pnpm --filter pipeline cf:types
```

## ODPT manifest update

```bash
pnpm --filter pipeline update:odpt-manifest
git diff -- pipeline/src/sources/odptManifest.json
```

更新スクリプトは開発時だけ実行する。Worker 実行時に CKAN HTML は解析しない。

## First nationwide run

本番初回の全国投入は手動で実行し、`pipeline/jobs/current.json`、`pipeline/jobs/<jobId>/summary.json`、Queues の DLQ を確認する。Workers Free の CPU 制限では GTFS 変換の安定完走を前提にしないため、本番運用は Workers Paid を推奨する。
```

- [ ] **Step 2: ルート README に pipeline の入口を追記する**

`README.md` の pipeline 説明節に次を追加する。

```md
### Pipeline

`pipeline/` は Cloudflare Workers Cron + Queues + R2 で GTFS を月次変換する。公開形式は `feeds.json` と `feeds/<feedId>/...` を維持するため、アプリ側の `/data/*` 読み取り契約は変えない。

詳しい検証手順と ODPT マニフェスト更新手順は `pipeline/README.md` を参照。
```

- [ ] **Step 3: 全検証を実行する**

Run: `pnpm test`

Expected: PASS。

Run: `pnpm check`

Expected: PASS。

Run: `pnpm lint`

Expected: PASS。

Run: `pnpm --filter pipeline cf:check`

Expected: PASS。

- [ ] **Step 4: 計画要件との照合を行う**

確認項目:

- gtfs-data.jp 未指定モードが `/v2/files` を呼ぶ。
- ODPT Worker 実行時に HTML 解析コードが import されていない。
- `scheduled()` は Queue 投入だけで、GTFS zip 変換を実行しない。
- `queue()` は通常のフィード処理エラーで `error` status を書いて ack する。
- status 書き込みや finalize の R2 失敗では `message.retry()` に進む。
- `feeds.json` は全 status が揃うまで書かれない。
- `feeds/<feedId>/bundle.json`、`routes.geojson`、`stops.geojson`、`timetable.json`、`meta.json` は維持される。
- `meta.json` は各フィードの最後に書かれる。
- 孤児掃除は finalize 後だけ実行され、`status: "error"` のフィード ID も active 扱いになる。

- [ ] **Step 5: 最終コミット**

```bash
git add pipeline/README.md README.md
git commit -m "docs(pipeline): 全国GTFS Queue運用手順を追加する"
```

---

## Self-Review

- Spec coverage: gtfs-data.jp 全件、ODPT 静的マニフェスト、Queue job 投入、フィード単位 status、finalize、DLQ 前提、孤児掃除、既存公開キー維持を Task 1-8 でカバーした。
- Placeholder scan: 未決定の空欄、後回し指示、詳細無しのテスト指示は含めていない。
- Type consistency: `FeedTarget`、`FeedJobMessage`、`FeedJobStatus`、`JobManifest`、`JobCurrent`、`JobSummary` の名前とプロパティは全タスクで統一した。
- Risk note: ODPT CKAN HTML は外部構造依存なので、Worker 実行時には絶対に import しない。HTML 変更時は Task 7 の parser fixture と selector を同時に更新する。
