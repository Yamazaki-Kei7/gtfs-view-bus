# GTFSバス位置可視化WebGIS 設計書

作成日: 2026-07-05
ステータス: 承認済み

## 概要

GTFS-JP静的データ(gtfs-data.jp リポジトリ)を用いて、指定した日時に群馬県内のバスがどの位置にいるかを地図上で確認できるWebGISを構築する。位置は時刻表ベースのシミュレーション(stop_times の予定時刻を shape 上に補間)であり、リアルタイム位置(GTFS-RT)は扱わない。

ホスティングは Cloudflare に完結させ、IaC(Terraform + wrangler)で管理する。

## 要件

- 対象: 群馬県の全GTFSフィード(gtfs-data.jp API v2 で取得、十数フィード規模)
- 表示: 日付ピッカー + 時刻スライダー + 再生/一時停止/倍速。スライダー操作・再生でバスが shape 上を連続的に移動する
- データ更新: 日次の Cron Trigger で自動更新(更新があったフィードのみ再変換)
- 変換実装: TypeScript。実測で Worker の CPU 制限に当たった場合のみ変換コアを Rust wasm 化する
- IaC: アカウントレベルリソースは Terraform、Worker 設定は wrangler.jsonc、CI/CD は GitHub Actions
- 社内標準準拠: pnpm(minimumReleaseAge: 10080)、SvelteKit SSR、MapLibre GL JS、GitHub Actions + Environment secrets

## アーキテクチャ

```
gtfs-data.jp API v2
      │ (日次 Cron)
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

日次 Cron(JST早朝)で以下を実行する。

1. `GET https://api.gtfs-data.jp/v2/files?pref=群馬県` でフィード一覧を取得
2. 各フィードの更新日時を R2 上のメタデータと比較し、更新分のみ処理
3. フィードごとに逐次処理: zip 取得 → 展開(fflate) → CSV パース(stops / trips / stop_times / shapes / calendar / calendar_dates) → 変換 → R2 書き込み

### 空間解析(停留所のshape射影)

`stop_times.shape_dist_traveled` が提供されないフィードでは、各停留所座標をトリップの shape ポリラインへ射影し、路線上の累積距離を求める。

- shape 頂点間の距離は haversine で累積距離配列(`cumDist`)を構築
- 停留所の射影は**単調増加制約付き**: 直前の停留所の射影位置より先の区間のみを探索する。単純な最近傍だと折り返し・ループ路線で誤マッチするため
- 各トリップは `(経過秒, 累積距離)` のキーフレーム列に変換される

## R2 データ形式

```
feeds.json                     # フィード一覧・更新日時・処理ステータス
{feedId}/stops.geojson         # バス停(表示用)
{feedId}/routes.geojson        # 路線ライン(表示用)
{feedId}/bundle.json           # 運行データ本体
```

`bundle.json`:

```jsonc
{
  "calendar": { /* service_id → 曜日パターン + calendar_dates 例外 */ },
  "shapes":   { "shp1": { "coords": [[lng, lat], ...], "cumDist": [0, 120.5, ...] } },
  "trips":    [ { "tripId": "...", "routeId": "...", "shapeId": "shp1",
                  "serviceId": "...", "keyframes": [[21600, 0], [21780, 1240.2], ...] } ]
}
```

クライアントは日付から有効な `service_id` を判定し、時刻 t ごとに各トリップのキーフレームを二分探索 → 距離を線形補間 → shape 上の座標へ変換する。群馬県全フィードで合計数MB(brotli圧縮後はさらに小)の見込み。フィード単位で遅延ロードする。

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
