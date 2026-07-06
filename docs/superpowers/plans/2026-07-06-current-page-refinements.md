# Current Page リファインメント Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** claude.ai/design のプロトタイプ差分(出典開閉・停留所↔路線関連付け・運行/運休の停留所&路線の描き分け)を現行 SvelteKit アプリに反映する。

**Architecture:** パイプライン(gtfs-core + pipeline Worker)で各停留所に「通る路線 route_id」を付与し、停留所 GeoJSON を stops.txt から生成一本化する。アプリは routeCatalog の当日運行判定を再利用して、停留所・路線を運行中/運休で描き分ける。

**Tech Stack:** TypeScript / Svelte 5 (runes) / svelte-maplibre-gl (MapLibre GL) / Vitest(gtfs-core・pipeline のみ) / Cloudflare Workers + R2 / just。

**前提:** 作業ブランチ `feature/current-page-refinements`(作成済み)。gtfs-core/pipeline は Vitest で TDD。アプリ(`app/`)は Vitest 未整備のため、型チェック(`pnpm --filter app check`)+ ローカル目視/Playwright で検証する(リポジトリの現状に準拠)。

---

## ファイル構成

**変更するファイルと責務:**

- `packages/gtfs-core/src/geojson.ts` — 停留所 GeoJSON 生成。`stopRouteIds`(新規: 停留所→route_id 集合)と `stopsToGeojson`(routeIds 付与)を担う。
- `packages/gtfs-core/src/geojson.test.ts` — 上記のテスト。
- `pipeline/src/run.ts` — 停留所 GeoJSON を生成一本化し routeIds を付与。
- `pipeline/src/run.test.ts` — 上記のテスト。
- `pipeline/src/sources/types.ts` / `sources/gtfsDataJp.ts` — 未使用化する `stopsGeojsonUrl` を削除。
- `pipeline/src/sources/gtfsDataJp.test.ts` / `sources/odpt.test.ts` — 上記に伴うアサーション削除。
- `app/src/lib/data.ts` — `StopFeature` 型と loadAll の停留所整形(feedId/routeKeys 付与)、`buildRouteLines` に `active` 追加。
- `app/src/routes/+page.svelte` — 運休路線ライン、停留所の運行/運休レイヤ、レイヤ重なり順。
- `app/src/lib/Controls.svelte` — データ出典の開閉トグル。

---

## Task 1: gtfs-core — `stopRouteIds`(停留所→route_id 集合)

**Files:**
- Modify: `packages/gtfs-core/src/geojson.ts`
- Test: `packages/gtfs-core/src/geojson.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/gtfs-core/src/geojson.test.ts` の import 行を差し替え、末尾に describe を追加する。

import 行(1行目付近)を次に変更:

```ts
import { shapesToGeojson, stopRouteIds, stopsToGeojson } from './geojson';
```

ファイル末尾に追加:

```ts
describe('stopRouteIds', () => {
	it('各停留所を通る route_id 集合を stop_times × trips から算出する', () => {
		// フィクスチャ: A/B/C とも T1・T2(R1)と T3(R2)が通る
		expect(stopRouteIds(FIXTURE_FILES)).toEqual({
			A: ['R1', 'R2'],
			B: ['R1', 'R2'],
			C: ['R1', 'R2'],
		});
	});

	it('stop_times が無ければ空オブジェクトを返す', () => {
		expect(stopRouteIds({})).toEqual({});
	});

	it('trips に無い trip_id の stop_time は無視する', () => {
		const files = {
			'trips.txt': 'route_id,service_id,trip_id\nRX,WD,T9\n',
			'stop_times.txt':
				'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT9,08:00,08:00,S1,1\nGHOST,09:00,09:00,S2,1\n',
		};
		expect(stopRouteIds(files)).toEqual({ S1: ['RX'] });
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core exec vitest run src/geojson.test.ts`
Expected: FAIL(`stopRouteIds is not a function` / import エラー)

- [ ] **Step 3: 実装を追加**

`packages/gtfs-core/src/geojson.ts` の `stopsToGeojson` の直前(21行目のコメントの前)に追加:

```ts
/**
 * 各停留所を通る route_id の集合を stop_times × trips から算出する。
 * trips.txt(trip_id→route_id)と stop_times.txt(stop_id)を突き合わせ、
 * 出現順を保った route_id 配列を stop_id ごとに返す。
 */
export function stopRouteIds(files: Record<string, string>): Record<string, string[]> {
	const tripRoute = new Map<string, string>();
	for (const t of parseCsv(files['trips.txt'] ?? '')) tripRoute.set(t.trip_id, t.route_id);
	const byStop = new Map<string, Set<string>>();
	for (const st of parseCsv(files['stop_times.txt'] ?? '')) {
		const routeId = tripRoute.get(st.trip_id);
		if (!routeId) continue;
		let set = byStop.get(st.stop_id);
		if (!set) {
			set = new Set();
			byStop.set(st.stop_id, set);
		}
		set.add(routeId);
	}
	const result: Record<string, string[]> = {};
	for (const [stopId, set] of byStop) result[stopId] = [...set];
	return result;
}
```

（`parseCsv` は同ファイルで import 済み。）

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter gtfs-core exec vitest run src/geojson.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/gtfs-core/src/geojson.ts packages/gtfs-core/src/geojson.test.ts
git commit -m "feat(gtfs-core): 停留所ごとの通過route_idを算出するstopRouteIdsを追加"
```

---

## Task 2: gtfs-core — `stopsToGeojson` に routeIds を付与

**Files:**
- Modify: `packages/gtfs-core/src/geojson.ts`
- Test: `packages/gtfs-core/src/geojson.test.ts`

- [ ] **Step 1: テストを更新(既存の期待値に routeIds を足し、新規ケースを追加)**

`geojson.test.ts` の既存の最初の `it` の期待値(`toEqual({...})`)を次に更新:

```ts
		expect(fc.features[0]).toEqual({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [139, 36] },
			properties: { stop_id: 'A', stop_name: '駅前', routeIds: [] },
		});
```

`describe('stopsToGeojson', ...)` の中に新規 `it` を追加:

```ts
	it('stopRoutes を渡すと各停留所に routeIds を付与する', () => {
		const fc = stopsToGeojson(FIXTURE_FILES, stopRouteIds(FIXTURE_FILES));
		expect(fc.features.find((f) => f.properties.stop_id === 'A')?.properties.routeIds).toEqual([
			'R1',
			'R2',
		]);
	});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core exec vitest run src/geojson.test.ts`
Expected: FAIL(最初の `it` が routeIds 不一致、新規 `it` が routeIds undefined)

- [ ] **Step 3: 実装を更新**

`geojson.ts` の `PointFeature` の properties に `routeIds` を追加:

```ts
export interface PointFeature {
	type: 'Feature';
	geometry: { type: 'Point'; coordinates: LngLat };
	/** routeIds は「この停留所を通る route_id」。旧データ(付与前)には無いため optional */
	properties: { stop_id: string; stop_name: string; routeIds?: string[] };
}
```

`stopsToGeojson` のシグネチャと push 部分を更新:

```ts
/** stops.txt からPointのFeatureCollectionを生成する(ソース提供のstops.geojsonが無いフィード用)。
 *  stopRoutes を渡すと各停留所に routeIds(通る route_id)を付与する。 */
export function stopsToGeojson(
	files: Record<string, string>,
	stopRoutes?: Record<string, string[]>,
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
			properties: {
				stop_id: row.stop_id,
				stop_name: row.stop_name,
				routeIds: stopRoutes?.[row.stop_id] ?? [],
			},
		});
	}
	return { type: 'FeatureCollection', features };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter gtfs-core exec vitest run src/geojson.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/gtfs-core/src/geojson.ts packages/gtfs-core/src/geojson.test.ts
git commit -m "feat(gtfs-core): stopsToGeojsonに停留所ごとのrouteIdsを付与"
```

---

## Task 3: pipeline — 停留所 GeoJSON を生成一本化し routeIds を付与

**Files:**
- Modify: `pipeline/src/run.ts:1`(import)、`pipeline/src/run.ts:145-154`(停留所書き込み)
- Test: `pipeline/src/run.test.ts`

- [ ] **Step 1: テストを更新(生成一本化 + routeIds を検証)**

`run.test.ts` の最初のテスト「新規フィードを変換して…」の `expect(bucket.store.has(...stops.geojson...)).toBe(true);`(112行目付近)の直後に追加:

```ts
			// file_stop_url があってもソース geojson は使わず stops.txt から生成し、routeIds を付与する
			const stops = JSON.parse(bucket.store.get(`feeds/${id}/stops.geojson`) ?? '{}') as {
				features: { properties: { stop_id: string; routeIds: string[] } }[];
			};
			expect(stops.features).toHaveLength(3);
			expect(stops.features.find((f) => f.properties.stop_id === 'A')?.properties.routeIds).toEqual(
				['R1', 'R2'],
			);
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/run.test.ts`
Expected: FAIL(現状はソース提供の空 FC を保存するため features が 0 件で `toHaveLength(3)` が失敗)

- [ ] **Step 3: 実装を更新**

`run.ts` の import(1行目)に `stopRouteIds` を追加:

```ts
import { convertFeed, shapesToGeojson, stopRouteIds, stopsToGeojson, unzipFeed } from 'gtfs-core';
```

`run.ts` の停留所ブロック(現在の 145-154 行)を次に置換:

```ts
		// 停留所レイヤは常に stops.txt から生成し、各停留所に routeIds(通る路線)を付与する。
		// これによりアプリ側で当日運行/運休の停留所を色分け・区別できる(ソース提供の
		// stops.geojson は stops.txt 由来の派生物のため使わない)。
		await bucket.put(
			`feeds/${d.id}/stops.geojson`,
			JSON.stringify(stopsToGeojson(files, stopRouteIds(files))),
		);
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter pipeline exec vitest run src/run.test.ts`
Expected: PASS(全テスト)

- [ ] **Step 5: コミット**

```bash
git add pipeline/src/run.ts pipeline/src/run.test.ts
git commit -m "feat(pipeline): 停留所geojsonを生成一本化しrouteIdsを付与"
```

---

## Task 4: pipeline — 未使用になった `stopsGeojsonUrl` を削除

**Files:**
- Modify: `pipeline/src/sources/types.ts:19-20`
- Modify: `pipeline/src/sources/gtfsDataJp.ts:44`
- Modify: `pipeline/src/sources/gtfsDataJp.test.ts`(2アサーション削除)
- Modify: `pipeline/src/sources/odpt.test.ts`(1アサーション削除)

- [ ] **Step 1: 型と実装から削除**

`types.ts` の 19-20 行を次に置換(`stopsGeojsonUrl` 行を削除し、コメントを routes 用に更新):

```ts
	/** ソースがルート形状のGeoJSONを別配布している場合のみ設定。無ければGTFSのshapesから生成する */
	routesGeojsonUrl?: string;
```

`gtfsDataJp.ts` の 44 行 `stopsGeojsonUrl: entry.file_stop_url ?? undefined,` を削除する(`routesGeojsonUrl` 行は残す)。

- [ ] **Step 2: テストのアサーションを削除**

`gtfsDataJp.test.ts` から次の1行を削除:

```ts
		expect(d.stopsGeojsonUrl).toBe('https://example.com/stops.geojson');
```

`gtfsDataJp.test.ts` から次の1行を削除:

```ts
		expect(feeds[0].stopsGeojsonUrl).toBeUndefined();
```

`odpt.test.ts` から次の1行を削除:

```ts
		expect(yosii?.stopsGeojsonUrl).toBeUndefined();
```

- [ ] **Step 3: 型チェックとテストが通ることを確認**

Run: `pnpm --filter pipeline run check && pnpm --filter pipeline exec vitest run`
Expected: PASS(型エラー無し・全テスト緑)

- [ ] **Step 4: コミット**

```bash
git add pipeline/src/sources/types.ts pipeline/src/sources/gtfsDataJp.ts pipeline/src/sources/gtfsDataJp.test.ts pipeline/src/sources/odpt.test.ts
git commit -m "refactor(pipeline): 未使用になったstopsGeojsonUrlを削除"
```

---

## Task 5: app — `data.ts` に停留所整形と路線 active 付与

**Files:**
- Modify: `app/src/lib/data.ts`

- [ ] **Step 1: import と型を追加**

`data.ts` の先頭の gtfs-core import に `LngLat` と `PointFeature` を追加:

```ts
import type {
	CatalogFeed,
	FeedBundle,
	GeneratedFeatureCollection,
	LineFeature,
	LngLat,
	PointFeature,
	RouteInfo,
} from 'gtfs-core';
```

`LoadedData` の直前に `StopFeature` 型を追加し、`LoadedData.stops` の型を差し替える:

```ts
/** アプリ描画用に整形した停留所。routeKeys は `${feedId}|${routeId}` の配列
 *  (旧データ=routeIds 無しは undefined:分類不能フォールバックの印) */
export interface StopFeature {
	type: 'Feature';
	geometry: { type: 'Point'; coordinates: LngLat };
	properties: { stopId: string; name: string; feedId: string; routeKeys: string[] | undefined };
}

export interface LoadedData {
	index: FeedIndex;
	feeds: CatalogFeed[];
	stops: GeneratedFeatureCollection<StopFeature>;
}
```

既存の `interface GeoJsonFeatureCollection { ... }` は他で使われていなければ削除する(loadAll の書き換えで不要になる)。

- [ ] **Step 2: loadAll の停留所整形を書き換える**

`loadAll` の本体を次に置換(`stops` を `StopFeature[]` として組み立て、feedId/routeKeys を付与):

```ts
export async function loadAll(): Promise<LoadedData> {
	const index = await fetchJson<FeedIndex>('/data/feeds.json');
	if (!index) throw new Error('feeds.json の取得に失敗しました');
	const stops: StopFeature[] = [];
	// Promise.all は入力順で結果を返すため、feeds.json の順序が保たれる(パネルの事業者並びを毎回同一にする)
	const feeds = (
		await Promise.all(
			index.feeds.map(async (f) => {
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
								// routeIds 無し(再生成前の旧データ)は undefined にして分類不能フォールバックへ
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
	return { index, feeds, stops: { type: 'FeatureCollection', features: stops } };
}
```

- [ ] **Step 3: buildRouteLines を全路線出力 + active 付与に変更**

`RouteLineFeature` の properties を更新:

```ts
interface RouteLineFeature {
	type: 'Feature';
	geometry: LineFeature['geometry'];
	/** color/key は描画・参照用。active は当日運行フラグ(運休路線の描き分け用) */
	properties: { color: string; key: string; active: boolean };
}
```

`buildRouteLines` の JSDoc と本体を、active フィルタ撤廃 + active 付与に更新:

```ts
/**
 * 路線線(色分け)の GeoJSON をクライアントで生成する。
 * bundle.shapes を trips 経由で route に結び付け、当日運行(active)フラグを付けて全路線を出力する。
 * 運行/運休の描き分けと非表示路線の除外はレイヤ側の filter で行う。
 */
export function buildRouteLines(feeds: CatalogFeed[], catalog: RouteInfo[]): RouteLineCollection {
	const byKey = new Map(catalog.map((r) => [r.key, r]));
	const features: RouteLineFeature[] = [];
	for (const { id, bundle } of feeds) {
		// shapeId → routeId(最初に見つかった trip の route を採用)
		const shapeRoute = new Map<string, string>();
		for (const trip of bundle.trips) {
			if (!shapeRoute.has(trip.shapeId)) shapeRoute.set(trip.shapeId, trip.routeId);
		}
		for (const [shapeId, shape] of Object.entries(bundle.shapes)) {
			if (shape.coords.length < 2) continue;
			const routeId = shapeRoute.get(shapeId);
			if (!routeId) continue;
			const info = byKey.get(`${id}|${routeId}`);
			if (!info) continue;
			features.push({
				type: 'Feature',
				geometry: { type: 'LineString', coordinates: shape.coords },
				properties: { color: info.color, key: info.key, active: info.active },
			});
		}
	}
	return { type: 'FeatureCollection', features };
}
```

- [ ] **Step 4: 型チェックが通ることを確認**

Run: `pnpm --filter app check`
Expected: `data.ts` 由来の型エラーが無いこと(`+page.svelte` は Task 6 で更新するため、そちらの参照エラーは Task 6 完了時に解消する)。

- [ ] **Step 5: コミット**

```bash
git add app/src/lib/data.ts
git commit -m "feat(app): 停留所にfeedId/routeKeysを付与し路線ラインにactiveを追加"
```

---

## Task 6: app — 運休路線ライン・停留所の運行/運休レイヤ

**Files:**
- Modify: `app/src/routes/+page.svelte`

- [ ] **Step 1: import と定数を更新**

`+page.svelte` の script 冒頭、`data.ts` からの import に `StopFeature` を追加:

```ts
	import {
		buildRouteLines,
		loadAll,
		type LoadedData,
		type RouteLineCollection,
		type StopFeature,
	} from '$lib/data';
```

停留所定数(44-56 行付近の `ROUTE_COLOR_EXPR`〜`STOP_RADIUS_EXPR`)を次に置換:

```ts
	// 路線色はデータ駆動式で指定する
	const ROUTE_COLOR_EXPR: ExpressionSpecification = ['get', 'color'];
	// 停留所を表示する最小ズーム(これ未満では非表示にして俯瞰時の煩雑さを避ける)
	const STOP_MIN_ZOOM = 12;
	// 運行中停留所: 白抜き + 路線色リング(ラインの視認を妨げない)
	const STOP_ACTIVE_RADIUS: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 12, 3.5, 16, 7];
	const STOP_ACTIVE_STROKE: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 2.5];
	// 運休停留所: 小さいグレーの中実点(運行中と別シンボルにして目立たせない)
	const STOP_INACTIVE_RADIUS: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 4.5];
	const STOP_INACTIVE_COLOR = '#aeb9bf';
	// 旧データ(routeIds 無し)フォールバックのリング色
	const STOP_NEUTRAL_COLOR = '#6e848d';
	// レイヤ filter は真偽式。get('active') で運行/運休を分離する
	const STOP_ACTIVE_FILTER: ExpressionSpecification = ['==', ['get', 'active'], true];
	const STOP_INACTIVE_FILTER: ExpressionSpecification = ['==', ['get', 'active'], false];
	const INACTIVE_ROUTE_FILTER: ExpressionSpecification = ['==', ['get', 'active'], false];
```

- [ ] **Step 2: 路線ライン filter を「運行 + 非表示除外」に変更**

既存の `routeLineFilter`(98-101 行付近)を、active==true と非表示除外の複合に置換:

```ts
	// 表示する路線ライン = 当日運行(active) かつ 非表示でない
	const activeRouteFilter = $derived<ExpressionSpecification>([
		'all',
		['==', ['get', 'active'], true],
		['!', ['in', ['get', 'key'], ['literal', Object.keys(hidden).filter((k) => hidden[k])]]],
	]);
```

`EMPTY_STOPS` 定数(104行付近)は不要になるため削除する。

- [ ] **Step 3: 停留所描画 FC を派生で作る**

`buses` の `$derived` の後(137 行付近)に、停留所分類の派生を追加:

```ts
	// 描画用の停留所 Feature(active と色をカタログ・非表示状態から決める)
	interface RenderStopFeature {
		type: 'Feature';
		geometry: StopFeature['geometry'];
		properties: { stopId: string; name: string; active: boolean; color: string };
	}
	const stopFC = $derived.by((): GeneratedFeatureCollection<RenderStopFeature> => {
		if (!data) return { type: 'FeatureCollection', features: [] };
		const features: RenderStopFeature[] = [];
		for (const s of data.stops.features) {
			const { stopId, name, routeKeys } = s.properties;
			if (routeKeys === undefined) {
				// 旧データ: 路線関連付けが無い → 中立色で運行中表示(淡色化しない)
				features.push({
					type: 'Feature',
					geometry: s.geometry,
					properties: { stopId, name, active: true, color: STOP_NEUTRAL_COLOR },
				});
				continue;
			}
			let hasActiveRoute = false;
			let visibleColor: string | null = null;
			for (const k of routeKeys) {
				const info = routeByKey.get(k);
				if (!info?.active) continue;
				hasActiveRoute = true;
				if (!hidden[k] && visibleColor === null) visibleColor = info.color;
			}
			if (!hasActiveRoute) {
				// 当日運行路線が1本も通らない → 運休停留所(グレー点)
				features.push({
					type: 'Feature',
					geometry: s.geometry,
					properties: { stopId, name, active: false, color: STOP_INACTIVE_COLOR },
				});
			} else if (visibleColor !== null) {
				// 運行中かつ表示中の路線が通る → 白抜き + その路線色のリング
				features.push({
					type: 'Feature',
					geometry: s.geometry,
					properties: { stopId, name, active: true, color: visibleColor },
				});
			}
			// hasActiveRoute かつ visibleColor===null(運行路線が全て非表示)→ 描画しない
		}
		return { type: 'FeatureCollection', features };
	});
```

（`GeneratedFeatureCollection` は既存の gtfs-core import にあるものを使う。無ければ import に追加する。）

- [ ] **Step 4: テンプレートのレイヤを再構成**

`+page.svelte` テンプレートの路線 `<GeoJSONSource data={routeLines}>` ブロック(236-264 行付近)を次に置換:

```svelte
		<GeoJSONSource data={routeLines}>
			<!-- 運休路線(最下層。細い破線グレーで運行中ラインの視認を妨げない) -->
			<LineLayer
				filter={INACTIVE_ROUTE_FILTER}
				layout={{ 'line-cap': 'butt', 'line-join': 'round' }}
				paint={{
					'line-color': '#9aa8ae',
					'line-width': 1.5,
					'line-opacity': 0.5,
					'line-dasharray': [2, 2.5],
				}}
			/>
			<!-- 運行中の路線ライン(地図が透けるよう細め・やや透明) -->
			<LineLayer
				filter={activeRouteFilter}
				layout={{ 'line-cap': 'round', 'line-join': 'round' }}
				paint={{ 'line-color': ROUTE_COLOR_EXPR, 'line-width': 2, 'line-opacity': 0.55 }}
			/>
			<!-- クリック判定用の透明な太いライン(運行路線のみ) -->
			<LineLayer
				id="routes-hit"
				filter={activeRouteFilter}
				layout={{ 'line-cap': 'round', 'line-join': 'round' }}
				paint={{ 'line-color': '#000000', 'line-opacity': 0, 'line-width': 14 }}
				onclick={(ev) => {
					// 下にバスがあればバスのポップアップを優先し、路線ポップアップは出さない
					const onBus = ev.target.queryRenderedFeatures(ev.point, { layers: ['buses'] });
					if (onBus.length > 0) return;
					const f = ev.features?.[0];
					if (!f || !f.properties) return;
					selected = {
						kind: 'route',
						key: String(f.properties.key),
						lnglat: [ev.lngLat.lng, ev.lngLat.lat],
					};
				}}
				onmouseenter={() => (cursor = 'pointer')}
				onmouseleave={() => (cursor = '')}
			/>
		</GeoJSONSource>
```

続く停留所 `<GeoJSONSource>` ブロック(266-276 行付近)を次に置換:

```svelte
		<GeoJSONSource data={stopFC}>
			<!-- 運休停留所(小さいグレー点。運行中の白抜き+リングと別シンボルで目立たせない) -->
			<CircleLayer
				minzoom={STOP_MIN_ZOOM}
				filter={STOP_INACTIVE_FILTER}
				paint={{
					'circle-radius': STOP_INACTIVE_RADIUS,
					'circle-color': STOP_INACTIVE_COLOR,
					'circle-opacity': 0.55,
					'circle-stroke-width': 0,
				}}
			/>
			<!-- 運行中停留所(白抜き + 路線色リング。ラインの視認を妨げない) -->
			<CircleLayer
				minzoom={STOP_MIN_ZOOM}
				filter={STOP_ACTIVE_FILTER}
				paint={{
					'circle-radius': STOP_ACTIVE_RADIUS,
					'circle-color': '#ffffff',
					'circle-stroke-width': STOP_ACTIVE_STROKE,
					'circle-stroke-color': ROUTE_COLOR_EXPR,
					'circle-opacity': 0.95,
				}}
			/>
		</GeoJSONSource>
```

- [ ] **Step 5: 型チェックが通ることを確認**

Run: `pnpm --filter app check`
Expected: 型エラー無し(Task 5 の参照エラーも解消)。

- [ ] **Step 6: コミット**

```bash
git add app/src/routes/+page.svelte
git commit -m "feat(app): 運休路線ラインと停留所の運行/運休描き分けを追加"
```

---

## Task 7: app — データ出典の開閉トグル

**Files:**
- Modify: `app/src/lib/Controls.svelte`

- [ ] **Step 1: 開閉状態を追加**

`Controls.svelte` の script 内、`credits` の `$derived` の後に状態を追加:

```ts
	// データ出典は既定で畳む(地図領域を優先。ⓘボタンで開閉)
	let attribOpen = $state(false);
```

- [ ] **Step 2: 出典表示を開閉式に置換**

テンプレート末尾の出典 `<div class="text-xs ...">…</div>`(101-108 行付近)を次に置換:

```svelte
	<div class="flex flex-col">
		<button
			onclick={() => (attribOpen = !attribOpen)}
			title="データの出典"
			class="flex items-center gap-1.5 self-start py-0.5 text-[11px] leading-4 font-semibold text-mi-slate-500 transition-colors hover:text-mi-teal-600"
		>
			<svg
				width="13"
				height="13"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line
					x1="12"
					y1="8"
					x2="12.01"
					y2="8"
				></line></svg
			>
			<span>データの出典</span>
			<svg
				width="13"
				height="13"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="transition-transform {attribOpen ? 'rotate-180' : ''}"
				><polyline points="6 9 12 15 18 9"></polyline></svg
			>
		</button>
		{#if attribOpen}
			<div class="pt-1 text-xs leading-relaxed text-mi-slate-500">
				データ: {#each feedInfos as f (f.id)}{f.name}({f.license ?? 'ライセンス不明'}{f.status ===
					'error'
						? '・更新失敗'
						: ''})
				{/each}
				— {credits} / 地図: © OpenStreetMap contributors | MapLibre
			</div>
		{/if}
	</div>
```

- [ ] **Step 3: 型チェックが通ることを確認**

Run: `pnpm --filter app check`
Expected: 型エラー無し。

- [ ] **Step 4: コミット**

```bash
git add app/src/lib/Controls.svelte
git commit -m "feat(app): データ出典を開閉式に変更"
```

---

## Task 8: 統合検証(ローカルデータ再生成 + 目視 + CI)

**Files:** なし(検証のみ)

- [ ] **Step 1: gtfs-core / pipeline のテストを一括実行**

Run: `pnpm --filter gtfs-core test && pnpm --filter pipeline test`
Expected: 全テスト PASS。

- [ ] **Step 2: ローカル R2 データを再生成**

別ターミナルで `just pipeline` を起動した状態で:

Run: `just seed`
Expected: エラーなく完了(ローカル R2 に routeIds 付き stops.geojson が投入される)。

- [ ] **Step 3: 開発サーバで目視確認**

Run: `just dev`
確認項目(Playwright MCP または手動、ズーム 12 以上):
- 運行中の停留所が「白抜き + 路線色リング」で表示され、路線ラインの視認を妨げないこと。
- ズームを上げると運休路線が細い破線グレーで、運休のみが通る停留所が小さいグレー点で控えめに表示されること。
- パネルで路線を非表示にすると、その路線ライン・その路線のみが通る停留所も消えること。
- 下部バーの「ⓘ データの出典」クリックで出典テキストが開閉し、シェブロンが回転すること。
- 日付を平日/休日で切り替えると運行/運休の路線・停留所が入れ替わること。

- [ ] **Step 4: CI 相当を一括実行**

Run: `just ci`
Expected: format:check / lint / check / test / build がすべて成功。失敗した場合は該当タスクへ戻って修正する。

- [ ] **Step 5: 最終コミット(必要なら format 差分など)**

```bash
git status
# 追加差分があれば:
git add -A && git commit -m "chore: フォーマット/検証差分の反映"
```

---

## Self-Review メモ

- **仕様カバレッジ**: ①出典開閉=Task 7 / ②停留所↔路線関連付け=Task 1-3 / ③停留所の運行/運休=Task 5-6 / ④運休路線=Task 5-6 / 生成一本化=Task 3-4。全項目にタスク対応あり。
- **型整合**: `stopRouteIds`(Task 1)→`stopsToGeojson(files, stopRoutes)`(Task 2)→`stopRouteIds(files)` を run.ts で使用(Task 3)。`PointFeature.routeIds?`→data.ts で `routeKeys`(Task 5)→`RenderStopFeature.active/color`(Task 6)。`RouteLineFeature.active`(Task 5)→`activeRouteFilter`/`INACTIVE_ROUTE_FILTER`(Task 6)。名称一致を確認済み。
- **後方互換**: routeIds 無しデータは data.ts で `routeKeys: undefined` → +page.svelte で中立色・運行中表示にフォールバック(Task 5-6)。
- **プレースホルダ**: 無し(各ステップに実コードを記載)。
