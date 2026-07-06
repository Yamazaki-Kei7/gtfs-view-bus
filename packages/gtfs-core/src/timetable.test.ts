import { describe, expect, it } from 'vitest';
import { convertFeed } from './convert';
import { FIXTURE_FILES } from './fixture';
import { buildStopTimetable, buildTimetableIndex, type TimetableEntry } from './timetable';

const calendar = convertFeed(FIXTURE_FILES).calendar;
// FIXTURE の WD は月〜金運行。2026-07-06 は月曜(平日)、2026-07-11 は土曜(運休)。
const WEEKDAY = '20260706';
const SATURDAY = '20260711';

// テスト用の路線表示情報。routeId をそのままエコーする素朴な実装。
function routeInfo(routeId: string) {
	return { name: `${routeId}名`, color: '#123456', feedName: 'テスト社', serviceLabel: '平日' };
}
const visibleAll = () => true;

describe('buildTimetableIndex', () => {
	const index = buildTimetableIndex(FIXTURE_FILES);

	it('停留所ごとに、通る便の発車秒エントリを持つ', () => {
		// 停留所A: T1(R1,08:00)・T2(R1,24:50)・T3(R2,09:00)
		const a = index.stops['A'];
		expect(a).toHaveLength(3);
		expect(a.map((e) => e.t).sort((x, y) => x - y)).toEqual([28800, 32400, 89400]);
		expect(new Set(a.map((e) => e.r))).toEqual(new Set(['R1', 'R2']));
	});

	it('departure_time を秒として採用し、24時超はそのまま保持する', () => {
		// 停留所B: T1 departure 08:11 = 29460、T2 25:00 = 90000
		const b = index.stops['B'];
		expect(b.find((e) => e.r === 'R1' && e.t < 86400)?.t).toBe(29460);
		expect(b.some((e) => e.t === 90000)).toBe(true);
	});

	it('direction_id・headsign が無いフィードでは d=null / h="" になる', () => {
		const a = index.stops['A'];
		expect(a.every((e) => e.d === null)).toBe(true);
		expect(a.every((e) => e.h === '')).toBe(true);
		expect(a.every((e) => e.s === 'WD')).toBe(true);
	});

	it('direction_id・headsign を持つフィードではそれらを取り込む(空 direction_id は null)', () => {
		const files: Record<string, string> = {
			'trips.txt': `route_id,service_id,trip_id,shape_id,direction_id,trip_headsign
RX,WD,X1,,0,A方面
RX,WD,X2,,1,B方面
RX,WD,X3,,,C方面
`,
			'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence
X1,10:00:00,10:00:00,P,1
X2,10:30:00,10:30:00,P,1
X3,,11:00:00,P,1
`,
		};
		const p = buildTimetableIndex(files).stops['P'];
		expect(p).toHaveLength(3);
		expect(p.find((e) => e.t === 36000)).toMatchObject({ d: 0, h: 'A方面' });
		expect(p.find((e) => e.t === 37800)).toMatchObject({ d: 1, h: 'B方面' });
		// direction_id 空欄 → null、departure のみでも採用
		expect(p.find((e) => e.t === 39600)).toMatchObject({ d: null, h: 'C方面' });
	});

	it('departure_time 欠落時は arrival_time を採用する', () => {
		const files: Record<string, string> = {
			'trips.txt': `route_id,service_id,trip_id\nRZ,WD,Z1\n`,
			'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence\nZ1,07:45:00,,Q,1\n`,
		};
		expect(buildTimetableIndex(files).stops['Q'][0].t).toBe(27900); // 07:45:00
	});
});

describe('buildStopTimetable', () => {
	const index = buildTimetableIndex(FIXTURE_FILES);

	it('指定日にアクティブな便を路線ごとにまとめ、次の発車をマークする', () => {
		const tt = buildStopTimetable({
			entries: index.stops['A'],
			calendar,
			date: WEEKDAY,
			nowSec: 8 * 3600 + 30 * 60, // 08:30
			routeInfo,
			isVisible: visibleAll,
		});
		const r1 = tt.routes.find((r) => r.routeId === 'R1');
		expect(r1).toBeTruthy();
		expect(r1?.name).toBe('R1名');
		// direction 無し → 単一「運行」グループ
		expect(r1?.dirs).toHaveLength(1);
		const dir = r1!.dirs[0];
		expect(dir.label).toBe('運行');
		// 08:00 は過去、24:50 が現在時刻以降の最初=次
		const past = dir.times.find((t) => t.sec === 28800)!;
		const next = dir.times.find((t) => t.sec === 89400)!;
		expect(past.isPast).toBe(true);
		expect(past.hm).toBe('08:00');
		expect(next.isNext).toBe(true);
		expect(next.hm).toBe('24:50'); // 24時超はそのまま
		expect(dir.nextSec).toBe(89400);
	});

	it('非表示路線は除外する', () => {
		const tt = buildStopTimetable({
			entries: index.stops['A'],
			calendar,
			date: WEEKDAY,
			nowSec: 0,
			routeInfo,
			isVisible: (routeId) => routeId !== 'R1',
		});
		expect(tt.routes.map((r) => r.routeId)).toEqual(['R2']);
	});

	it('指定日に運行しない便は現れない(土曜は運休で空)', () => {
		const tt = buildStopTimetable({
			entries: index.stops['A'],
			calendar,
			date: SATURDAY,
			nowSec: 0,
			routeInfo,
			isVisible: visibleAll,
		});
		expect(tt.routes).toEqual([]);
	});

	it('routeInfo が引けない路線は落とす', () => {
		const tt = buildStopTimetable({
			entries: index.stops['A'],
			calendar,
			date: WEEKDAY,
			nowSec: 0,
			routeInfo: (routeId) => (routeId === 'R2' ? routeInfo(routeId) : undefined),
			isVisible: visibleAll,
		});
		expect(tt.routes.map((r) => r.routeId)).toEqual(['R2']);
	});

	it('全便が過去なら nextSec は null(本日の運行終了)', () => {
		const tt = buildStopTimetable({
			entries: index.stops['A'],
			calendar,
			date: WEEKDAY,
			nowSec: 26 * 3600, // 全便より後
			routeInfo,
			isVisible: visibleAll,
		});
		for (const r of tt.routes) for (const d of r.dirs) expect(d.nextSec).toBeNull();
	});

	it('direction_id があれば下り(0)/上り(1)に分割する', () => {
		const entries: TimetableEntry[] = [
			{ r: 'RX', d: 0, h: 'A方面', s: 'WD', t: 36000 },
			{ r: 'RX', d: 1, h: 'B方面', s: 'WD', t: 37800 },
			{ r: 'RX', d: 0, h: 'A方面', s: 'WD', t: 39600 },
		];
		const tt = buildStopTimetable({
			entries,
			calendar,
			date: WEEKDAY,
			nowSec: 0,
			routeInfo,
			isVisible: visibleAll,
		});
		const dirs = tt.routes[0].dirs;
		expect(dirs.map((d) => d.label)).toEqual(['下り', '上り']);
		expect(dirs[0].times.map((t) => t.sec)).toEqual([36000, 39600]);
		expect(dirs[1].times.map((t) => t.sec)).toEqual([37800]);
	});

	it('direction_id が無ければ headsign 単位でグループ化する', () => {
		const entries: TimetableEntry[] = [
			{ r: 'RY', d: null, h: '内回り', s: 'WD', t: 36000 },
			{ r: 'RY', d: null, h: '外回り', s: 'WD', t: 37800 },
		];
		const tt = buildStopTimetable({
			entries,
			calendar,
			date: WEEKDAY,
			nowSec: 0,
			routeInfo,
			isVisible: visibleAll,
		});
		expect(tt.routes[0].dirs.map((d) => d.label)).toEqual(['内回り', '外回り']);
	});
});
