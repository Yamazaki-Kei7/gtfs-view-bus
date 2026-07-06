import { isServiceActive } from './calendar';
import { parseCsv } from './csv';
import { parseGtfsTime } from './time';
import type { CalendarData } from './types';

/** 停留所別時刻表の 1 レコード(ある便がこの停留所を発車する 1 件)。キーは配信サイズ節約のため短縮。 */
export interface TimetableEntry {
	/** route_id */
	r: string;
	/** direction_id(0|1)。無ければ null */
	d: 0 | 1 | null;
	/** trip_headsign(無ければ空文字) */
	h: string;
	/** service_id(指定日のカレンダー判定に使う) */
	s: string;
	/** 発車秒(当日0時起点・24時超あり) */
	t: number;
}

/** 停留所中心の時刻表インデックス(フィード単位で timetable.json として配信する) */
export interface TimetableIndex {
	stops: Record<string, TimetableEntry[]>;
}

/**
 * trips.txt × stop_times.txt から停留所別の時刻表インデックスを構築する(パイプライン生成用)。
 * 各停留所に、そこを通る便の発車秒・route/service/方向/行先を並べる。
 */
export function buildTimetableIndex(files: Record<string, string>): TimetableIndex {
	const tripMeta = new Map<
		string,
		{ routeId: string; serviceId: string; d: 0 | 1 | null; h: string }
	>();
	for (const t of parseCsv(files['trips.txt'] ?? '')) {
		const d = t.direction_id === '0' ? 0 : t.direction_id === '1' ? 1 : null;
		tripMeta.set(t.trip_id, {
			routeId: t.route_id,
			serviceId: t.service_id,
			d,
			h: t.trip_headsign ?? '',
		});
	}
	const stops: Record<string, TimetableEntry[]> = {};
	for (const st of parseCsv(files['stop_times.txt'] ?? '')) {
		const meta = tripMeta.get(st.trip_id);
		if (!meta) continue;
		// `??`(`||` ではない)は 0:00 ちょうど(=0秒)を欠損扱いしないため意図的
		const t = parseGtfsTime(st.departure_time ?? '') ?? parseGtfsTime(st.arrival_time ?? '');
		if (t === null) continue;
		(stops[st.stop_id] ??= []).push({
			r: meta.routeId,
			d: meta.d,
			h: meta.h,
			s: meta.serviceId,
			t,
		});
	}
	return { stops };
}

/** 路線の表示情報(アプリ側の RouteInfo から必要分だけ渡す) */
export interface RouteDisplay {
	name: string;
	color: string;
	feedName: string;
	serviceLabel: string;
}

export interface StopTimetableParams {
	/** 対象停留所のエントリ(timetable.json の stops[stopId]。未ロード/該当なしは []) */
	entries: TimetableEntry[];
	calendar: CalendarData;
	/** YYYYMMDD */
	date: string;
	/** 現在の経過秒(sim.timeSec)。次の発車・過去判定の基準 */
	nowSec: number;
	/** route_id → 表示情報。引けない路線は時刻表から除外する */
	routeInfo: (routeId: string) => RouteDisplay | undefined;
	/** 非表示路線(hidden)を除外する述語 */
	isVisible: (routeId: string) => boolean;
}

export interface TimetableTime {
	sec: number;
	/** HH:MM(24時超は 25:10 のまま) */
	hm: string;
	/** 現在時刻以降で最初の発車(次の発車) */
	isNext: boolean;
	/** 現在時刻より前 */
	isPast: boolean;
}

export interface TimetableDir {
	/** グルーピングキー(方向 '0'|'1'|'_' または headsign) */
	key: string;
	/** 表示ラベル(下り / 上り / 行先 / 運行) */
	label: string;
	/** 現在時刻以降で最初の発車秒。無ければ null(本日の運行終了) */
	nextSec: number | null;
	/** 発車秒昇順 */
	times: TimetableTime[];
}

export interface TimetableRoute extends RouteDisplay {
	routeId: string;
	dirs: TimetableDir[];
}

export interface StopTimetable {
	routes: TimetableRoute[];
}

const DIR_LABEL: Record<string, string> = { '0': '下り', '1': '上り' };

/** 秒 → HH:MM(24時超は 25:10 のような深夜表記のまま) */
function fmtHM(sec: number): string {
	const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
	const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
	return `${hh}:${mm}`;
}

/** 方向キーの並び順: 下り(0) → 上り(1) → その他 */
function dirRank(key: string): number {
	return key === '0' ? 0 : key === '1' ? 1 : 2;
}

/**
 * ある停留所の時刻表を組み立てる(指定日にアクティブ かつ 表示中 の便のみ・路線ごとに方向分割)。
 * 表示情報(名前・色・運行区分)は routeInfo から引き、装飾は持たせない(データのみ返す)。
 */
export function buildStopTimetable(params: StopTimetableParams): StopTimetable {
	const { entries, calendar, date, nowSec, routeInfo, isVisible } = params;
	// 路線ごとにグルーピング(出現順を保つ)。アクティブ・表示中・表示情報ありのみ。
	const order: string[] = [];
	const byRoute = new Map<string, TimetableEntry[]>();
	for (const e of entries) {
		if (!isVisible(e.r) || !routeInfo(e.r) || !isServiceActive(calendar, e.s, date)) continue;
		let arr = byRoute.get(e.r);
		if (!arr) {
			arr = [];
			byRoute.set(e.r, arr);
			order.push(e.r);
		}
		arr.push(e);
	}
	const routes: TimetableRoute[] = [];
	for (const routeId of order) {
		const info = routeInfo(routeId);
		if (!info) continue;
		const dirs = buildDirs(byRoute.get(routeId) ?? [], nowSec);
		if (dirs.length > 0) routes.push({ routeId, ...info, dirs });
	}
	return { routes };
}

/** 路線内の便を方向(または行先)ごとに分割する */
function buildDirs(entries: TimetableEntry[], nowSec: number): TimetableDir[] {
	// direction_id を1件でも持てば方向分割、なければ headsign 単位
	const hasDirection = entries.some((e) => e.d !== null);
	const order: string[] = [];
	const byKey = new Map<string, TimetableEntry[]>();
	for (const e of entries) {
		const key = hasDirection ? (e.d === null ? '_' : String(e.d)) : e.h;
		let arr = byKey.get(key);
		if (!arr) {
			arr = [];
			byKey.set(key, arr);
			order.push(key);
		}
		arr.push(e);
	}
	const keys = hasDirection ? [...order].sort((a, b) => dirRank(a) - dirRank(b)) : order;
	return keys.map((key) => {
		const times = [...new Set(byKey.get(key)?.map((e) => e.t) ?? [])].sort((a, b) => a - b);
		const nextSec = times.find((s) => s >= nowSec) ?? null;
		return {
			key,
			label: hasDirection ? (DIR_LABEL[key] ?? '運行') : key || '運行',
			nextSec,
			times: times.map((sec) => ({
				sec,
				hm: fmtHM(sec),
				isNext: sec === nextSec,
				isPast: sec < nowSec,
			})),
		};
	});
}
