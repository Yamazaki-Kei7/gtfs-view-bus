<script lang="ts">
	import type { StopTimetable } from 'gtfs-core';

	let {
		open,
		stopName,
		dateLabel,
		timeLabel,
		timetable,
		onClose,
	}: {
		open: boolean;
		stopName: string;
		dateLabel: string;
		timeLabel: string;
		/** 時刻表データ。null はロード中(まだ timetable.json 未取得) */
		timetable: StopTimetable | null;
		onClose: () => void;
	} = $props();

	// ロード済みかつ表示対象0件 → 空状態(運行中の路線が非表示 or 当日運行なし)
	const empty = $derived(timetable !== null && timetable.routes.length === 0);
</script>

<!-- バス停クリックで開く時刻表パネル(右からスライドイン) -->
<div
	class="absolute top-0 right-0 z-20 flex h-full w-[min(408px,100%)] flex-col border-l border-mi-slate-200 bg-white/95 shadow-[-14px_0_36px_rgba(7,48,61,0.16)] backdrop-blur-[10px] transition-transform duration-[280ms] ease-in-out {open
		? 'translate-x-0'
		: 'translate-x-full'}"
	aria-hidden={!open}
>
	<!-- ヘッダ -->
	<div class="flex items-start gap-2.5 border-b border-mi-slate-200 py-3.5 pr-3.5 pl-[18px]">
		<div class="flex min-w-0 flex-1 flex-col gap-1">
			<div class="font-display text-[11px] leading-4 font-bold tracking-[0.08em] text-mi-ember-500">
				TIMETABLE ・ {dateLabel}
			</div>
			<div class="flex min-w-0 items-center gap-2">
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="var(--color-mi-ember-500)"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="flex-none"
					><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0Z"></path><circle
						cx="12"
						cy="10"
						r="3"
					></circle></svg
				>
				<span class="truncate text-[19px] leading-[26px] font-bold text-mi-slate-900"
					>{stopName}</span
				>
			</div>
			<div class="flex items-center gap-1.5 text-xs leading-[18px] text-mi-slate-500">
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="flex-none"
					><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"
					></polyline></svg
				>
				<span
					>現在 <span class="font-mono font-semibold text-mi-teal-600">{timeLabel}</span>
					以降を<span class="font-bold text-mi-ember-500">オレンジ</span>で表示</span
				>
			</div>
		</div>
		<button
			onclick={onClose}
			title="閉じる"
			aria-label="時刻表を閉じる"
			class="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lg text-mi-slate-500 transition-colors hover:bg-mi-slate-100 hover:text-mi-slate-700"
		>
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg
			>
		</button>
	</div>

	<!-- 本体(スクロール) -->
	<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-3.5 pt-4 pb-5">
		{#if timetable}
			{#each timetable.routes as r (r.routeId)}
				<div
					class="flex flex-col overflow-hidden rounded-[14px] border border-mi-slate-200 shadow-[0_1px_3px_rgba(7,48,61,0.06)]"
				>
					<!-- 路線見出し(上辺 3px = 路線色) -->
					<div
						class="flex items-center gap-2.5 border-b border-mi-slate-200 px-3.5 py-[11px]"
						style="border-top: 3px solid {r.color}"
					>
						<span class="h-[5px] w-5 flex-none rounded-[3px]" style="background-color: {r.color}"
						></span>
						<span
							class="min-w-0 flex-1 truncate text-[14.5px] leading-tight font-bold text-mi-slate-900"
							>{r.name}</span
						>
						<span class="flex-none text-[11px] font-semibold text-mi-slate-500"
							>{r.feedName}・{r.serviceLabel}</span
						>
					</div>
					<!-- 方向ごと(下り/上り or 行先) -->
					<div class="flex flex-wrap">
						{#each r.dirs as d (d.key)}
							{@const nextLabel = d.times.find((t) => t.isNext)?.hm ?? '本日の運行終了'}
							<div
								class="flex min-w-[150px] flex-1 flex-col border-t border-mi-slate-100 px-3 pt-[11px] pb-[13px]"
							>
								<div class="mb-[9px] flex items-center justify-between gap-2">
									<span
										class="inline-flex items-center gap-1.5 text-xs font-bold text-mi-slate-700"
									>
										<span class="h-1.5 w-1.5 rounded-full bg-mi-teal-500"></span>{d.label}
									</span>
									<span
										class="inline-flex items-baseline gap-1 text-[10.5px] font-semibold text-mi-slate-500"
										>次 <span class="font-mono text-xs font-bold text-mi-ember-500"
											>{nextLabel}</span
										></span
									>
								</div>
								<div class="flex flex-wrap gap-[5px]">
									{#each d.times as t (t.sec)}
										<span
											class="inline-flex min-w-[48px] items-center justify-center rounded-lg px-2 py-[5px] font-mono text-[13px] tabular-nums {t.isNext
												? 'bg-mi-ember-500 font-bold text-white shadow-[0_2px_8px_rgba(226,88,31,0.35)]'
												: t.isPast
													? 'bg-mi-slate-100 text-mi-slate-400'
													: 'border border-mi-slate-200 bg-white font-semibold text-mi-slate-800'}"
											>{t.hm}</span
										>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
			{#if empty}
				<div class="px-3 py-6 text-center text-[13px] leading-relaxed text-mi-slate-500">
					このバス停を通る運行中の路線は、現在レイヤで表示されていません。<br
					/>左の「路線レイヤ」から表示をオンにしてください。
				</div>
			{/if}
		{:else}
			<div class="px-3 py-6 text-center text-[13px] leading-relaxed text-mi-slate-500">
				時刻表を読み込み中…
			</div>
		{/if}
	</div>
</div>
