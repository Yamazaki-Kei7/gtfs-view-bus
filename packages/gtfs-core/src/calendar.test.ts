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
