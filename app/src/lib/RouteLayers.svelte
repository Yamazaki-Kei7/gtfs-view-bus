<script lang="ts">
	import { onMount } from 'svelte';
	import type { Action } from 'svelte/action';
	import type { RouteInfo } from 'gtfs-core';

	let {
		routes,
		hidden = $bindable(),
		dateLabel,
	}: {
		routes: RouteInfo[];
		/** 非表示路線(key = `${feedId}|${routeId}`)。親と双方向バインド */
		hidden: Record<string, boolean>;
		dateLabel: string;
	} = $props();

	// SSR では window が無いため既定は開いた状態。マウント後にモバイル幅なら畳む。
	let open = $state(true);
	onMount(() => {
		if (window.matchMedia('(max-width: 640px)').matches) open = false;
	});

	let search = $state('');
	const searching = $derived(search.trim().length > 0);
	// 事業者・ファミリーとも既定は畳んだ状態(明示的に開いたものだけ true。検索中は自動展開)
	let expandedOp = $state<Record<string, boolean>>({});
	let expandedFam = $state<Record<string, boolean>>({});

	// パネル幅(px)。右端ハンドルのドラッグで調整、ダブルクリックで既定に戻す
	const WIDTH_DEFAULT = 288;
	const WIDTH_MIN = 232;
	const WIDTH_MAX = 560;
	let width = $state(WIDTH_DEFAULT);

	function clampWidth(w: number): number {
		return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, w));
	}

	function startResize(e: PointerEvent) {
		const handle = e.currentTarget as HTMLElement;
		const startX = e.clientX;
		const startWidth = width;
		handle.setPointerCapture(e.pointerId);
		const onMove = (ev: PointerEvent) => {
			width = clampWidth(startWidth + (ev.clientX - startX));
		};
		const onUp = () => {
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
		};
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
	}

	/** 表示ON/OFFの集計(事業者・ファミリー共通) */
	interface Counts {
		visibleCount: number;
		allOn: boolean;
		someOn: boolean;
	}
	interface Family extends Counts {
		famKey: string;
		name: string;
		routes: RouteInfo[];
	}
	type OperatorChild = { kind: 'route'; route: RouteInfo } | { kind: 'family'; family: Family };
	interface Group extends Counts {
		feedId: string;
		feedName: string;
		routes: RouteInfo[];
		children: OperatorChild[];
	}

	/**
	 * 路線名からファミリー名を導出する。
	 * 先頭の系統番号(例 "22A ")と末尾の経由カッコ(例 "（緑が丘経由）")を除去する。
	 * 空になったら元の名前を返す。
	 */
	function familyKey(name: string): string {
		let s = name.replace(/^\s*\d+[0-9A-Za-z]*\s+/, '');
		s = s.replace(/\s*[（(][^）)]*[）)]\s*$/, '');
		s = s.trim();
		return s || name;
	}

	function withCounts(rs: RouteInfo[]): Counts {
		let visibleCount = 0;
		for (const r of rs) if (!hidden[r.key]) visibleCount++;
		return {
			visibleCount,
			allOn: visibleCount === rs.length,
			someOn: visibleCount > 0 && visibleCount < rs.length,
		};
	}

	// 事業者ごと → ファミリーごとにグルーピング(order 配列で挿入順を保つ)。検索語があれば路線名・事業者名で絞り込む。
	// 開閉状態はここに含めず、テンプレート側で expandedOp / expandedFam を直接参照する(開閉で再計算しない)
	const groups = $derived.by((): Group[] => {
		const q = search.trim().toLowerCase();
		const feedOrder: string[] = [];
		const byFeed: Record<string, RouteInfo[]> = {};
		for (const r of routes) {
			if (searching && !r.name.toLowerCase().includes(q) && !r.feedName.toLowerCase().includes(q))
				continue;
			let arr = byFeed[r.feedId];
			if (!arr) {
				arr = [];
				byFeed[r.feedId] = arr;
				feedOrder.push(r.feedId);
			}
			arr.push(r);
		}

		const result: Group[] = [];
		for (const feedId of feedOrder) {
			const rs = byFeed[feedId] ?? [];
			const famOrder: string[] = [];
			const famMap: Record<string, RouteInfo[]> = {};
			for (const r of rs) {
				const fk = familyKey(r.name);
				let a = famMap[fk];
				if (!a) {
					a = [];
					famMap[fk] = a;
					famOrder.push(fk);
				}
				a.push(r);
			}
			const children: OperatorChild[] = [];
			for (const fk of famOrder) {
				const arr = famMap[fk] ?? [];
				// 同名ファミリーが2路線以上あるときだけサブグループ化する
				if (arr.length >= 2) {
					children.push({
						kind: 'family',
						family: {
							famKey: `fam:${feedId}:${fk}`,
							name: fk,
							routes: arr,
							...withCounts(arr),
						},
					});
				} else if (arr[0]) {
					children.push({ kind: 'route', route: arr[0] });
				}
			}
			result.push({
				feedId,
				feedName: rs[0]?.feedName ?? feedId,
				routes: rs,
				children,
				...withCounts(rs),
			});
		}
		return result;
	});

	const activeVisible = $derived.by(() => {
		let n = 0;
		for (const r of routes) if (!hidden[r.key]) n++;
		return n;
	});

	function toggleRoute(key: string) {
		hidden = { ...hidden, [key]: !hidden[key] };
	}

	// allOn のとき全OFF、それ以外は全ON(ファミリー・事業者チェック共通)。対象外の路線の設定は保持する
	function toggleGroup(rs: RouteInfo[], allOn: boolean) {
		const next = { ...hidden };
		for (const r of rs) {
			if (allOn) next[r.key] = true;
			else delete next[r.key];
		}
		hidden = next;
	}

	function toggleOp(feedId: string) {
		expandedOp[feedId] = !expandedOp[feedId];
	}

	function toggleFam(key: string) {
		expandedFam[key] = !expandedFam[key];
	}

	// HTML の checkbox は indeterminate を属性でバインドできないため action で設定する
	const indeterminate: Action<HTMLInputElement, boolean> = (node, value) => {
		node.indeterminate = value;
		return {
			update(v) {
				node.indeterminate = v;
			},
		};
	};
</script>

{#snippet routeRow(ly: RouteInfo)}
	<label
		class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-mi-slate-50"
	>
		<input
			type="checkbox"
			checked={!hidden[ly.key]}
			onchange={() => toggleRoute(ly.key)}
			class="m-0 flex-none accent-mi-teal-600"
		/>
		<span class="h-1 w-4 flex-none rounded-full" style="background-color: {ly.color}"></span>
		<span
			class="min-w-0 flex-1 truncate text-[12.5px] leading-tight font-semibold text-mi-slate-800"
			>{ly.name}</span
		>
		<span class="flex-none text-[10.5px] leading-tight text-mi-slate-500">{ly.serviceLabel}</span>
	</label>
{/snippet}

{#snippet chevron(expanded: boolean)}
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2.4"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="transition-transform {expanded ? 'rotate-90' : ''}"
		><polyline points="9 6 15 12 9 18"></polyline></svg
	>
{/snippet}

{#if open}
	<div
		class="absolute top-4 left-4 z-10 flex flex-col overflow-hidden rounded-2xl border border-mi-slate-200 bg-white/95 shadow-[0_10px_24px_rgba(7,48,61,0.14),0_2px_6px_rgba(7,48,61,0.08)] backdrop-blur"
		style="width: min({width}px, calc(100% - 32px))"
	>
		<!-- ヘッダ -->
		<div class="flex items-start gap-2 border-b border-mi-slate-200 py-2.5 pr-3 pl-4">
			<div class="flex min-w-0 flex-1 flex-col gap-0.5">
				<div
					class="font-display text-[11px] leading-4 font-bold tracking-[0.08em] text-mi-slate-500"
				>
					ROUTE LAYERS
				</div>
				<div class="text-sm leading-5 font-bold text-mi-slate-900">
					運行中の路線 <span class="font-semibold text-mi-teal-600">{dateLabel}</span>
				</div>
			</div>
			<button
				onclick={() => (open = false)}
				title="最小化"
				class="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-mi-slate-500 transition-colors hover:bg-mi-slate-100 hover:text-mi-slate-700"
				aria-label="路線レイヤを最小化"
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg
				>
			</button>
		</div>

		<!-- 検索 -->
		<div class="flex items-center gap-2 border-b border-mi-slate-200 px-3 py-2">
			<div class="relative flex min-w-0 flex-1 items-center">
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="var(--color-mi-slate-400)"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="pointer-events-none absolute left-2.5"
					><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"
					></line></svg
				>
				<input
					type="text"
					bind:value={search}
					placeholder="路線・事業者で検索"
					class="w-full rounded-lg border border-mi-slate-300 bg-white py-1.5 pr-2 pl-7 text-xs text-mi-slate-900 focus:border-mi-teal-400 focus:shadow-[0_0_0_3px_rgba(58,147,179,0.35)] focus:outline-none"
				/>
			</div>
		</div>

		<!-- 表示中サマリ + 一括操作 -->
		<div class="flex items-center justify-between gap-2 border-b border-mi-slate-200 px-3 py-[7px]">
			<span class="text-[11px] leading-4 text-mi-slate-500"
				>表示中 <span class="font-bold text-mi-teal-600">{activeVisible}/{routes.length}</span
				></span
			>
			<span class="flex gap-1.5">
				<button
					onclick={() => toggleGroup(routes, false)}
					class="rounded-md border border-mi-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-mi-teal-600 transition-colors hover:bg-mi-teal-50"
					>全表示</button
				>
				<button
					onclick={() => toggleGroup(routes, true)}
					class="rounded-md border border-mi-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-mi-slate-600 transition-colors hover:bg-mi-slate-100"
					>全非表示</button
				>
			</span>
		</div>

		<!-- 事業者 → ファミリー → 路線 -->
		<div class="flex max-h-[52vh] flex-col overflow-auto px-2 pt-1.5 pb-3">
			{#each groups as g (g.feedId)}
				{@const opExpanded = searching || !!expandedOp[g.feedId]}
				<div class="flex flex-col">
					<!-- 事業者見出し -->
					<div
						class="flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-mi-slate-50"
					>
						<button
							onclick={() => toggleOp(g.feedId)}
							title="開閉"
							aria-label="{g.feedName}を開閉"
							class="flex h-5 w-5 flex-none items-center justify-center rounded-md text-mi-slate-500"
						>
							{@render chevron(opExpanded)}
						</button>
						<input
							type="checkbox"
							checked={g.allOn}
							use:indeterminate={g.someOn}
							onchange={() => toggleGroup(g.routes, g.allOn)}
							class="m-0 flex-none cursor-pointer accent-mi-teal-600"
							aria-label="{g.feedName}をまとめて表示切替"
						/>
						<button
							onclick={() => toggleOp(g.feedId)}
							class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
						>
							<span
								class="min-w-0 flex-1 truncate text-[12.5px] leading-tight font-bold text-mi-slate-900"
								>{g.feedName}</span
							>
							<span
								class="flex-none rounded-full bg-mi-slate-100 px-1.5 py-px font-mono text-[10.5px] font-semibold text-mi-slate-500"
								>{g.visibleCount}/{g.routes.length}</span
							>
						</button>
					</div>

					<!-- 事業者配下(ファミリー or 単独路線) -->
					{#if opExpanded}
						<div
							class="ml-[9px] flex flex-col gap-px border-l border-mi-slate-200 pt-0.5 pb-1.5 pl-3.5"
						>
							{#each g.children as child (child.kind === 'route' ? child.route.key : child.family.famKey)}
								{#if child.kind === 'route'}
									{@render routeRow(child.route)}
								{:else}
									{@const famExpanded = searching || !!expandedFam[child.family.famKey]}
									<div class="flex flex-col">
										<!-- ファミリー見出し -->
										<div
											class="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-mi-slate-50"
										>
											<button
												onclick={() => toggleFam(child.family.famKey)}
												title="開閉"
												aria-label="{child.family.name}を開閉"
												class="flex h-5 w-5 flex-none items-center justify-center rounded-md text-mi-slate-400"
											>
												{@render chevron(famExpanded)}
											</button>
											<input
												type="checkbox"
												checked={child.family.allOn}
												use:indeterminate={child.family.someOn}
												onchange={() => toggleGroup(child.family.routes, child.family.allOn)}
												class="m-0 flex-none cursor-pointer accent-mi-teal-600"
												aria-label="{child.family.name}をまとめて表示切替"
											/>
											<button
												onclick={() => toggleFam(child.family.famKey)}
												class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
											>
												<span
													class="min-w-0 flex-1 truncate text-[12px] leading-tight font-semibold text-mi-slate-700"
													>{child.family.name}</span
												>
												<span
													class="flex-none rounded-full bg-mi-slate-100 px-1.5 py-px font-mono text-[10.5px] font-semibold text-mi-slate-500"
													>{child.family.visibleCount}/{child.family.routes.length}</span
												>
											</button>
										</div>
										{#if famExpanded}
											<div
												class="ml-[9px] flex flex-col gap-px border-l border-mi-slate-200 pt-0.5 pb-1 pl-3.5"
											>
												{#each child.family.routes as ly (ly.key)}
													{@render routeRow(ly)}
												{/each}
											</div>
										{/if}
									</div>
								{/if}
							{/each}
						</div>
					{/if}
				</div>
			{/each}

			{#if groups.length === 0}
				<div class="px-2 py-4 text-center text-xs leading-relaxed text-mi-slate-500">
					{#if search.trim()}該当する路線がありません{:else}この日に運行する路線はありません{/if}
				</div>
			{/if}
		</div>

		<!-- 幅調整ハンドル(ドラッグ / ←→キー / ダブルクリックで既定幅)。
		     WAI-ARIA の window splitter パターン(フォーカス可能な separator)であり、
		     svelte-check が非対話要素と誤検知するため ignore を指定 -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="パネル幅を調整"
			aria-valuenow={width}
			aria-valuemin={WIDTH_MIN}
			aria-valuemax={WIDTH_MAX}
			tabindex="0"
			class="absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none transition-colors hover:bg-mi-teal-300/50 focus:bg-mi-teal-300/50 focus:outline-none"
			onpointerdown={startResize}
			ondblclick={() => (width = WIDTH_DEFAULT)}
			onkeydown={(e) => {
				if (e.key === 'ArrowLeft') width = clampWidth(width - 16);
				else if (e.key === 'ArrowRight') width = clampWidth(width + 16);
			}}
		></div>
	</div>
{:else}
	<button
		onclick={() => (open = true)}
		title="路線レイヤを表示"
		class="absolute top-4 left-4 z-10 flex items-center gap-2 rounded-[10px] border border-mi-slate-200 bg-white/95 px-3.5 py-2 text-[13px] font-semibold text-mi-slate-900 shadow-[0_4px_12px_rgba(7,48,61,0.14)] backdrop-blur transition-colors hover:bg-mi-teal-50"
	>
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--color-mi-teal-600)"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"
			></polyline><polyline points="2 12 12 17 22 12"></polyline></svg
		>
		<span>路線レイヤ</span>
	</button>
{/if}
