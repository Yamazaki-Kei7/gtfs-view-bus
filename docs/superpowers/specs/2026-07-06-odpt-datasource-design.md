# ODPTデータソース追加 設計書

日付: 2026-07-06
ブランチ: `feature/odpt-datasource`（`feature/gtfs-webgis` から分岐）

## 背景と目的

現行パイプラインは GTFSデータリポジトリ(gtfs-data.jp) の `GET /v2/files?pref=10` のみをデータソースとしており、群馬県で取得できるのは3フィード（安中市あんバス・太田市営バス・大泉町あおぞら）に限られる。高崎市・前橋市のバスデータは gtfs-data.jp に存在せず、公共交通オープンデータセンター(ODPT) で公開されている（調査記録: `.tmp/gtfs-takasaki-maebashi-research.md`）。

本設計は ODPT をデータソースとして追加し、高崎市・前橋市を走るバスを地図に表示できるようにする。

## 要件（確定事項）

1. **両ソース併用**: gtfs-data.jp の既存3フィードは維持し、ODPT の8フィードを追加する（ODPTには安中・太田・大泉が存在しないため一本化は不可）
2. **全8フィードを追加**: よしいバス(高崎市)・群馬バス・群馬中央バス・上信観光バス・上信ハイヤー・関越交通・日本中央バス(前橋エリア)・永井運輸
3. **全路線をそのまま表示**: 高崎・前橋周辺への地理的フィルタは行わない
4. **R2の不要データを掃除する**: 旧バージョンフィードの残留（PR #1 時点の既知受容事項)を解消し、ストレージの無制限な増加を防ぐ
5. 将来 gtfs-data.jp を廃止しやすいよう、ソースをアダプタとして抽象化する

## 対象ODPTフィード

すべて `https://api-public.odpt.org/api/v4/files/odpt/<operator>/<feed>.zip?date=current` から APIキー不要でダウンロード可能（302リダイレクト、実機確認済み）。ライセンスは全て CC BY 4.0。

| operator | feed | 表示名 | 事業者名 |
|---|---|---|---|
| TakasakiCity | yosiibus | よしいバス | 高崎市 |
| GunmaBus | AllLines | 群馬バス(全路線) | 群馬バス |
| GunmachuoBus | AllLines | 群馬中央バス(全路線) | 群馬中央バス |
| JoshinKankoBus | AllLines | 上信観光バス(全路線) | 上信観光バス |
| JoshinHire | AllLines | 上信ハイヤー(全路線) | 上信ハイヤー |
| Kan_etsuTransportation | AllLines | 関越交通(全路線) | 関越交通 |
| NipponChuoBus | Maebashi_Area | 日本中央バス(前橋エリア) | 日本中央バス |
| NagaiTransportation | AllLines | 永井運輸(全路線) | 永井運輸 |

高崎市「ぐるりん」は単独フィードが存在せず、受託5社（群馬バス・群馬中央バス・上信観光バス・上信ハイヤー・関越交通）の全路線フィード内に系統として含まれる。前橋市「マイバス」も同様に日本中央バス等のフィードに含まれる。

## アーキテクチャ

### ソースアダプタ抽象化

```ts
// pipeline/src/sources/types.ts
export interface FeedDescriptor {
	id: string; // R2キー用の一意ID
	name: string; // フィード名(フッター表示用)
	orgName: string;
	license: string | null;
	fromDate: string; // ODPTでは空文字(アプリ未使用)
	toDate: string;
	source: 'gtfs-data.jp' | 'odpt'; // フッターのクレジット表示用
	versionId: string; // 差分検出キー
	fetchZip(fetcher: typeof fetch): Promise<Uint8Array>;
	stopsGeojsonUrl?: string; // ソース提供GeoJSONがある場合のみ
	routesGeojsonUrl?: string;
}

export interface FeedSource {
	listFeeds(fetcher: typeof fetch): Promise<FeedDescriptor[]>;
}
```

- `pipeline/src/sources/gtfsDataJp.ts`: 既存の `files?pref=` API呼び出しをアダプタ化。`id`（`org~feed~fromDate`）と `versionId`（=file_uid）は現行と同一値になるため、R2上の既存データは再処理されない
- `pipeline/src/sources/odpt.ts`: 上表8フィードを定数配列でハードコード。`id` は `odpt~<operator>~<feed>` 形式（日付なしの安定ID。更新時は同一キーへ上書きされるため肥大化しない）
- `pipeline/src/run.ts`: メインループを1本に統合。`sources` を順に `listFeeds()` し、記述子ごとに「meta比較 → スキップ or 変換 → R2書き込み」。**meta.json をフィードの最後に書く冪等性保証は現行のまま維持**

### ODPTの差分検出

gtfs-data.jp の `file_uid` に相当する一覧APIがODPTに無いため:

1. zip URLへ `redirect: 'manual'` でGET
2. 302の `Location` ヘッダからパス部を抽出（例: `/files-open/odpt/TakasakiCity/yosiibus-20260421.zip`。SASトークンのクエリは除去）→ これを `versionId` とする。**zip本体をダウンロードせずに更新有無が判定できる**
3. `fetchZip()` は改めて `redirect: 'follow'` でGETしてzipを取得（SAS URLは約2分で失効するため、Location URLの使い回しはしない）
4. フォールバック: 将来302でなく200が直接返る構成に変わった場合、bodyのSHA-256を `versionId` とし、bodyはそのまま変換に再利用する

### meta.json のキー改名

`fileUid` → `versionId` に改名。読み取り時は `versionId ?? fileUid` で旧metaも解釈し、既存フィードの無駄な再処理を防ぐ。書き込みは常に `versionId`。

### GeoJSON自前生成（gtfs-core に追加）

ODPTには `stops.geojson` / `routes.geojson` の別配布が無い。アプリの地図描画はこの2ファイルに依存しているため、gtfs-core に純関数を追加する:

- `stopsToGeojson(files: Record<string, string>)`: stops.txt → Point FeatureCollection
- `shapesToGeojson(bundle: FeedBundle)`: 変換済みbundleの shapes → LineString FeatureCollection

パイプラインは「記述子にソース提供URLがあればそれを取得、なければ生成」して同じR2キーへ書く。アプリはGeoJSONのジオメトリのみ使用しプロパティ非依存（確認済み）のため、アプリの読み取りコードは無変更。

### アプリ側の変更（最小）

- `app/src/lib/data.ts` の `FeedIndexEntry` に `source` フィールドを追加
- `app/src/lib/Controls.svelte`: ハードコードの `GTFSデータリポジトリ(gtfs-data.jp)` クレジットを、feeds.json 中に存在する `source` の集合から動的に表示する（`gtfs-data.jp` → `GTFSデータリポジトリ(gtfs-data.jp)`、`odpt` → `公共交通オープンデータセンター(ODPT)`）。CC BY 4.0 のクレジット表示義務に対応

## データフロー（1回のCron実行）

1. 既存の `feeds.json` を読む（ソース障害時の引き継ぎ用）
2. 各ソースの `listFeeds()` を実行（ソース単位で try/catch）
3. 記述子ごとに: meta の `versionId` 比較 → unchanged スキップ / zip取得 → `convertFeed` → GeoJSON書き込み → meta.json（最後）
4. `feeds.json` を全ソース分の statuses で更新（`source` フィールド付き）
5. 掃除フェーズ（下記）

## R2掃除

- `feeds/` プレフィックスを `list()` でページング走査し、キーの2セグメント目からフィードIDを抽出。今回のアクティブID集合（`status: 'error'` のフィードも含む）に属さないキーを一括 `delete()`
- 消える対象の典型: gtfs-data.jp フィード更新でIDが変わった際の旧ID一式（例: `annakacity~annakashi-rosenbus~2026-05-15` → `~2026-09-01` 移行後の前者）
- **安全ガード**: いずれかのソースで `listFeeds()` 自体が失敗した実行では掃除をスキップする（一覧取得失敗を「全フィード孤児」と誤認して全削除する事故の防止）
- `BucketLike` に `list(options: { prefix: string; cursor?: string })` と `delete(keys: string[])` を追加（R2Bucket と構造互換）。R2の一括deleteは1回1000キー上限のため、それを超える場合は分割して呼ぶ

## エラー処理

- **フィード単位**（現行踏襲): try/catch で `status: 'error'` として feeds.json に記録。エラーでもアクティブ扱いのため掃除されない
- **ソース単位**（新規): `listFeeds()` が失敗した場合、前回の feeds.json からそのソースのエントリを status も含めそのまま引き継いで載せ続ける（地図からの一時的な全消えを防ぐ）。この実行では掃除をスキップ
- gtfs-data.jp の一覧API失敗が従来はパイプライン全体の throw だったが、本設計後は片側ソースの障害がもう片方に波及しない

## テスト

- 既存 `pipeline/src/run.test.ts` のシナリオ（unchangedスキップ・フィード単位エラー・meta最後書き込み・shapeSourceCounts引き継ぎ）はアダプタ構造に載せ替えて全て維持
- 新規テスト:
  - ODPTソース: `Location` ヘッダからの versionId 抽出（SASクエリ除去含む）、200直返し時のSHA-256フォールバック
  - 掃除: 孤児キー削除・ソース失敗時のスキップ・error status フィードの非削除
  - ソース障害時の前回 feeds.json 引き継ぎ
  - gtfs-core: `stopsToGeojson` / `shapesToGeojson` の単体テスト
- アプリ側フッターの表示は手動確認（コンポーネントテスト基盤が無いため）

## スコープ外（YAGNI）

- 高崎・前橋周辺への地理的フィルタリング
- アプリの遅延ロード化（初回ロードが実測で問題になった場合に別途対応。CDNのgzip配信で実転送量は数MB程度に収まる見込み)
- GTFS-RT（リアルタイム位置）対応
- ODPTフィード一覧の動的検出（CKAN APIがこのインスタンスでは塞がれているためハードコードで確定)

## 参考

- 調査レポート: `.tmp/gtfs-takasaki-maebashi-research.md`
- ODPT CKAN: https://ckan.odpt.org/ （各データセットページに CC BY 4.0 明記）
- 現行設計書: `docs/superpowers/specs/2026-07-05-gtfs-bus-position-webgis-design.md`
