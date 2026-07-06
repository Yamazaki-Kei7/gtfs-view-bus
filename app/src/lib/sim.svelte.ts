/** GTFSの24時超表記に合わせ 0:00〜28:00 を扱う */
export const MAX_TIME_SEC = 28 * 3600;

function todayIso(): string {
	// Workers の SSR は UTC で動くため、バスの運行日は Asia/Tokyo 基準で決める
	return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

/**
 * 日本時間の現在日時を { date(YYYY-MM-DD), timeSec(当日0時からの経過秒) } で返す。
 * 「現在」ボタンでシミュレーションを現在時刻に合わせるために使う(クライアントでのみ呼ぶこと)。
 */
export function nowJst(): { date: string; timeSec: number } {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Tokyo',
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(Date.now());
	const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
	// hour は Asia/Tokyo で 24 を返す実装があるため 24→0 に丸める
	const timeSec =
		(Number(get('hour')) % 24) * 3600 + Number(get('minute')) * 60 + Number(get('second'));
	return { date: `${get('year')}-${get('month')}-${get('day')}`, timeSec };
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
