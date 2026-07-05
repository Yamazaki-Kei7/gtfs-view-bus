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
