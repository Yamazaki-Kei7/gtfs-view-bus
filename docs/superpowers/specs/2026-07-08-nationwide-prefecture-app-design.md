# 全国版アプリ(都道府県セレクタ)設計書

日付: 2026-07-08
ステータス: 設計承認待ち(Fable レビュー反映済み)
参照デザイン: `GTFS View Bus - Prefecture.dc.html`(claude.ai/design プロジェクト `d75d6b31…`)

## 背景と目的

全国パイプライン(`docs/superpowers/specs/2026-07-07-nationwide-pipeline-design.md`)により、`pipeline/` が全国のGTFSフィード(gtfs-data.jp 全件 + ODPT)を変換・R2保存できるようになった。しかしアプリ側は未対応で、`loadAll()` が `feeds.json` の全フィードについて `bundle.json` と `stops.geojson` を初回に一括ロードする。全国約646フィードでは初回ロードが数百MB規模になり破綻する。

本設計の目的は、アプリを全国データに対応させ、**都道府県セレクタを起点とした段階ロード**を導入すること。あわせて参照デザインの都道府県選択UI(コロプレス地図)と選択後のUIを反映する。

## 確定要件(ブレインストーミングでの決定)

1. 都道府県セレクタの主導線は **コロプレス地図(地図で選択)**。「変更」も同じ地図ピッカーを再表示する。
2. 対象範囲は **アプリ + パイプライン両方**。`feeds.json` に `prefId` を追加する。
3. 都道府県未選択(初回・`?pref` なし)では **必ずピッカーを表示**する。県を選ぶまでバス/路線は描画しない。
4. `feeds.json` に `prefId` を持つフィードが1件も無い場合は、**従来どおりの全量表示へフォールバック**する(アプリを prefId 投入前にデプロイしても既存表示が壊れないため)。
5. 本番反映のための全国パイプライン再実行(実データ投入)は本タスクの範囲外。コード実装とローカル検証までを対象とする。

## スコープ外

- 本番R2への全国データ投入(Workers Paid での Cron 手動実行)。
- 複数都道府県にまたがるフィードの複数県への重複所属(1フィード=1県に単純化する)。
- 都道府県より細かい市区町村・事業者単位の絞り込み画面。
- GTFS-RT、配信形式変更(ベクトルタイル等)。
- デザインの他2導線(地図＋一覧サイドドック / 検索モーダル)。主導線のコロプレス地図のみ実装する。

## データモデル: `feeds.json` に `prefId` を追加

各フィードに `prefId: number | null`(1〜47、JIS都道府県コード)を付与する。

### 取得源

- **gtfs-data.jp**: `/v2/files` レスポンスに `feed_pref_id`(数値、実APIで確認済み)が含まれる。権威的で追加取得コストなし。
- **ODPT**: `feed_pref_id` 相当が無いため、停留所の**代表座標(重心)**を point-in-polygon で判定する。

### 実装方針(スキーマ版を上げず、再処理を増やさない)

`FeedTarget` に `prefId?: number | null` を追加する。gtfs-data.jp ソースは `feed_pref_id` をここへ設定する。ODPT は未設定(undefined)。

consumer(`processFeedTarget`)での `prefId` 決定:

- **更新時(artifacts 生成時)**: `prefId = target.prefId ?? resolvePrefId(重心(生成した stops))`。`meta.json` に保存する。
- **unchanged 時**: `prefId = target.prefId ?? meta.prefId`。
- **error 時**: `target.prefId`(不明なら null)。

この方針が**スキーマ版の引き上げなしで成立する**根拠:

- gtfs-data.jp は毎回 `target.prefId`(権威値)を持つため、updated / unchanged いずれも再処理なしで prefId が定まる。
- ODPT は `versionId` が空文字で、`feedProcessor` の unchanged 判定が空 versionId を除外する(`feedProcessor.ts:107`)ため**常に再処理**される。したがって重心は毎回手元にあり、centroid 判定が常に走る。

`prefId` を `meta.json`・`FeedStatus`(`jobState.ts`)に追加し、`statusBase` から updated/unchanged/error の全戻り値に流す。finalize の `toPublicStatus` に `prefId` を含め、`feeds.json` の各エントリへ出力する。`OUTPUT_SCHEMA_VERSION` は据え置き(bundle/stops/timetable の生成物フォーマットは不変で、prefId は meta と feeds.json だけの追加のため、全 zip 再取得を伴う版上げは目的に対し過剰)。

`FeedIndexEntry`(アプリ型 `data.ts`)にも `prefId?: number | null` を追加する。

## gtfs-core: 都道府県モジュール(定数と幾何を分離)

Fable レビュー指摘1(定数を静的 import しつつポリゴンを動的分割する両立不能)を避けるため、**定数モジュールと幾何モジュールを分離**する。

### `packages/gtfs-core/src/prefectures.ts`(定数・軽量。バレルから export)

- `PREFECTURES: { id: number; ja: string; region: RegionName }[]` — 全47都道府県。デザインの `PREFS` からモック `feeds` 件数を除いて移植。
- `REGIONS: readonly RegionName[]` — `['北海道','東北','関東','中部','近畿','中国','四国','九州']`。
- 型 `RegionName` / `PrefectureInfo`。
- **ポリゴン GeoJSON を import しない**(このモジュールを静的に取り込んでも幾何は連れてこない)。

### `packages/gtfs-core/src/prefectureGeometry.ts`(幾何・重量。バレルからは export しない)

- `prefectures.geo.json`(簡略化ポリゴン、各 Feature の `properties.id` = 都道府県コード)を import。
- `PREFECTURES_GEOJSON`(`FeatureCollection`)を export。
- `resolvePrefId(lng: number, lat: number): number | null` — ray-casting の point-in-polygon。内包する県の id を返す。内包なしのときは一定距離しきい値内で最近傍ポリゴン重心の県へフォールバックし、それも無ければ null(海岸沿い重心の取りこぼし対策)。
- `centroidOf(coords: LngLat[]): LngLat | null` — 座標群の代表点(外れ値に強い成分別中央値)。consumer が stops から重心を得るのに使う。

このモジュールは `index.ts`(バレル)から `export *` しない。**パイプライン Worker のみが直接 import** する(`gtfs-core/prefectureGeometry` 相当のサブパス、または直接パス)。バレル(`gtfs-core`)経由で定数を import するアプリSSR/クライアントにはポリゴンが混入しないことをこの分離で保証する。

`index.ts` には `export * from './prefectures';` のみ追加する(`prefectureGeometry` は追加しない)。

### ポリゴン資産

- 出典は公開データ(dataofjapan/land 等)を mapshaper で簡略化し、リポジトリに同梱する。目標サイズは **gzip 後およそ 200KB 以下**(パイプライン Worker のバンドルに載るため。全国運用は Workers Paid=10MB 上限)。
- **アプリのコロプレス描画**は gtfs-core からポリゴンを import せず、`app/static/japan-prefectures.geojson`(同一の簡略化ソースから生成)を**ピッカー表示時に遅延 fetch** する。初期JSにポリゴンを載せない最も確実な方法。gtfs-core 同梱ファイルと同一 mapshaper コマンドで生成し、出所をコメントに明記する。

## アプリ: 全量ロード → 2段階ロード

`app/src/lib/data.ts` の `loadAll()` を分割する。

- `loadIndex(): Promise<FeedIndex>` — `feeds.json` のみ取得。`prefId` で都道府県別件数を集計し、セレクタ表示に使う。
- `loadPrefecture(prefId, index): Promise<{ feeds: CatalogFeed[]; stops: … }>` — `index.feeds` を `prefId` で絞り、その県のフィードの `bundle.json` / `stops.geojson` のみ並列取得。timetable は従来どおり停留所クリック時に遅延ロード。

`routeCatalog`(`routes.ts`)/ `buildRouteLines` / `busFeatureCollection`(`bus.ts`)は `feeds` 配列を走査するだけで全量前提の状態を持たないため、部分集合を渡すだけでロジック不変(色パレットの安定割当もロード集合内で閉じる)。

### 都道府県別件数の集計

`feeds.json` を `prefId` でグルーピングし、県ごとの登録フィード数を得る。`prefId === null` はどの県にも属さない(件数外・地図では選択不可)。件数 > 0 の県が「データ登録あり」。

## アプリ: 都道府県セレクタと状態遷移

### 状態と URL

- `selectedPref` の **single source of truth は URL クエリ `?pref=<id>`**。`page.url.searchParams`(SvelteKit)をリアクティブに購読し、選択は `goto('?pref=<id>')` で行う。二重管理を避け、ブラウザ戻る/進むにも自然に追随する。
- 妥当な id(件数 > 0)なら選択済みとしてロード、そうでなければ(または未指定なら)ピッカー表示。
- **フォールバック**: `feeds.json` に prefId を持つフィードが1件も無い場合はピッカーを出さず、従来の `loadAll` 相当で全量表示する(要件4)。

### 未選択時(ピッカー)

- 地図は全国表示(`fitBounds(JAPAN_BBOX)`)。既存の `BasemapControl` は維持。
- コロプレス: 遅延 fetch した `japan-prefectures.geojson` を `GeoJSONSource`(**`promoteId: 'id'` を指定**。feature-state hover は Feature トップレベル id を要するため)に載せ、`FillLayer` で塗り分ける。
  - 登録あり: `#cfe6ee` / データなし: `#e7edf0` / hover: `#3a93b3`(`feature-state` の `hover`)。
  - `LineLayer` で県境界の細線。
- プロンプト(`SELECT PREFECTURE / 都道府県を選択してください / … N都道府県が登録済み`)と凡例(登録あり/データなし)を表示。
- 県ホバーで名称+件数のフローティングツールチップ(命令的にDOM更新)。
- 県クリック: 件数 > 0 なら `goto('?pref=id')`、0 なら「◯◯県 はGTFSデータが未登録です」トースト。
- バス/路線/停留所レイヤは描画しない。

### 選択後

- コロプレス関連レイヤ/ソースを外す。
- `loadPrefecture` 完了後、**手元の stops の bbox へ `fitBounds`**(`maxZoom` 制限つき)。県ポリゴン bbox は使わない(東京/小笠原・鹿児島/奄美・島根/隠岐・長崎/対馬などの離島で bbox が巨大になり引きすぎるため。実データ分布に合わせる方が正確)。
- 常設ヘッダ(左上、`PREFECTURE / 県名` + 「変更」ボタン)。「変更」は `goto('?')`(pref 除去)でピッカーへ戻る。
- 県切替時に `hidden` / `selected` / `selectedStop` / `timetableByFeed` をクリアする(前県の非表示設定などの残留を防ぐ)。
- 既存 `RouteLayers`(事業者→系統→路線のグルーピング・検索・一括操作は実装済み)/ `Controls` / `StopTimetable` をその県のデータで表示。
- `Controls` の出典表示にはその県の部分集合フィードを渡す(全国分を渡すと出典が数百行になるため。現行 `feedInfos={data.index.feeds}` の配線を県サブセットへ変更)。
- 県データロード中は「全国の路線データを読み込み中…」のローディング表示。当日運行バス0なら既存の「運行中のバスはありません」通知を流用。

### 新規/変更コンポーネント

- 新規 `app/src/lib/PrefecturePicker.svelte` — コロプレス選択レイヤ+オーバーレイUI(プロンプト・凡例・ツールチップ・トースト)。地図本体は `+page.svelte` の `MapLibre` を共有する。
- 新規 `app/src/lib/PrefectureHeader.svelte` — 常設ヘッダ(県名 + 変更)。
- 変更 `app/src/routes/+page.svelte` — URL 駆動の状態機械、2段階ロード接続、`fitBounds`、フォールバック分岐。
- 変更 `app/src/lib/data.ts` — `loadIndex` / `loadPrefecture`、`FeedIndexEntry.prefId`。
- `Controls` / `RouteLayers` / `StopTimetable` は原則不変(出典の配線変更を除く)。

デザインの `mi-*` トークン(mi-teal / mi-ember / mi-slate)は既存アプリの Tailwind 設定にあるため流用。コロプレス色 `#cfe6ee` / `#e7edf0` / `#3a93b3` は専用に定義する。

## 検証

- **gtfs-core(Vitest)**: `prefectures.test.ts`
  - `resolvePrefId`: 各地方の代表点(例 那覇→47、札幌→1、前橋→10、東京駅→13、大阪→27)が期待する id。海上 → null(または最近傍フォールバックの境界)。
  - `PREFECTURES` が47件・id 重複なし・`region` が `REGIONS` に含まれる。
  - `centroidOf`: 外れ値を含む座標群で中央値ベースの代表点。
- **pipeline(Vitest)**: `feedProcessor.test.ts` / `finalize.test.ts` / `gtfsDataJp.test.ts` に追加
  - `target.prefId` があれば status/meta/`feeds.json` に反映。
  - `target.prefId` 無し(ODPT想定)で重心フォールバックが働く。
  - unchanged 時に `target.prefId ?? meta.prefId` が使われる。
  - gtfs-data.jp ソースが `feed_pref_id` を `FeedTarget.prefId` へ変換。
  - ODPT manifest 型に `prefId`(任意)を追加(将来の手動上書き用エスケープハッチ)。
  - finalize の summary に prefId=null 件数を集計(運用で不可視フィードに気づけるように)。
- **アプリ**: 型チェック(`pnpm check`)+ ローカルR2に**全国サブセット**を seed し手動確認
  - 初回=ピッカー表示、県クリックで段階ロード・stops bbox への `fitBounds`・各パネル表示。
  - データなし県クリックでトースト。
  - `?pref=10` 直リンクでピッカーを飛ばして群馬を表示。「変更」でピッカーへ戻り、状態がクリアされる。
  - **最大規模県のスケール確認**: gtfs-data.jp 実件数は高知51・長野42・三重39・福岡38 と群馬(計11)の約5倍。seed に高知 or 長野相当を含め、初回ロード時間と再生中(`busFeatureCollection` は毎フレーム全 trips 走査)のフレームレートを確認する。
  - prefId 皆無の feeds.json でフォールバック全量表示になること。

## ロールアウト

1. 本タスクではコード実装とローカル検証まで。
2. アプリは要件4のフォールバックにより prefId 投入前でも安全にデプロイできる(全量表示に退避)。
3. 本番の都道府県セレクタ有効化には、別途 全国パイプラインの Cron 手動実行(Workers Paid、`README.md`「本番初回実行を確認する」)で `prefId` 付き `feeds.json` と全国フィード成果物を投入する。
4. `/data/*` は `max-age=300` のため反映に最大5分。

## 既知のリスク

- ODPT の重心 point-in-polygon は、県境をまたぐ広域フィードで実営業エリアと異なる県に割り当たる可能性がある。1フィード=1県の単純化として受け入れる。必要なら ODPT manifest の手動 `prefId` で個別上書きする。
- 簡略化ポリゴンの精度により境界付近の重心が隣県判定・または内包なし(null)に落ちうる。代表点は中央値ベース、`resolvePrefId` は最近傍フォールバックを持たせて緩和する。
- コロプレス用 GeoJSON の同梱でパイプライン Worker バンドルが増える。gzip 後 200KB 以下を目標にし、Workers Paid(10MB)前提で許容する。アプリ側は静的資産の遅延 fetch で初期JSへ載せない。
- 最大規模県では全量描画・毎フレーム再計算の負荷が群馬比で増える。検証でスケールを確認し、問題があれば別途最適化(描画間引き等)を検討する。
