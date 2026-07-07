# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## ルール

- **日本語でコミュニケーションする**: 応答・説明・ドキュメント・コミットメッセージ・コードコメントはすべて日本語で書く。コミットメッセージは Conventional Commits の形式を維持し、type(`feat:` / `docs:` / `chore:` など)は英語のまま、説明文を日本語にする(例: `feat(gtfs-core): 停留所のshape射影を追加`)。
- **A Philosophy of Software Design に基づいて設計する**:
  - **shallow module を避ける**: モジュール・関数は「小さなインターフェースの裏に複雑さを隠す」deep なものにする。委譲するだけの関数、薄いラッパー層、1 か所でしか使わない抽象を追加しない。分割そのものを目的にしない。
  - **公開インターフェースを無闇に増やさない**: export・コンポーネント props・設定オプションは、実際に外部から使われるものだけを公開する。「念のため」の公開はしない。

パッケージマネージャは pnpm。現時点でコードは `app/` のみ(`app/` で実行):

- `pnpm dev` — 開発サーバ起動
- `pnpm build` / `pnpm preview` — 本番ビルド / プレビュー
- `pnpm check` — svelte-check による型チェック(`pnpm check:watch` で監視)

テスト・lint は未整備。導入する際は実装計画(下記)の定義に従う: Vitest は `pnpm --filter gtfs-core test`(単一ファイルは `pnpm --filter gtfs-core exec vitest run src/xxx.test.ts`)、ESLint(flat config)+ Prettier はルートに置く。

## アーキテクチャ

**目的**: 群馬県の GTFS フィードを月次で取得・変換し、指定日時のバス推定位置を地図上でアニメーション表示する WebGIS。位置は時刻表ベースのシミュレーション(GTFS-RT のリアルタイム位置は扱わない)。ホスティングは Cloudflare に完結。

**データフロー**:

```
gtfs-data.jp API v2 →(月次 Cron)pipeline Worker が変換 → R2
    → app Worker(SvelteKit SSR)が R2 バインディングで配信
    → ブラウザが二分探索 + 線形補間で任意時刻の位置を描画
```

**モノレポ構成**(pnpm workspace 化を計画中。現状は `app/` の雛形のみ):

- `app/` — SvelteKit フロントエンド
- `pipeline/` — 月次 Cron の変換 Worker(未作成)
- `packages/gtfs-core/` — 共有ロジック: CSV パース、shape 射影、キーフレーム生成、補間、カレンダー判定(未作成)
