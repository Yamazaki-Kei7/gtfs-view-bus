/**
 * GTFS の HH:MM:SS 形式を当日0時起点の経過秒に変換する。
 * 注意(緩い検証): GTFS 時刻は 24:00:00 超が正当なため HH に上限はなく、
 * MM/SS も範囲検証(<60)を行わない。形式さえ合えば不正な上流値でも
 * null ではなく数値を返す。
 */
export function parseGtfsTime(value: string): number | null {
	const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value.trim());
	if (!m) return null;
	return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
