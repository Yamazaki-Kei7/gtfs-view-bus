import { describe, expect, it } from 'vitest';
import { convertFeed } from './convert';
import { FIXTURE_FILES } from './fixture';
import { ROUTE_PALETTE, routeCatalog, type CatalogFeed } from './routes';
import type { FeedBundle } from './types';

const feeds: CatalogFeed[] = [
	{ id: 'test~feed~20260401', name: 'テストバス', bundle: convertFeed(FIXTURE_FILES) },
];

describe('routeCatalog', () => {
	it('フィクスチャの2路線を route_color 付きで返す', () => {
		const cat = routeCatalog(feeds, '20260706');
		expect(cat.map((r) => r.routeId).sort()).toEqual(['R1', 'R2']);
		const r1 = cat.find((r) => r.routeId === 'R1');
		expect(r1?.key).toBe('test~feed~20260401|R1');
		expect(r1?.name).toBe('1'); // route_short_name
		expect(r1?.color).toBe('#FF0000'); // route_color 優先
		expect(r1?.feedName).toBe('テストバス');
	});

	it('平日(月)は運行、土曜は運休(active=false)', () => {
		const mon = routeCatalog(feeds, '20260706'); // 月曜
		expect(mon.every((r) => r.active)).toBe(true);
		const sat = routeCatalog(feeds, '20260711'); // 土曜
		expect(sat.every((r) => !r.active)).toBe(true);
	});

	it('calendar_dates の追加/削除を active に反映する', () => {
		// 20260712(日)は WD 追加 → 運行、20260713(月)は WD 削除 → 運休
		expect(routeCatalog(feeds, '20260712').every((r) => r.active)).toBe(true);
		expect(routeCatalog(feeds, '20260713').every((r) => r.active)).toBe(false);
	});

	it('WD(月〜金)サービスは serviceLabel=平日', () => {
		const cat = routeCatalog(feeds, '20260706');
		expect(cat.every((r) => r.serviceLabel === '平日')).toBe(true);
	});

	it('route_color の無い路線はパレットから安定割当する', () => {
		const bundle: FeedBundle = {
			calendar: {
				services: {
					EVERYDAY: {
						days: [true, true, true, true, true, true, true],
						startDate: '20260101',
						endDate: '20261231',
					},
				},
				exceptions: {},
			},
			routes: {
				X: { shortName: '', longName: '幹線', color: null },
				Y: { shortName: 'Y2', longName: '', color: '#123456' },
			},
			shapes: {},
			trips: [
				{ tripId: 't1', routeId: 'X', serviceId: 'EVERYDAY', shapeId: 's', keyframes: [] },
				{ tripId: 't2', routeId: 'Y', serviceId: 'EVERYDAY', shapeId: 's', keyframes: [] },
			],
			shapeSourceCounts: { shapes: 0, route: 0, straight: 0 },
		};
		const cat = routeCatalog([{ id: 'f', name: 'F', bundle }], '20260601');
		const x = cat.find((r) => r.routeId === 'X');
		const y = cat.find((r) => r.routeId === 'Y');
		expect(x?.name).toBe('幹線'); // longName フォールバック
		expect((ROUTE_PALETTE as readonly string[]).includes(x?.color ?? '')).toBe(true);
		expect(y?.color).toBe('#123456'); // route_color 優先
		expect(x?.serviceLabel).toBe('毎日');
	});
});
