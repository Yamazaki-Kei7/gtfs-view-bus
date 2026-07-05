/** GTFSの24時超表記に合わせ 0:00〜28:00 を扱う */
export const MAX_TIME_SEC = 28 * 3600;

function todayIso(): string {
	const now = new Date();
	const mm = String(now.getMonth() + 1).padStart(2, '0');
	const dd = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${mm}-${dd}`;
}

export const sim = $state({
	/** YYYY-MM-DD (input[type=date] 互換) */
	date: todayIso(),
	/** 当日0時からの経過秒 */
	timeSec: 8 * 3600,
	playing: false,
	/** 再生倍率(実時間1秒 = speed 秒進む) */
	speed: 60,
});
