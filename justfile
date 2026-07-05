# ローカル開発用タスクランナー (https://just.systems)
# 前提: Node 22+ / pnpm 10 / just

pipeline_port := "8787"

# レシピ一覧を表示
default:
    @just --list --unsorted

# 依存関係をインストール
setup:
    pnpm install

# パイプラインWorkerをローカル起動(ローカルR2に永続化)
pipeline:
    pnpm --filter pipeline dev

# 起動中のパイプラインWorkerのCronを実行し、ローカルR2にGTFSデータを投入(初回のみ)
seed:
    @curl -fsS "http://localhost:{{pipeline_port}}/__scheduled?cron=0+20+L+*+*" \
        || { echo "エラー: パイプラインWorkerに接続できません。別ターミナルで 'just pipeline' を起動してから再実行してください。" >&2; exit 1; }

# フロントエンド開発サーバーを起動(要: seed済みのローカルR2データ)
dev:
    pnpm --filter app dev

# 全パッケージのテストを実行
test:
    pnpm -r run test

# 全パッケージの型チェック
check:
    pnpm -r run check

# ESLintを実行
lint:
    pnpm lint

# Prettierでフォーマット
format:
    pnpm format

# アプリをプロダクションビルド
build:
    pnpm --filter app build

# CIと同じチェックを一括実行
ci:
    pnpm install --frozen-lockfile
    pnpm format:check
    pnpm lint
    pnpm --filter app run prepare
    pnpm -r run check
    pnpm -r run test
    pnpm --filter app build
