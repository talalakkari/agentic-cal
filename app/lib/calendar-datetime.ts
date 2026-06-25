// Timezone-aware date helpers for the calendar view. Events are absolute epoch-ms
// instants; we render them in the app's canonical timezone (America/Los_Angeles —
// the same tz as DEFAULT_WORKING_HOURS / availability), so the UI agrees with what
// the agent reasons about. All tz math goes through Intl (DST-correct); no date lib.
//
// Civil-date arithmetic uses a "carrier" Date pinned to 12:00 UTC of a y/m/d. Noon
// UTC is always morning in PT, so the carrier's UTC calendar fields equal the PT
// calendar date it represents — and adding days via setUTCDate is DST-safe. We never
// need the (hard) civil→instant inverse: events are bucketed by their PT day key and
// positioned by their PT minute-of-day, both read directly from the instant.

export const CAL_TZ = "America/Los_Angeles";

const partsFmt = new Intl.DateTimeFormat("en-US", {
	timeZone: CAL_TZ,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
	weekday: "short",
});

const WEEKDAY_IDX: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

export interface TzParts {
	year: number;
	month: number; // 1-12
	day: number;
	hour: number; // 0-23
	minute: number;
	weekday: number; // 0=Sun
}

/** Wall-clock parts of an instant in CAL_TZ. */
export function tzParts(ms: number): TzParts {
	const parts = partsFmt.formatToParts(new Date(ms));
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
	let hour = parseInt(get("hour"), 10);
	if (hour === 24) hour = 0; // hour12:false can emit "24" at midnight
	return {
		year: Number(get("year")),
		month: Number(get("month")),
		day: Number(get("day")),
		hour,
		minute: Number(get("minute")),
		weekday: WEEKDAY_IDX[get("weekday")] ?? 0,
	};
}

/** "YYYY-MM-DD" of an instant in CAL_TZ — the key for bucketing events into days. */
export function tzDayKey(ms: number): string {
	const p = tzParts(ms);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutes since local midnight in CAL_TZ (0-1439), for vertical grid positioning. */
export function minutesInDay(ms: number): number {
	const p = tzParts(ms);
	return p.hour * 60 + p.minute;
}

// ── Civil-date carriers (12:00 UTC of a PT calendar date) ──────────────

export type CivilDate = Date;

export function civilOf(ms: number): CivilDate {
	const p = tzParts(ms);
	return new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
}

export function civilKey(c: CivilDate): string {
	return `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, "0")}-${String(c.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(c: CivilDate, n: number): CivilDate {
	const d = new Date(c);
	d.setUTCDate(d.getUTCDate() + n);
	return d;
}

/** 0=Sun … 6=Sat for the civil date. */
export function civilWeekday(c: CivilDate): number {
	return c.getUTCDay();
}

/** Sunday-start week. */
export function startOfWeek(c: CivilDate): CivilDate {
	return addDays(c, -civilWeekday(c));
}

export function startOfMonth(c: CivilDate): CivilDate {
	return new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), 1, 12));
}

/** 42 days (6 weeks) covering the month grid containing `c`. */
export function monthGridDays(c: CivilDate): CivilDate[] {
	const start = startOfWeek(startOfMonth(c));
	return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** The 7 days of the Sunday-start week containing `c`. */
export function weekDays(c: CivilDate): CivilDate[] {
	const start = startOfWeek(c);
	return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function isToday(c: CivilDate): boolean {
	return civilKey(c) === civilKey(civilOf(Date.now()));
}

export function isSameMonth(c: CivilDate, ref: CivilDate): boolean {
	return (
		c.getUTCFullYear() === ref.getUTCFullYear() &&
		c.getUTCMonth() === ref.getUTCMonth()
	);
}

/**
 * ISO query bounds covering a span of civil days, padded ±1 day so an over-fetch
 * never clips edge events (the /events endpoint filters precisely by dtstart/dtend,
 * and we re-bucket client-side by tzDayKey).
 */
export function isoWindow(first: CivilDate, last: CivilDate): {
	fromIso: string;
	toIso: string;
} {
	return {
		fromIso: new Date(first.getTime() - 24 * 3600_000).toISOString(),
		toIso: new Date(last.getTime() + 24 * 3600_000).toISOString(),
	};
}

// ── Labels (carrier formatters read UTC fields = the PT civil date) ────

const monthYearFmt = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	month: "long",
	year: "numeric",
});
const dayHeadingFmt = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	weekday: "long",
	month: "long",
	day: "numeric",
	year: "numeric",
});
const weekdayShortFmt = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	weekday: "short",
});
const monthDayFmt = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	month: "short",
	day: "numeric",
});

export function formatMonthYear(c: CivilDate): string {
	return monthYearFmt.format(c);
}
export function formatDayHeading(c: CivilDate): string {
	return dayHeadingFmt.format(c);
}
export function formatWeekdayShort(c: CivilDate): string {
	return weekdayShortFmt.format(c);
}
export function formatMonthDay(c: CivilDate): string {
	return monthDayFmt.format(c);
}

export function formatWeekRange(days: CivilDate[]): string {
	if (days.length === 0) return "";
	const first = days[0];
	const last = days[days.length - 1];
	return `${monthDayFmt.format(first)} – ${monthDayFmt.format(last)}, ${last.getUTCFullYear()}`;
}

const timeFmt = new Intl.DateTimeFormat("en-US", {
	timeZone: CAL_TZ,
	hour: "numeric",
	minute: "2-digit",
});

/** "2:00 PM" in CAL_TZ. */
export function formatTime(ms: number): string {
	return timeFmt.format(new Date(ms));
}

/** "2:00 – 3:00 PM" in CAL_TZ (start time drops the meridiem when it matches the end). */
export function formatTimeRange(startMs: number, endMs: number): string {
	return `${formatTime(startMs)} – ${formatTime(endMs)}`;
}

/** "8 AM" hour label for the time grid (0-23 → 12-hour). */
export function formatHourLabel(hour: number): string {
	const h12 = hour % 12 === 0 ? 12 : hour % 12;
	const mer = hour < 12 ? "AM" : "PM";
	return `${h12} ${mer}`;
}

const tzNameFmt = new Intl.DateTimeFormat("en-US", {
	timeZone: CAL_TZ,
	timeZoneName: "short",
});

/** "PDT"/"PST" for the given instant (defaults to now). */
export function tzAbbrev(ms: number = Date.now()): string {
	return (
		tzNameFmt.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")
			?.value ?? "PT"
	);
}
