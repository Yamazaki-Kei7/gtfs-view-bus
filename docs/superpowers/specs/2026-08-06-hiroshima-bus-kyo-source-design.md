# 広島県バス協会(bus-kyo)GTFSデータソース追加 設計書

日付: 2026-08-06
ステータス: 設計承認済み

## 背景と目的

現在のパイプラインは gtfs-data.jp・公共交通オープンデータセンター(ODPT)・北海道オープンデータプラットフォーム(HODA)をデータソースにしている。広島県の GTFS は、広島県バス協会が [bus-kyo.or.jp/gtfs-open-data](https://www.bus-kyo.or.jp/gtfs-open-data) で集約公開しているが、gtfs-data.jp には広島県(pref=34)の登録が 0 件で、既存ソースではカバーできない。

本設計の目的は、広島県バス協会が公開する 17 事業者の GTFS-JP 静的データを取り込み対象に追加し、`prefId=34` として R2 へ変換・公開することである。アプリは既に多県対応(都道府県ピッカー)済みのため、広島のフィードが R2 に入れば自動的に群馬と同じ UX で表示される。GTFS リアルタイムは対象外。

## 前提調査で確定した事実

- **アプリは多県対応済み**: `PrefecturePicker` が全国コロプレスを描画し、`feeds.json` の `prefId` 別にフィードをロードする。広島固有のアプリ改修は出典ラベル1行のみ。
- **既存ソースと重複しない**: gtfs-data.jp の `?pref=34` は 0 件。二重取り込みの懸念は無い。
- **bus-kyo は機械可読カタログを持たない**: HTML ページに 17 事業者の直リンクが並ぶだけ。API/CKAN は無い。
- **配布は3バックエンド系統・全 CC0**: モバイルクリエイト(`.../static/{N}/current_data.zip` ×13)、タウンクリエーション(busit.jp ×1)、両備システムズ(bus-vision.jp ×3)。
- **`prefId` は自動解決も可能**: `feedProcessor` は `target.prefId` 未設定でも停留所重心から解決するが、県境路線の誤判定回避のため明示的に `prefId=34` を与える(HODA が `prefId=1` を与えるのと同様)。

## 確定要件

1. 広島県バス協会が公開する 17 事業者の GTFS-JP 静的データ(現行ダイヤ)を取り込み対象にする。モバイルクリエイト系13事業者は「現在データ」を指す `current_data.zip` を使う(`latest.zip` は将来ダイヤ改正時に未来リビジョンへ先行し得るため使わない。※2026-08-06 時点では両者バイト一致)。
2. bus-kyo には機械可読カタログが無いため、17 事業者の一覧はリポジトリ内の**静的 JSON マニフェスト**で保持する。
3. 全フィードを `prefId=34`(広島県)に明示的に紐づける。
4. ライセンスは CC0。
5. 既存の R2 公開形式、`feeds.json` 形式、アプリ側の `/data/*` 読み取り契約は維持する。
6. フィード単位の変換失敗は既存の全国パイプラインのエラー処理(`status: "error"`)に乗せ、1 フィードの破損でジョブ全体を止めない(bus-kyo は固定マニフェストのため一覧取得の失敗経路は存在しない)。
7. 作業対象箇所である `containerProtocol.ts` の `isSourceId` が `'hoda'` を許可していない既存バグを、本作業でまとめて修正する。

## スコープ外

- bus-kyo ページの HTML スクレイピング(マニフェスト方式を採用)
- GTFS リアルタイム(TripUpdate / VehiclePosition / Alert)対応
- 「未来データ」(改正予定)の取り込み。今回は「現在データ」のみ。
- 広島県以外の新規ソース追加
- 静的リスト方式の汎用化(使用箇所が bus-kyo 1 箇所のため、2 県目が来るまで汎用抽象は作らない)

## アーキテクチャ

既存の `FeedSource` 境界(`sourceId` と `listTargets(fetcher)`)を維持する。bus-kyo は機械可読カタログを持たないため、リポジトリ内の固定マニフェストを読み `FeedTarget[]` へ変換する専用ソースを追加する。

新規ファイル:

- `pipeline/src/sources/busKyoManifest.json` — 17 事業者の固定リスト
- `pipeline/src/sources/busKyo.ts` — `createBusKyoSource()`。マニフェストを `FeedTarget[]` へ写像する
- `pipeline/src/sources/busKyo.test.ts` — 写像の検証

`createBusKyoSource()` は引数を取らず、モジュール内で `busKyoManifest.json` を import して固定の `FeedTarget[]` を返す。ネットワークアクセスは無い(取得先の zip は後段の `feedProcessor` がダウンロードする)。

```ts
export function createBusKyoSource(): FeedSource;
```

マニフェスト(データ)と変換関数(ロジック)を分離し、変換関数側に ID・`versionId`・`prefId`・ライセンスの規約を閉じ込める。

`SourceId` は `'gtfs-data.jp' | 'odpt' | 'hoda' | 'bus-kyo'` に拡張する。`Record<SourceId, number>` を使う既存箇所は、`bus-kyo` の件数集計漏れを型チェックで検出できる状態を保つ。

## マニフェスト定義

各エントリは `{ key, name, zipUrl }` を持つ。`key` は R2 キーに使う安定スラグで、URL や名称が変わっても不変にする。

| key | name(事業者) | zipUrl |
|---|---|---|
| `hiroden` | 広島電鉄 | `https://ajt-mobusta-gtfs.mcapps.jp/static/8/current_data.zip` |
| `hiroshima-bus` | 広島バス | `https://ajt-mobusta-gtfs.mcapps.jp/static/9/current_data.zip` |
| `hiroshima-kotsu` | 広島交通 | `https://ajt-mobusta-gtfs.mcapps.jp/static/10/current_data.zip` |
| `geiyo-bus` | 芸陽バス | `https://ajt-mobusta-gtfs.mcapps.jp/static/11/current_data.zip` |
| `bihoku-kotsu` | 備北交通 | `https://ajt-mobusta-gtfs.mcapps.jp/static/12/current_data.zip` |
| `jrbus-chugoku` | JRバス中国 | `https://ajt-mobusta-gtfs.mcapps.jp/static/15/current_data.zip` |
| `hd-nishi-hiroshima` | エイチ・ディー西広島 | `https://ajt-mobusta-gtfs.mcapps.jp/static/13/current_data.zip` |
| `forble` | フォーブル | `https://ajt-mobusta-gtfs.mcapps.jp/static/14/current_data.zip` |
| `sasaki-kanko` | ささき観光 | `https://ajt-mobusta-gtfs.mcapps.jp/static/17/current_data.zip` |
| `kure-seikatsu-bus` | 呉市生活バス | `https://ajt-mobusta-gtfs.mcapps.jp/static/18/current_data.zip` |
| `hatsukaichi-jishu` | 廿日市市自主運行バス | `https://ajt-mobusta-gtfs.mcapps.jp/static/19/current_data.zip` |
| `asahi-kotsu` | 朝日交通 | `https://ajt-mobusta-gtfs.mcapps.jp/static/54/current_data.zip` |
| `onomichi-bus` | おのみちバス | `https://ajt-mobusta-gtfs.mcapps.jp/static/53/current_data.zip` |
| `etajima-bus` | 江田島バス | `https://gtfs-st.busit.jp/api/etajimabus` |
| `chugoku-bus` | 中国バス | `https://bus-vision.jp/gtfs_v2/chugokubus/gtfsFeed` |
| `tomotetsu` | 鞆鉄道 | `https://bus-vision.jp/gtfs_v2/tomotetsubus/gtfsFeed` |
| `ikasa-bus` | 井笠バスカンパニー | `https://bus-vision.jp/gtfs_v2/ikasabus/gtfsFeed` |

計 17 件。末尾 4 件(`etajima-bus` / `chugoku-bus` / `tomotetsu` / `ikasa-bus`)は `.zip` 拡張子ではない API 風エンドポイントだが、GTFS 静的 zip を返す想定でそのまま `zipUrl` に入れる。

## FeedTarget変換

各マニフェストエントリを次のように `FeedTarget` へ写像する。

- `id`: `bus-kyo~<key>`(URL・名称が変わっても不変)
- `name`: `name`(事業者名)
- `orgName`: `name`(bus-kyo は 1 エントリ 1 事業者)
- `license`: `'CC0'`
- `fromDate`: 空文字
- `toDate`: 空文字
- `source`: `'bus-kyo'`
- `versionId`: 空文字 `''`
- `zipUrl`: `zipUrl`
- `prefId`: `34`

`fromDate` / `toDate` は listing に運行期間が無いため空文字にする。実際の運行日判定は GTFS 内の `calendar.txt` / `calendar_dates.txt` に基づくため地図表示には影響しない。

### versionId を空文字にする理由

`current_data.zip` 等は URL 固定で、listing 側にバージョン情報(`last_modified` 等)が無い。`feedProcessor` は `versionId === ''` を既に「差分スキップしない=常に再処理」の合図として扱っている(元は ODPT の版数解決失敗記述子)。bus-kyo は月次・17 件と少なく毎回再変換しても負荷は無視できるため、「ソース zip が変わったら確実に反映される(陳腐化しない)」ことを優先して `''` を採用する。HTTP HEAD で `ETag`/`Last-Modified` を取って差分スキップする最適化は、取得先サーバのヘッダ挙動に依存し複雑さに見合わないため採らない(YAGNI)。

## 既存バグの修正

`pipeline/src/containerProtocol.ts` の `isSourceId` が `'gtfs-data.jp'` と `'odpt'` しか許可しておらず、`'hoda'` が漏れている。

```ts
// 現状(バグ)
function isSourceId(value: string | undefined): value is SourceId {
	return value === 'gtfs-data.jp' || value === 'odpt';
}
```

`isSourceId` は `parseFeedStatusResponse` から Container の変換結果の `source` フィールド検証に使われる。Container は `target.source` をそのまま応答に載せるため、現状のままだと `source: 'hoda'` および `source: 'bus-kyo'` の応答が `container status response malformed: source` で例外になり、該当フィードが全滅する。

`SourceId` の全メンバー(`'gtfs-data.jp' | 'odpt' | 'hoda' | 'bus-kyo'`)を許可するよう修正する。将来のソース追加でも検証漏れが起きにくいよう、`SourceId` の定義と単一の情報源から導出する実装(例: 既知 SourceId の配列 + `includes`)を検討する。

## エラー処理

`createBusKyoSource().listTargets()` はネットワークアクセスを伴わず、固定マニフェストから常に 17 件を返す。取得失敗経路は無い。

個別 zip の取得・GTFS 展開・CSV 解析・変換に失敗した場合は、既存どおりフィード単位で `status: "error"` を記録し、1 フィードの破損でジョブ全体は止めない。末尾 4 件の API 風エンドポイントが zip を返さない場合も、この per-feed 耐性により他フィードには影響しない。

## アプリ側の変更

`app/src/lib/Controls.svelte` の `SOURCE_CREDITS` に bus-kyo を追加する。

```ts
const SOURCE_CREDITS: Record<string, string> = {
	'gtfs-data.jp': 'GTFSデータリポジトリ(gtfs-data.jp)',
	odpt: '公共交通オープンデータセンター(ODPT)',
	hoda: '北海道オープンデータプラットフォーム(HODA)',
	'bus-kyo': '広島県バス協会 GTFSオープンデータ',
};
```

未登録でも id 生表示にフォールバックして壊れはしないが、出典表記として追加する。bus-kyo フィードは `prefId=34` を持つため、都道府県集計・ピッカーでは広島県に入る。これ以外のアプリ改修は不要。

## テスト計画

`pipeline/src/sources/busKyo.test.ts` を追加し、次を確認する。

- `createBusKyoSource().listTargets()` が 17 件の `FeedTarget` を返す。
- 各 `FeedTarget` の `id` が `bus-kyo~<key>`、`source` が `'bus-kyo'`、`prefId` が `34`、`license` が `'CC0'`、`versionId` が `''`。
- `id` に重複が無い(安定スラグの一意性)。

既存テストへの追加確認:

- `jobProducer` の `sources` 集計に `'bus-kyo': 0` が入る(`jobProducer.test.ts`)。
- `finalize` と `JobSummary` が `'bus-kyo'` を含む `Record<SourceId, number>` を扱える(`finalize.test.ts`)。
- `consumer` の `sources` 期待値に `'bus-kyo': 0` を追加(`consumer.test.ts`)。
- `containerProtocol.test.ts` に `source: 'hoda'` と `source: 'bus-kyo'` の `parseFeedStatusResponse` 成功ケースを追加(バグ修正の回帰テスト)。
- `Controls.svelte` / app の型チェックで `bus-kyo` クレジット追加が壊れていない。

検証コマンド:

```sh
pnpm --filter pipeline test
pnpm --filter pipeline check
pnpm --filter app check
pnpm format:check
```

## 既知のリスク(実装時に検証)

- **末尾 4 件の API 風エンドポイント**: `etajima-bus`(busit.jp)、`chugoku-bus` / `tomotetsu` / `ikasa-bus`(bus-vision.jp)は `.zip` 拡張子でない。実装時に少なくとも 1 件を実際に fetch し、GTFS 静的 zip(RT protobuf でない・追加パラメータ不要)であることを確認する。zip でない場合は per-feed の `status: "error"` になり他に影響しないが、対象から外すか要判断。
- **「現在データ」であることの確認**: mobusta系は `current_data.zip`(現行ダイヤ)を使う。`latest.zip` は将来リビジョンへ先行し得るため使わない(2026-08-06 実測では全13事業者で両者バイト一致・全て当日を含む)。

## 反映(マージ後の運用)

月次 Cron で自動取得されるが、即座に広島を表示するには HODA と同様の一度きりの seed 実行(本番 R2 への投入)を行う。既存の `pipeline/.tmp/hoda-seed.mts` パターンを踏襲する。seed 後、`feeds.json` の `sources['bus-kyo']` 件数と `prefId=34` のフィード数、アプリのピッカーで広島県が選択可能になっていることを確認する。

## 採用しない案

### HTML スクレイピング

bus-kyo ページを月次で取得し HTML を解析してリンクを自動抽出する案。事業者増減に自動追従できる利点があるが、3 バックエンド系統で URL パターンが異なり解析が複雑で、ページのレイアウト変更で無言のうちに 0 件になるリスクがある。curated な協会ページは変更頻度が低いため、静的マニフェストの堅牢性を優先する。

### 静的リスト方式の汎用化

`createStaticListSource(manifest, config)` のような汎用ソースにする案。使用箇所が bus-kyo 1 箇所のみで、現時点では speculative generality になる(CLAUDE.md「1 か所でしか使わない抽象を追加しない」)。2 県目に同じ配布形態が来た時点で汎用化する。

### HTTP HEAD による versionId 生成

`current_data.zip` に HEAD を投げて `ETag`/`Last-Modified`/`Content-Length` を versionId にし差分スキップする案。最適だが取得先サーバのヘッダ挙動に依存し、月次 17 件の再変換コストに見合わない。
