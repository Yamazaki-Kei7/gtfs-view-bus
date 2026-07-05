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
