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
