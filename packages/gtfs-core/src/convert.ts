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

interface CoordinateBounds {
	minLng: number;
	maxLng: number;
	minLat: number;
	maxLat: number;
}

const SHAPE_BOUNDS_PADDING_RATIO = 0.1;
const MIN_SHAPE_BOUNDS_PADDING_DEGREES = 0.1;

function coordinateBounds(coords: Iterable<LngLat>): CoordinateBounds | null {
	let bounds: CoordinateBounds | null = null;
	for (const [lng, lat] of coords) {
		if (!bounds) {
			bounds = { minLng: lng, maxLng: lng, minLat: lat, maxLat: lat };
			continue;
		}
		bounds.minLng = Math.min(bounds.minLng, lng);
		bounds.maxLng = Math.max(bounds.maxLng, lng);
		bounds.minLat = Math.min(bounds.minLat, lat);
		bounds.maxLat = Math.max(bounds.maxLat, lat);
	}
	return bounds;
}

function padBounds(bounds: CoordinateBounds): CoordinateBounds {
	const lngPad = Math.max(
		(bounds.maxLng - bounds.minLng) * SHAPE_BOUNDS_PADDING_RATIO,
		MIN_SHAPE_BOUNDS_PADDING_DEGREES,
	);
	const latPad = Math.max(
		(bounds.maxLat - bounds.minLat) * SHAPE_BOUNDS_PADDING_RATIO,
		MIN_SHAPE_BOUNDS_PADDING_DEGREES,
	);
	return {
		minLng: bounds.minLng - lngPad,
		maxLng: bounds.maxLng + lngPad,
		minLat: bounds.minLat - latPad,
		maxLat: bounds.maxLat + latPad,
	};
}

function isValidLngLat(coord: LngLat): boolean {
	const [lng, lat] = coord;
	return (
		Number.isFinite(lng) &&
		Number.isFinite(lat) &&
		lng >= -180 &&
		lng <= 180 &&
		lat >= -90 &&
		lat <= 90
	);
}

function isWithinBounds(coord: LngLat, bounds: CoordinateBounds): boolean {
	const [lng, lat] = coord;
	return (
		lng >= bounds.minLng && lng <= bounds.maxLng && lat >= bounds.minLat && lat <= bounds.maxLat
	);
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
	const stopCoordBounds = coordinateBounds(stopCoord.values());
	const shapeCoordBounds = stopCoordBounds ? padBounds(stopCoordBounds) : null;

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
		const seq = Number(row.shape_pt_sequence);
		const coord: LngLat = [Number(row.shape_pt_lon), Number(row.shape_pt_lat)];
		if (
			!Number.isFinite(seq) ||
			!isValidLngLat(coord) ||
			(shapeCoordBounds && !isWithinBounds(coord, shapeCoordBounds))
		) {
			continue;
		}
		let arr = shapePoints.get(row.shape_id);
		if (!arr) {
			arr = [];
			shapePoints.set(row.shape_id, arr);
		}
		arr.push({ seq, coord });
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
	// GTFS 上 trip_id は一意のはずだが、実フィードでは重複が稀にある。
	// 最初の行を採用し、以降は直線フォールバックの shapeId 衝突を防ぐためスキップする
	const seenTripIds = new Set<string>();
	for (const t of tripRows) {
		if (seenTripIds.has(t.trip_id)) continue;
		seenTripIds.add(t.trip_id);
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

		const keyframes = buildKeyframes(st, distances).map(([sec, d]): [number, number] => [
			sec,
			round1(d),
		]);
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
