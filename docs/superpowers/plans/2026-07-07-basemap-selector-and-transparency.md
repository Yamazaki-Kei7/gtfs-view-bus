# 背景地図セレクタ + 透過表現調整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** claude.ai/design のプロトタイプに合わせて、背景地図(OSM/Positron/Voyager)を右上のセレクタで切り替えられるようにし、路線ライン・バス停・バスの不透明度をプロトタイプの値に調整する。

**Architecture:** 背景地図の設定を`basemaps.ts`に切り出し、`+page.svelte`は初期`style`をそのキーから生成する。切替は`style`propの再代入ではなく、bindした`map`インスタンスに対して`base`ソース/レイヤを直接`removeLayer`→`removeSource`→`addSource`→`addLayer`する(既存コードのコメント通り、`style`差し替えは不安定なため避ける)。UIは`svelte-maplibre-gl`の`CustomControl`を使い、既存パネルと同じTailwindトーンで実装する。透過表現は既存レイヤの`paint`数値のみを変更する。

**Tech Stack:** TypeScript / Svelte 5 (runes) / svelte-maplibre-gl(MapLibre GL) / Tailwind CSS v4。

**前提:** 作業ブランチ `feature/basemap-selector` を `main` から作成してから着手する。`app/`にはテストスイート未整備のため、各タスクの検証は型チェック(`pnpm --filter app check`)+ 目視で行う(リポジトリの現状に準拠。`docs/superpowers/plans/2026-07-06-current-page-refinements.md`と同方針)。

---

## ファイル構成

**変更・新規作成するファイルと責務:**

- `app/src/lib/basemaps.ts`(新規) — 背景地図3種(OSM/Positron/Voyager)のタイルURL・attribution・ラベルを持つ設定データ。
- `app/src/lib/BasemapControl.svelte`(新規) — 右上に縦積みボタンを描画する`CustomControl`ラッパー。選択状態の表示とクリック通知のみを担う。
- `app/src/lib/Controls.svelte` — 出典テキストの地図クレジット部分を`mapAttribution`propで動的化。
- `app/src/routes/+page.svelte` — 背景地図の状態(`basemap`)・切替関数(`setBasemap`)・`BasemapControl`のマウント・透過表現の数値調整。

---

## Task 1: `app/src/lib/basemaps.ts`(新規)— 背景地図設定データ

**Files:**
- Create: `app/src/lib/basemaps.ts`

- [ ] **Step 1: ファイルを作成**

`app/src/lib/basemaps.ts`を新規作成:

```ts
export type BasemapKey = 'osm' | 'positron' | 'voyager';

export interface BasemapDef {
	/** セレクタボタンのtitle属性用フルラベル */
	label: string;
	/** セレクタボタンに表示する短縮ラベル */
	short: string;
	tiles: string[];
	maxzoom: number;
	attribution: string;
}

const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const CARTO_ATTRIBUTION = '© OpenStreetMap contributors © CARTO';

// MapLibreのraster sourceは{s}サブドメイン置換に対応しないため、a/b/c/dを事前展開したURL配列を渡す
function cartoRasterTiles(path: string): string[] {
	return ['a', 'b', 'c', 'd'].map(
		(s) => `https://${s}.basemaps.cartocdn.com/${path}/{z}/{x}/{y}.png`,
	);
}

export const BASEMAPS: Record<BasemapKey, BasemapDef> = {
	osm: {
		label: 'OpenStreetMap(標準)',
		short: 'OSM',
		tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
		maxzoom: 19,
		attribution: OSM_ATTRIBUTION,
	},
	positron: {
		label: 'Carto Positron(淡色)',
		short: 'Positron',
		tiles: cartoRasterTiles('light_all'),
		maxzoom: 20,
		attribution: CARTO_ATTRIBUTION,
	},
	voyager: {
		label: 'Carto Voyager(道路強調)',
		short: 'Voyager',
		tiles: cartoRasterTiles('rastertiles/voyager'),
		maxzoom: 20,
		attribution: CARTO_ATTRIBUTION,
	},
};

export const BASEMAP_KEYS: BasemapKey[] = ['osm', 'positron', 'voyager'];
```

- [ ] **Step 2: 型チェックを実行して確認**

Run: `pnpm --filter app check`
Expected: PASS(新規ファイルはどこからも参照されていないが、型エラーは出ない)

- [ ] **Step 3: コミット**

```bash
git add app/src/lib/basemaps.ts
git commit -m "feat(app): 背景地図3種の設定データを追加"
```

---

## Task 2: `app/src/lib/BasemapControl.svelte`(新規)— セレクタUI

**Files:**
- Create: `app/src/lib/BasemapControl.svelte`

- [ ] **Step 1: ファイルを作成**

`app/src/lib/BasemapControl.svelte`を新規作成:

```svelte
<script lang="ts">
	import { CustomControl } from 'svelte-maplibre-gl';
	import { BASEMAP_KEYS, BASEMAPS, type BasemapKey } from '$lib/basemaps';

	let { active, onSelect }: { active: BasemapKey; onSelect: (key: BasemapKey) => void } =
		$props();
</script>

<CustomControl position="top-right" group={false}>
	<div
		class="flex flex-col overflow-hidden rounded-[10px] border border-mi-slate-200 bg-white/95 shadow-[0_4px_12px_rgba(7,48,61,0.14)] backdrop-blur"
	>
		{#each BASEMAP_KEYS as key, i (key)}
			<button
				type="button"
				title={BASEMAPS[key].label}
				onclick={() => onSelect(key)}
				class="px-2.5 py-1.5 text-[11px] font-bold tracking-wide whitespace-nowrap transition-colors {i >
				0
					? 'border-t border-mi-slate-200'
					: ''} {active === key
					? 'bg-mi-teal-600 text-white'
					: 'text-mi-slate-600 hover:bg-mi-slate-100'}"
			>
				{BASEMAPS[key].short}
			</button>
		{/each}
	</div>
</CustomControl>
```

- [ ] **Step 2: 型チェックを実行して確認**

Run: `pnpm --filter app check`
Expected: PASS(まだどこからもマウントされていないが型エラーは出ない)

- [ ] **Step 3: コミット**

```bash
git add app/src/lib/BasemapControl.svelte
git commit -m "feat(app): 背景地図セレクタのUIコンポーネントを追加"
```

---

## Task 3: 状態管理とUI配線(`Controls.svelte` + `+page.svelte`)

**Files:**
- Modify: `app/src/lib/Controls.svelte:5`(props)、`:147`(出典テキスト)
- Modify: `app/src/routes/+page.svelte`(import・BASE_STYLE・状態・setBasemap・テンプレート)

このタスクは2ファイルをまとめて1コミットにする(`Controls.svelte`だけを先にコミットすると`+page.svelte`側の呼び出しで型エラーになるため)。

- [ ] **Step 1: `Controls.svelte`のpropsに`mapAttribution`を追加**

`app/src/lib/Controls.svelte:5`を次に置換:

```ts
	let {
		busCount,
		feedInfos,
		mapAttribution,
	}: { busCount: number; feedInfos: FeedIndexEntry[]; mapAttribution: string } = $props();
```

- [ ] **Step 2: 出典テキストを動的化**

`app/src/lib/Controls.svelte:147`(`— {credits} / 地図: © OpenStreetMap contributors | MapLibre`)を次に置換:

```svelte
				— {credits} / 地図: {mapAttribution} | MapLibre
```

- [ ] **Step 3: `+page.svelte`のimportに背景地図関連を追加**

`app/src/routes/+page.svelte:28-30`(`Controls`/`RouteLayers`/`StopTimetable`のimport)の直後に追加:

```ts
	import BasemapControl from '$lib/BasemapControl.svelte';
```

`app/src/routes/+page.svelte:31-38`(`$lib/data`からのimportブロック)の直後に追加:

```ts
	import { BASEMAPS, type BasemapKey } from '$lib/basemaps';
```

- [ ] **Step 4: `BASE_STYLE`を`baseStyle()`関数に一般化**

`app/src/routes/+page.svelte:41-55`の次のブロックを:

```ts
	// OSMベースマップは初期スタイルに含める(RasterTileSource コンポーネント経由だと
	// タイルが読み込まれない事象があるため、スタイルオブジェクトで確実に描画する)
	const BASE_STYLE: StyleSpecification = {
		version: 8,
		sources: {
			osm: {
				type: 'raster',
				tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
				tileSize: 256,
				maxzoom: 19,
				attribution: '© OpenStreetMap contributors',
			},
		},
		layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
	};
```

次に置換:

```ts
	// 背景ラスタは初期スタイルに含める(RasterTileSource コンポーネント経由だと
	// タイルが読み込まれない事象があるため、スタイルオブジェクトで確実に描画する)。
	// 切替時はこのstyleを再代入せず、map への直接操作で base ソース/レイヤだけを差し替える(setBasemap参照)。
	function baseStyle(key: BasemapKey): StyleSpecification {
		const bm = BASEMAPS[key];
		return {
			version: 8,
			sources: {
				base: {
					type: 'raster',
					tiles: bm.tiles,
					tileSize: 256,
					maxzoom: bm.maxzoom,
					attribution: bm.attribution,
				},
			},
			layers: [{ id: 'base', type: 'raster', source: 'base' }],
		};
	}
	const INITIAL_BASEMAP: BasemapKey = 'positron';
	const BASE_STYLE = baseStyle(INITIAL_BASEMAP);
```

- [ ] **Step 5: `basemap`状態と`setBasemap`関数を追加**

`app/src/routes/+page.svelte:98`(`let map = $state<MaplibreMap | undefined>();`)の直後に追加:

```ts
	let basemap = $state<BasemapKey>(INITIAL_BASEMAP);

	// 背景ラスタを差し替える。style prop の再代入はレイヤ構成をリセットしうるため使わず、
	// map への直接操作で base ソース/レイヤだけを入れ替える(プロトタイプと同じ手法)。
	function setBasemap(key: BasemapKey) {
		basemap = key;
		if (!map) return;
		const bm = BASEMAPS[key];
		if (map.getLayer('base')) map.removeLayer('base');
		if (map.getSource('base')) map.removeSource('base');
		// 削除後のlayers[0]が現在の最下層(=baseを差し込むべき位置)になる
		const beforeId = map.getStyle().layers[0]?.id;
		map.addSource('base', {
			type: 'raster',
			tiles: bm.tiles,
			tileSize: 256,
			maxzoom: bm.maxzoom,
			attribution: bm.attribution,
		});
		map.addLayer({ id: 'base', type: 'raster', source: 'base' }, beforeId);
	}
```

- [ ] **Step 6: テンプレートに`BasemapControl`をマウントし、`Controls`に`mapAttribution`を渡す**

`app/src/routes/+page.svelte:385-386`(`<MapLibre>`開始タグ直後、`<NavigationControl>`の直前)を次に置換:

```svelte
	>
		<BasemapControl active={basemap} onSelect={setBasemap} />
		<NavigationControl showCompass={false} position="top-right" />
```

`app/src/routes/+page.svelte:566`(`<Controls busCount={buses.features.length} feedInfos={data?.index.feeds ?? []} />`)を次に置換:

```svelte
	<Controls
		busCount={buses.features.length}
		feedInfos={data?.index.feeds ?? []}
		mapAttribution={BASEMAPS[basemap].attribution}
	/>
```

- [ ] **Step 7: 型チェックを実行して確認**

Run: `pnpm --filter app check`
Expected: PASS(型エラー無し)

- [ ] **Step 8: コミット**

```bash
git add app/src/lib/Controls.svelte app/src/routes/+page.svelte
git commit -m "feat(app): 背景地図セレクタを配線し出典表示を動的化"
```

---

## Task 4: 透過表現の数値調整(`+page.svelte`)

**Files:**
- Modify: `app/src/routes/+page.svelte:309-320`(バスのpaint)、`:412`(路線ライン)、`:460-466`(停留所)

- [ ] **Step 1: 運行中路線ラインの線幅・不透明度を変更**

`app/src/routes/+page.svelte:412`を:

```svelte
				paint={{ 'line-color': ROUTE_COLOR_EXPR, 'line-width': 2, 'line-opacity': 0.55 }}
```

次に置換:

```svelte
				paint={{ 'line-color': ROUTE_COLOR_EXPR, 'line-width': 3, 'line-opacity': 0.6 }}
```

- [ ] **Step 2: 運行中停留所(`stops-active`)の不透明度を変更**

`app/src/routes/+page.svelte:460-466`を:

```svelte
				paint={{
					'circle-radius': STOP_ACTIVE_RADIUS,
					'circle-color': '#ffffff',
					'circle-stroke-width': STOP_ACTIVE_STROKE,
					'circle-stroke-color': ROUTE_COLOR_EXPR,
					'circle-opacity': 0.95,
				}}
```

次に置換:

```svelte
				paint={{
					'circle-radius': STOP_ACTIVE_RADIUS,
					'circle-color': '#ffffff',
					'circle-stroke-width': STOP_ACTIVE_STROKE,
					'circle-stroke-color': ROUTE_COLOR_EXPR,
					'circle-opacity': 0.8,
					'circle-stroke-opacity': 0.85,
				}}
```

- [ ] **Step 3: バス本体(`busCorePaint`)に不透明度を追加**

`app/src/routes/+page.svelte:315-320`を:

```ts
	const busCorePaint: CircleLayerSpecification['paint'] = $derived({
		'circle-radius': BUS_RADIUS + Math.sin(pulse * Math.PI * 2) * 1.2,
		'circle-color': ROUTE_COLOR_EXPR,
		'circle-stroke-width': 2,
		'circle-stroke-color': '#ffffff',
	});
```

次に置換:

```ts
	const busCorePaint: CircleLayerSpecification['paint'] = $derived({
		'circle-radius': BUS_RADIUS + Math.sin(pulse * Math.PI * 2) * 1.2,
		'circle-color': ROUTE_COLOR_EXPR,
		'circle-opacity': 0.78,
		'circle-stroke-width': 2,
		'circle-stroke-color': '#ffffff',
		'circle-stroke-opacity': 0.85,
	});
```

- [ ] **Step 4: 型チェックを実行して確認**

Run: `pnpm --filter app check`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/src/routes/+page.svelte
git commit -m "feat(app): 路線ライン・停留所・バスの透過表現をプロトタイプの値に調整"
```

---

## Task 5: 統合検証

**Files:** なし(検証のみ)

- [ ] **Step 1: 開発サーバで目視確認**

Run: `just dev`

確認項目:
- 起動直後の背景地図が Positron(淡色)であること。
- 右上のセレクタ(OSM/Positron/Voyager)をクリックすると背景が切り替わり、選択中ボタンが teal 背景+白文字になること。
- 切替後もズームコントロール・現在地ボタンが正しく右上に並び、背景ラスタがルート/バス停/バスより下に留まること。
- 下部パネルの「データの出典」を開くと、選択中の背景地図に応じて地図クレジットが切り替わること(OSM選択時「© OpenStreetMap contributors」、Positron/Voyager選択時「© OpenStreetMap contributors © CARTO」)。
- 路線ライン・運行中停留所・バスが重なったときに下のフィーチャが透けて見えること(以前より不透明度が下がっていること)。
- 既存機能(路線レイヤパネルの開閉・検索・表示切替、バス停クリックの時刻表パネル、再生/日付変更)が非破壊であること。

- [ ] **Step 2: CI相当を一括実行**

Run: `just ci`
Expected: format:check / lint / check / build がすべて成功。失敗した場合は該当タスクへ戻って修正する。

- [ ] **Step 3: 最終コミット(必要なら format 差分など)**

```bash
git status
# 差分があれば:
git add -A && git commit -m "chore: フォーマット差分の反映"
```

---

## Self-Review メモ

- **スペックカバレッジ**: ①背景地図セレクタ = Task 1-3 / ②透過表現の調整 = Task 4。設計書の対応表(路線ライン・停留所・バス)は全てTask 4のStep 1-3に対応あり。
- **型整合**: `BasemapKey`/`BASEMAPS`/`BASEMAP_KEYS`(Task 1)→`BasemapControl`の`active`/`onSelect`props(Task 2)→`+page.svelte`の`basemap`状態・`setBasemap`・`baseStyle()`(Task 3)→`Controls.svelte`の`mapAttribution`(Task 3)。名称の不一致なし。
- **プレースホルダ**: 無し(各ステップに実コードを記載)。
- **タスク順**: `Controls.svelte`と`+page.svelte`の呼び出し側をTask 3で同時にコミットするため、タスク間で型チェックが割れる区間が生じない(前回計画のTask5/6は意図的に許容していたが、今回は1タスクにまとめて回避した)。
