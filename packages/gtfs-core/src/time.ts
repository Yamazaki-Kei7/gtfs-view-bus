export function parseGtfsTime(value: string): number | null {
	const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value.trim());
	if (!m) return null;
	return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
