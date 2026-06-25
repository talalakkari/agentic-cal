// Calendar view — month / week / day / list views over the merged set of polled
// feed events (read-only) and agent-created blocks. Read-only display: click an
// item for details; blocks can be cancelled (the only write). Rendered at /calendar
// inside the calendar layout. All time math is tz-aware via app/lib/calendar-datetime.

import { Badge, Button, Dialog, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarBlock } from "~/services/api";
import {
	useCalendarBlocks,
	useCalendarEvents,
	useCancelCalendarBlock,
} from "~/queries/calendar";
import {
	type CivilDate,
	addDays,
	civilKey,
	civilOf,
	formatDayHeading,
	formatMonthDay,
	formatMonthYear,
	formatTime,
	formatTimeRange,
	formatHourLabel,
	formatWeekRange,
	formatWeekdayShort,
	isSameMonth,
	isToday,
	isoWindow,
	minutesInDay,
	monthGridDays,
	tzAbbrev,
	tzDayKey,
	weekDays,
} from "~/lib/calendar-datetime";

export function meta() {
	return [{ title: "Calendar" }];
}

type ViewKind = "month" | "week" | "day" | "list";

interface CalItem {
	key: string;
	title: string;
	startMs: number;
	endMs: number;
	allDay: boolean;
	source: string; // feed id, or "block"
	kind: "event" | "block";
	block?: CalendarBlock;
}

// Literal Tailwind classes per source (JIT needs them spelled out). Color-codes
// events by calendar; agent blocks are emerald. Translucent fills sit fine on
// either theme without dark: variants.
const SOURCE_STYLE: Record<string, { dot: string; band: string; chip: string }> = {
	proton: { dot: "bg-purple-500", band: "border-l-purple-500 bg-purple-500/10", chip: "border-purple-500/30 bg-purple-500/10" },
	icloud: { dot: "bg-sky-500", band: "border-l-sky-500 bg-sky-500/10", chip: "border-sky-500/30 bg-sky-500/10" },
	outlook: { dot: "bg-blue-500", band: "border-l-blue-500 bg-blue-500/10", chip: "border-blue-500/30 bg-blue-500/10" },
	block: { dot: "bg-emerald-500", band: "border-l-emerald-500 bg-emerald-500/10", chip: "border-emerald-500/30 bg-emerald-500/10" },
};
const FALLBACK_STYLE = { dot: "bg-gray-400", band: "border-l-gray-400 bg-gray-400/10", chip: "border-gray-400/30 bg-gray-400/10" };
const styleFor = (source: string) => SOURCE_STYLE[source] ?? FALLBACK_STYLE;

const BLOCK_STATUS_BADGE: Record<
	CalendarBlock["status"],
	"success" | "beta" | "secondary" | "outline"
> = { confirmed: "success", partial: "beta", pending: "secondary", cancelled: "outline" };

const PARTSTAT_GLYPH: Record<string, string> = {
	ACCEPTED: "✓",
	DECLINED: "✗",
	TENTATIVE: "~",
	"NEEDS-ACTION": "…",
};

const HOUR_PX = 44; // px per hour in the time grid
const SCROLL_TO_HOUR = 7; // initial scroll position for week/day

const VIEWS: ViewKind[] = ["month", "week", "day", "list"];
const LIST_DAYS = 45;

const seg = (active: boolean) =>
	`px-2.5 py-1 text-sm rounded-md transition-colors ${
		active ? "bg-kumo-fill text-kumo-default font-medium" : "text-kumo-subtle hover:text-kumo-default"
	}`;

function itemsForDay(items: CalItem[], dayKey: string): CalItem[] {
	return items.filter((it) => tzDayKey(it.startMs) === dayKey);
}

export default function CalendarViewRoute() {
	const [view, setView] = useState<ViewKind>("month");
	const [cursorMs, setCursorMs] = useState(() => civilOf(Date.now()).getTime());
	const [selected, setSelected] = useState<CalItem | null>(null);

	const cursor = civilOf(cursorMs);

	// Days the current view renders, and the (padded) fetch window.
	const rangeDays: CivilDate[] = useMemo(() => {
		if (view === "month") return monthGridDays(cursor);
		if (view === "week") return weekDays(cursor);
		if (view === "day") return [cursor];
		return Array.from({ length: LIST_DAYS }, (_, i) => addDays(cursor, i));
	}, [view, cursorMs]);

	const { fromIso, toIso } = isoWindow(rangeDays[0], rangeDays[rangeDays.length - 1]);
	const eventsQ = useCalendarEvents(fromIso, toIso);
	const blocksQ = useCalendarBlocks();

	const items: CalItem[] = useMemo(() => {
		const evs: CalItem[] = (eventsQ.data?.events ?? [])
			.filter((e) => e.is_own_block === 0) // our blocks come from /blocks; avoid double-display
			.map((e) => ({
				key: `e${e.id}`,
				title: e.summary ?? "Busy",
				startMs: e.dtstart,
				endMs: e.dtend,
				allDay: e.all_day === 1,
				source: e.feed_id,
				kind: "event" as const,
			}));
		const blks: CalItem[] = (blocksQ.data?.blocks ?? []).map((b) => ({
			key: `b${b.uid}`,
			title: b.title,
			startMs: Date.parse(b.start),
			endMs: Date.parse(b.end),
			allDay: false,
			source: "block",
			kind: "block" as const,
			block: b,
		}));
		return [...evs, ...blks].sort((a, b) => a.startMs - b.startMs);
	}, [eventsQ.data, blocksQ.data]);

	const shift = (dir: -1 | 1) => {
		if (view === "month") {
			setCursorMs(
				Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + dir, 1, 12),
			);
		} else if (view === "week") {
			setCursorMs(addDays(cursor, 7 * dir).getTime());
		} else if (view === "day") {
			setCursorMs(addDays(cursor, dir).getTime());
		} else {
			setCursorMs(addDays(cursor, LIST_DAYS * dir).getTime());
		}
	};

	const periodLabel =
		view === "month"
			? formatMonthYear(cursor)
			: view === "week"
				? formatWeekRange(rangeDays)
				: view === "day"
					? formatDayHeading(cursor)
					: `${formatMonthDay(rangeDays[0])} – ${formatMonthDay(rangeDays[rangeDays.length - 1])}`;

	const loading = eventsQ.isLoading && blocksQ.isLoading;

	return (
		<div>
			{/* Controls */}
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<Button variant="secondary" size="sm" onClick={() => setCursorMs(civilOf(Date.now()).getTime())}>
						Today
					</Button>
					<div className="flex items-center">
						<Button
							variant="ghost"
							size="sm"
							shape="square"
							icon={<CaretLeftIcon size={16} />}
							aria-label="Previous"
							onClick={() => shift(-1)}
						/>
						<Button
							variant="ghost"
							size="sm"
							shape="square"
							icon={<CaretRightIcon size={16} />}
							aria-label="Next"
							onClick={() => shift(1)}
						/>
					</div>
					<h2 className="text-base font-semibold text-kumo-default">{periodLabel}</h2>
					<span className="text-xs text-kumo-subtle">{tzAbbrev()}</span>
				</div>
				<nav className="inline-flex rounded-lg border border-kumo-line bg-kumo-base p-0.5">
					{VIEWS.map((v) => (
						<button key={v} type="button" className={seg(view === v)} onClick={() => setView(v)}>
							{v[0].toUpperCase() + v.slice(1)}
						</button>
					))}
				</nav>
			</div>

			{loading ? (
				<div className="flex justify-center py-20">
					<Loader size="lg" />
				</div>
			) : view === "month" ? (
				<MonthView
					days={rangeDays}
					cursor={cursor}
					items={items}
					onPick={setSelected}
					onPickDay={(d) => {
						setCursorMs(d.getTime());
						setView("day");
					}}
				/>
			) : view === "list" ? (
				<ListView days={rangeDays} items={items} onPick={setSelected} />
			) : (
				<TimeGrid days={rangeDays} items={items} onPick={setSelected} />
			)}

			<Legend />

			<DetailDialog item={selected} onClose={() => setSelected(null)} />
		</div>
	);
}

function Legend() {
	return (
		<div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-kumo-subtle">
			{[
				["proton", "Proton"],
				["icloud", "iCloud"],
				["outlook", "Outlook"],
				["block", "Agent block"],
			].map(([src, label]) => (
				<span key={src} className="inline-flex items-center gap-1.5">
					<span className={`h-2 w-2 rounded-full ${styleFor(src).dot}`} />
					{label}
				</span>
			))}
		</div>
	);
}

function ItemDot({ source }: { source: string }) {
	return <span className={`h-2 w-2 shrink-0 rounded-full ${styleFor(source).dot}`} />;
}

// ── Month ──────────────────────────────────────────────────────────────

function MonthView({
	days,
	cursor,
	items,
	onPick,
	onPickDay,
}: {
	days: CivilDate[];
	cursor: CivilDate;
	items: CalItem[];
	onPick: (it: CalItem) => void;
	onPickDay: (d: CivilDate) => void;
}) {
	const MAX_CHIPS = 3;
	return (
		<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
			<div className="grid grid-cols-7 border-b border-kumo-line">
				{days.slice(0, 7).map((d) => (
					<div key={civilKey(d)} className="px-2 py-1.5 text-center text-xs font-medium text-kumo-subtle">
						{formatWeekdayShort(d)}
					</div>
				))}
			</div>
			<div className="grid grid-cols-7">
				{days.map((d, idx) => {
					const key = civilKey(d);
					const dayItems = itemsForDay(items, key);
					const muted = !isSameMonth(d, cursor);
					const today = isToday(d);
					return (
						<div
							key={key}
							className={`min-h-24 border-kumo-line p-1 ${idx % 7 !== 0 ? "border-l" : ""} ${idx >= 7 ? "border-t" : ""} ${muted ? "bg-kumo-recessed/40" : ""}`}
						>
							<button
								type="button"
								onClick={() => onPickDay(d)}
								className={`mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs ${today ? "bg-kumo-brand font-bold text-kumo-inverse" : muted ? "text-kumo-subtle" : "text-kumo-default"} hover:bg-kumo-tint`}
							>
								{d.getUTCDate()}
							</button>
							<div className="flex flex-col gap-0.5">
								{dayItems.slice(0, MAX_CHIPS).map((it) => (
									<button
										key={it.key}
										type="button"
										onClick={() => onPick(it)}
										className={`flex items-center gap-1 truncate rounded border-l-2 px-1 py-0.5 text-left text-xs text-kumo-default ${styleFor(it.source).band} ${it.block?.status === "cancelled" ? "line-through opacity-50" : ""}`}
										title={it.title}
									>
										{!it.allDay && (
											<span className="shrink-0 text-[10px] text-kumo-subtle">{formatTime(it.startMs)}</span>
										)}
										<span className="truncate">{it.title}</span>
									</button>
								))}
								{dayItems.length > MAX_CHIPS && (
									<button
										type="button"
										onClick={() => onPickDay(d)}
										className="px-1 text-left text-[11px] text-kumo-subtle hover:text-kumo-default"
									>
										+{dayItems.length - MAX_CHIPS} more
									</button>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

// ── List / agenda ────────────────────────────────────────────────────────

function ListView({
	days,
	items,
	onPick,
}: {
	days: CivilDate[];
	items: CalItem[];
	onPick: (it: CalItem) => void;
}) {
	const daysWithItems = days
		.map((d) => ({ d, key: civilKey(d), dayItems: itemsForDay(items, civilKey(d)) }))
		.filter((x) => x.dayItems.length > 0);

	if (daysWithItems.length === 0) {
		return (
			<div className="rounded-xl border border-kumo-line bg-kumo-base px-5 py-12 text-center text-sm text-kumo-subtle">
				No events in this range.
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			{daysWithItems.map(({ d, key, dayItems }) => (
				<div key={key}>
					<div className={`mb-1.5 text-sm font-semibold ${isToday(d) ? "text-kumo-brand" : "text-kumo-default"}`}>
						{formatDayHeading(d)}
					</div>
					<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
						{dayItems.map((it, idx) => (
							<button
								key={it.key}
								type="button"
								onClick={() => onPick(it)}
								className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-kumo-tint ${idx > 0 ? "border-t border-kumo-line" : ""}`}
							>
								<ItemDot source={it.source} />
								<span className="w-32 shrink-0 text-xs text-kumo-subtle">
									{it.allDay ? "All day" : formatTimeRange(it.startMs, it.endMs)}
								</span>
								<span className={`min-w-0 flex-1 truncate text-sm text-kumo-default ${it.block?.status === "cancelled" ? "line-through opacity-60" : ""}`}>
									{it.title}
								</span>
								{it.block?.last_error && <Badge variant="destructive">invite failed</Badge>}
								{it.kind === "block" && it.block && it.block.status !== "cancelled" && (
									<Badge variant={BLOCK_STATUS_BADGE[it.block.status]}>{it.block.status}</Badge>
								)}
							</button>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

// ── Week / Day time grid ──────────────────────────────────────────────────

interface Positioned {
	item: CalItem;
	top: number;
	height: number;
	lane: number;
	lanes: number;
}

/** Greedy lane packing of overlapping timed items within one day column. */
function layoutDay(dayItems: CalItem[], dayKey: string): Positioned[] {
	const timed = dayItems
		.filter((it) => !it.allDay)
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	const out: Positioned[] = [];
	let cluster: CalItem[] = [];
	let clusterEnd = -Infinity;

	const flush = () => {
		const laneEnds: number[] = [];
		const laneOf = new Map<string, number>();
		for (const it of cluster) {
			let lane = laneEnds.findIndex((end) => end <= it.startMs);
			if (lane === -1) {
				lane = laneEnds.length;
				laneEnds.push(it.endMs);
			} else {
				laneEnds[lane] = it.endMs;
			}
			laneOf.set(it.key, lane);
		}
		const lanes = laneEnds.length;
		for (const it of cluster) {
			const startMin = tzDayKey(it.startMs) === dayKey ? minutesInDay(it.startMs) : 0;
			let endMin = tzDayKey(it.endMs) === dayKey ? minutesInDay(it.endMs) : 1440;
			if (endMin <= startMin) endMin = Math.min(startMin + 30, 1440);
			out.push({
				item: it,
				top: (startMin / 60) * HOUR_PX,
				height: Math.max(((endMin - startMin) / 60) * HOUR_PX, 16),
				lane: laneOf.get(it.key) ?? 0,
				lanes,
			});
		}
		cluster = [];
		clusterEnd = -Infinity;
	};

	for (const it of timed) {
		if (cluster.length && it.startMs >= clusterEnd) flush();
		cluster.push(it);
		clusterEnd = Math.max(clusterEnd, it.endMs);
	}
	if (cluster.length) flush();
	return out;
}

function TimeGrid({
	days,
	items,
	onPick,
}: {
	days: CivilDate[];
	items: CalItem[];
	onPick: (it: CalItem) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (scrollRef.current) scrollRef.current.scrollTop = SCROLL_TO_HOUR * HOUR_PX;
	}, [days.length]);

	const hours = Array.from({ length: 24 }, (_, h) => h);
	const cols = days.map((d) => {
		const key = civilKey(d);
		const dayItems = itemsForDay(items, key);
		return {
			d,
			key,
			allDay: dayItems.filter((it) => it.allDay),
			positioned: layoutDay(dayItems, key),
		};
	});
	const anyAllDay = cols.some((c) => c.allDay.length > 0);

	return (
		<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
			{/* Day headers */}
			<div className="flex border-b border-kumo-line">
				<div className="w-14 shrink-0" />
				{cols.map((c) => (
					<div key={c.key} className="flex-1 border-l border-kumo-line px-2 py-1.5 text-center">
						<div className="text-xs text-kumo-subtle">{formatWeekdayShort(c.d)}</div>
						<div className={`text-sm font-semibold ${isToday(c.d) ? "text-kumo-brand" : "text-kumo-default"}`}>
							{c.d.getUTCDate()}
						</div>
					</div>
				))}
			</div>

			{/* All-day row */}
			{anyAllDay && (
				<div className="flex border-b border-kumo-line bg-kumo-recessed/40">
					<div className="flex w-14 shrink-0 items-center justify-end pr-2 text-[10px] text-kumo-subtle">all-day</div>
					{cols.map((c) => (
						<div key={c.key} className="flex-1 space-y-0.5 border-l border-kumo-line p-1">
							{c.allDay.map((it) => (
								<button
									key={it.key}
									type="button"
									onClick={() => onPick(it)}
									className={`block w-full truncate rounded border-l-2 px-1 py-0.5 text-left text-xs text-kumo-default ${styleFor(it.source).band}`}
									title={it.title}
								>
									{it.title}
								</button>
							))}
						</div>
					))}
				</div>
			)}

			{/* Scrollable hour grid */}
			<div ref={scrollRef} className="max-h-[640px] overflow-y-auto">
				<div className="flex">
					{/* Hour gutter */}
					<div className="w-14 shrink-0">
						{hours.map((h) => (
							<div key={h} className="relative border-b border-kumo-line" style={{ height: HOUR_PX }}>
								<span className="absolute -top-2 right-2 text-[10px] text-kumo-subtle">
									{h === 0 ? "" : formatHourLabel(h)}
								</span>
							</div>
						))}
					</div>
					{/* Day columns */}
					{cols.map((c) => (
						<div key={c.key} className="relative flex-1 border-l border-kumo-line">
							{hours.map((h) => (
								<div
									key={h}
									className={`border-b border-kumo-line ${h >= 8 && h < 18 ? "bg-kumo-tint/30" : ""}`}
									style={{ height: HOUR_PX }}
								/>
							))}
							{c.positioned.map((p) => {
								const widthPct = 100 / p.lanes;
								return (
									<button
										key={p.item.key}
										type="button"
										onClick={() => onPick(p.item)}
										className={`absolute overflow-hidden rounded border-l-2 px-1 text-left text-xs text-kumo-default ${styleFor(p.item.source).band} ${p.item.block?.status === "cancelled" ? "line-through opacity-50" : ""}`}
										style={{
											top: p.top,
											height: p.height,
											left: `calc(${p.lane * widthPct}% + 2px)`,
											width: `calc(${widthPct}% - 4px)`,
										}}
										title={`${p.item.title} · ${formatTimeRange(p.item.startMs, p.item.endMs)}`}
									>
										<span className="block truncate font-medium">{p.item.title}</span>
										{p.height > 28 && (
											<span className="block truncate text-[10px] text-kumo-subtle">
												{formatTime(p.item.startMs)}
											</span>
										)}
									</button>
								);
							})}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

// ── Detail dialog ──────────────────────────────────────────────────────────

function DetailDialog({ item, onClose }: { item: CalItem | null; onClose: () => void }) {
	const toastManager = useKumoToastManager();
	const cancelBlock = useCancelCalendarBlock();

	const handleCancel = async () => {
		if (!item?.block) return;
		if (!window.confirm(`Cancel "${item.block.title}" on every calendar?`)) return;
		try {
			await cancelBlock.mutateAsync(item.block.uid);
			toastManager.add({ title: "Cancellation sent to all calendars" });
			onClose();
		} catch (err) {
			toastManager.add({
				title: (err as Error).message || "Failed to cancel block",
				variant: "error",
			});
		}
	};

	return (
		<Dialog.Root open={!!item} onOpenChange={(open) => !open && onClose()}>
			<Dialog size="sm" className="p-6">
				{item && (
					<>
						<Dialog.Title className="mb-1 flex items-center gap-2 text-base font-semibold">
							<ItemDot source={item.source} />
							<span className="min-w-0 truncate">{item.title}</span>
						</Dialog.Title>
						<div className="space-y-1 text-sm text-kumo-subtle">
							<div>{formatDayHeading(civilOf(item.startMs))}</div>
							<div>
								{item.allDay ? "All day" : `${formatTimeRange(item.startMs, item.endMs)} ${tzAbbrev(item.startMs)}`}
							</div>
							<div className="capitalize">
								{item.kind === "block" ? "Agent block" : `${item.source} calendar`}
							</div>
						</div>

						{item.block && (
							<div className="mt-4 space-y-3">
								<div className="flex items-center gap-2">
									<Badge variant={BLOCK_STATUS_BADGE[item.block.status]}>{item.block.status}</Badge>
									{item.block.last_error && <Badge variant="destructive">invite failed</Badge>}
								</div>
								{item.block.last_error && (
									<p className="text-xs text-kumo-danger">No invites sent — {item.block.last_error}</p>
								)}
								<div className="flex flex-wrap gap-2 text-xs text-kumo-subtle">
									{item.block.attendees.map((a) => (
										<span key={a.account} className="rounded-full border border-kumo-line px-2 py-0.5" title={a.partstat}>
											{a.account} {PARTSTAT_GLYPH[a.partstat] ?? "?"}
										</span>
									))}
								</div>
							</div>
						)}

						<div className="mt-6 flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Close
									</Button>
								)}
							/>
							{item.block && item.block.status !== "cancelled" && (
								<Button variant="destructive" size="sm" loading={cancelBlock.isPending} onClick={handleCancel}>
									Cancel block
								</Button>
							)}
						</div>
					</>
				)}
			</Dialog>
		</Dialog.Root>
	);
}
