# 全国版アプリ(都道府県セレクタ)設計書

日付: 2026-07-08
ステータス: 設計承認待ち
参照デザイン: `GTFS View Bus - Prefecture.dc.html`(claude.ai/design プロジェクト `d75d6b31…`)

## 背景と目的

全国パイプライン(`docs/superpowers/specs/2026-07-07-nationwide-pipeline-design.md`)により、`pipeline/` が全国のGTFSフィード(gtfs-data.jp 全件 + ODPT)を変換・R2保存できるようになった。しかしアプリ側は未対応で、`loadAll()` が `feeds.json` の全フィードについて `bundle.json` と `stops.geojson` を初回に一括ロードする。全国約646フィードでは初回ロードが数百MB規模になり破綻する。

本設計の目的は、アプリを全国データに対応させ、**都道府県セレクタを起点とした段階ロード**を導入すること。あわせて参照デザインの都道府県選択UI(コロプレス地図)と選択後のUIを反映する。

## 確定要件(ブレインストーミングでの決定)

1. 都道府県セレクタの主導線は **コロプレス地図(地図で選択)**。「変更」も同じ地図ピッカーを再表示する。
2. 対象範囲は **アプリ + パイプライン両方**。`feeds.json` に `prefId` を追加する。
3. 都道府県未選択(初回・`?pref` なし)では **必ずピッカーを表示**する。県を選ぶまでバス/路線は描画しない。
4. 本番反映のための全国パイプライン再実行(実データ投入)は本タスクの範囲外。コード実装とローカル検証までを対象とする。

## スコープ外

- 本番R2への全国データ投入(Workers Paid での Cron 手動実行)。
- 複数都道府県にまたがるフィードの複数県への重複所属(1フィード=1県に単純化する)。
- 都道府県より細かい市区町村・事業者単位の絞り込み画面。
- GTFS-RT、配信形式変更(ベクトルタイル等)。
- デザインの他2導線(地図＋一覧サイドドック / 検索モーダル)。主導線のコロプレス地図のみ実装する。

## データモデル: `feeds.json` に `prefId` を追加

各フィードに `prefId: number | null`(1〜47、JIS都道府県コード)を付与する。

### 取得源

- **gtfs-data.jp**: `/v2/files` レスポンスに `feed_pref_id` が含まれる(権威的・追加取得コストなし)。
- **ODPT**: `feed_pref_id` に相当するフィールドが無いため、停留所の**代表座標(重心)**を point-in-polygon で判定する。

### 実装方針(再処理を増やさない)

`FeedTarget` に `prefId?: number | null` を追加する。gtfs-data.jp のソースは `feed_pref_id` をここへ設定する。ODPT は未設定(undefined)。

consumer(`processFeedTarget`)は次で `prefId` を決める:

```
prefId = target.prefId ?? resolvePrefId(重心(stops))
```

- `target.prefId`(gtfs-data.jp の権威値)があれば優先。
- 無ければ(ODPT等)、生成済み stops から重心を計算し `resolvePrefId` で解決。
- 解決不能(海上・国外・空フィード)は `null`。

`prefId` は `meta.json` と `FeedStatus` に保存する。`shapeSourceCounts` と同じく、**unchanged 時は `meta.json` から読み戻す**ため、月次運用で再処理は増えない。出力スキーマ版を **4 → 5** に上げ、既存フィード(本番は群馬11件のみ)は一度だけ移行処理される。

finalize の `toPublicStatus` に `prefId` を含め、`feeds.json` の各エントリへ出力する。`FeedIndexEntry`(アプリ型)にも `prefId?: number | null` を追加する。

## gtfs-core: `prefectures` モジュール(単一の真実源)

新規 `packages/gtfs-core/src/prefectures.ts` を追加する。パイプラインの `resolvePrefId` と、アプリのコロプレス描画・県別集計が同じ定義を共有する。

- `PREFECTURES: { id: number; ja: string; region: RegionName }[]` — 全47都道府県。デザインの `PREFS` からモック `feeds` 件数を除いて移植。
- `REGIONS: RegionName[]` — `['北海道','東北','関東','中部','近畿','中国','四国','九州']`。
- `PREFECTURES_GEOJSON` — 簡略化した47都道府県ポリゴン(`FeatureCollection`、各 Feature の `properties.id` = 都道府県コード)。出典は公開データ(dataofjapan/land 等)を mapshaper で簡略化し、リポジトリに同梱する。
- `resolvePrefId(lng: number, lat: number): number | null` — ray-casting による point-in-polygon。最初に内包する県の id を返す。
- `prefectureBbox(id: number): [[number, number], [number, number]] | null` — 県境界の bbox(選択後の `fitBounds` 用)。ポリゴンから算出する。
- `centroidOf(coords: LngLat[]): LngLat | null` — 座標群の代表点(平均でなく外れ値に強い中央値ベース)。consumer が stops から重心を得るために使う。

GeoJSON は動的 import 可能な独立ファイル(`prefectures.geo.json`)として持ち、`resolvePrefId` は同ファイルを参照する。アプリのコロプレスは `PREFECTURES_GEOJSON` を**動的 import**して別チャンク化し、初期JSを膨らませない。

`index.ts` に `export * from './prefectures';` を追加する。

## アプリ: 全量ロード → 2段階ロード

`app/src/lib/data.ts` の `loadAll()` を2つに分割する。

- `loadIndex(): Promise<FeedIndex>` — `feeds.json` のみ取得。都道府県別の件数集計とセレクタ表示に使う。
- `loadPrefecture(prefId: number, index: FeedIndex): Promise<{ feeds: CatalogFeed[]; stops: … }>` — `index.feeds` を `prefId` で絞り、その県のフィードの `bundle.json` / `stops.geojson` のみ並列取得。timetable は従来通り停留所クリック時に遅延ロード。

`routeCatalog` / `buildRouteLines` / `busFeatureCollection` などは、渡すフィード配列が部分集合になるだけでロジックは不変。

### 都道府県別件数の集計

`feeds.json` を `prefId` でグルーピングし、県ごとの登録フィード数を得る。`prefId === null` のフィードはどの県にも属さない(件数外・地図では選択不可)。件数 > 0 の県が「データ登録あり」。

## アプリ: 都道府県セレクタと状態遷移

### 状態

- `selectedPref: number | null` を **URL クエリ `?pref=<id>`** に保持する(共有・ブラウザ戻る対応)。SvelteKit の `page`/`goto` を用いる。
- マウント時に `?pref` を読む。妥当な id(件数 > 0)なら選択済みとして直接ロード、そうでなければピッカー表示。
- 選択中フィードデータ・ローディング・エラーは既存の `$state` パターンに合わせる。

### 未選択時(ピッカー)

- 地図は全国表示(`fitBounds(JAPAN_BBOX)`)。既存の `BasemapControl` は維持。
- コロプレス: `PREFECTURES_GEOJSON` を `GeoJSONSource` に載せ、`FillLayer` で塗り分ける。
  - 登録あり: `#cfe6ee` / データなし: `#e7edf0` / hover: `#3a93b3`(`feature-state` の `hover`)。
  - `LineLayer` で県境界の細線。
- プロンプト(`SELECT PREFECTURE / 都道府県を選択してください / 地図をタップ… N都道府県が登録済み`)と凡例(登録あり/データなし)を表示。
- 県ホバーで名称+件数のフローティングツールチップ(命令的にDOM更新)。
- 県クリック: 件数 > 0 なら `selectPref(id)`、0 なら「◯◯県 はGTFSデータが未登録です」トースト。
- バス/路線/停留所レイヤは描画しない。

### 選択後

- コロプレス関連レイヤを外し、`fitBounds(prefectureBbox(id))`(`maxZoom` 制限つき)でその県へ寄せる。
- 常設ヘッダ(左上、`PREFECTURE / 県名` + 「変更」ボタン)。「変更」は `selectedPref = null`(URLからも除去)でピッカーへ戻る。
- 既存 `RouteLayers`(事業者→系統→路線のグルーピング・検索・一括操作は実装済み)/ `Controls`(タイムバー・出典)/ `StopTimetable`(時刻表)をその県のデータで表示。
- 県データロード中は「全国の路線データを読み込み中…」のローディング表示。
- 当日運行バスが0なら既存の「この日時に運行中のバスはありません」通知を流用。

### 新規/変更コンポーネント

- 新規 `app/src/lib/PrefecturePicker.svelte` — コロプレス地図オーバーレイ(プロンプト・凡例・ツールチップ・トースト)。地図本体は `+page.svelte` の `MapLibre` を共有し、本コンポーネントは選択レイヤとオーバーレイUIを担う。
- 新規 `app/src/lib/PrefectureHeader.svelte` — 常設ヘッダ(県名 + 変更)。
- 変更 `app/src/routes/+page.svelte` — 状態機械(未選択=ピッカー / 選択後=描画)、2段階ロードの接続、URL 同期、`fitBounds`。
- 変更 `app/src/lib/data.ts` — `loadIndex` / `loadPrefecture`、`FeedIndexEntry.prefId`。
- `Controls` / `RouteLayers` / `StopTimetable` は原則不変(選択後にそのまま使う)。

デザインの `mi-*` トークン(mi-teal / mi-ember / mi-slate)は既存アプリの Tailwind 設定にあるため流用する。色値 `#cfe6ee` / `#e7edf0` / `#3a93b3` はコロプレス専用として定義する。

## 検証

- **gtfs-core(Vitest)**: `prefectures.test.ts`
  - `resolvePrefId`: 各地方の代表点(例 那覇→47、札幌→1、前橋→10、東京駅→13)が期待する id。県外(海上)→ null。
  - `prefectureBbox`: 既知県の bbox が妥当な範囲。
  - `PREFECTURES` が47件・id 重複なし・`region` が `REGIONS` に含まれる。
- **pipeline(Vitest)**: 既存 `feedProcessor.test.ts` / `finalize.test.ts` に追加
  - `target.prefId` があれば status/meta/`feeds.json` に反映。
  - `target.prefId` 無し(ODPT想定)で重心フォールバックが働く。
  - unchanged 時に `meta.json` の `prefId` を読み戻す。
  - gtfs-data.jp ソースが `feed_pref_id` を `FeedTarget.prefId` へ変換。ODPT manifest 型に `prefId`(任意)を追加。
- **アプリ**: 型チェック(`pnpm check`)+ ローカルR2に全国サブセットを seed し、手動確認
  - 初回=ピッカー表示、県クリックで段階ロード・`fitBounds`・各パネル表示。
  - データなし県クリックでトースト。
  - `?pref=10` 直リンクでピッカーを飛ばして群馬を表示。「変更」でピッカーへ戻る。

## ロールアウト

1. 本タスクではコード実装とローカル検証まで。
2. 本番反映は別途、全国パイプラインの Cron 手動実行(Workers Paid、`README.md` の「本番初回実行を確認する」手順)で `feeds.json`(`prefId` 付き)と全国フィード成果物を投入する。
3. `/data/*` は `max-age=300` のため反映に最大5分。

## 既知のリスク

- ODPT の重心 point-in-polygon は、県境をまたぐ広域フィードで実際の営業エリアと異なる県に割り当たる可能性がある。1フィード=1県の単純化として受け入れる。
- 簡略化ポリゴンの精度により、境界付近の重心が隣県に判定されうる。代表点は中央値ベースにして外れ値の影響を抑える。
- コロプレス用 GeoJSON の同梱でリポジトリ/バンドルが増える。動的 import で初期JSへの影響は抑えるが、サイズは簡略化度で調整する。
- 出力スキーマ版 4→5 で既存フィードが一度再処理される。本番は群馬11件のみのため軽微。
