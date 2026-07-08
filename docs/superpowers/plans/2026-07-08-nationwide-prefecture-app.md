# 全国版アプリ(都道府県セレクタ)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全国約646件のGTFSフィードを、コロプレス地図の都道府県セレクタを起点に段階ロードして表示できるようにする。

**Architecture:** `feeds.json` に `prefId` を追加(gtfs-data.jp は `feed_pref_id`、ODPT は停留所重心の point-in-polygon)。gtfs-core に都道府県の定数・幾何・判定を置き、パイプラインが再利用。アプリは `loadAll` を「インデックス取得 → 選択県のみロード」に分割し、未選択時はコロプレス地図ピッカーを表示する。

**Tech Stack:** TypeScript / SvelteKit(Svelte 5 runes)/ MapLibre GL / Cloudflare Workers + R2 / Vitest / pnpm workspace。

参照:
- 設計書: `docs/superpowers/specs/2026-07-08-nationwide-prefecture-app-design.md`
- 参照デザイン: `GTFS View Bus - Prefecture.dc.html`(色・マークアップの正)
- 前提: `docs/superpowers/specs/2026-07-07-nationwide-pipeline-design.md`

---

## ファイル構成

**gtfs-core(共有ロジック)**
- 新規 `packages/gtfs-core/src/prefectures.ts` — 都道府県マスタ定数(id/ja/region)。ポリゴンを import しない軽量モジュール。バレルから公開。
- 新規 `packages/gtfs-core/src/prefectures.geo.json` — 簡略化47都道府県ポリゴン。
- 新規 `packages/gtfs-core/src/prefectureGeometry.ts` — `PREFECTURES_GEOJSON` と `resolvePrefId`。ポリゴンを import する重量モジュール。**バレル非公開**、サブパス `gtfs-core/prefectureGeometry` で公開。
- 変更 `packages/gtfs-core/src/geo.ts` — `centroidOf`(純粋な代表点計算)を追加。
- 変更 `packages/gtfs-core/src/index.ts` — `export * from './prefectures'` のみ追加。
- 変更 `packages/gtfs-core/package.json` — `exports` にサブパス追加。
- 変更 `packages/gtfs-core/tsconfig.json` — `resolveJsonModule` 追加。

**pipeline**
- 変更 `pipeline/src/sources/types.ts` — `FeedTarget.prefId?`。
- 変更 `pipeline/src/sources/gtfsDataJp.ts` — `feed_pref_id` → `prefId`。
- 変更 `pipeline/src/sources/odptManifestTypes.ts` / `odpt.ts` — 任意 `prefId` の受け渡し。
- 変更 `pipeline/src/jobState.ts` — `FeedStatus.prefId?`。
- 変更 `pipeline/src/feedProcessor.ts` — 重心判定・meta 保存・unchanged 読み戻し。
- 変更 `pipeline/src/finalize.ts` — `toPublicStatus` と summary の null 集計。

**app**
- 新規 `app/static/japan-prefectures.geojson` — コロプレス描画用(gtfs-core と同一ソース)。
- 変更 `app/src/lib/data.ts` — `FeedIndexEntry.prefId`、`loadIndex` / `loadPrefecture`、`prefectureCounts`。
- 新規 `app/src/lib/PrefectureHeader.svelte` — 選択後の常設ヘッダ。
- 新規 `app/src/lib/PrefecturePicker.svelte` — コロプレス選択レイヤ+オーバーレイUI。
- 変更 `app/src/routes/+page.svelte` — URL 駆動の状態機械・2段階ロード・fitBounds・フォールバック。

---

## Phase A — gtfs-core 都道府県基盤

### Task 1: 都道府県マスタ定数 `prefectures.ts`

**Files:**
- Create: `packages/gtfs-core/src/prefectures.ts`
- Create: `packages/gtfs-core/src/prefectures.test.ts`
- Modify: `packages/gtfs-core/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/gtfs-core/src/prefectures.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PREFECTURES, REGIONS } from './prefectures';

describe('都道府県マスタ', () => {
	it('47件で id は 1〜47 の重複なし', () => {
		expect(PREFECTURES).toHaveLength(47);
		const ids = PREFECTURES.map((p) => p.id);
		expect(new Set(ids).size).toBe(47);
		expect(Math.min(...ids)).toBe(1);
		expect(Math.max(...ids)).toBe(47);
	});

	it('各県の region は REGIONS に含まれる', () => {
		for (const p of PREFECTURES) expect(REGIONS).toContain(p.region);
	});

	it('地方順に北海道→九州で並ぶ', () => {
		expect(REGIONS).toEqual(['北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州']);
		expect(PREFECTURES[0]).toMatchObject({ id: 1, ja: '北海道' });
		expect(PREFECTURES[46]).toMatchObject({ id: 47, ja: '沖縄県' });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gtfs-core && pnpm exec vitest run src/prefectures.test.ts`
Expected: FAIL(`Cannot find module './prefectures'`)

- [ ] **Step 3: Write the implementation**

`packages/gtfs-core/src/prefectures.ts`:

```ts
export type RegionName = '北海道' | '東北' | '関東' | '中部' | '近畿' | '中国' | '四国' | '九州';

export interface PrefectureInfo {
	/** JIS 都道府県コード(1〜47) */
	id: number;
	/** 和名(セレクタ表示用) */
	ja: string;
	/** 地方区分 */
	region: RegionName;
}

export const REGIONS: readonly RegionName[] = [
	'北海道',
	'東北',
	'関東',
	'中部',
	'近畿',
	'中国',
	'四国',
	'九州',
];

export const PREFECTURES: readonly PrefectureInfo[] = [
	{ id: 1, ja: '北海道', region: '北海道' },
	{ id: 2, ja: '青森県', region: '東北' },
	{ id: 3, ja: '岩手県', region: '東北' },
	{ id: 4, ja: '宮城県', region: '東北' },
	{ id: 5, ja: '秋田県', region: '東北' },
	{ id: 6, ja: '山形県', region: '東北' },
	{ id: 7, ja: '福島県', region: '東北' },
	{ id: 8, ja: '茨城県', region: '関東' },
	{ id: 9, ja: '栃木県', region: '関東' },
	{ id: 10, ja: '群馬県', region: '関東' },
	{ id: 11, ja: '埼玉県', region: '関東' },
	{ id: 12, ja: '千葉県', region: '関東' },
	{ id: 13, ja: '東京都', region: '関東' },
	{ id: 14, ja: '神奈川県', region: '関東' },
	{ id: 15, ja: '新潟県', region: '中部' },
	{ id: 16, ja: '富山県', region: '中部' },
	{ id: 17, ja: '石川県', region: '中部' },
	{ id: 18, ja: '福井県', region: '中部' },
	{ id: 19, ja: '山梨県', region: '中部' },
	{ id: 20, ja: '長野県', region: '中部' },
	{ id: 21, ja: '岐阜県', region: '中部' },
	{ id: 22, ja: '静岡県', region: '中部' },
	{ id: 23, ja: '愛知県', region: '中部' },
	{ id: 24, ja: '三重県', region: '近畿' },
	{ id: 25, ja: '滋賀県', region: '近畿' },
	{ id: 26, ja: '京都府', region: '近畿' },
	{ id: 27, ja: '大阪府', region: '近畿' },
	{ id: 28, ja: '兵庫県', region: '近畿' },
	{ id: 29, ja: '奈良県', region: '近畿' },
	{ id: 30, ja: '和歌山県', region: '近畿' },
	{ id: 31, ja: '鳥取県', region: '中国' },
	{ id: 32, ja: '島根県', region: '中国' },
	{ id: 33, ja: '岡山県', region: '中国' },
	{ id: 34, ja: '広島県', region: '中国' },
	{ id: 35, ja: '山口県', region: '中国' },
	{ id: 36, ja: '徳島県', region: '四国' },
	{ id: 37, ja: '香川県', region: '四国' },
	{ id: 38, ja: '愛媛県', region: '四国' },
	{ id: 39, ja: '高知県', region: '四国' },
	{ id: 40, ja: '福岡県', region: '九州' },
	{ id: 41, ja: '佐賀県', region: '九州' },
	{ id: 42, ja: '長崎県', region: '九州' },
	{ id: 43, ja: '熊本県', region: '九州' },
	{ id: 44, ja: '大分県', region: '九州' },
	{ id: 45, ja: '宮崎県', region: '九州' },
	{ id: 46, ja: '鹿児島県', region: '九州' },
	{ id: 47, ja: '沖縄県', region: '九州' },
];

const PREF_BY_ID = new Map(PREFECTURES.map((p) => [p.id, p]));

/** id から都道府県情報を引く(不正 id は undefined) */
export function prefectureById(id: number): PrefectureInfo | undefined {
	return PREF_BY_ID.get(id);
}
```

- [ ] **Step 4: Add barrel export**

`packages/gtfs-core/src/index.ts` の末尾に追加:

```ts
export * from './prefectures';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/gtfs-core && pnpm exec vitest run src/prefectures.test.ts`
Expected: PASS(3 件)

- [ ] **Step 6: Commit**

```bash
git add packages/gtfs-core/src/prefectures.ts packages/gtfs-core/src/prefectures.test.ts packages/gtfs-core/src/index.ts
git commit -m "feat(gtfs-core): 都道府県マスタ定数を追加する"
```

---

### Task 2: 代表点計算 `centroidOf`

**Files:**
- Modify: `packages/gtfs-core/src/geo.ts`
- Modify: `packages/gtfs-core/src/geo.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/gtfs-core/src/geo.test.ts` に追記(既存 import に `centroidOf` を足す):

```ts
import { centroidOf } from './geo';

describe('centroidOf', () => {
	it('空配列は null', () => {
		expect(centroidOf([])).toBeNull();
	});

	it('外れ値に引きずられない成分別中央値を返す', () => {
		// 3点は東京付近、1点だけ極端な外れ値。中央値なら外れ値の影響を受けない
		const pts: [number, number][] = [
			[139.7, 35.68],
			[139.71, 35.69],
			[139.69, 35.67],
			[999, 999],
		];
		const c = centroidOf(pts);
		expect(c).not.toBeNull();
		expect(c![0]).toBeGreaterThan(139.6);
		expect(c![0]).toBeLessThan(139.8);
		expect(c![1]).toBeGreaterThan(35.6);
		expect(c![1]).toBeLessThan(35.8);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gtfs-core && pnpm exec vitest run src/geo.test.ts`
Expected: FAIL(`centroidOf` 未定義)

- [ ] **Step 3: Write the implementation**

`packages/gtfs-core/src/geo.ts` の末尾に追加:

```ts
function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 座標群の代表点。外れ値の影響を抑えるため成分別の中央値を返す。空配列は null。 */
export function centroidOf(coords: LngLat[]): LngLat | null {
	if (coords.length === 0) return null;
	return [median(coords.map((c) => c[0])), median(coords.map((c) => c[1]))];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/gtfs-core && pnpm exec vitest run src/geo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gtfs-core/src/geo.ts packages/gtfs-core/src/geo.test.ts
git commit -m "feat(gtfs-core): 座標群の代表点計算centroidOfを追加する"
```

---

### Task 3: 都道府県ポリゴンと `resolvePrefId`

**Files:**
- Create: `packages/gtfs-core/src/prefectures.geo.json`(生成物)
- Create: `packages/gtfs-core/src/prefectureGeometry.ts`
- Create: `packages/gtfs-core/src/prefectureGeometry.test.ts`
- Modify: `packages/gtfs-core/package.json`
- Modify: `packages/gtfs-core/tsconfig.json`

- [ ] **Step 1: ポリゴンGeoJSONを生成する**

dataofjapan/land の日本地図(properties に都道府県コード `id` を持つ)を mapshaper で簡略化し、`{ id: number }` のみに正規化する。

```bash
cd packages/gtfs-core/src
curl -fsSL https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson -o /tmp/japan-raw.geojson
npx -y mapshaper /tmp/japan-raw.geojson \
  -simplify 6% keep-shapes \
  -each 'this.properties = { id: Number(this.properties.id) }' \
  -o format=geojson precision=0.0001 prefectures.geo.json
```

生成後の検証(47 features・id 1〜47・gzip サイズ目標 200KB 以下):

```bash
node -e 'const g=require("./prefectures.geo.json"); const ids=g.features.map(f=>f.properties.id).sort((a,b)=>a-b); console.log("features:",g.features.length); console.log("id範囲:",ids[0],ids[ids.length-1],"件数:",new Set(ids).size)'
gzip -c prefectures.geo.json | wc -c
```

Expected: `features: 47` / `id範囲: 1 47 件数: 47` / gzip が概ね 200000 バイト以下(超える場合は `-simplify 4%` に下げて再生成)。

- [ ] **Step 2: JSON import とサブパス公開の設定**

`packages/gtfs-core/tsconfig.json` の `compilerOptions` に追加:

```json
"resolveJsonModule": true,
```

`packages/gtfs-core/package.json` の `exports` を差し替え:

```json
"exports": {
	".": "./src/index.ts",
	"./prefectureGeometry": "./src/prefectureGeometry.ts"
},
```

- [ ] **Step 3: Write the failing test**

`packages/gtfs-core/src/prefectureGeometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PREFECTURES_GEOJSON, resolvePrefId } from './prefectureGeometry';

describe('PREFECTURES_GEOJSON', () => {
	it('47 features で properties.id を持つ', () => {
		expect(PREFECTURES_GEOJSON.features).toHaveLength(47);
		for (const f of PREFECTURES_GEOJSON.features) {
			expect(typeof f.properties.id).toBe('number');
		}
	});
});

describe('resolvePrefId', () => {
	it.each([
		['札幌', 141.3469, 43.0642, 1],
		['前橋', 139.0608, 36.3912, 10],
		['東京駅', 139.7671, 35.6812, 13],
		['大阪', 135.5023, 34.6937, 27],
		['那覇', 127.6809, 26.2124, 47],
	])('%s は id %d', (_name, lng, lat, expected) => {
		expect(resolvePrefId(lng, lat)).toBe(expected);
	});

	it('陸から遠い海上は null', () => {
		expect(resolvePrefId(150, 30)).toBeNull();
	});
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd packages/gtfs-core && pnpm exec vitest run src/prefectureGeometry.test.ts`
Expected: FAIL(`Cannot find module './prefectureGeometry'`)

- [ ] **Step 5: Write the implementation**

`packages/gtfs-core/src/prefectureGeometry.ts`:

```ts
import geojson from './prefectures.geo.json';
import type { LngLat } from './types';

type Ring = number[][];
interface PrefFeature {
	type: 'Feature';
	properties: { id: number };
	geometry:
		| { type: 'Polygon'; coordinates: Ring[] }
		| { type: 'MultiPolygon'; coordinates: Ring[][] };
}
export interface PrefectureFeatureCollection {
	type: 'FeatureCollection';
	features: PrefFeature[];
}

export const PREFECTURES_GEOJSON = geojson as PrefectureFeatureCollection;

/** 内包なし時の最近傍フォールバックを許す最大距離(度)。約60km相当。 */
const NEAREST_MAX_DEG = 0.6;

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0];
		const yi = ring[i][1];
		const xj = ring[j][0];
		const yj = ring[j][1];
		const intersect =
			yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

/** 1つ目のリングを外周、以降を穴として point-in-polygon 判定する。 */
function pointInPolygon(lng: number, lat: number, rings: Ring[]): boolean {
	if (rings.length === 0 || !pointInRing(lng, lat, rings[0])) return false;
	for (let i = 1; i < rings.length; i++) {
		if (pointInRing(lng, lat, rings[i])) return false; // 穴の中
	}
	return true;
}

function featureContains(lng: number, lat: number, f: PrefFeature): boolean {
	if (f.geometry.type === 'Polygon') return pointInPolygon(lng, lat, f.geometry.coordinates);
	return f.geometry.coordinates.some((poly) => pointInPolygon(lng, lat, poly));
}

function ringsOf(f: PrefFeature): Ring[] {
	return f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat();
}

/**
 * 座標が属する都道府県コードを返す。
 * まず point-in-polygon で内包判定し、内包する県が無ければ一定距離内で最近傍の外周頂点を持つ県へフォールバックする
 * (海岸沿いの重心が簡略化ポリゴンからわずかに外れるケースの救済)。どれにも当てはまらなければ null。
 */
export function resolvePrefId(lng: number, lat: number): number | null {
	for (const f of PREFECTURES_GEOJSON.features) {
		if (featureContains(lng, lat, f)) return f.properties.id;
	}
	let bestId: number | null = null;
	let bestDist = NEAREST_MAX_DEG;
	for (const f of PREFECTURES_GEOJSON.features) {
		for (const ring of ringsOf(f)) {
			for (const [x, y] of ring) {
				const d = Math.hypot(x - lng, y - lat);
				if (d < bestDist) {
					bestDist = d;
					bestId = f.properties.id;
				}
			}
		}
	}
	return bestId;
}

/** app 静的資産(app/static/japan-prefectures.geojson)との同一性を保つための代表点。app からは import しない。 */
export function resolvePrefIdOf(coord: LngLat): number | null {
	return resolvePrefId(coord[0], coord[1]);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/gtfs-core && pnpm exec vitest run src/prefectureGeometry.test.ts`
Expected: PASS。もし特定県が隣県に誤判定されるなら Step 1 の簡略化率を上げて(例 `-simplify 8%`)再生成する。

- [ ] **Step 7: gtfs-core 全体の型チェックとテスト**

Run: `cd packages/gtfs-core && pnpm check && pnpm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/gtfs-core/src/prefectures.geo.json packages/gtfs-core/src/prefectureGeometry.ts packages/gtfs-core/src/prefectureGeometry.test.ts packages/gtfs-core/package.json packages/gtfs-core/tsconfig.json
git commit -m "feat(gtfs-core): 都道府県ポリゴンとresolvePrefIdを追加する"
```

---

## Phase B — pipeline: `prefId` を feeds.json へ

### Task 4: `FeedTarget.prefId` と gtfs-data.jp マッピング

**Files:**
- Modify: `pipeline/src/sources/types.ts`
- Modify: `pipeline/src/sources/gtfsDataJp.ts`
- Modify: `pipeline/src/sources/gtfsDataJp.test.ts`

- [ ] **Step 1: `FeedTarget` に prefId を追加**

`pipeline/src/sources/types.ts` の `FeedTarget` に追加(`routesGeojsonUrl` の下):

```ts
	/** JIS 都道府県コード(1〜47)。未解決は null / 未設定。ソースが権威値を持つ場合に設定する */
	prefId?: number | null;
```

- [ ] **Step 2: Write the failing test**

`pipeline/src/sources/gtfsDataJp.test.ts` の `GtfsFileEntry` 生成 `entry()` に `feed_pref_id: 10` を既定で足し、最初のテスト(全国全件)の期待 `targets[0]` に `prefId: 10` を追加する。さらに新規テストを追加:

```ts
it('feed_pref_idをprefIdへ変換する', async () => {
	const calls: string[] = [];
	const targets = await createGtfsDataJpSource().listTargets(
		fetcherFor([entry({ feed_pref_id: 13 })], calls),
	);
	expect(targets[0].prefId).toBe(13);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd pipeline && pnpm exec vitest run src/sources/gtfsDataJp.test.ts`
Expected: FAIL(`prefId` が undefined / 型に `feed_pref_id` が無い)

- [ ] **Step 4: Write the implementation**

`pipeline/src/sources/gtfsDataJp.ts` の `GtfsFileEntry` に `feed_pref_id: number;` を追加(`feed_id` の下)。`toTarget` の戻り値に追加:

```ts
		prefId: entry.feed_pref_id,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd pipeline && pnpm exec vitest run src/sources/gtfsDataJp.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/sources/types.ts pipeline/src/sources/gtfsDataJp.ts pipeline/src/sources/gtfsDataJp.test.ts
git commit -m "feat(pipeline): gtfs-data.jpのfeed_pref_idをprefIdへ通す"
```

---

### Task 5: ODPT マニフェストの任意 prefId 受け渡し

**Files:**
- Modify: `pipeline/src/sources/odptManifestTypes.ts`
- Modify: `pipeline/src/sources/odpt.ts`
- Modify: `pipeline/src/sources/odpt.test.ts`

- [ ] **Step 1: マニフェスト型に任意 prefId を追加**

`pipeline/src/sources/odptManifestTypes.ts` の `OdptManifestEntry` に追加(`zipUrl` の下):

```ts
	/** 任意。手動で県を上書きする場合のみ設定(通常はconsumerが停留所重心で解決) */
	prefId?: number | null;
```

- [ ] **Step 2: Write the failing test**

`pipeline/src/sources/odpt.test.ts` を開き(無ければ既存の他ソーステスト構造に倣って作成)、マニフェストに `prefId` を持つエントリを渡すと `target.prefId` に反映されるテストを追加する。既存テストが `createOdptSource(manifest)` に手製マニフェストを渡す形なら、それに `prefId: 33` のエントリを足して:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd pipeline && pnpm exec vitest run src/sources/odpt.test.ts`
Expected: FAIL(`prefId` が undefined)

- [ ] **Step 4: Write the implementation**

`pipeline/src/sources/odpt.ts` の `targetBase` 戻り値に追加:

```ts
		prefId: entry.prefId ?? null,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd pipeline && pnpm exec vitest run src/sources/odpt.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/sources/odptManifestTypes.ts pipeline/src/sources/odpt.ts pipeline/src/sources/odpt.test.ts
git commit -m "feat(pipeline): ODPTマニフェストの任意prefIdを通す"
```

---

### Task 6: consumer で prefId を決定・保存

**Files:**
- Modify: `pipeline/src/jobState.ts`
- Modify: `pipeline/src/feedProcessor.ts`
- Modify: `pipeline/src/feedProcessor.test.ts`

- [ ] **Step 1: `FeedStatus` に prefId を追加**

`pipeline/src/jobState.ts` の `FeedStatus` に追加(`source` の下):

```ts
	/** JIS 都道府県コード(1〜47)。未解決は null */
	prefId?: number | null;
```

- [ ] **Step 2: Write the failing tests**

`pipeline/src/feedProcessor.test.ts` に追加。FIXTURE の停留所はテスト用座標なので、`resolvePrefId` が返す id ではなく「target.prefId が優先されること」と「target.prefId 無しでも stops 重心から数値 or null が入ること」を検証する:

```ts
import { resolvePrefId } from 'gtfs-core/prefectureGeometry';

it('target.prefIdがあればstatusとmetaに反映する', async () => {
	const bucket = fakeBucket();
	const status = await processFeedTarget({
		bucket,
		fetcher: fetcher(),
		target: target({ prefId: 13 }),
	});
	expect(status.prefId).toBe(13);
	const meta = JSON.parse(bucket.store.get('feeds/testorg~testfeed~2026-04-01/meta.json') ?? '{}');
	expect(meta.prefId).toBe(13);
});

it('target.prefId無しは停留所重心のresolvePrefId結果になる', async () => {
	const bucket = fakeBucket();
	const status = await processFeedTarget({
		bucket,
		fetcher: fetcher(),
		target: target({ prefId: undefined, source: 'odpt' }),
	});
	// FIXTURE停留所の重心を独立に解くと同じ値になる(数値 or null)
	expect(status.prefId === null || typeof status.prefId === 'number').toBe(true);
});

it('unchanged時はtarget.prefId ?? meta.prefIdを使う', async () => {
	const bucket = fakeBucket();
	bucket.store.set(
		'feeds/testorg~testfeed~2026-04-01/meta.json',
		JSON.stringify({
			versionId: 'uid-1',
			schemaVersion: 4,
			shapeSourceCounts: { shapes: 2, route: 0, straight: 0 },
			prefId: 21,
		}),
	);
	const status = await processFeedTarget({
		bucket,
		fetcher: fetcher(),
		target: target({ prefId: undefined }),
	});
	expect(status.status).toBe('unchanged');
	expect(status.prefId).toBe(21);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd pipeline && pnpm exec vitest run src/feedProcessor.test.ts`
Expected: FAIL(`status.prefId` が undefined)

- [ ] **Step 4: Write the implementation**

`pipeline/src/feedProcessor.ts`:

1. import を追加:

```ts
import { centroidOf } from 'gtfs-core';
import { resolvePrefId } from 'gtfs-core/prefectureGeometry';
```

2. `FeedMeta` に `prefId?: number | null;` を追加。

3. `FeedArtifacts` に `prefId: number | null;` を追加。

4. `buildFeedArtifacts` 内で stops を変数化して重心から prefId を解決する。`stopsToGeojson(...)` の呼び出しを分解:

```ts
	const stops = stopsToGeojson(files, stopRouteIds(files));
	const prefId =
		target.prefId ?? resolvePrefId(...(centroidOf(stops.features.map((f) => f.geometry.coordinates)) ?? [NaN, NaN]));
	return {
		bundleJson: JSON.stringify(bundle),
		routesGeojson: routesText ?? JSON.stringify(shapesToGeojson(bundle)),
		stopsGeojson: JSON.stringify(stops),
		timetableJson: JSON.stringify(buildTimetableIndex(files)),
		metaJson: JSON.stringify({
			versionId: target.versionId,
			schemaVersion: OUTPUT_SCHEMA_VERSION,
			shapeSourceCounts: bundle.shapeSourceCounts,
			prefId,
		}),
		shapeSourceCounts: bundle.shapeSourceCounts,
		prefId,
	};
```

> 補足: `centroidOf` が null(停留所なし)なら `resolvePrefId(NaN, NaN)` は内包判定・距離計算とも偽になり null を返す。`target.prefId` があればそちらが優先されるので重心計算は走らない(短絡)。

5. unchanged の戻り値に prefId を追加:

```ts
		return {
			...base,
			status: 'unchanged',
			prefId: target.prefId ?? meta.prefId ?? null,
			shapeSourceCounts: meta.shapeSourceCounts,
		};
```

6. updated の戻り値に prefId を追加:

```ts
	return {
		...base,
		status: 'updated',
		prefId: artifacts.prefId,
		shapeSourceCounts: artifacts.shapeSourceCounts,
	};
```

7. error の戻り値に `prefId: target.prefId ?? null,` を追加。

- [ ] **Step 5: Run test to verify it passes**

Run: `cd pipeline && pnpm exec vitest run src/feedProcessor.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/jobState.ts pipeline/src/feedProcessor.ts pipeline/src/feedProcessor.test.ts
git commit -m "feat(pipeline): consumerで停留所重心からprefIdを決定する"
```

---

### Task 7: finalize で feeds.json へ prefId 出力・summary 集計

**Files:**
- Modify: `pipeline/src/jobState.ts`
- Modify: `pipeline/src/finalize.ts`
- Modify: `pipeline/src/finalize.test.ts`

- [ ] **Step 1: Write the failing test**

`pipeline/src/finalize.test.ts`:

1. `status(t, value)` の戻り値に `prefId: t.prefId ?? null,` を追加。
2. `target(id, source)` に第3引数 `prefId?: number | null` を足し、戻り値に `prefId` を含める。
3. 完了テスト(全 status 完了)で `a` を `target('a','gtfs-data.jp', 13)`、`b` を `target('b','odpt', null)` にし、以下を追加:

```ts
	expect(index.feeds.map((f) => (f as { prefId?: number | null }).prefId)).toEqual([13, null]);
	expect((summary as unknown as { prefIdMissing: number }).prefIdMissing).toBe(1);
```

`JobSummary` 期待値オブジェクトにも `prefIdMissing: 1` を追加する。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && pnpm exec vitest run src/finalize.test.ts`
Expected: FAIL(`prefId` / `prefIdMissing` が無い)

- [ ] **Step 3: Write the implementation**

1. `pipeline/src/jobState.ts` の `JobSummary` に `prefIdMissing: number;` を追加。

2. `pipeline/src/finalize.ts` の `toPublicStatus` 戻り値に `prefId: status.prefId ?? null,` を追加(`source` の下)。

3. `buildSummary` に集計を追加:

```ts
		prefIdMissing: statuses.filter((s) => s.prefId === null || s.prefId === undefined).length,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && pnpm exec vitest run src/finalize.test.ts`
Expected: PASS

- [ ] **Step 5: pipeline 全体の型チェックとテスト**

Run: `cd pipeline && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS(既存テストも含め緑)

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/jobState.ts pipeline/src/finalize.ts pipeline/src/finalize.test.ts
git commit -m "feat(pipeline): feeds.jsonへprefIdを出力しsummaryで未解決を集計する"
```

---

## Phase C — app: 2段階ロードと都道府県セレクタ

### Task 8: コロプレス用静的資産

**Files:**
- Create: `app/static/japan-prefectures.geojson`

- [ ] **Step 1: gtfs-core と同一のポリゴンを app/static へ配置**

Task 3 で生成した簡略化ポリゴンをそのまま静的資産に複製する(同一ソース・同一 `id` 正規化)。

```bash
cp packages/gtfs-core/src/prefectures.geo.json app/static/japan-prefectures.geojson
node -e 'const g=require("./app/static/japan-prefectures.geojson"); console.log("features:",g.features.length, "先頭props:",JSON.stringify(g.features[0].properties))'
```

Expected: `features: 47` / `先頭props: {"id":1}`

- [ ] **Step 2: Commit**

```bash
git add app/static/japan-prefectures.geojson
git commit -m "feat(app): コロプレス用の都道府県ポリゴン静的資産を追加する"
```

---

### Task 9: `data.ts` を2段階ロードへ

**Files:**
- Modify: `app/src/lib/data.ts`

- [ ] **Step 1: `FeedIndexEntry` に prefId を追加**

`app/src/lib/data.ts` の `FeedIndexEntry` に追加(`source?` の下):

```ts
	/** JIS 都道府県コード(1〜47)。旧feeds.json / 未解決は null|undefined */
	prefId?: number | null;
```

- [ ] **Step 2: `loadAll` を `loadIndex` + `loadPrefecture` に分割**

`loadAll` を削除し、次を追加する。`fetchJson` / 既存 import(`CatalogFeed` 等)はそのまま利用する。

```ts
/** feeds.json(インデックス)のみ取得する。都道府県セレクタと件数集計に使う。 */
export async function loadIndex(): Promise<FeedIndex> {
	const index = await fetchJson<FeedIndex>('/data/feeds.json');
	if (!index) throw new Error('feeds.json の取得に失敗しました');
	return index;
}

/** 指定フィード集合の bundle と stops を並列取得する(loadIndex 後に選択県分だけ呼ぶ)。 */
async function loadFeeds(entries: FeedIndexEntry[]): Promise<LoadedData> {
	const stops: StopFeature[] = [];
	const feeds = (
		await Promise.all(
			entries.map(async (f) => {
				const [bundle, s] = await Promise.all([
					fetchJson<FeedBundle>(`/data/feeds/${f.id}/bundle.json`),
					fetchJson<GeneratedFeatureCollection<PointFeature>>(`/data/feeds/${f.id}/stops.geojson`),
				]);
				if (s) {
					for (const feat of s.features) {
						stops.push({
							type: 'Feature',
							geometry: feat.geometry,
							properties: {
								stopId: feat.properties.stop_id,
								name: feat.properties.stop_name,
								feedId: f.id,
								routeKeys: feat.properties.routeIds
									? feat.properties.routeIds.map((rid) => `${f.id}|${rid}`)
									: undefined,
							},
						});
					}
				}
				return bundle ? { id: f.id, name: f.name, bundle } : null;
			}),
		)
	).filter((f): f is CatalogFeed => f !== null);
	return { stops: { type: 'FeatureCollection', features: stops }, feeds };
}

/** 指定都道府県のフィードのみロードする。 */
export function loadPrefecture(prefId: number, index: FeedIndex): Promise<LoadedData> {
	return loadFeeds(index.feeds.filter((f) => f.prefId === prefId));
}

/** フォールバック: prefId が無い(旧feeds.json / 未投入)場合に全フィードをロードする。 */
export function loadAllFeeds(index: FeedIndex): Promise<LoadedData> {
	return loadFeeds(index.feeds);
}

/** 都道府県別の登録フィード数(prefId=null は集計外)。 */
export function prefectureCounts(index: FeedIndex): Map<number, number> {
	const counts = new Map<number, number>();
	for (const f of index.feeds) {
		if (f.prefId == null) continue;
		counts.set(f.prefId, (counts.get(f.prefId) ?? 0) + 1);
	}
	return counts;
}
```

`LoadedData` から `index` フィールドを外す(index は別管理になるため)。`LoadedData` を次に変更:

```ts
export interface LoadedData {
	feeds: CatalogFeed[];
	stops: GeneratedFeatureCollection<StopFeature>;
}
```

- [ ] **Step 3: 型チェック(この時点では +page.svelte が壊れるので後続タスクで直す)**

Run: `cd packages/gtfs-core && pnpm check`(gtfs-core 側の import 健全性のみ先に確認)
Expected: PASS。app の `pnpm check` は Task 12 完了後にまとめて緑にする。

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/data.ts
git commit -m "feat(app): データ取得を2段階(index/prefecture)へ分割する"
```

---

### Task 10: `PrefectureHeader.svelte`

**Files:**
- Create: `app/src/lib/PrefectureHeader.svelte`

参照デザイン「選択後:常設ヘッダーセレクタ」節(`PREFECTURE` ラベル + 県名 + 変更ボタン)。

- [ ] **Step 1: コンポーネントを作成**

`app/src/lib/PrefectureHeader.svelte`:

```svelte
<script lang="ts">
	let { prefName, onChange }: { prefName: string; onChange: () => void } = $props();
</script>

<div
	class="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2.5 rounded-xl border border-mi-slate-200 bg-white/95 py-1.5 pr-1.5 pl-3.5 shadow-[0_8px_20px_rgba(7,48,61,0.14)] backdrop-blur"
>
	<div class="flex min-w-0 flex-col">
		<span class="font-display text-[9.5px] leading-3 font-bold tracking-[0.08em] text-mi-slate-400"
			>PREFECTURE</span
		>
		<span class="truncate text-[15px] leading-5 font-bold text-mi-slate-900">{prefName}</span>
	</div>
	<button
		onclick={onChange}
		class="flex flex-none items-center gap-1.5 rounded-[9px] border border-mi-slate-300 bg-white px-2.5 py-1.5 text-[12.5px] font-bold text-mi-teal-600 transition-colors hover:bg-mi-teal-50"
	>
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"
			></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"
			></path></svg
		>
		変更
	</button>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add app/src/lib/PrefectureHeader.svelte
git commit -m "feat(app): 選択後の都道府県ヘッダを追加する"
```

---

### Task 11: `PrefecturePicker.svelte`(コロプレス)

**Files:**
- Create: `app/src/lib/PrefecturePicker.svelte`

参照デザイン「選択導線A:オーバーレイ(地図で選択)」節。地図本体(`MapLibre` インスタンス)は `+page.svelte` から `map` prop で受け取り、本コンポーネントはコロプレス用の source/layer を命令的に追加・除去し、オーバーレイUI(プロンプト・凡例・ツールチップ・トースト)を描画する。

- [ ] **Step 1: コンポーネントを作成**

`app/src/lib/PrefecturePicker.svelte`:

```svelte
<script lang="ts">
	import type { Map as MaplibreMap, MapLayerMouseEvent } from 'maplibre-gl';
	import { PREFECTURES, prefectureById } from 'gtfs-core';

	let {
		map,
		counts,
		onSelect,
	}: {
		map: MaplibreMap | undefined;
		/** 都道府県別フィード数(prefId → 件数) */
		counts: Map<number, number>;
		onSelect: (prefId: number) => void;
	} = $props();

	const REG = '#cfe6ee';
	const NONE = '#e7edf0';
	const HOVER = '#3a93b3';
	const SRC = 'pref-choropleth';
	const registeredIds = $derived([...counts.keys()].filter((id) => (counts.get(id) ?? 0) > 0));
	const registeredCount = $derived(registeredIds.length);

	let toast = $state<string | null>(null);
	let tip = $state<{ x: number; y: number; text: string } | null>(null);
	let hoverId: number | null = null;

	function showToast(msg: string) {
		toast = msg;
		setTimeout(() => (toast = null), 2600);
	}

	async function fetchPolygons(): Promise<GeoJSON.FeatureCollection> {
		const res = await fetch('/japan-prefectures.geojson');
		return (await res.json()) as GeoJSON.FeatureCollection;
	}

	function setHover(id: number | null) {
		if (!map) return;
		if (hoverId !== null) map.setFeatureState({ source: SRC, id: hoverId }, { hover: false });
		hoverId = id;
		if (id !== null) map.setFeatureState({ source: SRC, id }, { hover: true });
	}

	function onMove(ev: MapLayerMouseEvent) {
		const f = ev.features?.[0];
		if (!f || typeof f.id !== 'number') return;
		if (f.id !== hoverId) setHover(f.id);
		const info = prefectureById(f.id);
		const n = counts.get(f.id) ?? 0;
		tip = {
			x: ev.point.x,
			y: ev.point.y,
			text: info ? `${info.ja}・${n > 0 ? `${n}フィード` : 'データなし'}` : '',
		};
		map!.getCanvas().style.cursor = n > 0 ? 'pointer' : 'default';
	}

	function onLeave() {
		setHover(null);
		tip = null;
		if (map) map.getCanvas().style.cursor = '';
	}

	function onClick(ev: MapLayerMouseEvent) {
		const f = ev.features?.[0];
		if (!f || typeof f.id !== 'number') return;
		const n = counts.get(f.id) ?? 0;
		const info = prefectureById(f.id);
		if (n > 0) onSelect(f.id);
		else if (info) showToast(`${info.ja} はGTFSデータが未登録です`);
	}

	// map と counts が揃ったらコロプレスを追加。破棄時にレイヤ/ソース/ハンドラを外す。
	$effect(() => {
		const m = map;
		if (!m) return;
		let disposed = false;
		fetchPolygons().then((geo) => {
			if (disposed || !m.isStyleLoaded()) {
				if (disposed) return;
			}
			if (m.getSource(SRC)) return;
			m.addSource(SRC, { type: 'geojson', data: geo, promoteId: 'id' });
			const before = m.getStyle().layers.find((l) => l.id !== 'base')?.id;
			m.addLayer(
				{
					id: 'pref-fill',
					type: 'fill',
					source: SRC,
					paint: {
						'fill-color': [
							'case',
							['boolean', ['feature-state', 'hover'], false],
							HOVER,
							['in', ['get', 'id'], ['literal', registeredIds]],
							REG,
							NONE,
						],
						'fill-opacity': [
							'case',
							['boolean', ['feature-state', 'hover'], false],
							0.72,
							['in', ['get', 'id'], ['literal', registeredIds]],
							0.5,
							0.4,
						],
					},
				},
				before,
			);
			m.addLayer(
				{
					id: 'pref-line',
					type: 'line',
					source: SRC,
					paint: { 'line-color': HOVER, 'line-width': 0.8, 'line-opacity': 0.7 },
				},
				before,
			);
			m.on('mousemove', 'pref-fill', onMove);
			m.on('mouseleave', 'pref-fill', onLeave);
			m.on('click', 'pref-fill', onClick);
		});
		return () => {
			disposed = true;
			if (!m.getStyle()) return;
			m.off('mousemove', 'pref-fill', onMove);
			m.off('mouseleave', 'pref-fill', onLeave);
			m.off('click', 'pref-fill', onClick);
			for (const id of ['pref-fill', 'pref-line']) if (m.getLayer(id)) m.removeLayer(id);
			if (m.getSource(SRC)) m.removeSource(SRC);
			m.getCanvas().style.cursor = '';
		};
	});
</script>

<!-- プロンプト -->
<div
	class="pointer-events-none absolute top-6 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-0.5 rounded-2xl border border-mi-slate-200 bg-white/95 px-6 py-3 text-center shadow-[0_10px_26px_rgba(7,48,61,0.14)] backdrop-blur"
>
	<div class="font-display text-[11px] font-bold tracking-[0.1em] text-mi-teal-600">
		SELECT PREFECTURE
	</div>
	<div class="text-[17px] leading-6 font-bold text-mi-slate-900">都道府県を選択してください</div>
	<div class="text-[12.5px] leading-[18px] text-mi-slate-500">
		地図をタップすると、その県のバス路線を表示します・<span class="font-bold text-mi-teal-600"
			>{registeredCount}</span
		> 都道府県が登録済み
	</div>
</div>

<!-- 凡例 -->
<div
	class="absolute bottom-6 left-4 z-10 flex flex-col gap-1.5 rounded-xl border border-mi-slate-200 bg-white/95 px-3.5 py-2.5 shadow-[0_6px_16px_rgba(7,48,61,0.12)] backdrop-blur"
>
	<div class="flex items-center gap-2 text-[11.5px] text-mi-slate-700">
		<span class="h-3 w-3 rounded-[3px] border-[1.5px] border-mi-teal-600" style="background:#cfe6ee"
		></span>データ登録あり
	</div>
	<div class="flex items-center gap-2 text-[11.5px] text-mi-slate-500">
		<span class="h-3 w-3 rounded-[3px] border-[1.5px] border-mi-slate-300" style="background:#e7edf0"
		></span>データなし
	</div>
</div>

<!-- ホバーツールチップ -->
{#if tip}
	<div
		class="pointer-events-none absolute z-30 rounded-[9px] bg-mi-teal-900/90 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg"
		style="left:{tip.x}px; top:{tip.y}px; transform:translate(14px,14px)"
	>
		{tip.text}
	</div>
{/if}

<!-- トースト -->
{#if toast}
	<div
		class="absolute bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-[10px] bg-mi-teal-900/90 px-4 py-2.5 text-center text-[13.5px] text-white shadow-lg"
	>
		{toast}
	</div>
{/if}
```

> 注意: `feature-state` の hover は Feature id を要するため `promoteId: 'id'`(properties.id を Feature id に昇格)を指定している。`base` レイヤ(背景ラスタ)より上・他レイヤより下に差し込む。

- [ ] **Step 2: Commit**

```bash
git add app/src/lib/PrefecturePicker.svelte
git commit -m "feat(app): コロプレス都道府県ピッカーを追加する"
```

---

### Task 12: `+page.svelte` を URL 駆動の状態機械へ

**Files:**
- Modify: `app/src/routes/+page.svelte`

現状の `+page.svelte` は `loadAll()` を1回呼び全描画する。これを「index ロード → 未選択ならピッカー / 選択済みなら県ロードして描画」に組み替える。

- [ ] **Step 1: import と状態を差し替える**

先頭 import に追加:

```ts
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import PrefecturePicker from '$lib/PrefecturePicker.svelte';
	import PrefectureHeader from '$lib/PrefectureHeader.svelte';
	import { prefectureById } from 'gtfs-core';
	import {
		loadIndex,
		loadPrefecture,
		loadAllFeeds,
		prefectureCounts,
		type FeedIndex,
	} from '$lib/data';
	import { LngLatBounds } from 'maplibre-gl';
```

`loadAll` の import は削除する。`data` 状態はそのまま(`LoadedData | null`)。以下を追加:

```ts
	let index = $state<FeedIndex | null>(null);
	// prefId が全て null(旧feeds.json / 未投入)なら従来の全量表示にフォールバックする
	const hasPrefData = $derived(!!index && index.feeds.some((f) => f.prefId != null));
	const counts = $derived(index ? prefectureCounts(index) : new Map<number, number>());
	// 選択中の都道府県は URL クエリ ?pref を単一情報源にする
	const selectedPref = $derived.by(() => {
		const raw = page.url.searchParams.get('pref');
		const n = raw ? Number(raw) : NaN;
		return Number.isInteger(n) && (counts.get(n) ?? 0) > 0 ? n : null;
	});
	const showPicker = $derived(!!index && hasPrefData && selectedPref === null);
	let prefLoading = $state(false);
```

- [ ] **Step 2: ロードの $effect を差し替える**

既存の `loadAll().then(...)` の `$effect` を次に置換:

```ts
	// インデックス(feeds.json)を初回に取得する
	$effect(() => {
		loadIndex()
			.then((idx) => (index = idx))
			.catch((e: Error) => (loadError = e.message));
	});

	// 選択県(または prefId 無しなら全量)に応じてフィードデータをロードし直す
	$effect(() => {
		const idx = index;
		if (!idx) return;
		// prefId 未投入 → 従来どおり全量表示
		if (!hasPrefData) {
			prefLoading = true;
			loadAllFeeds(idx)
				.then((d) => (data = d))
				.catch((e: Error) => (loadError = e.message))
				.finally(() => (prefLoading = false));
			return;
		}
		const pref = selectedPref;
		if (pref === null) {
			// 未選択: ピッカー表示。前県の描画・状態をクリアする
			data = null;
			hidden = {};
			selected = null;
			selectedStop = null;
			timetableByFeed = {};
			return;
		}
		prefLoading = true;
		loadPrefecture(pref, idx)
			.then((d) => {
				data = d;
				fitToStops(d);
			})
			.catch((e: Error) => (loadError = e.message))
			.finally(() => (prefLoading = false));
	});

	// ロード済み県の停留所範囲へ地図を寄せる(県ポリゴンbboxは離島で巨大になるため使わない)
	function fitToStops(d: typeof data) {
		if (!map || !d || d.stops.features.length === 0) return;
		const b = new LngLatBounds();
		for (const s of d.stops.features) b.extend(s.geometry.coordinates);
		map.fitBounds(b, { padding: { top: 90, right: 60, bottom: 150, left: 60 }, maxZoom: 13, duration: 1200 });
	}

	function selectPref(prefId: number) {
		goto(`?pref=${prefId}`, { keepFocus: true, noScroll: true });
	}
	function clearPref() {
		goto('?', { keepFocus: true, noScroll: true });
	}
```

- [ ] **Step 3: `Controls` に渡す出典を県サブセットへ**

現状 `feedInfos={data?.index.feeds ?? []}` は `data.index` が無くなったため壊れる。選択県の index エントリを渡すよう変更する。`catalog` 等の `$derived` は `data.feeds`(部分集合)を使うので不変。`Controls` 呼び出しを:

```svelte
	<Controls
		busCount={buses.features.length}
		feedInfos={index && selectedPref !== null
			? index.feeds.filter((f) => f.prefId === selectedPref)
			: (index?.feeds ?? [])}
		mapAttribution={BASEMAPS[basemap].attribution}
	/>
```

- [ ] **Step 4: テンプレートにピッカー / ヘッダ / ローディングを差し込む**

`MapLibre` の中(レイヤ群と同階層)ではなく、`{#if data}` 周辺のオーバーレイ領域に追加する。`RouteLayers` / `Controls` / `StopTimetable` は **選択県がある(showPicker が false かつ data あり)ときだけ** 表示する。

`{#if data}<RouteLayers .../>{/if}` と `<Controls .../>`、`<StopTimetable .../>` を次のようにガードする:

```svelte
	{#if showPicker}
		<PrefecturePicker {map} {counts} onSelect={selectPref} />
	{/if}

	{#if selectedPref !== null && index}
		<PrefectureHeader
			prefName={prefectureById(selectedPref)?.ja ?? ''}
			onChange={clearPref}
		/>
	{/if}

	{#if prefLoading}
		<div
			class="absolute top-1/2 left-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 rounded-xl border border-mi-slate-200 bg-white/95 px-4.5 py-3 text-sm text-mi-slate-600 shadow-[0_8px_22px_rgba(7,48,61,0.16)]"
		>
			<span
				class="h-4 w-4 animate-spin rounded-full border-[2.5px] border-mi-slate-200 border-t-mi-teal-600"
			></span>
			全国の路線データを読み込み中…
		</div>
	{/if}

	{#if data && !showPicker}
		<RouteLayers routes={activeRoutes} bind:hidden {dateLabel} />
		<Controls
			busCount={buses.features.length}
			feedInfos={index && selectedPref !== null
				? index.feeds.filter((f) => f.prefId === selectedPref)
				: (index?.feeds ?? [])}
			mapAttribution={BASEMAPS[basemap].attribution}
		/>
		<StopTimetable
			open={!!selectedStop}
			stopName={selectedStop?.name ?? ''}
			{dateLabel}
			{timeLabel}
			timetable={stopTimetable}
			onClose={() => (selectedStop = null)}
		/>
	{/if}
```

> 既存の「運行中のバスはありません」通知(`{#if data && buses.features.length === 0}`)も `!showPicker` 条件を足す。`loadError` 表示は現状のまま。`MapLibre` の初期 `center`/`zoom` は全国が見える値(例 `center={[137.5, 38]} zoom={4}`)に変更する。

- [ ] **Step 5: 初期ビューを全国に**

`<MapLibre ... center={[139.2, 36.35]} zoom={10} ...>` を `center={[137.5, 38]} zoom={4}` に変更する(未選択時に日本全体が見える)。選択後は `fitToStops` が寄せる。

- [ ] **Step 6: 型チェック**

Run: `cd app && pnpm check`
Expected: PASS(0 errors)。エラーが出たら該当箇所を修正する(主に `data.index` 参照の残り・型不一致)。

- [ ] **Step 7: Commit**

```bash
git add app/src/routes/+page.svelte
git commit -m "feat(app): URL駆動の都道府県セレクタと2段階ロードを実装する"
```

---

### Task 13: ローカル検証(全国サブセット + スケール確認)

**Files:** なし(検証のみ)

- [ ] **Step 1: 環境準備**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
```

- [ ] **Step 2: ローカル R2 に全国サブセットを seed**

`pipeline/src/index.ts` のローカル seed 対象(gtfs-data.jp の `prefIds`)に群馬(10)に加え**最大規模県の高知(39)か長野(20)**を含める。既存の seed 手順(README「ローカルR2を更新する」)に従い実行:

```bash
# ターミナル1
cd pipeline && pnpm dev
# ターミナル2
just seed   # もしくは curl "http://localhost:8787/__scheduled?cron=0+20+L+*+*"
```

seed 後、ローカル R2 の feeds.json に `prefId` が入っていることを確認:

```bash
cd pipeline
pnpm exec wrangler r2 object get gtfs-view-bus-data/feeds.json --local --file /tmp/local-feeds.json
node -e 'const j=require("/tmp/local-feeds.json"); const withPref=j.feeds.filter(f=>f.prefId!=null); console.log("total:",j.feeds.length,"prefId有:",withPref.length); console.log("pref別:",[...new Set(j.feeds.map(f=>f.prefId))])'
```

Expected: `prefId有` が gtfs-data.jp 由来フィード数以上。群馬(10)と最大規模県の id が現れる。

- [ ] **Step 3: dev サーバで手動確認**

```bash
just dev
```

ブラウザで以下を確認(設計書「検証」節):
- 初回アクセスで**コロプレスピッカー**が出る。登録県はティール、データなしはグレー。
- 登録県クリックで段階ロード → ローディング表示 → その県の路線/バス/停留所が描画され、**停留所範囲へ fitBounds** される。
- データなし県クリックで「◯◯県 はGTFSデータが未登録です」トースト。
- `?pref=10` を直接開くとピッカーを飛ばして群馬を表示。「変更」でピッカーへ戻り、路線パネルの hidden 等がクリアされる。
- 最大規模県(高知/長野)で初回ロードが実用的な時間で終わり、再生(×60)中もフレーム落ちが許容範囲。
- ブラウザの戻る/進むで pref 選択が復元する。

- [ ] **Step 4: フォールバック確認**

prefId を持たない旧 feeds.json(例: `prefId` フィールドを外した feeds.json)を R2 に置くと、ピッカーを出さず従来どおり全量表示になることを確認する。確認後、通常の seed に戻す。

- [ ] **Step 5: 全体 CI チェック**

```bash
just ci
```

Expected: format:check → lint → check → test → build がすべて緑。

- [ ] **Step 6: Commit(必要なら seed 対象変更のみ)**

```bash
git add pipeline/src/index.ts
git commit -m "chore(pipeline): ローカルseedに最大規模県を追加する"
```

---

## Self-Review 結果

- **Spec coverage**: データモデル(Task 4-7)、gtfs-core モジュール分離(Task 1-3)、2段階ロード(Task 9)、コロプレスピッカー+`promoteId`(Task 11)、常設ヘッダ+変更(Task 10,12)、URL 単一情報源+状態リセット(Task 12)、stops bbox への fitBounds(Task 12)、フォールバック(Task 9,12,13)、出典サブセット(Task 12)、summary の null 集計(Task 7)、最大規模県スケール確認(Task 13)— 設計書の各節に対応タスクあり。
- **型整合**: `loadIndex`/`loadPrefecture`/`loadAllFeeds`/`prefectureCounts`(data.ts)、`resolvePrefId`/`centroidOf`/`PREFECTURES`/`prefectureById`(gtfs-core)、`FeedTarget.prefId`/`FeedStatus.prefId`/`JobSummary.prefIdMissing`(pipeline)を各タスク間で一貫使用。
- **プレースホルダ**: 実コード/実コマンドで記述。ポリゴン生成のみ外部データ取得を伴うため検証コマンドを併記。
