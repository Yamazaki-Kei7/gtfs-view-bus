# 背景地図セレクタ + 透過表現調整 設計

作成日: 2026-07-07 / ブランチ: `feature/basemap-selector`(作成予定)

## 背景

claude.ai/design のプロトタイプ `GTFS View Bus - Current Page.dc.html`(前回 `2026-07-06-current-page-refinements` からさらに更新)を現行アプリに反映する。今回のプロトタイプ差分は次の2点:

1. 背景地図(OSM/Positron/Voyager)を右上のセレクタで切り替えられる。
2. 路線ライン・バス停・バスの不透明度が現行アプリより低め(重なりが透けて見える)に調整されている。

## 決定事項(ユーザー確認済み)

- **背景地図の初期表示**: `Positron`(淡色・Carto)。プロトタイプのコードコメント「淡色系で色数が少なく、路線色・バス・停留所が最も見やすい Positron を既定に」を採用する(プロトタイプの Tweaks 上のデフォルト値表示は `OSM` だが、これは設計意図とは無関係な保存時の状態と判断)。

## スコープ

### ① 背景地図セレクタ(新規)

対象: `app/src/lib/basemaps.ts`(新規)、`app/src/lib/BasemapControl.svelte`(新規)、`app/src/routes/+page.svelte`、`app/src/lib/Controls.svelte`

- **`basemaps.ts`**: 背景地図3種の設定を持つ純粋なデータモジュール。
  ```ts
  export type BasemapKey = 'osm' | 'positron' | 'voyager';
  export interface BasemapDef {
    label: string;      // セレクタのtitle属性用
    short: string;       // ボタンの表示ラベル(OSM/Positron/Voyager)
    tiles: string[];
    maxzoom: number;
    attribution: string;
  }
  ```
  - `osm`: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`(単一URL)、`maxzoom: 19`、attribution `© OpenStreetMap contributors`。
  - `positron` / `voyager`: Carto ラスタタイル。`a`/`b`/`c`/`d` サブドメイン4つの実URLを配列で渡す(MapLibreのraster sourceは`{s}`プレースホルダ非対応のため、プロトタイプと同様に事前展開する)。`positron` は `light_all` パス、`voyager` は `rastertiles/voyager` パス。両方 `maxzoom: 20`、attribution `© OpenStreetMap contributors © CARTO`。
  - `BASEMAP_KEYS: BasemapKey[] = ['osm', 'positron', 'voyager']`(セレクタの描画順)。

- **`BasemapControl.svelte`**: `svelte-maplibre-gl` の `CustomControl`(`group={false}`、独自スタイル)を使い、縦積みボタン3つを描画する。props: `active: BasemapKey`, `onSelect: (key: BasemapKey) => void`。選択中ボタンは `bg-mi-teal-600 text-white`、非選択は `text-mi-slate-600 hover:bg-mi-slate-100`。外枠は `rounded-[10px] border border-mi-slate-200 bg-white/95 shadow-[...] backdrop-blur`(既存パネルと同トーン)。

- **`+page.svelte`**:
  - `BASE_STYLE` を `baseStyle(key: BasemapKey): StyleSpecification` 関数に一般化し、初期値は `baseStyle('positron')`。ソースIDは`base`固定(現状`osm`固定だったIDを`base`に変更)。
  - `let basemap = $state<BasemapKey>('positron')` を追加。
  - `setBasemap(key)`: `basemap`を更新し、`map`が存在すれば `removeLayer('base')` → `removeSource('base')` → 新設定で `addSource('base', ...)` → `addLayer({id:'base',...}, beforeId)`。`beforeId` は削除後の `map.getStyle().layers[0]?.id`(=現在の最下層)を使う。これにより既存レイヤに明示IDを振らずに済み、常に背景を最下層に保てる。
  - `style` prop は初期値のまま固定し、切替時に再代入しない(`style`経由の差し替えは既存コードのコメントにある通り不安定なため、プロトタイプ同様に `map` への直接操作で行う)。
  - `<BasemapControl active={basemap} onSelect={setBasemap} />` を `<MapLibre>` 内、`<NavigationControl>` より前に配置(右上での重なり順をプロトタイプに合わせる: セレクタ→ズーム→現在地)。
  - `<Controls>` に `mapAttribution={BASEMAPS[basemap].attribution}` を渡す。

- **`Controls.svelte`**: props に `mapAttribution: string` を追加。出典テキストの `地図: © OpenStreetMap contributors | MapLibre` を `地図: {mapAttribution} | MapLibre` に変更。

### ② 透過表現の調整(数値変更のみ、`+page.svelte`)

プロトタイプの値に合わせる。ロジック・filter・レイヤ構成は変更しない。

| レイヤ | プロパティ | 現状 | 変更後 |
|---|---|---|---|
| 運行中路線ライン | `line-width` | 2 | 3 |
| 運行中路線ライン | `line-opacity` | 0.55 | 0.6 |
| 運行中停留所(`stops-active`) | `circle-opacity` | 0.95 | 0.8 |
| 運行中停留所(`stops-active`) | `circle-stroke-opacity` | (未指定=1) | 0.85(新規追加) |
| バス本体(`busCorePaint`) | `circle-opacity` | (未指定=1) | 0.78(新規追加) |
| バス本体(`busCorePaint`) | `circle-stroke-opacity` | (未指定=1) | 0.85(新規追加) |

変更しない(現状がプロトタイプと一致済み): 運休路線ライン、運休停留所(`stops-inactive`)、バス波紋(`buses-pulse`)。

## 変更しないもの

- 3階層グループ化パネル(`RouteLayers.svelte`)、時刻表パネル(`StopTimetable.svelte`)、時間スライダー・再生ロジック(`sim.svelte.ts`)。
- バス/路線ポップアップ、脈動アニメーションのロジック本体(数値のみ上記表の通り変更)。
- レイヤの重なり順・filter・データ取得ロジック(`data.ts`)。

## テスト・検証

- app にはテストスイート未整備のため、型チェック(`pnpm --filter app check`)+ `just dev` での目視確認。
- 確認項目: セレクタ3種の切替でタイルが切り替わり背景に留まること(データレイヤの上に乗らない)、選択中ボタンのハイライト、データ出典の地図クレジットが選択中の背景地図に応じて切り替わること、路線ライン・停留所・バスの重なり部分が透けて見えること、既存機能(路線パネル・時刻表・再生)が非破壊であること。
- `just ci`(format:check / lint / check / build)を通す。

## リスク・留意点

- Carto の匿名ラスタタイル(`basemaps.cartocdn.com`)はレート制限がある無料エンドポイント。個人・小規模利用の想定で許容(プロトタイプも同エンドポイントを使用)。
- `map.getStyle().layers[0]?.id` に依拠した最下層挿入は、初回ロード時に他レイヤがまだ追加されていない(=`base`のみ)状態で `setBasemap` が呼ばれても安全(`layers[0]`が`base`自身になるが、削除後なので次点のレイヤか無しになる)。
