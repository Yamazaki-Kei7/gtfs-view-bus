# GTFSバス位置可視化WebGIS 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 群馬県のGTFSフィードを月次で取得・変換し、指定日時のバス推定位置を地図上でアニメーション表示するWebGISをCloudflare上に構築する。

**Architecture:** pipeline Worker(月次Cron)が gtfs-data.jp API v2 からフィードを取得し、停留所をshapeに射影して「(経過秒, 累積距離)キーフレーム列」に変換してR2へ書き込む。app(SvelteKit, Workers SSR)がR2バインディング経由でデータを配信し、クライアントが二分探索+線形補間で任意時刻の位置を描画する。共有ロジックは `packages/gtfs-core` に置く。

**Tech Stack:** pnpm workspace / TypeScript / SvelteKit(Svelte 5 runes, adapter-cloudflare) / svelte-maplibre-gl v2 + MapLibre GL JS / fflate / Cloudflare Workers + R2 / Vitest / Terraform(cloudflare provider) / GitHub Actions

**設計書:** `docs/superpowers/specs/2026-07-05-gtfs-bus-position-webgis-design.md`

**事前調査で確定した事実(2026-07-05時点):**

- フィード一覧API: `GET https://api.gtfs-data.jp/v2/files?pref=10`(10=群馬県、`pref` は数値ID。日本語名を渡すと500)
- 群馬県は現在3フィード: annakacity/annakashi-rosenbus、gunma-otacity/ootacitybus、oizumitown/kouikikoukyoubasuaozora
- 一覧レスポンス: `{ code, message, body: [...] }`。各エントリの主要フィールド: `organization_id`, `organization_name`, `feed_id`, `feed_name`, `feed_license_id`, `file_uid`, `file_from_date`, `file_to_date`, `file_url`(zip), `file_stop_url`(stops.geojson), `file_route_url`(routes.geojson), `file_last_updated_at`
- **リポジトリが stops.geojson / routes.geojson を提供している**ため、表示用GeoJSONは自前生成せずコピーする(設計書の「pipeline が生成」をこの形で満たす)
- フィードzipは 12〜128KB と極小(3フィード合計約170KB)。`file_url` は**リダイレクトを返す**ためfetch時は追従が必要(Workers の fetch は既定で追従する)
- **太田市・大泉町のフィードには shapes.txt が無い**(安中市のみあり)。一方 routes.geojson は道路形状を持つ(例: 太田市尾島線は MultiLineString で計320頂点、`properties.id` = route_id、`properties.route_name` あり)。よって shapes.txt が無い trip は routes.geojson の形状にマッチングする(下記)
- svelte-maplibre-gl v2 は `MapLibre` / `GeoJSONSource`(propsは `GeoJSONSourceSpecification` 準拠で `data` を持つ) / `CircleLayer` / `LineLayer` / `RasterTileSource` / `RasterLayer` / `Popup`(`lnglat` prop)をエクスポート。maplibre-gl は peerDependency で**未インストール**
- app の雛形は `svelte.config.js` を持たず、`vite.config.ts` の `sveltekit({ adapter })` でアダプタを設定するスタイル

**実装上の設計判断(設計書からの具体化):**

- `shape_dist_traveled` は使わず**常に自前射影**する(単位系の揺れを排除し、コードパスを1本化)
- **形状の解決優先順位(tripごと)**: ①shapes.txt → ②routes.geojson の形状マッチング(各パーツ・全パーツ連結・それぞれの逆順を候補とし、停留所の単調射影で最大射影誤差が150m以内の最良候補を採用) → ③停留所座標の直線ポリライン(最終フォールバック)。ソース内訳を `bundle.shapeSourceCounts` と feeds.json に記録する
- 出力サイズ規律: 座標は小数6桁、距離は0.1m単位に丸める(設計書「データ形式の選定理由」参照)
- 24時超の便(例: 25:10発)に対応するため、時刻スケールは 0〜28時(100800秒)。前日運行便の深夜帯表示は `timeSec + 86400` で前日カレンダーも判定する
- R2キー: `feeds.json` / `feeds/{org}~{feed}~{fromDate}/bundle.json|stops.geojson|routes.geojson|meta.json`
- Cron: `0 20 L * *`(毎月末日20:00 UTC = 翌月1日 05:00 JST。CloudflareはL記法対応。デプロイ時にエラーになる場合は `0 0 1 * *`=1日9:00 JSTに変更)

---

## Task 1: モノレポ再編(ルートworkspace化)

**Files:**
- Create: `pnpm-workspace.yaml`(ルート)
- Create: `package.json`(ルート)
- Create: `.prettierrc`, `.prettierignore`
- Create: `eslint.config.js`(ルート、全パッケージ共通)
- Delete: `app/pnpm-workspace.yaml`(内容はルートへ移動)
- Modify: `.gitignore`

- [ ] **Step 1: ルート pnpm-workspace.yaml を作成**(appの `onlyBuiltDependencies` を引き継ぎ、社内標準の検疫期間を設定)

```yaml
packages:
  - app
  - pipeline
  - packages/*

onlyBuiltDependencies:
  - esbuild
  - workerd

minimumReleaseAge: 10080
```

- [ ] **Step 2: app/pnpm-workspace.yaml を削除**

```bash
rm app/pnpm-workspace.yaml
```

- [ ] **Step 3: ルート package.json を作成**

```json
{
	"name": "gtfs-view-bus",
	"private": true,
	"type": "module",
	"scripts": {
		"test": "pnpm -r run test",
		"check": "pnpm -r run check",
		"lint": "eslint .",
		"format": "prettier --write .",
		"format:check": "prettier --check ."
	}
}
```

- [ ] **Step 4: prettier と eslint をルートに追加**

```bash
pnpm add -w -D prettier prettier-plugin-svelte
pnpm add -w -D eslint @eslint/js typescript-eslint eslint-plugin-svelte eslint-config-prettier globals
```

注意: `minimumReleaseAge` により公開7日未満のバージョンは解決されない。もし `ERR_PNPM_NO_MATCHING_VERSION` が出たら、それは正常動作(少し古いバージョンが入る)。

- [ ] **Step 5: .prettierrc と .prettierignore を作成**

`.prettierrc`:

```json
{
	"useTabs": true,
	"singleQuote": true,
	"printWidth": 100,
	"plugins": ["prettier-plugin-svelte"],
	"overrides": [{ "files": "*.svelte", "options": { "parser": "svelte" } }]
}
```

`.prettierignore`:

```
node_modules
.svelte-kit
dist
.wrangler
pnpm-lock.yaml
docs
```

- [ ] **Step 5b: eslint.config.js を作成**(flat config。TS + Svelte 全体に適用)

`eslint.config.js`:

```js
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
		},
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: { parser: ts.parser },
		},
	},
	{
		rules: {
			// プロジェクト規約: any / unknown を使わない
			'@typescript-eslint/no-explicit-any': 'error',
		},
	},
	{
		ignores: [
			'**/node_modules/',
			'**/.svelte-kit/',
			'**/dist/',
			'**/.wrangler/',
			'docs/',
			'infra/',
		],
	},
);
```

(`eslint-plugin-svelte` v3 は flat config が既定。v2 が入った場合は `svelte.configs['flat/recommended']` / `svelte.configs['flat/prettier']` に読み替える)

- [ ] **Step 6: .gitignore に追記**

既存 `.gitignore` の末尾に追加:

```
.wrangler/
.dev.vars
*.tfstate
*.tfstate.backup
.terraform/
```

- [ ] **Step 7: インストールと動作確認**

```bash
pnpm install
pnpm format
pnpm format:check
pnpm lint
```

Expected: `pnpm install` がルートで成功し、`pnpm format:check` と `pnpm lint` が exit 0。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: restructure as pnpm workspace monorepo"
```

---

## Task 2: gtfs-core パッケージ雛形 + CSVパーサ

**Files:**
- Create: `packages/gtfs-core/package.json`
- Create: `packages/gtfs-core/tsconfig.json`
- Create: `packages/gtfs-core/vitest.config.ts`
- Create: `packages/gtfs-core/src/index.ts`
- Create: `packages/gtfs-core/src/csv.ts`
- Test: `packages/gtfs-core/src/csv.test.ts`

- [ ] **Step 1: パッケージ雛形を作成**

`packages/gtfs-core/package.json`:

```json
{
	"name": "gtfs-core",
	"private": true,
	"version": "0.0.1",
	"type": "module",
	"exports": { ".": "./src/index.ts" },
	"scripts": {
		"test": "vitest run",
		"check": "tsc --noEmit"
	}
}
```

依存はバージョンを直書きせず pnpm に解決させる:

```bash
pnpm --filter gtfs-core add fflate
pnpm --filter gtfs-core add -D typescript vitest
```

`packages/gtfs-core/tsconfig.json`:

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"strict": true,
		"noUncheckedIndexedAccess": false,
		"skipLibCheck": true,
		"noEmit": true
	},
	"include": ["src"]
}
```

`packages/gtfs-core/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: { include: ['src/**/*.test.ts'] },
});
```

`packages/gtfs-core/src/index.ts`(この時点では空に近い。以降のタスクでexportを追加していく):

```ts
export * from './csv';
```

- [ ] **Step 2: CSVパーサの失敗するテストを書く**

`packages/gtfs-core/src/csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv', () => {
	it('ヘッダ行をキーにしたオブジェクト配列を返す', () => {
		const rows = parseCsv('stop_id,stop_name\nA,駅前\nB,中央\n');
		expect(rows).toEqual([
			{ stop_id: 'A', stop_name: '駅前' },
			{ stop_id: 'B', stop_name: '中央' },
		]);
	});

	it('ダブルクォート・カンマ・改行入りフィールドを扱える', () => {
		const rows = parseCsv('id,name\n1,"a,b"\n2,"say ""hi"""\n3,"line1\nline2"\n');
		expect(rows[0].name).toBe('a,b');
		expect(rows[1].name).toBe('say "hi"');
		expect(rows[2].name).toBe('line1\nline2');
	});

	it('BOM・CRLF・末尾改行なしを扱える', () => {
		const rows = parseCsv('﻿id,name\r\n1,x\r\n2,y');
		expect(rows).toEqual([
			{ id: '1', name: 'x' },
			{ id: '2', name: 'y' },
		]);
	});

	it('欠けた列は空文字になる', () => {
		const rows = parseCsv('a,b,c\n1,2\n');
		expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
	});

	it('空文字列は空配列を返す', () => {
		expect(parseCsv('')).toEqual([]);
	});
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core test`
Expected: FAIL(`./csv` が存在しない)

- [ ] **Step 4: CSVパーサを実装**

`packages/gtfs-core/src/csv.ts`:

```ts
function parseCsvRows(text: string): string[][] {
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inQuotes) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			row.push(field);
			field = '';
		} else if (ch === '\n') {
			row.push(field);
			field = '';
			rows.push(row);
			row = [];
		} else if (ch !== '\r') {
			field += ch;
		}
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

export function parseCsv(text: string): Record<string, string>[] {
	const rows = parseCsvRows(text);
	if (rows.length === 0) return [];
	const header = rows[0].map((h) => h.trim());
	return rows.slice(1).map((r) => {
		const obj: Record<string, string> = {};
		header.forEach((h, i) => {
			obj[h] = r[i] ?? '';
		});
		return obj;
	});
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm --filter gtfs-core test`
Expected: PASS(5 tests)

Run: `pnpm --filter gtfs-core check`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add packages/gtfs-core pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(gtfs-core): add package scaffold and RFC4180 CSV parser"
```

---

## Task 3: 型定義・距離計算・GTFS時刻パース

**Files:**
- Create: `packages/gtfs-core/src/types.ts`
- Create: `packages/gtfs-core/src/geo.ts`
- Create: `packages/gtfs-core/src/time.ts`
- Modify: `packages/gtfs-core/src/index.ts`
- Test: `packages/gtfs-core/src/geo.test.ts`, `packages/gtfs-core/src/time.test.ts`

- [ ] **Step 1: 型定義を作成**

`packages/gtfs-core/src/types.ts`:

```ts
export type LngLat = [number, number];

export interface ShapeData {
	coords: LngLat[];
	/** 各頂点までの累積距離(メートル)。coords と同じ長さ */
	cumDist: number[];
}

export interface TripData {
	tripId: string;
	routeId: string;
	serviceId: string;
	shapeId: string;
	/** [経過秒(当日0時起点、24時超あり), 累積距離(m)] の列。時刻昇順 */
	keyframes: [number, number][];
}

export interface RouteData {
	shortName: string;
	longName: string;
	color: string | null;
}

export interface ServicePattern {
	/** 月〜日の7要素 */
	days: boolean[];
	/** YYYYMMDD */
	startDate: string;
	endDate: string;
}

export interface CalendarData {
	services: Record<string, ServicePattern>;
	/** date(YYYYMMDD) -> service_id -> exception_type(1=追加, 2=削除) */
	exceptions: Record<string, Record<string, number>>;
}

/** trip の形状の由来: shapes.txt / routes.geojson マッチング / 停留所直線フォールバック */
export type ShapeSource = 'shapes' | 'route' | 'straight';

export interface FeedBundle {
	calendar: CalendarData;
	routes: Record<string, RouteData>;
	shapes: Record<string, ShapeData>;
	trips: TripData[];
	shapeSourceCounts: Record<ShapeSource, number>;
}
```

- [ ] **Step 2: geo と time の失敗するテストを書く**

`packages/gtfs-core/src/geo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cumulativeDistances, haversineMeters } from './geo';

describe('haversineMeters', () => {
	it('経度0.01度(緯度36度)は約900mになる', () => {
		const d = haversineMeters([139.0, 36.0], [139.01, 36.0]);
		expect(d).toBeGreaterThan(880);
		expect(d).toBeLessThan(920);
	});

	it('同一点は0', () => {
		expect(haversineMeters([139.0, 36.0], [139.0, 36.0])).toBe(0);
	});
});

describe('cumulativeDistances', () => {
	it('累積距離の配列を返す(先頭は0、単調非減少)', () => {
		const cum = cumulativeDistances([
			[139.0, 36.0],
			[139.01, 36.0],
			[139.01, 36.01],
		]);
		expect(cum.length).toBe(3);
		expect(cum[0]).toBe(0);
		expect(cum[1]).toBeCloseTo(haversineMeters([139.0, 36.0], [139.01, 36.0]), 6);
		expect(cum[2]).toBeGreaterThan(cum[1]);
	});
});
```

`packages/gtfs-core/src/time.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseGtfsTime } from './time';

describe('parseGtfsTime', () => {
	it('HH:MM:SS を秒に変換する', () => {
		expect(parseGtfsTime('08:10:30')).toBe(8 * 3600 + 10 * 60 + 30);
	});

	it('24時超をそのまま扱う', () => {
		expect(parseGtfsTime('25:10:00')).toBe(25 * 3600 + 10 * 60);
	});

	it('先頭ゼロなし(8:05:00)を扱う', () => {
		expect(parseGtfsTime('8:05:00')).toBe(8 * 3600 + 5 * 60);
	});

	it('空文字や不正値は null', () => {
		expect(parseGtfsTime('')).toBeNull();
		expect(parseGtfsTime('abc')).toBeNull();
	});
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core test`
Expected: FAIL(`./geo`, `./time` が存在しない)

- [ ] **Step 4: geo.ts と time.ts を実装**

`packages/gtfs-core/src/geo.ts`:

```ts
import type { LngLat } from './types';

export const EARTH_RADIUS_M = 6371008.8;
export const DEG = Math.PI / 180;

export function haversineMeters(a: LngLat, b: LngLat): number {
	const dLat = (b[1] - a[1]) * DEG;
	const dLng = (b[0] - a[0]) * DEG;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

export function cumulativeDistances(coords: LngLat[]): number[] {
	const cum: number[] = [0];
	for (let i = 1; i < coords.length; i++) {
		cum.push(cum[i - 1] + haversineMeters(coords[i - 1], coords[i]));
	}
	return cum;
}
```

`packages/gtfs-core/src/time.ts`:

```ts
export function parseGtfsTime(value: string): number | null {
	const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value.trim());
	if (!m) return null;
	return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
```

`packages/gtfs-core/src/index.ts` を更新:

```ts
export * from './csv';
export * from './types';
export * from './geo';
export * from './time';
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm --filter gtfs-core test` → PASS
Run: `pnpm --filter gtfs-core check` → exit 0

- [ ] **Step 6: Commit**

```bash
git add packages/gtfs-core
git commit -m "feat(gtfs-core): add types, haversine distance, and GTFS time parsing"
```

---

## Task 4: 停留所のshape射影(単調増加制約付き)

**Files:**
- Create: `packages/gtfs-core/src/projection.ts`
- Modify: `packages/gtfs-core/src/index.ts`
- Test: `packages/gtfs-core/src/projection.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/gtfs-core/src/projection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cumulativeDistances } from './geo';
import { projectStopsToShape } from './projection';
import type { LngLat, ShapeData } from './types';

function makeShape(coords: LngLat[]): ShapeData {
	return { coords, cumDist: cumulativeDistances(coords) };
}

describe('projectStopsToShape', () => {
	it('L字型shape上の停留所を累積距離に変換する', () => {
		// 東へ約900m、その後北へ約1113m のL字
		const shape = makeShape([
			[139.0, 36.0],
			[139.01, 36.0],
			[139.01, 36.01],
		]);
		const stops: LngLat[] = [
			[139.0, 36.0], // 起点
			[139.005, 36.0001], // 第1セグメント中間(少し北にずれた位置)
			[139.01, 36.01], // 終点
		];
		const dists = projectStopsToShape(shape, stops);
		expect(dists[0]).toBeCloseTo(0, 0);
		expect(dists[1]).toBeGreaterThan(shape.cumDist[1] * 0.4);
		expect(dists[1]).toBeLessThan(shape.cumDist[1] * 0.6);
		expect(dists[2]).toBeCloseTo(shape.cumDist[2], 0);
	});

	it('折り返し路線では単調増加制約により復路側に射影される', () => {
		// 東へ約1113m 進んで同じ道を戻る(赤道上で計算しやすく)
		const shape = makeShape([
			[0.0, 0.0],
			[0.01, 0.0],
			[0.0, 0.0],
		]);
		const total = shape.cumDist[2];
		const stops: LngLat[] = [
			[0.006, 0.0], // 往路
			[0.004, 0.0], // 単純最近傍なら往路445m地点だが、復路でなければならない
		];
		const dists = projectStopsToShape(shape, stops);
		expect(dists[0]).toBeCloseTo(total * 0.3, -1); // 668m 付近
		expect(dists[1]).toBeGreaterThan(shape.cumDist[1]); // 折り返し点より先
		expect(dists[1]).toBeGreaterThan(dists[0]);
	});

	it('結果は常に単調非減少', () => {
		const shape = makeShape([
			[139.0, 36.0],
			[139.01, 36.0],
		]);
		// 2番目の停留所が1番目より手前にあるデータ不備でも逆行しない
		const dists = projectStopsToShape(shape, [
			[139.006, 36.0],
			[139.004, 36.0],
		]);
		expect(dists[1]).toBeGreaterThanOrEqual(dists[0]);
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core test`
Expected: FAIL(`./projection` が存在しない)

- [ ] **Step 3: 射影を実装**

`packages/gtfs-core/src/projection.ts`:

```ts
import { DEG, EARTH_RADIUS_M } from './geo';
import type { LngLat, ShapeData } from './types';

/** 短距離用の局所平面近似(equirectangular) */
function toXY(p: LngLat, cosLat: number): [number, number] {
	return [p[0] * DEG * EARTH_RADIUS_M * cosLat, p[1] * DEG * EARTH_RADIUS_M];
}

interface Projection {
	dist: number;
	segment: number;
	/** 見つかったセグメント内のオフセット(0〜1) */
	t: number;
}

/**
 * 点をポリラインへ射影する。minSegment より前のセグメントは探索せず、
 * minSegment 自体では t >= minT に制限する(=直前の射影位置より後ろへ戻らない)。
 */
export function projectPointToPolyline(
	coords: LngLat[],
	cumDist: number[],
	point: LngLat,
	minSegment = 0,
	minT = 0,
): Projection {
	const cosLat = Math.cos(point[1] * DEG);
	const p = toXY(point, cosLat);
	let bestDist = cumDist[cumDist.length - 1];
	let bestSegment = Math.max(coords.length - 2, 0);
	let bestT = 1;
	let bestD2 = Infinity;
	for (let i = Math.max(0, minSegment); i < coords.length - 1; i++) {
		const a = toXY(coords[i], cosLat);
		const b = toXY(coords[i + 1], cosLat);
		const abx = b[0] - a[0];
		const aby = b[1] - a[1];
		const len2 = abx * abx + aby * aby;
		const tLo = i === minSegment ? minT : 0;
		const raw = len2 === 0 ? 0 : ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
		const t = Math.max(tLo, Math.min(1, raw));
		const qx = a[0] + t * abx;
		const qy = a[1] + t * aby;
		const dx = p[0] - qx;
		const dy = p[1] - qy;
		const d2 = dx * dx + dy * dy;
		if (d2 < bestD2) {
			bestD2 = d2;
			bestSegment = i;
			bestT = t;
			bestDist = cumDist[i] + (cumDist[i + 1] - cumDist[i]) * t;
		}
	}
	return { dist: bestDist, segment: bestSegment, t: bestT };
}

/**
 * 各停留所をshapeポリラインへ射影し、累積距離(m)の列を返す。
 * 直前の停留所の射影位置(セグメント番号+セグメント内オフセット)より
 * 手前には戻らない単調増加制約付き。折り返し・ループ路線での誤マッチを防ぐ。
 */
export function projectStopsToShape(shape: ShapeData, stops: LngLat[]): number[] {
	const result: number[] = [];
	let segment = 0;
	let t = 0;
	let prev = 0;
	for (const stop of stops) {
		const r = projectPointToPolyline(shape.coords, shape.cumDist, stop, segment, t);
		const d = Math.max(r.dist, prev);
		result.push(d);
		segment = r.segment;
		t = r.t;
		prev = d;
	}
	return result;
}
```

`packages/gtfs-core/src/index.ts` に追記:

```ts
export * from './projection';
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter gtfs-core test` → PASS
Run: `pnpm --filter gtfs-core check` → exit 0

- [ ] **Step 5: Commit**

```bash
git add packages/gtfs-core
git commit -m "feat(gtfs-core): add monotonic stop-to-shape projection"
```

---

## Task 5: 運行カレンダー判定

**Files:**
- Create: `packages/gtfs-core/src/calendar.ts`
- Modify: `packages/gtfs-core/src/index.ts`
- Test: `packages/gtfs-core/src/calendar.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/gtfs-core/src/calendar.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addDays, buildCalendar, dayOfWeek, isServiceActive } from './calendar';

const cal = buildCalendar(
	[
		{
			service_id: 'WD',
			monday: '1',
			tuesday: '1',
			wednesday: '1',
			thursday: '1',
			friday: '1',
			saturday: '0',
			sunday: '0',
			start_date: '20260401',
			end_date: '20270331',
		},
	],
	[
		{ date: '20260713', service_id: 'WD', exception_type: '2' },
		{ date: '20260712', service_id: 'WD', exception_type: '1' },
	],
);

describe('dayOfWeek', () => {
	it('月曜=0、日曜=6', () => {
		expect(dayOfWeek('20260706')).toBe(0); // 2026-07-06 は月曜
		expect(dayOfWeek('20260705')).toBe(6); // 2026-07-05 は日曜
	});
});

describe('isServiceActive', () => {
	it('平日は運行、土日は運休', () => {
		expect(isServiceActive(cal, 'WD', '20260706')).toBe(true);
		expect(isServiceActive(cal, 'WD', '20260711')).toBe(false);
	});

	it('calendar_dates の削除(2)・追加(1)が優先される', () => {
		expect(isServiceActive(cal, 'WD', '20260713')).toBe(false); // 月曜だが削除
		expect(isServiceActive(cal, 'WD', '20260712')).toBe(true); // 日曜だが追加
	});

	it('有効期間外は運休', () => {
		expect(isServiceActive(cal, 'WD', '20260330')).toBe(false);
		expect(isServiceActive(cal, 'WD', '20270405')).toBe(false);
	});

	it('未知の service_id は運休', () => {
		expect(isServiceActive(cal, 'XX', '20260706')).toBe(false);
	});
});

describe('addDays', () => {
	it('月跨ぎ・年跨ぎを扱える', () => {
		expect(addDays('20260701', -1)).toBe('20260630');
		expect(addDays('20260101', -1)).toBe('20251231');
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core test`
Expected: FAIL(`./calendar` が存在しない)

- [ ] **Step 3: calendar.ts を実装**

`packages/gtfs-core/src/calendar.ts`:

```ts
import type { CalendarData, ServicePattern } from './types';

const DAY_COLUMNS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function buildCalendar(
	calendarRows: Record<string, string>[],
	calendarDateRows: Record<string, string>[],
): CalendarData {
	const services: Record<string, ServicePattern> = {};
	for (const row of calendarRows) {
		services[row.service_id] = {
			days: DAY_COLUMNS.map((c) => row[c] === '1'),
			startDate: row.start_date,
			endDate: row.end_date,
		};
	}
	const exceptions: CalendarData['exceptions'] = {};
	for (const row of calendarDateRows) {
		(exceptions[row.date] ??= {})[row.service_id] = Number(row.exception_type);
	}
	return { services, exceptions };
}

/** date: YYYYMMDD。月曜=0 … 日曜=6 */
export function dayOfWeek(date: string): number {
	const y = Number(date.slice(0, 4));
	const m = Number(date.slice(4, 6));
	const d = Number(date.slice(6, 8));
	return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function addDays(date: string, delta: number): string {
	const y = Number(date.slice(0, 4));
	const m = Number(date.slice(4, 6));
	const d = Number(date.slice(6, 8));
	const dt = new Date(Date.UTC(y, m - 1, d + delta));
	const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(dt.getUTCDate()).padStart(2, '0');
	return `${dt.getUTCFullYear()}${mm}${dd}`;
}

export function isServiceActive(cal: CalendarData, serviceId: string, date: string): boolean {
	const exception = cal.exceptions[date]?.[serviceId];
	if (exception === 2) return false;
	if (exception === 1) return true;
	const svc = cal.services[serviceId];
	if (!svc) return false;
	if (date < svc.startDate || date > svc.endDate) return false;
	return svc.days[dayOfWeek(date)];
}
```

`packages/gtfs-core/src/index.ts` に追記:

```ts
export * from './calendar';
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter gtfs-core test` → PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gtfs-core
git commit -m "feat(gtfs-core): add service calendar evaluation"
```

---

## Task 6: キーフレーム生成と時刻補間

**Files:**
- Create: `packages/gtfs-core/src/keyframes.ts`
- Create: `packages/gtfs-core/src/interpolate.ts`
- Modify: `packages/gtfs-core/src/index.ts`
- Test: `packages/gtfs-core/src/keyframes.test.ts`, `packages/gtfs-core/src/interpolate.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/gtfs-core/src/keyframes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildKeyframes } from './keyframes';

describe('buildKeyframes', () => {
	it('停車(到着≠発車)は2キーフレームになる', () => {
		const kf = buildKeyframes(
			[
				{ arrival: 28800, departure: 28800 }, // 08:00
				{ arrival: 29400, departure: 29460 }, // 08:10 着 08:11 発
				{ arrival: 30600, departure: 30600 }, // 08:30
			],
			[0, 450, 2000],
		);
		expect(kf).toEqual([
			[28800, 0],
			[29400, 450],
			[29460, 450],
			[30600, 2000],
		]);
	});

	it('時刻欠損の停留所はスキップされる', () => {
		const kf = buildKeyframes(
			[
				{ arrival: 100, departure: 100 },
				{ arrival: null, departure: null },
				{ arrival: 300, departure: 300 },
			],
			[0, 50, 100],
		);
		expect(kf).toEqual([
			[100, 0],
			[300, 100],
		]);
	});

	it('時刻の逆行はクランプされ非減少になる', () => {
		const kf = buildKeyframes(
			[
				{ arrival: 200, departure: 200 },
				{ arrival: 150, departure: 150 },
			],
			[0, 100],
		);
		expect(kf[1][0]).toBeGreaterThanOrEqual(kf[0][0]);
	});
});
```

`packages/gtfs-core/src/interpolate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cumulativeDistances } from './geo';
import { distanceAtTime, pointAtDistance } from './interpolate';
import type { ShapeData } from './types';

describe('distanceAtTime', () => {
	const kf: [number, number][] = [
		[28800, 0],
		[29400, 450],
		[30600, 2000],
	];

	it('キーフレーム間を線形補間する', () => {
		expect(distanceAtTime(kf, 28800)).toBe(0);
		expect(distanceAtTime(kf, 29100)).toBeCloseTo(225, 6); // 中間
		expect(distanceAtTime(kf, 30600)).toBe(2000);
	});

	it('運行時間外は null', () => {
		expect(distanceAtTime(kf, 28799)).toBeNull();
		expect(distanceAtTime(kf, 30601)).toBeNull();
	});

	it('キーフレームが2未満なら null', () => {
		expect(distanceAtTime([[100, 0]], 100)).toBeNull();
	});
});

describe('pointAtDistance', () => {
	const shape: ShapeData = (() => {
		const coords: [number, number][] = [
			[139.0, 36.0],
			[139.01, 36.0],
		];
		return { coords, cumDist: cumulativeDistances(coords) };
	})();

	it('距離0は始点、全長は終点', () => {
		expect(pointAtDistance(shape, 0)).toEqual([139.0, 36.0]);
		const end = pointAtDistance(shape, shape.cumDist[1]);
		expect(end[0]).toBeCloseTo(139.01, 8);
	});

	it('中間距離は線分上を補間する', () => {
		const mid = pointAtDistance(shape, shape.cumDist[1] / 2);
		expect(mid[0]).toBeCloseTo(139.005, 5);
		expect(mid[1]).toBeCloseTo(36.0, 8);
	});

	it('範囲外はクランプされる', () => {
		expect(pointAtDistance(shape, -10)).toEqual([139.0, 36.0]);
		expect(pointAtDistance(shape, 1e9)[0]).toBeCloseTo(139.01, 8);
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core test`
Expected: FAIL(モジュール未作成)

- [ ] **Step 3: 実装する**

`packages/gtfs-core/src/keyframes.ts`:

```ts
export interface StopTimePoint {
	arrival: number | null;
	departure: number | null;
}

/**
 * 停留所ごとの (到着秒, 発車秒) と累積距離から、[秒, 距離] キーフレーム列を作る。
 * 到着≠発車なら停車を表す2点を置く。時刻は非減少にクランプする。
 */
export function buildKeyframes(
	stopTimes: StopTimePoint[],
	distances: number[],
): [number, number][] {
	const kf: [number, number][] = [];
	let lastT = -Infinity;
	for (let i = 0; i < stopTimes.length; i++) {
		const st = stopTimes[i];
		const arrival = st.arrival ?? st.departure;
		const departure = st.departure ?? st.arrival;
		if (arrival === null || departure === null) continue;
		const a = Math.max(arrival, lastT);
		kf.push([a, distances[i]]);
		lastT = a;
		if (departure > a) {
			kf.push([departure, distances[i]]);
			lastT = departure;
		}
	}
	return kf;
}
```

`packages/gtfs-core/src/interpolate.ts`:

```ts
import type { LngLat, ShapeData } from './types';

/** 時刻 t(秒)における累積距離。運行時間外なら null */
export function distanceAtTime(keyframes: [number, number][], t: number): number | null {
	if (keyframes.length < 2) return null;
	const first = keyframes[0];
	const last = keyframes[keyframes.length - 1];
	if (t < first[0] || t > last[0]) return null;
	let lo = 0;
	let hi = keyframes.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (keyframes[mid][0] <= t) lo = mid;
		else hi = mid;
	}
	const [t0, d0] = keyframes[lo];
	const [t1, d1] = keyframes[hi];
	if (t1 === t0) return d0;
	return d0 + ((d1 - d0) * (t - t0)) / (t1 - t0);
}

/** 累積距離 d(m)に対応する shape 上の座標(範囲外はクランプ) */
export function pointAtDistance(shape: ShapeData, dist: number): LngLat {
	const { coords, cumDist } = shape;
	const total = cumDist[cumDist.length - 1];
	const d = Math.max(0, Math.min(dist, total));
	let lo = 0;
	let hi = cumDist.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (cumDist[mid] <= d) lo = mid;
		else hi = mid;
	}
	const span = cumDist[hi] - cumDist[lo];
	const t = span === 0 ? 0 : (d - cumDist[lo]) / span;
	return [
		coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
		coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t,
	];
}
```

`packages/gtfs-core/src/index.ts` に追記:

```ts
export * from './keyframes';
export * from './interpolate';
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter gtfs-core test` → PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gtfs-core
git commit -m "feat(gtfs-core): add keyframe generation and time-to-position interpolation"
```

---

## Task 6.5: routes.geojson 形状マッチング

shapes.txt が無いフィード(太田市・大泉町)向けに、リポジトリ提供の routes.geojson の道路形状へ停留所列をマッチングするモジュール。

**Files:**
- Create: `packages/gtfs-core/src/routeShapes.ts`
- Modify: `packages/gtfs-core/src/index.ts`
- Test: `packages/gtfs-core/src/routeShapes.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/gtfs-core/src/routeShapes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { matchStopsToRouteLines, parseRouteLines } from './routeShapes';
import type { LngLat } from './types';

/** 東西1113m(赤道上0.01度)の道路を0.001度刻みで表した密なポリライン */
const road: LngLat[] = Array.from({ length: 11 }, (_, i) => [i * 0.001, 0]);

describe('parseRouteLines', () => {
	it('LineString と MultiLineString を route_id ごとのパーツ配列にする', () => {
		const text = JSON.stringify({
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					properties: { id: '10', route_name: 'A線' },
					geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
				},
				{
					type: 'Feature',
					properties: { id: 20 },
					geometry: {
						type: 'MultiLineString',
						coordinates: [
							[[0, 0], [1, 0]],
							[[1, 0], [2, 0]],
						],
					},
				},
			],
		});
		const lines = parseRouteLines(text);
		expect(lines['10'].length).toBe(1);
		expect(lines['20'].length).toBe(2);
	});

	it('id なし・不正ジオメトリはスキップする', () => {
		const text = JSON.stringify({
			type: 'FeatureCollection',
			features: [
				{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
				{ type: 'Feature', properties: { id: '30' }, geometry: null },
			],
		});
		expect(Object.keys(parseRouteLines(text))).toEqual([]);
	});
});

describe('matchStopsToRouteLines', () => {
	it('道路沿いの停留所列は小さな誤差でマッチし距離が単調増加する', () => {
		// 道路から約11m(0.0001度)ずれた停留所
		const stops: LngLat[] = [
			[0.001, 0.0001],
			[0.005, -0.0001],
			[0.009, 0.0001],
		];
		const m = matchStopsToRouteLines([road], stops);
		expect(m).not.toBeNull();
		expect(m!.maxError).toBeLessThan(30);
		expect(m!.distances[0]).toBeLessThan(m!.distances[1]);
		expect(m!.distances[1]).toBeLessThan(m!.distances[2]);
	});

	it('逆順の停留所列(復路便)は逆向き候補にマッチする', () => {
		const stops: LngLat[] = [
			[0.009, 0.0001],
			[0.005, -0.0001],
			[0.001, 0.0001],
		];
		const m = matchStopsToRouteLines([road], stops);
		expect(m).not.toBeNull();
		expect(m!.maxError).toBeLessThan(30);
		// 逆向き候補上で距離は単調増加になる
		expect(m!.distances[0]).toBeLessThan(m!.distances[2]);
	});

	it('路線から大きく外れた停留所列は誤差が大きい(呼び出し側で棄却される)', () => {
		const stops: LngLat[] = [
			[0.001, 0.05], // 約5.5km 北
			[0.009, 0.05],
		];
		const m = matchStopsToRouteLines([road], stops);
		expect(m).not.toBeNull();
		expect(m!.maxError).toBeGreaterThan(1000);
	});

	it('パーツが分割されていても連結候補でマッチする', () => {
		const parts: LngLat[][] = [road.slice(0, 6), road.slice(5)];
		const stops: LngLat[] = [
			[0.001, 0.0001],
			[0.009, 0.0001],
		];
		const m = matchStopsToRouteLines(parts, stops);
		expect(m).not.toBeNull();
		expect(m!.maxError).toBeLessThan(30);
		expect(m!.distances[1]).toBeGreaterThan(m!.distances[0]);
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core test`
Expected: FAIL(`./routeShapes` が存在しない)

- [ ] **Step 3: routeShapes.ts を実装**

`packages/gtfs-core/src/routeShapes.ts`:

```ts
import { cumulativeDistances, haversineMeters } from './geo';
import { pointAtDistance } from './interpolate';
import { projectStopsToShape } from './projection';
import type { LngLat, ShapeData } from './types';

/** routes.geojson マッチングの許容最大射影誤差(m)。超えたら直線フォールバック */
export const MAX_ROUTE_SHAPE_ERROR_M = 150;

/** route_id → ラインパーツ(頂点列)の配列 */
export type RouteLines = Record<string, LngLat[][]>;

interface RouteFeature {
	properties: { id?: string | number } | null;
	geometry:
		| { type: 'LineString'; coordinates: LngLat[] }
		| { type: 'MultiLineString'; coordinates: LngLat[][] }
		| null;
}

interface RouteFeatureCollection {
	features: RouteFeature[];
}

export function parseRouteLines(geojsonText: string): RouteLines {
	const fc = JSON.parse(geojsonText) as RouteFeatureCollection;
	const lines: RouteLines = {};
	for (const f of fc.features ?? []) {
		const id = f.properties?.id;
		if (id === undefined || id === null || !f.geometry) continue;
		const parts =
			f.geometry.type === 'LineString'
				? [f.geometry.coordinates]
				: f.geometry.type === 'MultiLineString'
					? f.geometry.coordinates
					: [];
		const valid = parts.filter((p) => p.length >= 2);
		if (valid.length > 0) (lines[String(id)] ??= []).push(...valid);
	}
	return lines;
}

export interface ShapeMatch {
	/** 候補の識別子(shapeId の一部に使う): 'concat' | 'concat-r' | 'part0' | 'part0-r' | ... */
	key: string;
	shape: ShapeData;
	/** 各停留所の累積距離(単調非減少) */
	distances: number[];
	/** 停留所と射影位置の最大距離(m) */
	maxError: number;
}

/**
 * 停留所列を路線ラインへマッチングする。
 * 候補 = 全パーツ連結・各パーツ・それぞれの逆順。停留所を単調射影し、
 * 「停留所→射影位置」の最大距離が最小の候補を返す。
 * 採否判定(MAX_ROUTE_SHAPE_ERROR_M との比較)は呼び出し側が行う。
 */
export function matchStopsToRouteLines(parts: LngLat[][], stops: LngLat[]): ShapeMatch | null {
	if (parts.length === 0 || stops.length < 2) return null;
	const candidates: { key: string; coords: LngLat[] }[] = [];
	if (parts.length > 1) {
		const concat = ([] as LngLat[]).concat(...parts);
		candidates.push({ key: 'concat', coords: concat });
		candidates.push({ key: 'concat-r', coords: [...concat].reverse() });
	}
	parts.forEach((p, i) => {
		candidates.push({ key: `part${i}`, coords: p });
		candidates.push({ key: `part${i}-r`, coords: [...p].reverse() });
	});

	let best: ShapeMatch | null = null;
	for (const cand of candidates) {
		if (cand.coords.length < 2) continue;
		const shape: ShapeData = {
			coords: cand.coords,
			cumDist: cumulativeDistances(cand.coords),
		};
		const distances = projectStopsToShape(shape, stops);
		let maxError = 0;
		for (let i = 0; i < stops.length; i++) {
			const err = haversineMeters(stops[i], pointAtDistance(shape, distances[i]));
			if (err > maxError) maxError = err;
		}
		if (!best || maxError < best.maxError) {
			best = { key: cand.key, shape, distances, maxError };
		}
	}
	return best;
}
```

`packages/gtfs-core/src/index.ts` に追記:

```ts
export * from './routeShapes';
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter gtfs-core test` → PASS
Run: `pnpm --filter gtfs-core check` → exit 0

- [ ] **Step 5: Commit**

```bash
git add packages/gtfs-core
git commit -m "feat(gtfs-core): add stop-sequence matching against routes.geojson road geometry"
```

---

## Task 7: フィード変換(convert)とテストフィクスチャ

**Files:**
- Create: `packages/gtfs-core/src/fixture.ts`
- Create: `packages/gtfs-core/src/convert.ts`
- Modify: `packages/gtfs-core/src/index.ts`
- Test: `packages/gtfs-core/src/convert.test.ts`

- [ ] **Step 1: フィクスチャを作成**(pipelineのテストでも使うため src に置いて export する)

`packages/gtfs-core/src/fixture.ts`:

```ts
/** テスト用の極小GTFSフィード(L字路線1本・停留所3つ・平日運行・深夜便あり) */
export const FIXTURE_FILES: Record<string, string> = {
	'stops.txt': `stop_id,stop_name,stop_lat,stop_lon
A,駅前,36.0000,139.0000
B,中央,36.0001,139.0050
C,公園,36.0100,139.0100
`,
	'routes.txt': `route_id,route_short_name,route_long_name,route_color
R1,1,駅前線,FF0000
R2,2,循環線,0000FF
`,
	'trips.txt': `route_id,service_id,trip_id,shape_id
R1,WD,T1,S1
R1,WD,T2,
R2,WD,T3,
`,
	'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,08:00:00,08:00:00,A,1
T1,08:10:00,08:11:00,B,2
T1,08:30:00,08:30:00,C,3
T2,24:50:00,24:50:00,A,1
T2,25:00:00,25:00:00,B,2
T2,25:20:00,25:20:00,C,3
T3,09:00:00,09:00:00,A,1
T3,09:10:00,09:10:00,B,2
T3,09:30:00,09:30:00,C,3
`,
	'shapes.txt': `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
S1,36.0000,139.0000,1
S1,36.0000,139.0100,2
S1,36.0100,139.0100,3
`,
	'calendar.txt': `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WD,1,1,1,1,1,0,0,20260401,20270331
`,
	'calendar_dates.txt': `date,service_id,exception_type
20260713,WD,2
20260712,WD,1
`,
};

/** R2 の道路形状: L字を0.001度刻みで密にした頂点列(shapes.txt なしフィードの代替形状源) */
const r2RoadCoords: [number, number][] = [
	...Array.from({ length: 11 }, (_, i): [number, number] => [139.0 + i * 0.001, 36.0]),
	...Array.from({ length: 10 }, (_, i): [number, number] => [139.01, 36.001 + i * 0.001]),
];

/** リポジトリ提供の routes.geojson を模したフィクスチャ(properties.id = route_id) */
export const FIXTURE_ROUTES_GEOJSON = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			properties: { id: 'R2', route_name: '循環線' },
			geometry: { type: 'MultiLineString', coordinates: [r2RoadCoords] },
		},
	],
});
```

(T2 は shape_id 空かつ R1 が routes.geojson に無い → 直線フォールバックのテストを兼ねる。T3 は routes.geojson マッチングのテスト用)

- [ ] **Step 2: 失敗するテストを書く**

`packages/gtfs-core/src/convert.test.ts`:

```ts
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convertFeed, unzipFeed } from './convert';
import { FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON } from './fixture';

describe('convertFeed', () => {
	const bundle = convertFeed(FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON);

	it('routes を変換する', () => {
		expect(bundle.routes.R1).toEqual({ shortName: '1', longName: '駅前線', color: '#FF0000' });
	});

	it('shape_id ありの trip はそのshapeでキーフレーム化される', () => {
		const t1 = bundle.trips.find((t) => t.tripId === 'T1');
		expect(t1).toBeDefined();
		expect(t1?.shapeId).toBe('S1');
		// 08:00発 A(0m) → 08:10/08:11 B(停車で2点) → 08:30 C(終点)
		expect(t1?.keyframes.length).toBe(4);
		expect(t1?.keyframes[0][0]).toBe(8 * 3600);
		expect(t1?.keyframes[0][1]).toBeCloseTo(0, 0);
		const total = bundle.shapes.S1.cumDist.at(-1) ?? 0;
		expect(t1?.keyframes[3][1]).toBeCloseTo(total, 0);
	});

	it('shape も routes.geojson も無い trip は停留所座標の直線ポリラインになる', () => {
		// T2 の route R1 は FIXTURE_ROUTES_GEOJSON に存在しない
		const t2 = bundle.trips.find((t) => t.tripId === 'T2');
		expect(t2?.shapeId).toBe('trip:T2');
		expect(bundle.shapes['trip:T2'].coords.length).toBe(3);
	});

	it('shapes.txt が無い trip は routes.geojson の道路形状にマッチされる', () => {
		const t3 = bundle.trips.find((t) => t.tripId === 'T3');
		expect(t3?.shapeId.startsWith('route:R2:')).toBe(true);
		const shape = bundle.shapes[t3?.shapeId ?? ''];
		expect(shape.coords.length).toBeGreaterThan(10); // 停留所数(3)より密な道路頂点
		// キーフレーム距離は単調増加
		const dists = (t3?.keyframes ?? []).map((k) => k[1]);
		expect(dists[0]).toBeLessThan(dists[dists.length - 1]);
	});

	it('形状ソースの内訳が記録される', () => {
		expect(bundle.shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});

	it('座標は6桁・距離は0.1m単位に丸められる', () => {
		for (const shape of Object.values(bundle.shapes)) {
			for (const [lng, lat] of shape.coords) {
				expect(lng).toBeCloseTo(Math.round(lng * 1e6) / 1e6, 10);
				expect(lat).toBeCloseTo(Math.round(lat * 1e6) / 1e6, 10);
			}
			for (const d of shape.cumDist) {
				expect(d).toBeCloseTo(Math.round(d * 10) / 10, 10);
			}
		}
	});

	it('calendar が変換される', () => {
		expect(bundle.calendar.services.WD.days).toEqual([
			true, true, true, true, true, false, false,
		]);
		expect(bundle.calendar.exceptions['20260713'].WD).toBe(2);
	});
});

describe('unzipFeed', () => {
	it('zipバイト列(サブフォルダ入り)からtxtを取り出せる', () => {
		const zipped = zipSync({
			'feed/stops.txt': strToU8(FIXTURE_FILES['stops.txt']),
			'feed/trips.txt': strToU8(FIXTURE_FILES['trips.txt']),
		});
		const files = unzipFeed(zipped);
		expect(Object.keys(files).sort()).toEqual(['stops.txt', 'trips.txt']);
		expect(files['stops.txt']).toContain('駅前');
	});
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core test`
Expected: FAIL(`./convert` が存在しない)

- [ ] **Step 4: convert.ts を実装**

`packages/gtfs-core/src/convert.ts`:

```ts
import { unzipSync } from 'fflate';
import { buildCalendar } from './calendar';
import { parseCsv } from './csv';
import { cumulativeDistances } from './geo';
import { buildKeyframes } from './keyframes';
import { projectStopsToShape } from './projection';
import {
	MAX_ROUTE_SHAPE_ERROR_M,
	matchStopsToRouteLines,
	parseRouteLines,
	type ShapeMatch,
} from './routeShapes';
import { parseGtfsTime } from './time';
import type { FeedBundle, LngLat, RouteData, ShapeData, ShapeSource, TripData } from './types';

/** GTFS zip を展開し、ファイル名(basename)→テキスト のマップを返す */
export function unzipFeed(zip: Uint8Array): Record<string, string> {
	const entries = unzipSync(zip);
	const decoder = new TextDecoder('utf-8');
	const files: Record<string, string> = {};
	for (const [path, data] of Object.entries(entries)) {
		const base = path.split('/').pop() ?? path;
		if (base.endsWith('.txt')) files[base] = decoder.decode(data);
	}
	return files;
}

interface StopTimeRow {
	seq: number;
	stopId: string;
	arrival: number | null;
	departure: number | null;
}

function round6(v: number): number {
	return Math.round(v * 1e6) / 1e6;
}

function round1(v: number): number {
	return Math.round(v * 10) / 10;
}

function roundShape(shape: ShapeData): ShapeData {
	return {
		coords: shape.coords.map((c): LngLat => [round6(c[0]), round6(c[1])]),
		cumDist: shape.cumDist.map(round1),
	};
}

/**
 * @param routeGeojson リポジトリ提供の routes.geojson テキスト。
 *   shapes.txt を持たない trip の形状源として使う(任意)
 */
export function convertFeed(files: Record<string, string>, routeGeojson?: string): FeedBundle {
	const stopRows = parseCsv(files['stops.txt'] ?? '');
	const routeRows = parseCsv(files['routes.txt'] ?? '');
	const tripRows = parseCsv(files['trips.txt'] ?? '');
	const stopTimeRows = parseCsv(files['stop_times.txt'] ?? '');
	const shapeRows = parseCsv(files['shapes.txt'] ?? '');
	const calendarRows = parseCsv(files['calendar.txt'] ?? '');
	const calendarDateRows = parseCsv(files['calendar_dates.txt'] ?? '');

	const stopCoord = new Map<string, LngLat>();
	for (const s of stopRows) {
		const lng = Number(s.stop_lon);
		const lat = Number(s.stop_lat);
		if (Number.isFinite(lng) && Number.isFinite(lat)) stopCoord.set(s.stop_id, [lng, lat]);
	}

	const routes: Record<string, RouteData> = {};
	for (const r of routeRows) {
		routes[r.route_id] = {
			shortName: r.route_short_name ?? '',
			longName: r.route_long_name ?? '',
			color: r.route_color ? `#${r.route_color}` : null,
		};
	}

	const shapePoints = new Map<string, { seq: number; coord: LngLat }[]>();
	for (const row of shapeRows) {
		let arr = shapePoints.get(row.shape_id);
		if (!arr) {
			arr = [];
			shapePoints.set(row.shape_id, arr);
		}
		arr.push({
			seq: Number(row.shape_pt_sequence),
			coord: [Number(row.shape_pt_lon), Number(row.shape_pt_lat)],
		});
	}
	const shapes: Record<string, ShapeData> = {};
	for (const [id, pts] of shapePoints) {
		pts.sort((a, b) => a.seq - b.seq);
		const coords = pts.map((p) => p.coord);
		if (coords.length < 2) continue;
		shapes[id] = { coords, cumDist: cumulativeDistances(coords) };
	}

	const stByTrip = new Map<string, StopTimeRow[]>();
	for (const row of stopTimeRows) {
		let arr = stByTrip.get(row.trip_id);
		if (!arr) {
			arr = [];
			stByTrip.set(row.trip_id, arr);
		}
		arr.push({
			seq: Number(row.stop_sequence),
			stopId: row.stop_id,
			arrival: parseGtfsTime(row.arrival_time),
			departure: parseGtfsTime(row.departure_time),
		});
	}

	const routeLines = routeGeojson ? parseRouteLines(routeGeojson) : {};
	// 同一路線・同一停留所パターンの trip は多数あるためマッチング結果をキャッシュする
	const matchCache = new Map<string, ShapeMatch | null>();

	const trips: TripData[] = [];
	const usedShapes = new Set<string>();
	const shapeSourceCounts: Record<ShapeSource, number> = { shapes: 0, route: 0, straight: 0 };
	for (const t of tripRows) {
		const st = stByTrip.get(t.trip_id);
		if (!st || st.length < 2) continue;
		st.sort((a, b) => a.seq - b.seq);
		const coords: LngLat[] = [];
		for (const s of st) {
			const c = stopCoord.get(s.stopId);
			if (c) coords.push(c);
		}
		if (coords.length !== st.length) continue; // 座標欠損のあるtripは除外

		// 形状の解決優先順位: shapes.txt → routes.geojson マッチング → 停留所直線
		let shapeId: string;
		let distances: number[];
		let source: ShapeSource;
		if (t.shape_id && shapes[t.shape_id]) {
			shapeId = t.shape_id;
			distances = projectStopsToShape(shapes[shapeId], coords);
			source = 'shapes';
		} else {
			const cacheKey = `${t.route_id}|${st.map((s) => s.stopId).join(',')}`;
			let match = matchCache.get(cacheKey);
			if (match === undefined) {
				const parts = routeLines[t.route_id];
				match = parts ? matchStopsToRouteLines(parts, coords) : null;
				if (match && match.maxError > MAX_ROUTE_SHAPE_ERROR_M) match = null;
				matchCache.set(cacheKey, match);
			}
			if (match) {
				shapeId = `route:${t.route_id}:${match.key}`;
				if (!shapes[shapeId]) shapes[shapeId] = match.shape;
				distances = match.distances;
				source = 'route';
			} else {
				shapeId = `trip:${t.trip_id}`;
				shapes[shapeId] = { coords, cumDist: cumulativeDistances(coords) };
				distances = projectStopsToShape(shapes[shapeId], coords);
				source = 'straight';
			}
		}

		const keyframes = buildKeyframes(st, distances).map(
			([sec, d]): [number, number] => [sec, round1(d)],
		);
		if (keyframes.length < 2) continue;
		usedShapes.add(shapeId);
		shapeSourceCounts[source]++;
		trips.push({
			tripId: t.trip_id,
			routeId: t.route_id,
			serviceId: t.service_id,
			shapeId,
			keyframes,
		});
	}
	for (const id of Object.keys(shapes)) {
		if (!usedShapes.has(id)) {
			delete shapes[id];
			continue;
		}
		shapes[id] = roundShape(shapes[id]);
	}

	return {
		calendar: buildCalendar(calendarRows, calendarDateRows),
		routes,
		shapes,
		trips,
		shapeSourceCounts,
	};
}
```

`packages/gtfs-core/src/index.ts` に追記:

```ts
export * from './convert';
export * from './fixture';
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm --filter gtfs-core test` → PASS
Run: `pnpm --filter gtfs-core check` → exit 0

- [ ] **Step 6: Commit**

```bash
git add packages/gtfs-core
git commit -m "feat(gtfs-core): add GTFS feed conversion with zip extraction and fixture"
```

---

## Task 8: バス位置のFeatureCollection生成

**Files:**
- Create: `packages/gtfs-core/src/bus.ts`
- Modify: `packages/gtfs-core/src/index.ts`
- Test: `packages/gtfs-core/src/bus.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/gtfs-core/src/bus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { busFeatureCollection } from './bus';
import { convertFeed } from './convert';
import { FIXTURE_FILES } from './fixture';

const feeds = [{ id: 'test~feed~20260401', bundle: convertFeed(FIXTURE_FILES) }];

describe('busFeatureCollection', () => {
	it('運行中の時刻はバスが1台表示される(平日 2026-07-06 08:05)', () => {
		const fc = busFeatureCollection(feeds, '20260706', 8 * 3600 + 5 * 60);
		expect(fc.features.length).toBe(1);
		const f = fc.features[0];
		expect(f.properties.tripId).toBe('T1');
		expect(f.properties.routeName).toBe('1');
		// A(139.0)→C(139.01) の途中
		expect(f.geometry.coordinates[0]).toBeGreaterThan(139.0);
		expect(f.geometry.coordinates[0]).toBeLessThan(139.01);
	});

	it('運行時間外は0台', () => {
		expect(busFeatureCollection(feeds, '20260706', 12 * 3600).features.length).toBe(0);
	});

	it('運休日(土曜)は0台', () => {
		expect(busFeatureCollection(feeds, '20260711', 8 * 3600 + 5 * 60).features.length).toBe(0);
	});

	it('前日の24時超便が深夜帯に表示される(火曜 01:05 = 月曜の25:05発 T2)', () => {
		const fc = busFeatureCollection(feeds, '20260707', 1 * 3600 + 5 * 60);
		expect(fc.features.map((f) => f.properties.tripId)).toContain('T2');
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter gtfs-core test`
Expected: FAIL(`./bus` が存在しない)

- [ ] **Step 3: bus.ts を実装**

`packages/gtfs-core/src/bus.ts`:

```ts
import { addDays, isServiceActive } from './calendar';
import { distanceAtTime, pointAtDistance } from './interpolate';
import type { FeedBundle, LngLat } from './types';

export interface BusFeature {
	type: 'Feature';
	geometry: { type: 'Point'; coordinates: LngLat };
	properties: {
		feedId: string;
		tripId: string;
		routeId: string;
		routeName: string;
	};
}

export interface BusFeatureCollection {
	type: 'FeatureCollection';
	features: BusFeature[];
}

/**
 * 指定日 date(YYYYMMDD)の時刻 timeSec(0〜28h)における全バスの推定位置。
 * 前日の24時超便は timeSec+86400 で前日カレンダーに対して判定する。
 */
export function busFeatureCollection(
	feeds: { id: string; bundle: FeedBundle }[],
	date: string,
	timeSec: number,
): BusFeatureCollection {
	const prevDate = addDays(date, -1);
	const features: BusFeature[] = [];
	for (const { id, bundle } of feeds) {
		for (const trip of bundle.trips) {
			let d: number | null = null;
			if (isServiceActive(bundle.calendar, trip.serviceId, date)) {
				d = distanceAtTime(trip.keyframes, timeSec);
			}
			if (d === null && isServiceActive(bundle.calendar, trip.serviceId, prevDate)) {
				d = distanceAtTime(trip.keyframes, timeSec + 86400);
			}
			if (d === null) continue;
			const shape = bundle.shapes[trip.shapeId];
			if (!shape) continue;
			const route = bundle.routes[trip.routeId];
			const routeName = route ? route.shortName || route.longName : trip.routeId;
			features.push({
				type: 'Feature',
				geometry: { type: 'Point', coordinates: pointAtDistance(shape, d) },
				properties: { feedId: id, tripId: trip.tripId, routeId: trip.routeId, routeName },
			});
		}
	}
	return { type: 'FeatureCollection', features };
}
```

`packages/gtfs-core/src/index.ts` に追記:

```ts
export * from './bus';
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter gtfs-core test` → PASS(全テスト)

- [ ] **Step 5: Commit**

```bash
git add packages/gtfs-core
git commit -m "feat(gtfs-core): add bus position feature collection for a given datetime"
```

---

## Task 9: pipeline Worker

**Files:**
- Create: `pipeline/package.json`
- Create: `pipeline/tsconfig.json`
- Create: `pipeline/vitest.config.ts`
- Create: `pipeline/wrangler.jsonc`
- Create: `pipeline/src/run.ts`
- Create: `pipeline/src/index.ts`
- Test: `pipeline/src/run.test.ts`

- [ ] **Step 1: パッケージ雛形を作成**

`pipeline/package.json`:

```json
{
	"name": "pipeline",
	"private": true,
	"version": "0.0.1",
	"type": "module",
	"scripts": {
		"dev": "wrangler dev --test-scheduled --persist-to ../.wrangler/state",
		"deploy": "wrangler deploy",
		"test": "vitest run",
		"check": "tsc --noEmit"
	},
	"dependencies": {
		"gtfs-core": "workspace:*"
	}
}
```

依存はバージョンを直書きせず pnpm に解決させる:

```bash
pnpm install
pnpm --filter pipeline add -D wrangler @cloudflare/workers-types typescript vitest fflate
```

`pipeline/tsconfig.json`:

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"strict": true,
		"skipLibCheck": true,
		"noEmit": true,
		"types": ["@cloudflare/workers-types"]
	},
	"include": ["src"]
}
```

`pipeline/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: { include: ['src/**/*.test.ts'] },
});
```

`pipeline/wrangler.jsonc`:

```jsonc
{
	"name": "gtfs-view-bus-pipeline",
	"main": "src/index.ts",
	"compatibility_date": "2026-06-01",
	// 毎月末日 20:00 UTC = 翌月1日 05:00 JST。L記法が拒否されたら "0 0 1 * *" に変更
	"triggers": { "crons": ["0 20 L * *"] },
	"r2_buckets": [{ "binding": "DATA_BUCKET", "bucket_name": "gtfs-view-bus-data" }],
	"vars": { "GTFS_PREF_ID": "10" }
}
```

```bash
pnpm install
```

- [ ] **Step 2: runPipeline の失敗するテストを書く**

`pipeline/src/run.test.ts`:

```ts
import { strToU8, zipSync } from 'fflate';
import { FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON } from 'gtfs-core';
import { describe, expect, it } from 'vitest';
import { runPipeline, type BucketLike, type GtfsFileEntry } from './run';

function fakeBucket(): BucketLike & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			const v = store.get(key);
			return v === undefined ? null : { text: async () => v };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
	};
}

function entry(overrides: Partial<GtfsFileEntry>): GtfsFileEntry {
	return {
		organization_id: 'testorg',
		organization_name: 'テスト協議会',
		feed_id: 'testfeed',
		feed_name: 'テストバス',
		feed_license_id: 'CC BY 4.0',
		file_uid: 'uid-1',
		file_from_date: '2026-04-01',
		file_to_date: '2027-03-31',
		file_url: 'https://example.com/feed.zip',
		file_stop_url: 'https://example.com/stops.geojson',
		file_route_url: 'https://example.com/routes.geojson',
		file_last_updated_at: '2026-06-01T00:00:00+09:00',
		...overrides,
	};
}

const FIXTURE_ZIP = zipSync(
	Object.fromEntries(Object.entries(FIXTURE_FILES).map(([k, v]) => [k, strToU8(v)])),
);

function fetcherFor(entries: GtfsFileEntry[]): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = String(input);
		if (url.includes('/v2/files')) {
			return new Response(JSON.stringify({ code: 200, message: 'ok', body: entries }));
		}
		if (url.endsWith('feed.zip')) return new Response(FIXTURE_ZIP);
		if (url.endsWith('routes.geojson')) return new Response(FIXTURE_ROUTES_GEOJSON);
		if (url.endsWith('.geojson')) {
			return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }));
		}
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

describe('runPipeline', () => {
	it('新規フィードを変換してR2へ書き込み、feeds.jsonを更新する', async () => {
		const bucket = fakeBucket();
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			prefId: '10',
		});
		expect(statuses).toHaveLength(1);
		expect(statuses[0].status).toBe('updated');
		const id = 'testorg~testfeed~2026-04-01';
		expect(bucket.store.has(`feeds/${id}/bundle.json`)).toBe(true);
		expect(bucket.store.has(`feeds/${id}/stops.geojson`)).toBe(true);
		expect(bucket.store.has(`feeds/${id}/routes.geojson`)).toBe(true);
		expect(bucket.store.has(`feeds/${id}/meta.json`)).toBe(true);
		const index = JSON.parse(bucket.store.get('feeds.json') ?? '{}') as {
			feeds: { id: string; status: string }[];
		};
		expect(index.feeds[0].id).toBe(id);
		// フィクスチャ: T1=shapes.txt / T3=routes.geojsonマッチ / T2=直線フォールバック
		expect(statuses[0].shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});

	it('file_uid が同じなら unchanged でスキップする', async () => {
		const bucket = fakeBucket();
		const deps = { bucket, fetcher: fetcherFor([entry({})]), prefId: '10' };
		await runPipeline(deps);
		const second = await runPipeline(deps);
		expect(second[0].status).toBe('unchanged');
	});

	it('1フィードの失敗が他フィードを巻き込まない', async () => {
		const bucket = fakeBucket();
		const bad = entry({
			organization_id: 'badorg',
			file_url: 'https://example.com/missing.zip',
		});
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([bad, entry({})]),
			prefId: '10',
		});
		expect(statuses.find((s) => s.id.startsWith('badorg'))?.status).toBe('error');
		expect(statuses.find((s) => s.id.startsWith('testorg'))?.status).toBe('updated');
	});
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm --filter pipeline test`
Expected: FAIL(`./run` が存在しない)

- [ ] **Step 4: run.ts を実装**

`pipeline/src/run.ts`:

```ts
import { convertFeed, unzipFeed } from 'gtfs-core';

export interface GtfsFileEntry {
	organization_id: string;
	organization_name: string;
	feed_id: string;
	feed_name: string;
	feed_license_id: string | null;
	file_uid: string;
	file_from_date: string;
	file_to_date: string;
	file_url: string;
	file_stop_url: string | null;
	file_route_url: string | null;
	file_last_updated_at: string;
}

interface FilesResponse {
	code: number;
	body: GtfsFileEntry[];
}

/** R2Bucket と構造的に互換な最小インターフェース(テスト差し替え用) */
export interface BucketLike {
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	put(key: string, value: string): Promise<void>;
}

export interface PipelineDeps {
	bucket: BucketLike;
	fetcher: typeof fetch;
	prefId: string;
}

export interface FeedStatus {
	id: string;
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	status: 'updated' | 'unchanged' | 'error';
	error?: string;
	/** trip の形状ソース内訳(shapes / route / straight)。updated 時のみ */
	shapeSourceCounts?: Record<string, number>;
}

const API_BASE = 'https://api.gtfs-data.jp/v2';

export async function runPipeline({ bucket, fetcher, prefId }: PipelineDeps): Promise<FeedStatus[]> {
	const listRes = await fetcher(`${API_BASE}/files?pref=${prefId}`);
	if (!listRes.ok) throw new Error(`feed list fetch failed: ${listRes.status}`);
	const list = (await listRes.json()) as FilesResponse;

	const statuses: FeedStatus[] = [];
	for (const entry of list.body) {
		const id = `${entry.organization_id}~${entry.feed_id}~${entry.file_from_date}`;
		const base = {
			id,
			name: entry.feed_name,
			orgName: entry.organization_name,
			license: entry.feed_license_id,
			fromDate: entry.file_from_date,
			toDate: entry.file_to_date,
		};
		try {
			const metaObj = await bucket.get(`feeds/${id}/meta.json`);
			const meta = metaObj
				? (JSON.parse(await metaObj.text()) as { fileUid: string })
				: null;
			if (meta && meta.fileUid === entry.file_uid) {
				statuses.push({ ...base, status: 'unchanged' });
				continue;
			}

			const zipRes = await fetcher(entry.file_url);
			if (!zipRes.ok) throw new Error(`zip fetch failed: ${zipRes.status}`);

			// routes.geojson は shapes.txt なしフィードの形状源になるため変換前に取得する
			let routesText: string | null = null;
			if (entry.file_route_url) {
				const res = await fetcher(entry.file_route_url);
				if (res.ok) routesText = await res.text();
			}

			const bundle = convertFeed(
				unzipFeed(new Uint8Array(await zipRes.arrayBuffer())),
				routesText ?? undefined,
			);
			await bucket.put(`feeds/${id}/bundle.json`, JSON.stringify(bundle));
			if (routesText) await bucket.put(`feeds/${id}/routes.geojson`, routesText);
			if (entry.file_stop_url) {
				const res = await fetcher(entry.file_stop_url);
				if (res.ok) await bucket.put(`feeds/${id}/stops.geojson`, await res.text());
			}

			await bucket.put(
				`feeds/${id}/meta.json`,
				JSON.stringify({ fileUid: entry.file_uid, lastUpdatedAt: entry.file_last_updated_at }),
			);
			statuses.push({ ...base, status: 'updated', shapeSourceCounts: bundle.shapeSourceCounts });
		} catch (e) {
			statuses.push({
				...base,
				status: 'error',
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	await bucket.put(
		'feeds.json',
		JSON.stringify({ generatedAt: new Date().toISOString(), feeds: statuses }),
	);
	return statuses;
}
```

`pipeline/src/index.ts`:

```ts
import { runPipeline } from './run';

interface Env {
	DATA_BUCKET: R2Bucket;
	GTFS_PREF_ID: string;
}

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			runPipeline({ bucket: env.DATA_BUCKET, fetcher: fetch, prefId: env.GTFS_PREF_ID }),
		);
	},
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: テストと型チェックが通ることを確認**

Run: `pnpm --filter pipeline test` → PASS(3 tests)
Run: `pnpm --filter pipeline check` → exit 0

- [ ] **Step 6: ローカル実行で実データ変換を確認**(このステップだけネットワークを使う)

```bash
cd pipeline
pnpm dev
```

別ターミナルで:

```bash
curl "http://localhost:8787/__scheduled?cron=0+20+L+*+*"
```

(404になる場合は `curl "http://localhost:8787/cdn-cgi/handler/scheduled"` を試す)

Expected: wrangler のログに R2 書き込みが流れ、`.wrangler/state`(リポジトリルート)配下にローカルR2データが生成される。終わったら `wrangler dev` を停止。

確認:

```bash
ls ../.wrangler/state/v3/r2
```

Expected: バケットのディレクトリが存在する。

- [ ] **Step 7: Commit**

```bash
git add pipeline pnpm-lock.yaml
git commit -m "feat(pipeline): add monthly GTFS fetch-convert-store worker"
```

---

## Task 10: app を adapter-cloudflare 化し /data 配信ルートを追加

**Files:**
- Modify: `app/package.json`(依存追加)
- Modify: `app/vite.config.ts`
- Create: `app/wrangler.jsonc`
- Modify: `app/src/app.d.ts`
- Create: `app/src/routes/data/[...path]/+server.ts`

- [ ] **Step 1: 依存を追加・削除**

```bash
pnpm --filter app remove @sveltejs/adapter-auto
pnpm --filter app add -D @sveltejs/adapter-cloudflare @cloudflare/workers-types wrangler maplibre-gl
pnpm --filter app add -D --workspace gtfs-core
```

- [ ] **Step 2: vite.config.ts のアダプタを差し替え**

`app/vite.config.ts` の import と adapter 行を変更(全体):

```ts
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: adapter({
				config: 'wrangler.jsonc',
				platformProxy: {
					configPath: 'wrangler.jsonc',
					persist: { path: '../.wrangler/state/v3' }
				}
			})
		})
	]
});
```

(`persist` のパスを pipeline の `--persist-to ../.wrangler/state` と同じ実体に合わせている。`vite dev` でローカルR2の中身が見えない場合はこのパス対応を疑うこと)

- [ ] **Step 3: app/wrangler.jsonc を作成**

```jsonc
{
	"name": "gtfs-view-bus-app",
	"compatibility_date": "2026-06-01",
	"main": ".svelte-kit/cloudflare/_worker.js",
	"assets": { "binding": "ASSETS", "directory": ".svelte-kit/cloudflare" },
	"r2_buckets": [{ "binding": "DATA_BUCKET", "bucket_name": "gtfs-view-bus-data" }]
}
```

- [ ] **Step 4: app.d.ts に Platform 型を定義**

`app/src/app.d.ts`(全体を置き換え):

```ts
import type { R2Bucket } from '@cloudflare/workers-types';

declare global {
	namespace App {
		interface Platform {
			env: {
				DATA_BUCKET: R2Bucket;
			};
		}
	}
}

export {};
```

- [ ] **Step 5: /data 配信ルートを作成**

`app/src/routes/data/[...path]/+server.ts`:

```ts
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform }) => {
	const bucket = platform?.env?.DATA_BUCKET;
	if (!bucket) error(500, 'R2 binding is not available');
	const object = await bucket.get(params.path);
	if (!object) error(404, 'not found');
	const contentType = params.path.endsWith('.geojson')
		? 'application/geo+json'
		: 'application/json';
	return new Response(object.body as BodyInit, {
		headers: {
			'content-type': contentType,
			'cache-control': 'public, max-age=300',
		},
	});
};
```

- [ ] **Step 6: ビルドと動作確認**

```bash
pnpm --filter app run prepare
pnpm --filter app check
pnpm --filter app build
```

Expected: すべて exit 0。

Task 9 Step 6 でローカルR2にデータを入れた状態で:

```bash
pnpm --filter app dev
```

```bash
curl -s http://localhost:5173/data/feeds.json | head -c 300
```

Expected: feeds.json のJSONが返る(3フィードのステータス)。存在しないキーで404:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/data/nothing.json
```

Expected: `404`

- [ ] **Step 7: Commit**

```bash
git add app pnpm-lock.yaml
git commit -m "feat(app): switch to cloudflare adapter and serve R2 data via /data route"
```

---

## Task 11: フロントエンド — データロードとシミュレーション状態

**Files:**
- Create: `app/src/lib/data.ts`
- Create: `app/src/lib/sim.svelte.ts`
- Delete: `app/src/lib/index.ts`(雛形の空ファイル)

- [ ] **Step 1: データローダを作成**

`app/src/lib/data.ts`:

```ts
import type { FeedBundle } from 'gtfs-core';

export interface FeedIndexEntry {
	id: string;
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	status: string;
}

export interface FeedIndex {
	generatedAt: string;
	feeds: FeedIndexEntry[];
}

interface GeoJsonFeatureCollection {
	type: 'FeatureCollection';
	features: object[];
}

export interface LoadedData {
	index: FeedIndex;
	feeds: { id: string; bundle: FeedBundle }[];
	stops: GeoJsonFeatureCollection;
	routes: GeoJsonFeatureCollection;
}

async function fetchJson<T>(url: string): Promise<T | null> {
	const res = await fetch(url);
	if (!res.ok) return null;
	return (await res.json()) as T;
}

export async function loadAll(): Promise<LoadedData> {
	const index = await fetchJson<FeedIndex>('/data/feeds.json');
	if (!index) throw new Error('feeds.json の取得に失敗しました');
	const feeds: LoadedData['feeds'] = [];
	const stops: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };
	const routes: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };
	await Promise.all(
		index.feeds.map(async (f) => {
			const [bundle, s, r] = await Promise.all([
				fetchJson<FeedBundle>(`/data/feeds/${f.id}/bundle.json`),
				fetchJson<GeoJsonFeatureCollection>(`/data/feeds/${f.id}/stops.geojson`),
				fetchJson<GeoJsonFeatureCollection>(`/data/feeds/${f.id}/routes.geojson`),
			]);
			if (bundle) feeds.push({ id: f.id, bundle });
			if (s) stops.features.push(...s.features);
			if (r) routes.features.push(...r.features);
		}),
	);
	return { index, feeds, stops, routes };
}
```

- [ ] **Step 2: シミュレーション状態(runes)を作成**

`app/src/lib/sim.svelte.ts`:

```ts
/** GTFSの24時超表記に合わせ 0:00〜28:00 を扱う */
export const MAX_TIME_SEC = 28 * 3600;

function todayIso(): string {
	const now = new Date();
	const mm = String(now.getMonth() + 1).padStart(2, '0');
	const dd = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${mm}-${dd}`;
}

export const sim = $state({
	/** YYYY-MM-DD (input[type=date] 互換) */
	date: todayIso(),
	/** 当日0時からの経過秒 */
	timeSec: 8 * 3600,
	playing: false,
	/** 再生倍率(実時間1秒 = speed 秒進む) */
	speed: 60,
});
```

- [ ] **Step 3: 雛形の空ファイルを削除**

```bash
rm app/src/lib/index.ts
```

- [ ] **Step 4: 型チェック**

Run: `pnpm --filter app check`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add -A app/src/lib
git commit -m "feat(app): add data loader and simulation state"
```

---

## Task 12: フロントエンド — 地図・コントロールUI

**Files:**
- Create: `app/src/lib/Controls.svelte`
- Modify: `app/src/routes/+page.svelte`(全面置き換え)

- [ ] **Step 1: コントロールUIを作成**

`app/src/lib/Controls.svelte`:

```svelte
<script lang="ts">
	import { MAX_TIME_SEC, sim } from '$lib/sim.svelte';
	import type { FeedIndexEntry } from '$lib/data';

	let { busCount, feedInfos }: { busCount: number; feedInfos: FeedIndexEntry[] } = $props();

	const timeLabel = $derived(
		`${String(Math.floor(sim.timeSec / 3600)).padStart(2, '0')}:${String(
			Math.floor((sim.timeSec % 3600) / 60),
		).padStart(2, '0')}`,
	);
</script>

<div
	class="absolute bottom-4 left-1/2 z-10 w-[min(680px,92vw)] -translate-x-1/2 space-y-2 rounded-lg bg-white/90 p-4 shadow-lg"
>
	<div class="flex flex-wrap items-center gap-3">
		<input type="date" bind:value={sim.date} class="rounded border px-2 py-1" />
		<button
			class="rounded bg-rose-600 px-3 py-1 text-white"
			onclick={() => (sim.playing = !sim.playing)}
		>
			{sim.playing ? '⏸ 停止' : '▶ 再生'}
		</button>
		<select bind:value={sim.speed} class="rounded border px-2 py-1">
			<option value={10}>×10</option>
			<option value={60}>×60</option>
			<option value={300}>×300</option>
		</select>
		<span class="font-mono text-lg tabular-nums">{timeLabel}</span>
		<span class="ml-auto text-sm text-gray-600">運行中: {busCount}台</span>
	</div>
	<input
		type="range"
		min="0"
		max={MAX_TIME_SEC}
		step="60"
		bind:value={sim.timeSec}
		class="w-full"
	/>
	<div class="text-xs text-gray-500">
		データ: {#each feedInfos as f (f.id)}{f.name}({f.license ?? 'ライセンス不明'}) {/each}
		— GTFSデータリポジトリ(gtfs-data.jp) / 地図: © OpenStreetMap contributors
	</div>
</div>
```

- [ ] **Step 2: 地図ページを作成**

`app/src/routes/+page.svelte`(全面置き換え):

```svelte
<script lang="ts">
	import {
		CircleLayer,
		GeoJSONSource,
		LineLayer,
		MapLibre,
		Popup,
		RasterLayer,
		RasterTileSource,
	} from 'svelte-maplibre-gl';
	import { busFeatureCollection, type BusFeatureCollection } from 'gtfs-core';
	import Controls from '$lib/Controls.svelte';
	import { loadAll, type LoadedData } from '$lib/data';
	import { MAX_TIME_SEC, sim } from '$lib/sim.svelte';

	let data = $state<LoadedData | null>(null);
	let loadError = $state<string | null>(null);
	let selected = $state<{ lnglat: [number, number]; routeName: string; tripId: string } | null>(
		null,
	);

	$effect(() => {
		loadAll()
			.then((d) => (data = d))
			.catch((e: Error) => (loadError = e.message));
	});

	const EMPTY_FC: BusFeatureCollection = { type: 'FeatureCollection', features: [] };
	const buses = $derived(
		data ? busFeatureCollection(data.feeds, sim.date.replaceAll('-', ''), sim.timeSec) : EMPTY_FC,
	);

	// 再生ループ: 実時間 dt 秒 → シミュレーション dt×speed 秒
	$effect(() => {
		if (!sim.playing) return;
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			sim.timeSec = Math.min(sim.timeSec + ((now - last) / 1000) * sim.speed, MAX_TIME_SEC);
			last = now;
			if (sim.timeSec >= MAX_TIME_SEC) {
				sim.playing = false;
			} else {
				raf = requestAnimationFrame(tick);
			}
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});
</script>

<div class="relative h-screen w-screen">
	<MapLibre
		class="h-full w-full"
		style={{ version: 8, sources: {}, layers: [] }}
		center={[139.2, 36.35]}
		zoom={10}
	>
		<RasterTileSource
			tiles={['https://tile.openstreetmap.org/{z}/{x}/{y}.png']}
			tileSize={256}
			attribution="© OpenStreetMap contributors"
		>
			<RasterLayer />
		</RasterTileSource>
		{#if data}
			<GeoJSONSource data={data.routes}>
				<LineLayer paint={{ 'line-color': '#3b82f6', 'line-width': 2, 'line-opacity': 0.5 }} />
			</GeoJSONSource>
			<GeoJSONSource data={data.stops}>
				<CircleLayer
					paint={{
						'circle-radius': 3,
						'circle-color': '#6b7280',
						'circle-stroke-width': 1,
						'circle-stroke-color': '#ffffff',
					}}
				/>
			</GeoJSONSource>
		{/if}
		<GeoJSONSource data={buses}>
			<CircleLayer
				paint={{
					'circle-radius': 7,
					'circle-color': '#e11d48',
					'circle-stroke-width': 2,
					'circle-stroke-color': '#ffffff',
				}}
				onclick={(ev) => {
					const f = ev.features?.[0];
					if (f && f.geometry.type === 'Point') {
						selected = {
							lnglat: [f.geometry.coordinates[0], f.geometry.coordinates[1]],
							routeName: String(f.properties.routeName),
							tripId: String(f.properties.tripId),
						};
					}
				}}
			/>
		</GeoJSONSource>
		{#if selected}
			<Popup lnglat={selected.lnglat} onclose={() => (selected = null)}>
				<div class="text-sm">
					<div class="font-bold">{selected.routeName}</div>
					<div class="text-gray-600">便: {selected.tripId}</div>
				</div>
			</Popup>
		{/if}
	</MapLibre>

	{#if loadError}
		<div class="absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded bg-red-600 px-4 py-2 text-white">
			{loadError}
		</div>
	{/if}
	{#if data && buses.features.length === 0}
		<div class="absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded bg-gray-800/80 px-4 py-2 text-sm text-white">
			この日時に運行中のバスはありません(日付がダイヤの有効期間外の可能性があります)
		</div>
	{/if}
	<Controls busCount={buses.features.length} feedInfos={data?.index.feeds ?? []} />
</div>
```

- [ ] **Step 3: 型チェックとビルド**

Run: `pnpm --filter app check` → exit 0
Run: `pnpm --filter app build` → exit 0

- [ ] **Step 4: ブラウザで動作確認**(ローカルR2に Task 9 Step 6 のデータがある前提)

```bash
pnpm --filter app dev
```

ブラウザで http://localhost:5173 を開き、以下を確認:

1. 群馬県周辺に路線ライン(青)とバス停(灰色)が表示される
2. 日付を平日(フィード有効期間内、例: 直近の月曜)にし、スライダーを 08:00 付近へ → 赤いバスが表示される
3. 「▶ 再生」でバスが路線に沿って動く
4. バスをクリックすると系統名・便IDのポップアップが出る
5. 日付を有効期間外(例: 2020-01-01)にすると「運行中のバスはありません」と表示される

- [ ] **Step 5: Commit**

```bash
git add app/src
git commit -m "feat(app): add map view with time slider and bus animation"
```

---

## Task 13: Terraform(IaC)

**Files:**
- Create: `infra/main.tf`
- Create: `infra/variables.tf`
- Create: `infra/README.md`

- [ ] **Step 1: Terraform 設定を作成**

`infra/main.tf`:

```hcl
terraform {
  required_version = ">= 1.7"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

# 認証は環境変数 CLOUDFLARE_API_TOKEN を使う
provider "cloudflare" {}

resource "cloudflare_r2_bucket" "data" {
  account_id = var.cloudflare_account_id
  name       = "gtfs-view-bus-data"
  location   = "APAC"
}
```

`infra/variables.tf`:

```hcl
variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}
```

`infra/README.md`:

````markdown
# infra

Cloudflare のアカウントレベルリソース(R2バケット)を Terraform で管理する。
Worker 本体の設定・デプロイは各パッケージの wrangler.jsonc + GitHub Actions が担う。

## 事前準備

- Cloudflare API トークン(R2 編集権限)を作成し、環境変数に設定:
  `export CLOUDFLARE_API_TOKEN=...`
- アカウントIDは Cloudflare ダッシュボードの右下(またはURL)から取得

## 実行

```bash
cd infra
terraform init
terraform plan -var cloudflare_account_id=<ACCOUNT_ID>
terraform apply -var cloudflare_account_id=<ACCOUNT_ID>
```

state はローカル管理(PoC)。チーム運用に移行する場合はリモートバックエンドを検討する。
````

- [ ] **Step 2: 検証**

```bash
cd infra
terraform init
terraform validate
```

Expected: `Success! The configuration is valid.`

(実際の `terraform apply` はAPIトークン準備後にユーザーが実行。applyまで行う場合は `terraform apply` の完了と、`wrangler r2 bucket list` でバケットが見えることを確認)

- [ ] **Step 3: Commit**

```bash
git add infra
git commit -m "feat(infra): add Terraform config for R2 bucket"
```

---

## Task 14: GitHub Actions(CI/CD)

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: CI ワークフローを作成**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm format:check
      - run: pnpm lint
      - run: pnpm --filter app run prepare
      - run: pnpm -r run check
      - run: pnpm -r run test
      - run: pnpm --filter app build
```

(pnpm/action-setup はバージョン指定なしで packageManager フィールド or 最新を使う。ルート package.json に `"packageManager": "pnpm@<ローカルのバージョン>"` を追記しておくこと。`pnpm --version` で確認して記入)

- [ ] **Step 2: デプロイワークフローを作成**

`.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter app build
      - name: Deploy pipeline worker
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: pipeline
          packageManager: pnpm
      - name: Deploy app
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: app
          packageManager: pnpm
```

- [ ] **Step 3: ルート package.json に packageManager を追記**

```bash
node -e "const v=require('child_process').execSync('pnpm --version').toString().trim(); const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.packageManager='pnpm@'+v; fs.writeFileSync('package.json', JSON.stringify(p, null, '\t')+'\n');"
git diff package.json
```

Expected: `"packageManager": "pnpm@10.x.x"` が追加される。

- [ ] **Step 4: ローカルでCI相当を通す**

```bash
pnpm format:check && pnpm lint && pnpm -r run check && pnpm -r run test && pnpm --filter app build
```

Expected: すべて exit 0。lint エラーが出た場合はこのタスク内で修正してから進む。

- [ ] **Step 5: Commit**

```bash
git add .github package.json
git commit -m "ci: add CI and Cloudflare deploy workflows"
```

---

## Task 15: 本番デプロイと最終確認(手動ステップ含む)

**Files:**
- Create: `README.md`(ルート)

- [ ] **Step 1: README を作成**

ルート `README.md`:

````markdown
# gtfs-view-bus

群馬県のGTFSフィード(gtfs-data.jp)をもとに、指定日時のバス推定位置を地図上に表示するWebGIS。

- 設計書: `docs/superpowers/specs/2026-07-05-gtfs-bus-position-webgis-design.md`
- 構成: `pipeline/`(月次変換Worker) → R2 → `app/`(SvelteKit on Workers) → MapLibre
- 共有ロジック: `packages/gtfs-core/`
- IaC: `infra/`(Terraform, R2バケット) + 各 `wrangler.jsonc`

## 開発

```bash
pnpm install
pnpm -r run test

# ローカルR2にデータ投入(初回のみ)
cd pipeline && pnpm dev
# 別ターミナルで: curl "http://localhost:8787/__scheduled?cron=0+20+L+*+*"

# フロント起動
pnpm --filter app dev
```

## デプロイ

1. `infra/` で R2 バケットを作成(infra/README.md 参照)
2. GitHub Environment `production` に `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を設定
3. main へマージすると GitHub Actions がデプロイ
4. 初回はデータが空なので、Cloudflare ダッシュボードから gtfs-view-bus-pipeline の
   Cron を手動トリガー(または `cd pipeline && pnpm exec wrangler deploy && pnpm exec wrangler triggers deploy` 後、
   ダッシュボードの「Trigger scheduled event」を実行)
````

- [ ] **Step 2: 手動デプロイ前提の確認**(ユーザー操作が必要。実行できない場合はユーザーに依頼して待つ)

1. `infra/` で `terraform apply`(Task 13)が完了していること
2. GitHub リポジトリに Environment `production` を作成し、secrets `CLOUDFLARE_API_TOKEN`(Workers + R2 権限)と `CLOUDFLARE_ACCOUNT_ID` を設定

- [ ] **Step 3: デプロイと本番動作確認**

main へ push(またはPRマージ)後:

1. GitHub Actions の Deploy が成功すること
2. pipeline の初回実行: Cloudflare ダッシュボード → Workers → gtfs-view-bus-pipeline → Settings → Trigger Events から手動実行(できない場合は一時的に `wrangler dev --remote --test-scheduled` で本番R2に対して実行)
3. `https://gtfs-view-bus-app.<subdomain>.workers.dev/data/feeds.json` が3フィードを返すこと
4. アプリURLを開き、平日08:00設定でバスが表示・再生されること

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add project README"
```

---

## 完了条件(設計書との対応)

| 設計書の要件 | タスク |
|---|---|
| 群馬県全フィードの取得・変換(月次Cron) | Task 9 |
| 停留所→shape射影(単調増加制約) | Task 4 |
| shapes.txt なしフィードの形状補完(routes.geojsonマッチング)と直線フォールバック | Task 6.5, 7 |
| 形状ソース内訳の記録(bundle / feeds.json) | Task 7, 9 |
| 座標6桁・距離0.1m丸め(データ形式の選定理由) | Task 7 |
| キーフレーム化・時刻補間 | Task 6, 8 |
| 24時超・前日便の扱い | Task 6(time), 8(bus) |
| R2データ形式(feeds.json / bundle.json / geojson) | Task 9 |
| SvelteKit SSR(adapter-cloudflare)+ /data 配信 | Task 10 |
| 日付+スライダー+再生UI・ポップアップ | Task 11, 12 |
| フィード単位のエラー隔離とステータス記録 | Task 9 |
| 有効期間外の日付のUI表示 | Task 12 |
| Terraform + wrangler の IaC | Task 13, 9, 10 |
| GitHub Actions CI/CD(Environment secrets) | Task 14 |
| ESLint による lint(ローカル + CI) | Task 1, 14 |
| ユニットテスト(射影・補間・カレンダー・変換) | Task 2〜8 |
```
