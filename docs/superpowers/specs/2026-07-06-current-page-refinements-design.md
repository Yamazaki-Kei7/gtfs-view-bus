# Current Page リファインメント設計

作成日: 2026-07-06 / ブランチ: `feature/current-page-refinements`

## 背景

claude.ai/design のプロトタイプ `GTFS View Bus - Current Page.dc.html` を実アプリに反映する。プロトタイプは現行 SvelteKit アプリ(`main`)とほぼ同じ構成の React 版であり、現行との差分が今回の実装対象となる。パネルの3階層グループ化など現行アプリで既に発展済みの機能は維持し(プロトタイプは2階層だが退行させない)、以下4点を「重ねる」形で実装する。

## 決定事項(ユーザー確認済み)

- **バスの色分け**: 路線ごと(現状踏襲)。`route_color` 優先、無ければ9色パレットを安定割当。実データでは色が循環・重複するが許容。
- **運休バス停の判定**: パイプライン拡張で停留所↔路線を関連付け、正確に区別する。
- **停留所 GeoJSON**: routeIds を全フィードで確実に付与するため、stops.txt からの生成に一本化する(ソース提供 `file_stop_url` は stops.txt 由来の派生物のため実質ロスなし)。

## スコープ

### ① データ出典の開閉トグル(app のみ)

対象: `app/src/lib/Controls.svelte`

現状はパネル下部に出典テキストを常時表示。プロトタイプに合わせ開閉式にする。

- 「ⓘ データの出典 ⌄」ボタン(slate-500、hover で teal-600、11px、info アイコン + 回転シェブロン)。
- `attribOpen` 状態(既定 `false`)。開いたときのみ出典テキストを表示。
- 出典内容は現行の動的生成ロジック(`feedInfos` からフィード名・ライセンス・`SOURCE_CREDITS` クレジット・地図クレジットを組み立て)をそのまま流用する。プロトタイプはハードコードだが、動的版を維持する。

### ② 停留所↔路線の関連付け(pipeline 拡張)

対象: `packages/gtfs-core/src/geojson.ts`、`pipeline/src/run.ts`

- **gtfs-core に `stopRouteIds(files): Record<stopId, routeId[]>` を新設**。`trips.txt`(trip_id→route_id)と `stop_times.txt`(stop_id 列)を突き合わせ、各停留所を通る route_id 集合を算出する純粋関数。
- **`stopsToGeojson(files, stopRoutes?)` を拡張**し、各 `PointFeature` の properties に `routeIds: string[]`(`stopRoutes?.[stop_id] ?? []`)を付与。`PointFeature` 型も更新。
- **`run.ts` の停留所書き込みを生成一本化**: `d.stopsGeojsonUrl` のフェッチ/使用を廃止し、常に `stopsToGeojson(files, stopRouteIds(files))` を書き込む。これによりソース geojson フェッチ分岐(および失敗時 throw)が停留所レイヤから消える。`routesGeojsonUrl`(形状源)は従来どおり維持。
- **後方互換**: 再生成前の旧 R2 データ(routeIds 無し)は、app 側で「中立色で表示・淡色化しない」フォールバックとして扱う(下記③)。

### ③ 停留所の運行/運休表示(app)

対象: `app/src/lib/data.ts`、`app/src/routes/+page.svelte`

- **`data.ts`**: `loadAll` で各 stop feature に `feedId` と `routeKeys`(=`${feedId}|${routeId}` の配列)を付与した型付き `StopFeature` を生成する。`routeIds` が properties に無い旧データは `routeKeys: undefined`(フォールバック印)とする。
- **`+page.svelte`**: `catalog`(routeByKey で active/color 参照)と `hidden` から停留所 FC を派生。各 feature の properties に `active: boolean` と `color` を持たせ、1つの source + 2レイヤ(filter で分離)で描画する。
  - **運行中停留所**(`active=true`): 当日運行(`active`)かつ非表示でない路線が1本以上通る。`color` = その最初の路線の色。
  - **運休停留所**(`active=false`): 当日運行路線が1本も通らない(=運休路線のみが通る)。
  - 運行路線がすべて非表示の停留所は FC から除外(プロトタイプ準拠)。
  - `routeKeys === undefined`(旧データ)の停留所は `active=true`・中立色フォールバックで表示(淡色化しない)。
- **スタイル(プロトタイプ準拠、minzoom 12)**:
  - 運行中: `circle-color:#ffffff`、`circle-stroke-color:['get','color']`、`circle-stroke-width` = zoom12→1.5 / zoom16→2.5、`circle-radius` = zoom12→3.5 / zoom16→7、`circle-opacity:0.95`。
  - 運休: `circle-color:#aeb9bf`、`circle-stroke-width:0`、`circle-radius` = zoom12→2.5 / zoom16→4.5、`circle-opacity:0.55`。

### ④ 運休路線ライン(app)

対象: `app/src/lib/data.ts`、`app/src/routes/+page.svelte`

- **`buildRouteLines`**: active フィルタを撤廃し全路線(shape あり)を出力。properties に `active: boolean` を追加(color・key は現状どおり)。
- **`+page.svelte`**: 1つの `routeLines` source に対しレイヤを再構成。
  - 運休路線ライン(`active=false`): 破線グレー `#9aa8ae` / `line-width:1.5` / `line-opacity:0.5` / `line-dasharray:[2,2.5]` / `line-cap:butt`。
  - 運行路線ライン(`active=true` かつ非表示でない): 現行の色付きスタイル。
  - クリック判定 hit ライン: 運行路線のみ(filter は運行表示と同一)。

### レイヤ重なり(下 → 上)

1. 運休路線ライン
2. 運行路線ライン + クリック判定 hit
3. 運休停留所 → 運行停留所
4. バス波紋 → バス本体

svelte-maplibre-gl は宣言順で重なりが決まるため、`+page.svelte` 内の宣言順をこの順に並べる。

## 変更しないもの

- 3階層グループ化パネル(`RouteLayers.svelte`)。
- バスのポップアップ追随・路線ポップアップ・脈動アニメーション。
- バスの色分けロジック(路線色、現状踏襲)。
- 停留所のクリック/ポップアップ(現行同様、無し)。

## テスト・検証

- gtfs-core: `stopRouteIds` の単体テスト追加、`geojson.test.ts` を `routeIds` 付与に合わせて更新。
- pipeline: `run.test.ts` を停留所生成一本化に合わせて更新。
- ローカル: `just pipeline` → `just seed`(データ再生成) → `just dev`。Playwright MCP で運行中/運休の停留所・路線、出典開閉を目視確認。
- `just ci`(format:check / lint / check / test / build)を通す。

## リスク・留意点

- 本番 R2 は次回 Cron まで旧 stops.geojson(routeIds 無し)。app のフォールバックで停留所が全消えしないことを担保する。反映は手動 Cron 実行で早められる(README 記載)。
- 生成一本化でソース提供 stops.geojson の座標を使わなくなる。GTFS の stops.txt が正準であり実害はない想定だが、座標差異があれば留意。
