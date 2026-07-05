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
