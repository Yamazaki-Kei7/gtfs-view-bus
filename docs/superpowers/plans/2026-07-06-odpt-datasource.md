# ODPTデータソース追加 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 公共交通オープンデータセンター(ODPT)の8フィード（高崎市・前橋市エリア）をパイプラインに追加し、gtfs-data.jpと併用するソースアダプタ構造に再編する。R2の孤児データ掃除も導入する。

**Architecture:** `FeedSource` インターフェース（`listFeeds()` がソース非依存の `FeedDescriptor[]` を返す）を導入し、gtfs-data.jp用とODPT用の2実装を用意。`runPipeline` のメインループは記述子だけを見て「versionId比較 → スキップ or 変換 → R2書き込み → meta最後」を行う1本に統合。ODPTはGeoJSON別配布が無いため、gtfs-coreに追加する純関数でGTFSから `stops.geojson` / `routes.geojson` を生成する。実行の最後に `feeds/` 配下の孤児キーを削除する（ソース一覧取得が1つでも失敗した実行ではスキップ）。

**Tech Stack:** TypeScript / Cloudflare Workers (R2, Cron) / fflate / vitest / SvelteKit + svelte-maplibre-gl / pnpm workspace

**Spec:** `docs/superpowers/specs/2026-07-06-odpt-datasource-design.md`

**環境準備（各タスク共通）:**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/yamakei/Documents/GitHub/01_poc/gtfs-view-bus/.worktrees/gtfs-webgis
git branch --show-current   # feature/odpt-datasource であること
```

**コーディング規約（このリポジトリ）:** インデントはタブ。TypeScriptで `any` / `unknown` / `class` を使わない。コメントは日本語。

---

### Task 1: gtfs-core にGeoJSON生成関数を追加

ODPTフィードにはソース提供の `stops.geojson` / `routes.geojson` が無い。アプリの地図描画（`app/src/routes/+page.svelte` の GeoJSONSource）はこの2ファイルに依存するため、GTFSから生成する純関数を gtfs-core に追加する。アプリはジオメトリのみ使用しプロパティ非依存（確認済み）。

**Files:**
- Create: `packages/gtfs-core/src/geojson.ts`
- Create: `packages/gtfs-core/src/geojson.test.ts`
- Modify: `packages/gtfs-core/src/index.ts`（exportを1行追加）

- [ ] **Step 1: 失敗するテストを書く**

`packages/gtfs-core/src/geojson.test.ts` を新規作成:

```ts
import { describe, expect, it } from 'vitest';
import { convertFeed } from './convert';
import { FIXTURE_FILES } from './fixture';
import { shapesToGeojson, stopsToGeojson } from './geojson';

describe('stopsToGeojson', () => {
	it('stops.txt をPointのFeatureCollectionへ変換する', () => {
		const fc = stopsToGeojson(FIXTURE_FILES);
		expect(fc.type).toBe('FeatureCollection');
		expect(fc.features).toHaveLength(3);
		expect(fc.features[0]).toEqual({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [139, 36] },
			properties: { stop_id: 'A', stop_name: '駅前' },
		});
	});

	it('座標が数値でない行と空欄の行はスキップする', () => {
		const files = {
			'stops.txt':
				'stop_id,stop_name,stop_lat,stop_lon\nX,壊れ,abc,139.0\nY,空欄,,139.0\nZ,正常,36.0,139.0\n',
		};
		const fc = stopsToGeojson(files);
		expect(fc.features).toHaveLength(1);
		expect(fc.features[0].properties.stop_id).toBe('Z');
	});

	it('stops.txt が無ければ空のFeatureCollectionを返す', () => {
		expect(stopsToGeojson({}).features).toHaveLength(0);
	});
});

describe('shapesToGeojson', () => {
	it('bundleのshapesをLineStringのFeatureCollectionへ変換する', () => {
		const bundle = convertFeed(FIXTURE_FILES);
		const fc = shapesToGeojson(bundle);
		expect(fc.type).toBe('FeatureCollection');
		expect(fc.features.length).toBeGreaterThan(0);
		for (const f of fc.features) {
			expect(f.geometry.type).toBe('LineString');
			expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
		}
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core test src/geojson.test.ts`
Expected: FAIL（`./geojson` が存在しないため解決エラー）

- [ ] **Step 3: 実装を書く**

`packages/gtfs-core/src/geojson.ts` を新規作成:

```ts
import { parseCsv } from './csv';
import type { FeedBundle, LngLat } from './types';

export interface PointFeature {
	type: 'Feature';
	geometry: { type: 'Point'; coordinates: LngLat };
	properties: { stop_id: string; stop_name: string };
}

export interface LineFeature {
	type: 'Feature';
	geometry: { type: 'LineString'; coordinates: LngLat[] };
	properties: { shape_id: string };
}

export interface GeneratedFeatureCollection<F> {
	type: 'FeatureCollection';
	features: F[];
}

/** stops.txt からPointのFeatureCollectionを生成する(ソース提供のstops.geojsonが無いフィード用) */
export function stopsToGeojson(
	files: Record<string, string>,
): GeneratedFeatureCollection<PointFeature> {
	const features: PointFeature[] = [];
	for (const row of parseCsv(files['stops.txt'] ?? '')) {
		// Number('') は 0 になるため空欄は先に弾く
		if (!row.stop_lat || !row.stop_lon) continue;
		const lon = Number(row.stop_lon);
		const lat = Number(row.stop_lat);
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
		features.push({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [lon, lat] },
			properties: { stop_id: row.stop_id, stop_name: row.stop_name },
		});
	}
	return { type: 'FeatureCollection', features };
}

/** 変換済みbundleのshapesからLineStringのFeatureCollectionを生成する(ソース提供のroutes.geojsonが無いフィード用) */
export function shapesToGeojson(bundle: FeedBundle): GeneratedFeatureCollection<LineFeature> {
	const features: LineFeature[] = [];
	for (const [shapeId, shape] of Object.entries(bundle.shapes)) {
		if (shape.coords.length < 2) continue;
		features.push({
			type: 'Feature',
			geometry: { type: 'LineString', coordinates: shape.coords },
			properties: { shape_id: shapeId },
		});
	}
	return { type: 'FeatureCollection', features };
}
```

`packages/gtfs-core/src/index.ts` の `export * from './convert';` の下に追加:

```ts
export * from './geojson';
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter gtfs-core test`
Expected: 全テストPASS（既存テスト含む）

- [ ] **Step 5: 型チェックとコミット**

```bash
pnpm --filter gtfs-core check
git add packages/gtfs-core/src/geojson.ts packages/gtfs-core/src/geojson.test.ts packages/gtfs-core/src/index.ts
git commit -m "feat(gtfs-core): GTFSからstops/routes GeoJSONを生成する関数を追加"
```

---

### Task 2: ソース抽象の型定義と gtfs-data.jp アダプタ

**Files:**
- Create: `pipeline/src/sources/types.ts`
- Create: `pipeline/src/sources/gtfsDataJp.ts`
- Create: `pipeline/src/sources/gtfsDataJp.test.ts`

- [ ] **Step 1: 型定義を書く**

`pipeline/src/sources/types.ts` を新規作成:

```ts
/** フィードの取得元レジストリ */
export type SourceId = 'gtfs-data.jp' | 'odpt';

/** ソース非依存のフィード記述子。メインループはこれだけを見て処理する */
export interface FeedDescriptor {
	/** R2キー用の一意ID */
	id: string;
	/** フィード名(フッター表示用) */
	name: string;
	orgName: string;
	license: string | null;
	/** fromDate/toDate はODPTでは提供されないため空文字(アプリ未使用) */
	fromDate: string;
	toDate: string;
	source: SourceId;
	/** 差分検出キー。前回metaと一致すれば再処理をスキップする */
	versionId: string;
	fetchZip(fetcher: typeof fetch): Promise<Uint8Array>;
	/** ソースがGeoJSONを別配布している場合のみ設定。無ければGTFSから生成する */
	stopsGeojsonUrl?: string;
	routesGeojsonUrl?: string;
}

export interface FeedSource {
	sourceId: SourceId;
	listFeeds(fetcher: typeof fetch): Promise<FeedDescriptor[]>;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`pipeline/src/sources/gtfsDataJp.test.ts` を新規作成:

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
		expect(d.stopsGeojsonUrl).toBe('https://example.com/stops.geojson');
		expect(d.routesGeojsonUrl).toBe('https://example.com/routes.geojson');
		expect(await d.fetchZip(fetcherFor([]))).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('一覧APIの失敗でthrowする', async () => {
		const impl = async (): Promise<Response> => new Response('error', { status: 500 });
		await expect(createGtfsDataJpSource('10').listFeeds(impl as typeof fetch)).rejects.toThrow(
			'feed list fetch failed',
		);
	});

	it('stop/route URLがnullならundefinedになる', async () => {
		const feeds = await createGtfsDataJpSource('10').listFeeds(
			fetcherFor([entry({ file_stop_url: null, file_route_url: null })]),
		);
		expect(feeds[0].stopsGeojsonUrl).toBeUndefined();
		expect(feeds[0].routesGeojsonUrl).toBeUndefined();
	});
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm --filter pipeline test src/sources/gtfsDataJp.test.ts`
Expected: FAIL（`./gtfsDataJp` が存在しないため解決エラー）

- [ ] **Step 4: 実装を書く**

`pipeline/src/sources/gtfsDataJp.ts` を新規作成（`GtfsFileEntry` は既存 `run.ts` からの移設。Task 4 で `run.ts` 側を削除する）:

```ts
import type { FeedDescriptor, FeedSource } from './types';

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

const API_BASE = 'https://api.gtfs-data.jp/v2';

/** GTFSデータリポジトリ(gtfs-data.jp)の県別一覧APIをFeedSourceへ適合させる */
export function createGtfsDataJpSource(prefId: string): FeedSource {
	return {
		sourceId: 'gtfs-data.jp',
		async listFeeds(fetcher) {
			const listRes = await fetcher(`${API_BASE}/files?pref=${prefId}`);
			if (!listRes.ok) throw new Error(`feed list fetch failed: ${listRes.status}`);
			const list = (await listRes.json()) as FilesResponse;
			// HTTP 200でエラーボディが返るケースの診断性を上げる実行時ガード
			if (!Array.isArray(list.body)) throw new Error('feed list response malformed');
			return list.body.map((entry): FeedDescriptor => ({
				id: `${entry.organization_id}~${entry.feed_id}~${entry.file_from_date}`,
				name: entry.feed_name,
				orgName: entry.organization_name,
				license: entry.feed_license_id,
				fromDate: entry.file_from_date,
				toDate: entry.file_to_date,
				source: 'gtfs-data.jp',
				versionId: entry.file_uid,
				stopsGeojsonUrl: entry.file_stop_url ?? undefined,
				routesGeojsonUrl: entry.file_route_url ?? undefined,
				async fetchZip(f) {
					const zipRes = await f(entry.file_url);
					if (!zipRes.ok) throw new Error(`zip fetch failed: ${zipRes.status}`);
					return new Uint8Array(await zipRes.arrayBuffer());
				},
			}));
		},
	};
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm --filter pipeline test src/sources/gtfsDataJp.test.ts`
Expected: PASS（3件）。※ この時点で `run.ts` は未改修のため他テストへの影響なし

- [ ] **Step 6: コミット**

```bash
git add pipeline/src/sources/
git commit -m "feat(pipeline): ソースアダプタ型とgtfs-data.jpソースを追加"
```

---

### Task 3: ODPTソース

版数検出: zip URLへ `redirect: 'manual'` でGETし、302の `Location` パス（例: `/files-open/odpt/TakasakiCity/yosiibus-20260421.zip`）を `versionId` にする。SASトークン付きの `Location` URLは約2分で失効するため `fetchZip` では使い回さず、改めて `redirect: 'follow'`（デフォルト）でGETする。

**Files:**
- Create: `pipeline/src/sources/odpt.ts`
- Create: `pipeline/src/sources/odpt.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/src/sources/odpt.test.ts` を新規作成:

```ts
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline test src/sources/odpt.test.ts`
Expected: FAIL（`./odpt` が存在しないため解決エラー）

- [ ] **Step 3: 実装を書く**

`pipeline/src/sources/odpt.ts` を新規作成:

```ts
import type { FeedDescriptor, FeedSource } from './types';

interface OdptFeedDef {
	operator: string;
	feed: string;
	name: string;
	orgName: string;
}

/**
 * 配信対象のODPTフィード一覧。ODPTには県別一覧APIが無いためハードコードする。
 * 全フィード CC BY 4.0(各CKANデータセットページ https://ckan.odpt.org/ に明記)。
 * 選定根拠は docs/superpowers/specs/2026-07-06-odpt-datasource-design.md を参照。
 */
export const ODPT_FEEDS: OdptFeedDef[] = [
	{ operator: 'TakasakiCity', feed: 'yosiibus', name: 'よしいバス', orgName: '高崎市' },
	{ operator: 'GunmaBus', feed: 'AllLines', name: '群馬バス(全路線)', orgName: '群馬バス' },
	{
		operator: 'GunmachuoBus',
		feed: 'AllLines',
		name: '群馬中央バス(全路線)',
		orgName: '群馬中央バス',
	},
	{
		operator: 'JoshinKankoBus',
		feed: 'AllLines',
		name: '上信観光バス(全路線)',
		orgName: '上信観光バス',
	},
	{
		operator: 'JoshinHire',
		feed: 'AllLines',
		name: '上信ハイヤー(全路線)',
		orgName: '上信ハイヤー',
	},
	{
		operator: 'Kan_etsuTransportation',
		feed: 'AllLines',
		name: '関越交通(全路線)',
		orgName: '関越交通',
	},
	{
		operator: 'NipponChuoBus',
		feed: 'Maebashi_Area',
		name: '日本中央バス(前橋エリア)',
		orgName: '日本中央バス',
	},
	{
		operator: 'NagaiTransportation',
		feed: 'AllLines',
		name: '永井運輸(全路線)',
		orgName: '永井運輸',
	},
];

const API_BASE = 'https://api-public.odpt.org/api/v4/files/odpt';

function zipUrl(def: OdptFeedDef): string {
	return `${API_BASE}/${def.operator}/${def.feed}.zip?date=current`;
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * versionId(と200直返し時のみzip本体)を解決する。
 * 302のLocationパスにはデータ版数入りのファイル名が含まれるため、
 * zip本体をダウンロードせずに更新有無を判定できる。
 */
async function resolveVersion(
	fetcher: typeof fetch,
	def: OdptFeedDef,
): Promise<{ versionId: string; body?: Uint8Array }> {
	const res = await fetcher(zipUrl(def), { redirect: 'manual' });
	if (res.status >= 300 && res.status < 400) {
		const loc = res.headers.get('location');
		if (!loc) throw new Error(`redirect without location: ${def.operator}/${def.feed}`);
		return { versionId: new URL(loc, API_BASE).pathname };
	}
	if (res.ok) {
		// リダイレクトを挟まない構成に変わった場合: 本体のハッシュを版数とし、本体は変換に再利用する
		const body = new Uint8Array(await res.arrayBuffer());
		return { versionId: await sha256Hex(body), body };
	}
	throw new Error(`odpt zip fetch failed: ${res.status} (${def.operator}/${def.feed})`);
}

/** 公共交通オープンデータセンター(ODPT)のファイルAPIをFeedSourceへ適合させる */
export function createOdptSource(): FeedSource {
	return {
		sourceId: 'odpt',
		async listFeeds(fetcher) {
			const descriptors: FeedDescriptor[] = [];
			for (const def of ODPT_FEEDS) {
				const base = {
					id: `odpt~${def.operator}~${def.feed}`,
					name: def.name,
					orgName: def.orgName,
					license: 'CC BY 4.0',
					fromDate: '',
					toDate: '',
					source: 'odpt' as const,
				};
				try {
					const { versionId, body } = await resolveVersion(fetcher, def);
					descriptors.push({
						...base,
						versionId,
						fetchZip: body
							? async () => body
							: async (f) => {
									const res = await f(zipUrl(def));
									if (!res.ok) throw new Error(`zip fetch failed: ${res.status}`);
									return new Uint8Array(await res.arrayBuffer());
								},
					});
				} catch (e) {
					// 版数解決に失敗したフィードはメインループのフィード単位エラー処理に載せるため、
					// 「fetchZipが必ず失敗する記述子」として一覧に残す(掃除の対象にもならない)
					descriptors.push({
						...base,
						versionId: '',
						fetchZip: () => Promise.reject(e instanceof Error ? e : new Error(String(e))),
					});
				}
			}
			return descriptors;
		},
	};
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter pipeline test src/sources/odpt.test.ts`
Expected: PASS（4件）

- [ ] **Step 5: コミット**

```bash
git add pipeline/src/sources/odpt.ts pipeline/src/sources/odpt.test.ts
git commit -m "feat(pipeline): ODPTソースを追加(8フィード・Location版数検出)"
```

---

### Task 4: run.ts メインループ統合とR2掃除

`runPipeline` を「複数の `FeedSource` を受け取り、記述子単位で処理する」形に全面書き換えする。掃除（孤児キー削除）・ソース障害時の前回エントリ引き継ぎ・旧meta（`fileUid`）互換もここで入れる。テストは既存4シナリオを新構造へ載せ替えた上で新規シナリオを追加する。

**Files:**
- Rewrite: `pipeline/src/run.ts`
- Rewrite: `pipeline/src/run.test.ts`

- [ ] **Step 1: run.test.ts を全面書き換え（失敗するテスト）**

`pipeline/src/run.test.ts` を以下の内容へ置き換え:

```ts
import { strToU8, zipSync } from 'fflate';
import { FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON } from 'gtfs-core';
import { describe, expect, it } from 'vitest';
import { runPipeline, type BucketLike } from './run';
import { createGtfsDataJpSource, type GtfsFileEntry } from './sources/gtfsDataJp';
import type { FeedDescriptor, FeedSource } from './sources/types';

function fakeBucket(options?: {
	/** listの1ページあたり件数。指定するとtruncated/cursorのページングを模す */
	listPageSize?: number;
}): BucketLike & { store: Map<string, string>; deleted: string[] } {
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
		async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
			const start = cursor ? Number(cursor) : 0;
			const size = options?.listPageSize ?? keys.length;
			const truncated = start + size < keys.length;
			return {
				objects: keys.slice(start, start + size).map((key) => ({ key })),
				truncated,
				cursor: truncated ? String(start + size) : undefined,
			};
		},
		async delete(keys: string[]) {
			deleted.push(...keys);
			for (const k of keys) store.delete(k);
		},
	};
}

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

const FIXTURE_ZIP = zipSync(
	Object.fromEntries(Object.entries(FIXTURE_FILES).map(([k, v]) => [k, strToU8(v)])),
);

function fetcherFor(entries: GtfsFileEntry[]): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = String(input);
		if (url.includes('/v2/files')) {
			return new Response(JSON.stringify({ code: 200, message: 'ok', body: entries }));
		}
		if (url.endsWith('feed.zip')) return new Response(FIXTURE_ZIP);
		if (url.endsWith('routes.geojson')) return new Response(FIXTURE_ROUTES_GEOJSON);
		if (url.endsWith('.geojson')) {
			return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }));
		}
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

/** GeoJSON別配布の無いODPT風フィードを模した記述子 */
function odptDescriptor(): FeedDescriptor {
	return {
		id: 'odpt~TestOp~AllLines',
		name: 'テスト事業者(全路線)',
		orgName: 'テスト事業者',
		license: 'CC BY 4.0',
		fromDate: '',
		toDate: '',
		source: 'odpt',
		versionId: '/files-open/odpt/TestOp/AllLines-20260601.zip',
		fetchZip: async () => FIXTURE_ZIP,
	};
}

function stubSource(descriptors: FeedDescriptor[]): FeedSource {
	return { sourceId: 'odpt', listFeeds: async () => descriptors };
}

describe('runPipeline', () => {
	it('新規フィードを変換してR2へ書き込み、feeds.jsonを更新する', async () => {
		const bucket = fakeBucket();
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10')],
		});
		expect(statuses).toHaveLength(1);
		expect(statuses[0].status).toBe('updated');
		expect(statuses[0].source).toBe('gtfs-data.jp');
		const id = 'testorg~testfeed~2026-04-01';
		expect(bucket.store.has(`feeds/${id}/bundle.json`)).toBe(true);
		expect(bucket.store.has(`feeds/${id}/stops.geojson`)).toBe(true);
		// ソース提供のroutes.geojsonはそのまま保存される
		expect(bucket.store.get(`feeds/${id}/routes.geojson`)).toBe(FIXTURE_ROUTES_GEOJSON);
		expect(bucket.store.has(`feeds/${id}/meta.json`)).toBe(true);
		const index = JSON.parse(bucket.store.get('feeds.json') ?? '{}') as {
			feeds: { id: string; status: string; source: string }[];
		};
		expect(index.feeds[0].id).toBe(id);
		expect(index.feeds[0].source).toBe('gtfs-data.jp');
		// フィクスチャ: T1=shapes.txt / T3=routes.geojsonマッチ / T2=直線フォールバック
		expect(statuses[0].shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});

	it('versionId が同じなら unchanged でスキップし、shapeSourceCounts を引き継ぐ', async () => {
		const bucket = fakeBucket();
		const deps = {
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10')],
		};
		await runPipeline(deps);
		const second = await runPipeline(deps);
		expect(second[0].status).toBe('unchanged');
		expect(second[0].shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});

	it('旧形式meta(fileUid)でもunchanged判定できる', async () => {
		const bucket = fakeBucket();
		const id = 'testorg~testfeed~2026-04-01';
		bucket.store.set(
			`feeds/${id}/meta.json`,
			JSON.stringify({ fileUid: 'uid-1', shapeSourceCounts: { shapes: 3, route: 0, straight: 0 } }),
		);
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10')],
		});
		expect(statuses[0].status).toBe('unchanged');
		expect(statuses[0].shapeSourceCounts).toEqual({ shapes: 3, route: 0, straight: 0 });
	});

	it('1フィードの失敗が他フィードを巻き込まない', async () => {
		const bucket = fakeBucket();
		const bad = entry({
			organization_id: 'badorg',
			file_url: 'https://example.com/missing.zip',
		});
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([bad, entry({})]),
			sources: [createGtfsDataJpSource('10')],
		});
		expect(statuses.find((s) => s.id.startsWith('badorg'))?.status).toBe('error');
		expect(statuses.find((s) => s.id.startsWith('testorg'))?.status).toBe('updated');
	});

	it('GeoJSON未提供のフィードはGTFSからstops/routesを生成する', async () => {
		const bucket = fakeBucket();
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([]),
			sources: [stubSource([odptDescriptor()])],
		});
		expect(statuses[0].status).toBe('updated');
		const stops = JSON.parse(
			bucket.store.get('feeds/odpt~TestOp~AllLines/stops.geojson') ?? '{}',
		) as { features: object[] };
		expect(stops.features).toHaveLength(3);
		const routes = JSON.parse(
			bucket.store.get('feeds/odpt~TestOp~AllLines/routes.geojson') ?? '{}',
		) as { features: object[] };
		expect(routes.features.length).toBeGreaterThan(0);
	});

	it('どのソースにも属さない旧フィードのキーを削除する', async () => {
		const bucket = fakeBucket();
		bucket.store.set('feeds/testorg~testfeed~2025-01-01/bundle.json', '{}');
		bucket.store.set('feeds/testorg~testfeed~2025-01-01/meta.json', '{}');
		await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10')],
		});
		expect(bucket.store.has('feeds/testorg~testfeed~2025-01-01/bundle.json')).toBe(false);
		expect(bucket.store.has('feeds/testorg~testfeed~2025-01-01/meta.json')).toBe(false);
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/bundle.json')).toBe(true);
	});

	it('複数ページにまたがる孤児キーも全て削除する', async () => {
		const bucket = fakeBucket({ listPageSize: 2 });
		bucket.store.set('feeds/orphan~a~1/bundle.json', '{}');
		bucket.store.set('feeds/orphan~a~1/meta.json', '{}');
		bucket.store.set('feeds/orphan~b~2/bundle.json', '{}');
		bucket.store.set('feeds/orphan~b~2/meta.json', '{}');
		bucket.store.set('feeds/orphan~c~3/bundle.json', '{}');
		await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10')],
		});
		// アクティブなフィードのキーは残り、孤児キーは全ページ分削除される
		const remaining = [...bucket.store.keys()].filter((k) => k.startsWith('feeds/orphan'));
		expect(remaining).toHaveLength(0);
		expect(bucket.deleted).toHaveLength(5);
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/bundle.json')).toBe(true);
	});

	it('エラーになったフィードの既存データは削除しない', async () => {
		const bucket = fakeBucket();
		const bad = entry({
			organization_id: 'badorg',
			file_url: 'https://example.com/missing.zip',
		});
		bucket.store.set('feeds/badorg~testfeed~2026-04-01/bundle.json', '{}');
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([bad]),
			sources: [createGtfsDataJpSource('10')],
		});
		expect(statuses[0].status).toBe('error');
		expect(bucket.store.has('feeds/badorg~testfeed~2026-04-01/bundle.json')).toBe(true);
	});

	it('ソース一覧の取得失敗時は前回エントリを引き継ぎ、掃除をスキップする', async () => {
		const bucket = fakeBucket();
		bucket.store.set(
			'feeds.json',
			JSON.stringify({
				generatedAt: '2026-07-01T00:00:00Z',
				feeds: [
					{
						id: 'odpt~A~B',
						name: '前回フィード',
						orgName: 'o',
						license: 'CC BY 4.0',
						fromDate: '',
						toDate: '',
						source: 'odpt',
						status: 'updated',
					},
				],
			}),
		);
		bucket.store.set('feeds/odpt~A~B/bundle.json', '{}');
		// どのソースにも属さない孤児キー: 掃除が誤って実行されると消えてしまう監視対象
		bucket.store.set('feeds/orphan~X~Y/bundle.json', '{}');
		const failingSource: FeedSource = {
			sourceId: 'odpt',
			listFeeds: () => Promise.reject(new Error('down')),
		};
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([]),
			sources: [failingSource],
		});
		expect(statuses).toHaveLength(1);
		expect(statuses[0].id).toBe('odpt~A~B');
		expect(bucket.deleted).toHaveLength(0);
		expect(bucket.store.has('feeds/odpt~A~B/bundle.json')).toBe(true);
		// 一覧失敗時は掃除自体がスキップされるため孤児キーも残る
		expect(bucket.store.has('feeds/orphan~X~Y/bundle.json')).toBe(true);
	});

	it('片側ソースの一覧失敗がもう片方の処理を妨げない', async () => {
		const bucket = fakeBucket();
		const failingSource: FeedSource = {
			sourceId: 'odpt',
			listFeeds: () => Promise.reject(new Error('down')),
		};
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10'), failingSource],
		});
		expect(statuses).toHaveLength(1);
		expect(statuses[0].status).toBe('updated');
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline test src/run.test.ts`
Expected: FAIL（`runPipeline` の引数型に `sources` が無い等の型エラー/実行エラー）

- [ ] **Step 3: run.ts を全面書き換え**

`pipeline/src/run.ts` を以下の内容へ置き換え:

```ts
import { convertFeed, shapesToGeojson, stopsToGeojson, unzipFeed } from 'gtfs-core';
import type { FeedDescriptor, FeedSource, SourceId } from './sources/types';

/** R2Bucket と構造的に互換な最小インターフェース(テスト差し替え用) */
export interface BucketLike {
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	put(key: string, value: string): Promise<void>;
	list(options: {
		prefix: string;
		cursor?: string;
	}): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
	delete(keys: string[]): Promise<void>;
}

export interface PipelineDeps {
	bucket: BucketLike;
	fetcher: typeof fetch;
	sources: FeedSource[];
}

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
	/** trip の形状ソース内訳(shapes / route / straight)。unchanged 時は meta.json から引き継ぐ */
	shapeSourceCounts?: Record<string, number>;
}

interface FeedsIndex {
	generatedAt: string;
	feeds: FeedStatus[];
}

interface FeedMeta {
	versionId?: string;
	/** 旧形式のキー(fileUid時代)。読み取り時のみ解釈する */
	fileUid?: string;
	shapeSourceCounts?: Record<string, number>;
}

/** R2の一括deleteは1回1000キーまで */
const DELETE_BATCH = 1000;

export async function runPipeline({
	bucket,
	fetcher,
	sources,
}: PipelineDeps): Promise<FeedStatus[]> {
	const prev = await readIndex(bucket);
	const statuses: FeedStatus[] = [];
	let anyListFailed = false;

	for (const source of sources) {
		let descriptors: FeedDescriptor[];
		try {
			descriptors = await source.listFeeds(fetcher);
		} catch (e) {
			// 一覧取得に失敗したソースは前回のエントリをそのまま引き継ぐ(地図からの全消え防止)。
			// 引き継いだエントリの status は前回実行時の値のまま残る点に注意。
			// この実行では掃除もスキップする(全フィードを孤児と誤認した全削除の防止)
			console.error(`source list failed: ${source.sourceId}`, e);
			anyListFailed = true;
			statuses.push(...(prev?.feeds?.filter((f) => f.source === source.sourceId) ?? []));
			continue;
		}
		for (const d of descriptors) {
			statuses.push(await processFeed(bucket, fetcher, d));
		}
	}

	await bucket.put(
		'feeds.json',
		JSON.stringify({ generatedAt: new Date().toISOString(), feeds: statuses }),
	);
	if (!anyListFailed) {
		await cleanupOrphans(bucket, new Set(statuses.map((s) => s.id)));
	}
	return statuses;
}

async function readIndex(bucket: BucketLike): Promise<FeedsIndex | null> {
	const obj = await bucket.get('feeds.json');
	if (!obj) return null;
	try {
		return JSON.parse(await obj.text()) as FeedsIndex;
	} catch {
		return null;
	}
}

async function processFeed(
	bucket: BucketLike,
	fetcher: typeof fetch,
	d: FeedDescriptor,
): Promise<FeedStatus> {
	const base = {
		id: d.id,
		name: d.name,
		orgName: d.orgName,
		license: d.license,
		fromDate: d.fromDate,
		toDate: d.toDate,
		source: d.source,
	};
	try {
		const metaObj = await bucket.get(`feeds/${d.id}/meta.json`);
		const meta = metaObj ? (JSON.parse(await metaObj.text()) as FeedMeta) : null;
		// versionId '' は版数解決に失敗したエラー記述子(ODPT)なので unchanged 扱いにしない
		if (meta && d.versionId !== '' && (meta.versionId ?? meta.fileUid) === d.versionId) {
			return { ...base, status: 'unchanged', shapeSourceCounts: meta.shapeSourceCounts };
		}

		const zip = await d.fetchZip(fetcher);

		// routes.geojson は shapes.txt なしフィードの形状源になるため変換前に取得する。
		// ソースがURLを宣言しているのに取得できない場合は throw してフィード単位のエラーにする:
		// 黙って生成フォールバックすると劣化データ(直線化bundle等)が新versionIdで固定されてしまう
		let routesText: string | null = null;
		if (d.routesGeojsonUrl) {
			const res = await fetcher(d.routesGeojsonUrl);
			if (!res.ok) throw new Error(`routes geojson fetch failed: ${res.status}`);
			routesText = await res.text();
		}

		const files = unzipFeed(zip);
		const bundle = convertFeed(files, routesText ?? undefined);
		await bucket.put(`feeds/${d.id}/bundle.json`, JSON.stringify(bundle));
		await bucket.put(
			`feeds/${d.id}/routes.geojson`,
			routesText ?? JSON.stringify(shapesToGeojson(bundle)),
		);

		let stopsText: string | null = null;
		if (d.stopsGeojsonUrl) {
			const res = await fetcher(d.stopsGeojsonUrl);
			if (!res.ok) throw new Error(`stops geojson fetch failed: ${res.status}`);
			stopsText = await res.text();
		}
		await bucket.put(
			`feeds/${d.id}/stops.geojson`,
			stopsText ?? JSON.stringify(stopsToGeojson(files)),
		);

		// meta.json は必ずこのフィードの最後の書き込みにすること: 更新完了のマーカーであり、
		// 途中でクラッシュしても meta が残らず次回実行時に最初から再処理される(自己修復的な冪等性)。
		// put の順序を入れ替えるとこの保証が静かに壊れる。
		await bucket.put(
			`feeds/${d.id}/meta.json`,
			JSON.stringify({ versionId: d.versionId, shapeSourceCounts: bundle.shapeSourceCounts }),
		);
		return { ...base, status: 'updated', shapeSourceCounts: bundle.shapeSourceCounts };
	} catch (e) {
		return {
			...base,
			status: 'error',
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/** アクティブなフィードIDに属さない feeds/ 配下のキーを削除する */
async function cleanupOrphans(bucket: BucketLike, activeIds: Set<string>): Promise<void> {
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

変更点の要旨（旧 `run.ts` との差分）:
- `GtfsFileEntry` / 一覧API呼び出しは `sources/gtfsDataJp.ts` へ移設済み（本ファイルからは削除）
- `PipelineDeps.prefId` → `sources: FeedSource[]`
- meta の `fileUid` → `versionId`（読み取りは両対応）。`lastUpdatedAt` は未使用のため廃止
- stops/routes GeoJSONはソース提供が無ければ生成して必ず書く
- 掃除・前回feeds.json引き継ぎを追加
- 宣言済みの routes/stops GeoJSON URL が非okの場合は生成フォールバックへ黒黙移行せず throw する（劣化データが新versionIdで焼き付くのを防止）
- listFeeds失敗時に `console.error` でログを残す
- 前回feeds.json引き継ぎは `prev?.feeds?.filter(...)` でoptional chainingを強化
- unchanged判定に `d.versionId !== ''` ガードを追加（版数解決失敗の記述子を誤ってunchanged扱いしないため）

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter pipeline test`
Expected: 全テストPASS（run 10件 + sources 7件）

※ この時点で `pipeline/src/index.ts` は旧 `runPipeline` シグネチャ（`prefId`）を参照しており型エラーになるが、次タスクで修正する。`vitest` はテスト対象のみコンパイルするためテストは通る。

- [ ] **Step 5: コミット**

```bash
git add pipeline/src/run.ts pipeline/src/run.test.ts
git commit -m "feat(pipeline): メインループをソースアダプタ構造へ統合、R2孤児キー掃除を追加"
```

---

### Task 5: Workerエントリの配線

**Files:**
- Rewrite: `pipeline/src/index.ts`

- [ ] **Step 1: index.ts を書き換え**

`pipeline/src/index.ts` を以下の内容へ置き換え:

```ts
import type { BucketLike } from './run';
import { runPipeline } from './run';
import { createGtfsDataJpSource } from './sources/gtfsDataJp';
import { createOdptSource } from './sources/odpt';

interface Env {
	DATA_BUCKET: R2Bucket;
	GTFS_PREF_ID: string;
}

/** R2Bucket の戻り値型を BucketLike の期待へ薄くラップする */
function toBucketLike(bucket: R2Bucket): BucketLike {
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

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			runPipeline({
				bucket: toBucketLike(env.DATA_BUCKET),
				fetcher: fetch,
				sources: [createGtfsDataJpSource(env.GTFS_PREF_ID), createOdptSource()],
			}),
		);
	},
} satisfies ExportedHandler<Env>;
```

※ `wrangler.jsonc` の `GTFS_PREF_ID: "10"` は gtfs-data.jp ソース用としてそのまま使う（変更なし）。

- [ ] **Step 2: 型チェックとテスト**

Run: `pnpm --filter pipeline check && pnpm --filter pipeline test`
Expected: 型エラーなし、全テストPASS

※ `bucket.list()` の戻り値の `cursor` 型で `res.truncated ? res.cursor : undefined` が型エラーになる場合は、`@cloudflare/workers-types` の `R2Objects` が判別共用体でない古い版。その場合は `cursor: 'cursor' in res ? res.cursor : undefined` に置き換える。

- [ ] **Step 3: コミット**

```bash
git add pipeline/src/index.ts
git commit -m "feat(pipeline): Workerエントリを2ソース構成へ配線"
```

---

### Task 6: アプリのソース表示とREADME更新

**Files:**
- Modify: `app/src/lib/data.ts:3-11`（FeedIndexEntry に source 追加）
- Modify: `app/src/lib/Controls.svelte`（フッターのクレジットを動的化）
- Modify: `README.md:3,52`（データソースの記述を更新）

- [ ] **Step 1: data.ts の FeedIndexEntry に source を追加**

`app/src/lib/data.ts` の `FeedIndexEntry` を以下へ変更:

```ts
export interface FeedIndexEntry {
	id: string;
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	status: string;
	/** 取得元レジストリ。旧feeds.json(移行前)には無いためoptional */
	source?: string;
}
```

- [ ] **Step 2: Controls.svelte のクレジットを動的化**

`app/src/lib/Controls.svelte` の `<script>` ブロックに追加（`timeLabel` の定義の下）:

```ts
const SOURCE_CREDITS: Record<string, string> = {
	'gtfs-data.jp': 'GTFSデータリポジトリ(gtfs-data.jp)',
	odpt: '公共交通オープンデータセンター(ODPT)',
};
// source未設定の旧feeds.jsonはgtfs-data.jp由来として扱う
const credits = $derived(
	[...new Set(feedInfos.map((f) => f.source ?? 'gtfs-data.jp'))]
		.map((s) => SOURCE_CREDITS[s] ?? s)
		.join(' / '),
);
```

フッター部分（既存47行目付近）を変更:

変更前:

```svelte
		— GTFSデータリポジトリ(gtfs-data.jp) / 地図: © OpenStreetMap contributors
```

変更後:

```svelte
		— {credits} / 地図: © OpenStreetMap contributors
```

- [ ] **Step 3: README.md の更新**

3行目を変更:

変更前:

```markdown
群馬県のGTFSフィード(gtfs-data.jp)をもとに、指定日時のバス推定位置を地図上に表示するWebGIS。
```

変更後:

```markdown
群馬県のGTFSフィード(gtfs-data.jp・公共交通オープンデータセンター)をもとに、指定日時のバス推定位置を地図上に表示するWebGIS。
```

52行目を変更:

変更前:

```markdown
- バスデータ: GTFSデータリポジトリ(gtfs-data.jp)の各事業者フィード(CC BY 4.0 等、feeds.json に記載)
```

変更後:

```markdown
- バスデータ: GTFSデータリポジトリ(gtfs-data.jp)および公共交通オープンデータセンター(ODPT)の各事業者フィード(CC BY 4.0 等、feeds.json に記載)
```

- [ ] **Step 4: 型チェック**

Run: `pnpm --filter app check`
Expected: エラーなし（`svelte-kit sync` が先に走る）

- [ ] **Step 5: コミット**

```bash
git add app/src/lib/data.ts app/src/lib/Controls.svelte README.md
git commit -m "feat(app): データソース別のクレジット表示に対応"
```

---

### Task 7: 全体検証とローカルE2E確認

- [ ] **Step 1: CIと同じチェックを一括実行**

```bash
pnpm format
just ci
```

Expected: format差分があれば適用された上で、install / format:check / lint / check / test / build がすべて成功

- [ ] **Step 2: ローカルE2E（実データでパイプラインを回す）**

ターミナル1:

```bash
just pipeline
```

ターミナル2（Workerが起動してから）:

```bash
just seed
```

Expected: 実際の gtfs-data.jp と ODPT へアクセスし、ローカルR2に11フィード分のデータが投入される（ODPT 8 + gtfs-data.jp 3。関越交通は2.3MBあるため1〜2分かかる場合あり）

ターミナル3:

```bash
just dev
```

ブラウザで http://localhost:5173 を開き、以下を目視確認:

1. 地図に高崎市・前橋市周辺のバス路線（青線）と停留所（灰点)が表示される（従来は安中・太田・大泉のみ）
2. 再生すると高崎・前橋周辺でもバス（赤点）が動く
3. フッターに8つのODPTフィード名と `公共交通オープンデータセンター(ODPT)` のクレジットが表示される
4. 既存の安中・太田・大泉の表示が消えていない

- [ ] **Step 3: 掃除の動作確認（ローカル、任意)**

`just seed` をもう一度実行し、Workerのログに全フィード `unchanged` が並ぶこと（=差分検出が機能）、およびエラーが無いことを確認。

- [ ] **Step 4: 最終コミットとプッシュ**

```bash
git status   # 残差分が無いこと(あればformat適用分をコミット)
git push -u origin feature/odpt-datasource
```

その後、superpowers:finishing-a-development-branch スキルに従ってPR作成等の統合方法を決める。

---

## 補足: 実装中に判断に迷ったら

- 仕様の根拠は `docs/superpowers/specs/2026-07-06-odpt-datasource-design.md`
- ODPTフィードのURL・ライセンスの調査記録は `.tmp/gtfs-takasaki-maebashi-research.md`（未コミットの作業メモ）
- 「meta.json を最後に書く」順序は絶対に崩さない（冪等性マーカー）
- 掃除は「全ソースの一覧取得が成功した実行」でのみ行う
- 既知の受容リスク: gtfs-data.jpの一覧APIがHTTP 200で空配列 body: [] を返す異常系では、全フィードが孤児掃除される（listFeedsのrejectのみが掃除スキップの条件）。データは再生成可能なキャッシュであり、次回成功実行で自己回復するため受容する。
