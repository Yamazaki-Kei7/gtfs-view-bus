# GTFSバス位置可視化WebGIS 設計書

作成日: 2026-07-05
ステータス: 承認済み

## 概要

GTFS-JP静的データ(gtfs-data.jp リポジトリ)を用いて、指定した日時に群馬県内のバスがどの位置にいるかを地図上で確認できるWebGISを構築する。位置は時刻表ベースのシミュレーション(stop_times の予定時刻を shape 上に補間)であり、リアルタイム位置(GTFS-RT)は扱わない。

ホスティングは Cloudflare に完結させ、IaC(Terraform + wrangler)で管理する。

## 要件

- 対象: 群馬県の全GTFSフィード(gtfs-data.jp API v2 で取得。2026-07-05 時点の実測で3フィード: 安中市あんバス・太田市営バス・大泉町あおぞら)
- 表示: 日付ピッカー + 時刻スライダー + 再生/一時停止/倍速。スライダー操作・再生でバスが shape 上を連続的に移動する
- データ更新: 月次の Cron Trigger で自動更新(更新があったフィードのみ再変換)。ダイヤ改正の反映は最大1か月遅れることを許容する
- 変換実装: TypeScript。実測で Worker の CPU 制限に当たった場合のみ変換コアを Rust wasm 化する
- IaC: アカウントレベルリソースは Terraform、Worker 設定は wrangler.jsonc、CI/CD は GitHub Actions
- 社内標準準拠: pnpm(minimumReleaseAge: 10080)、SvelteKit SSR、MapLibre GL JS、GitHub Actions + Environment secrets

## アーキテクチャ

```
gtfs-data.jp API v2
      │ (月次 Cron)
      ▼
pipeline Worker ──変換──▶ R2 バケット ◀──R2バインディング── app Worker (SvelteKit SSR)
                                                                  │
                                                              ブラウザ (MapLibre + 補間描画)
```

## リポジトリ構成

```
gtfs-view-bus/
├── app/                  # SvelteKit フロントエンド (adapter-cloudflare, Workers上でSSR)
├── pipeline/             # データ変換 Worker (Cron Trigger)
├── packages/
│   └── gtfs-core/        # 共有パッケージ: 型定義・GTFSパース・空間解析・補間ロジック
├── infra/                # Terraform (cloudflare provider)
├── .github/workflows/    # CI/CD
└── pnpm-workspace.yaml   # ルートをワークスペース化。minimumReleaseAge: 10080
```

`gtfs-core` が設計の要点。「時刻→位置」の補間ロジックを pipeline(変換・テスト)と app(描画)で共有し、将来 wasm 化する場合はこのパッケージの実装を差し替える。

## データパイプライン(pipeline Worker)

月次 Cron(毎月1日 JST早朝)で以下を実行する。

1. `GET https://api.gtfs-data.jp/v2/files?pref=10` でフィード一覧を取得(10=群馬県。`pref` は数値ID)
2. 各フィードの `file_uid` を R2 上のメタデータと比較し、更新分のみ処理
3. フィードごとに逐次処理: zip 取得 → 展開(fflate) → CSV パース(stops / trips / stop_times / shapes / calendar / calendar_dates) → **リポジトリ提供の routes.geojson も取得** → 変換 → R2 書き込み(bundle と stops/routes.geojson)

### 空間解析(停留所の路線ライン射影)

各トリップを `(経過秒, 累積距離)` のキーフレーム列に変換する。バスの描画位置は常に**路線ラインの頂点列を辿って**補間するため、バス停間でも直線ショートカットは起きない。

- 停留所座標を路線ポリラインへ射影して累積距離を求める。射影は**単調増加制約付き**(直前の停留所の射影位置=セグメント番号+セグメント内オフセットより手前に戻らない)。単純な最近傍だと折り返し・ループ路線で誤マッチするため
- ポリライン頂点間の距離は haversine で累積距離配列(`cumDist`)を構築
- `stop_times.shape_dist_traveled` は単位系が揺れるため使用せず、常に自前射影する

**形状(shape)の解決優先順位** — 実データ検証で群馬県3フィード中2つ(太田市・大泉町)に shapes.txt が無いことが判明したため、トリップごとに次の順で形状を決める:

1. **shapes.txt** があればその shape を使う
2. なければ**リポジトリ提供の routes.geojson**(道路形状を持つ。例: 太田市尾島線は320頂点)から該当 route_id の形状を取得。各パーツ・全パーツ連結・それぞれの逆順を候補ポリラインとし、停留所を単調射影して**適合度(全停留所の最大射影誤差が150m以内)**で最良候補を採用
3. 適合しない場合のみ停留所座標の直線ポリラインにフォールバック

トリップごとの形状ソース内訳(shapes / route / straight)を bundle に記録し、feeds.json のステータスにも反映して近似表示のフィードを識別できるようにする。

## R2 データ形式

```
feeds.json                     # フィード一覧・更新日時・処理ステータス・形状ソース内訳
{feedId}/stops.geojson         # バス停(表示用、リポジトリ提供物のコピー)
{feedId}/routes.geojson        # 路線ライン(表示用、リポジトリ提供物のコピー)
{feedId}/bundle.json           # 運行データ本体
```

`bundle.json`:

```jsonc
{
  "calendar": { /* service_id → 曜日パターン + calendar_dates 例外 */ },
  "routes":   { "R1": { "shortName": "1", "longName": "駅前線", "color": "#FF0000" } },
  "shapes":   { "shp1": { "coords": [[lng, lat], ...], "cumDist": [0, 120.5, ...] } },
  "trips":    [ { "tripId": "...", "routeId": "...", "shapeId": "shp1",
                  "serviceId": "...", "keyframes": [[21600, 0], [21780, 1240.2], ...] } ],
  "shapeSourceCounts": { "shapes": 120, "route": 40, "straight": 2 }
}
```

クライアントは日付から有効な `service_id` を判定し、時刻 t ごとに各トリップのキーフレームを二分探索 → 距離を線形補間 → shape 上の座標へ変換する。実測でフィードzipは12〜128KB(3フィード合計約170KB)であり、変換後の全データも生数MB以下・brotli圧縮後は数百KB以下。フィード単位で遅延ロードする。

## データ形式の選定理由と移行パス

表示用データは GeoJSON、計算用データは JSON を採用する。判断根拠:

- MapLibre GL JS のソースは GeoJSON かベクトルタイル(PMTiles含む)のみ。FlatGeobuf / GeoParquet はブラウザでパーサライブラリ(parquet-wasm は1MB超)を介して結局 GeoJSON にデシリアライズすることになり、今回の全データ(圧縮後数百KB以下)よりパーサの方が大きい
- FlatGeobuf(空間インデックス+Range リクエスト)や GeoParquet(列指向の部分読み取り)の強みは「全量をクライアントへ送れない規模」(数十MB〜)で初めて効く
- `bundle.json` はキーフレーム+shape頂点列を補間ループが丸ごと使う計算用データであり、列指向・空間インデックスの恩恵がない

サイズ規律として、座標は小数6桁・距離は0.1m単位に丸めて出力する。配信は Cloudflare エッジの brotli/gzip に任せる。

| データ量・用途 | 採用フォーマット |
|---|---|
| 〜数MB・全量表示(本PoC) | GeoJSON + edge 圧縮 + 桁丸め |
| 表示レイヤーが10MB超・広域(複数県〜全国) | PMTiles(CI等ネイティブ環境で tippecanoe により生成) |
| 単一レイヤー巨大・bbox部分取得 | FlatGeobuf |
| 分析ワークロード(stop_times 集計等) | GeoParquet |

## フロントエンド(app)

- `@sveltejs/adapter-cloudflare` に変更し Workers 上で SSR
- 地図: svelte-maplibre-gl。ベースマップは PoC では OSM ラスタタイル(設定で差し替え可能にする)
- UI:
  - 日付ピッカー
  - 時刻スライダー: 0:00〜28:00 スケール(GTFS の 24 時超表記に対応)
  - 再生 / 一時停止 / 倍速
- バス位置は GeoJSON ソースを `requestAnimationFrame` ごとに `setData` で更新。数千トリップ × 二分探索は 1ms 未満のためメインスレッドで計算
- バス停・路線ラインをレイヤー表示。バスクリックで系統・便情報のポップアップ
- 変換済みデータは app Worker の R2 バインディング経由(`/data/...` ルート)で配信

## IaC・デプロイ

| 対象 | ツール |
|---|---|
| R2 バケット等アカウントレベルリソース | Terraform (`infra/`, cloudflare provider) |
| Worker 設定(Cron、R2 バインディング) | 各 Worker の wrangler.jsonc |
| CI(lint / svelte-check / test) | GitHub Actions(PR 時) |
| デプロイ(`wrangler deploy` × app / pipeline) | GitHub Actions(main マージ時)、secrets は Environment secrets |

## エラー処理

- パイプラインはフィード単位で try/catch。1 フィードの破損が他フィードの処理を止めない
- 処理結果(成功 / 失敗 / スキップ)を `feeds.json` に記録し、フロントで「取得失敗」を表示できるようにする
- 指定日がフィードの calendar 有効期間外の場合は UI にその旨を表示
- CPU 制限対策: フィード逐次処理とし、進捗を R2 に記録して途中再開可能にする

## テスト

- `gtfs-core` に Vitest ユニットテスト: CSV パース、停留所射影(折り返し路線フィクスチャ含む)、キーフレーム補間、calendar 判定
- 小型フィクスチャ GTFS(数停留所 × 数便)を同梱し変換の E2E テスト
- CI で lint / typecheck / test を必須化

## スコープ外

- GTFS-RT によるリアルタイム車両位置
- 群馬県以外の都道府県(ただしパイプラインは複数フィード前提のため拡張は県指定の変更のみ)
- Rust wasm 化(CPU 制限に実測で当たった場合の対応として温存)
- 経路検索・到達圏解析などの高度な解析機能
