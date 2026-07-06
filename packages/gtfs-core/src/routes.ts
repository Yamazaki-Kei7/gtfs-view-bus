import { isServiceActive } from './calendar';
import type { FeedBundle } from './types';

/**
 * 路線の識別色パレット(互いに見分けやすい9色)。
 * route_color を持たない路線に安定した順序で割り当てる。
 */
export const ROUTE_PALETTE = [
	'#005773',
	'#e2581f',
	'#1f8a5b',
	'#7b4fa6',
	'#2a6fdb',
	'#c2417a',
	'#8a6d1f',
	'#00879e',
	'#b23333',
] as const;

export interface RouteInfo {
	/** `${feedId}|${routeId}`。フィード間で route_id が衝突しても一意になる */
	key: string;
	feedId: string;
	routeId: string;
	/** 表示名: route_short_name → route_long_name → route_id */
	name: string;
	/** #RRGGBB。route_color があれば優先、無ければパレットから安定割当 */
	color: string;
	/** フィード表示名(feeds.json 由来) */
	feedName: string;
	/** 運行区分ラベル: 毎日 / 平日 / 土日祝 / 運行 */
	serviceLabel: string;
	/** 指定日(前日発の深夜便を含む)に運行するか */
	active: boolean;
}

export interface CatalogFeed {
	id: string;
	name: string;
	bundle: FeedBundle;
}

function makeKey(feedId: string, routeId: string): string {
	return `${feedId}|${routeId}`;
}

/** service の運行曜日(月0…日6)の和集合から運行区分ラベルを導出する(exceptions・期間は考慮しない) */
function serviceLabel(days: boolean[]): string {
	const weekday = days.slice(0, 5).every(Boolean);
	const weekend = days[5] && days[6];
	const noWeekday = days.slice(0, 5).every((d) => !d);
	const noWeekend = !days[5] && !days[6];
	if (weekday && weekend) return '毎日';
	if (weekday && noWeekend) return '平日';
	if (weekend && noWeekday) return '土日祝';
	return '運行';
}

/**
 * 全フィードの路線カタログを返す。指定日 date(YYYYMMDD)の運行有無・色・運行区分ラベルを付与する。
 * 色は日付非依存で固定される(active な路線集合が変わっても路線ごとの色は変わらない)。
 * active は選択日のカレンダーのみで判定する(前日発の24時超便のバスは busFeatureCollection が
 * 引き続き描画するが、その路線が選択日に運行しなければ路線線・パネルには現れない)。
 */
export function routeCatalog(feeds: CatalogFeed[], date: string): RouteInfo[] {
	// 各フィードで trip を持つ route と、その service_id 集合を集める
	const perFeed = feeds.map(({ id, name, bundle }) => {
		const serviceIds = new Map<string, Set<string>>();
		for (const trip of bundle.trips) {
			let set = serviceIds.get(trip.routeId);
			if (!set) {
				set = new Set();
				serviceIds.set(trip.routeId, set);
			}
			set.add(trip.serviceId);
		}
		return { id, name, bundle, serviceIds };
	});

	// route_color を持たない路線へパレットを割り当てるため、全 key を安定順にソートする
	const allKeys: string[] = [];
	for (const f of perFeed) {
		for (const routeId of f.serviceIds.keys()) allKeys.push(makeKey(f.id, routeId));
	}
	allKeys.sort();
	const paletteIndex = new Map(allKeys.map((k, i) => [k, i]));

	const result: RouteInfo[] = [];
	for (const f of perFeed) {
		for (const [routeId, serviceIdSet] of f.serviceIds) {
			const key = makeKey(f.id, routeId);
			const route = f.bundle.routes[routeId];
			const name = route ? route.shortName || route.longName || routeId : routeId;
			const color =
				route?.color ?? ROUTE_PALETTE[(paletteIndex.get(key) ?? 0) % ROUTE_PALETTE.length];

			const unionDays = [false, false, false, false, false, false, false];
			let active = false;
			for (const serviceId of serviceIdSet) {
				const svc = f.bundle.calendar.services[serviceId];
				if (svc) for (let i = 0; i < 7; i++) unionDays[i] ||= svc.days[i];
				if (!active && isServiceActive(f.bundle.calendar, serviceId, date)) active = true;
			}

			result.push({
				key,
				feedId: f.id,
				routeId,
				name,
				color,
				feedName: f.name,
				serviceLabel: serviceLabel(unionDays),
				active,
			});
		}
	}
	return result;
}
