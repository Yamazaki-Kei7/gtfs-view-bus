/** GTFSの24時超表記に合わせ 0:00〜28:00 を扱う */
export const MAX_TIME_SEC = 28 * 3600;

function todayIso(): string {
	// Workers の SSR は UTC で動くため、バスの運行日は Asia/Tokyo 基準で決める
	return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

// モジュールレベルの $state は Workers の同一 isolate 内で複数リクエストに共有される。
// SSR 中に sim を書き換えるコードを追加してはならない(クライアント側でのみ変更すること)。
export const sim = $state({
	/** YYYY-MM-DD (input[type=date] 互換) */
	date: todayIso(),
	/** 当日0時からの経過秒 */
	timeSec: 8 * 3600,
	playing: false,
	/** 再生倍率(実時間1秒 = speed 秒進む) */
	speed: 60,
});
