// Availability interval math (Phase 2). Pure module — no Cloudflare imports —
// so it can be exercised outside the Workers runtime.
// Semantics per docs/AGENTIC-CALENDAR-SPEC.md §5/§9: busy = merged opaque
// intervals; free slots = gaps intersected with working hours in the
// operator's timezone. All math in epoch ms UTC; the MCP layer does ISO 8601.

export interface Interval {
	start: number; // epoch ms UTC, inclusive
	end: number; // epoch ms UTC, exclusive
}

export interface WorkingHours {
	start: string; // "HH:MM" operator-local
	end: string; // "HH:MM"
	tz: string; // IANA timezone
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
	start: "08:00",
	end: "18:00",
	tz: "America/Los_Angeles",
};

const MAX_SLOTS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Merge overlapping/adjacent intervals into a sorted, disjoint list. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
	const sorted = intervals
		.filter((iv) => iv.end > iv.start)
		.sort((a, b) => a.start - b.start);
	const merged: Interval[] = [];
	for (const iv of sorted) {
		const last = merged[merged.length - 1];
		if (last && iv.start <= last.end) {
			last.end = Math.max(last.end, iv.end);
		} else {
			merged.push({ ...iv });
		}
	}
	return merged;
}

// ── Timezone helpers (Intl-based; no tz library on Workers) ───────

function tzOffsetMs(utcMs: number, tz: string): number {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const parts: Record<string, string> = {};
	for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
	const asUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour) % 24, // Intl emits "24" for midnight in some locales
		Number(parts.minute),
		Number(parts.second),
	);
	return asUtc - utcMs;
}

/** Convert a wall-clock time in `tz` to the UTC instant it names. */
function wallTimeToUtc(
	y: number,
	mo: number, // 1-12
	d: number,
	hh: number,
	mm: number,
	tz: string,
): number {
	const naive = Date.UTC(y, mo - 1, d, hh, mm);
	// Two-pass: estimate the offset at the naive instant, re-evaluate at the
	// corrected instant so DST boundaries land on the right side.
	let utc = naive - tzOffsetMs(naive, tz);
	utc = naive - tzOffsetMs(utc, tz);
	return utc;
}

function localDateParts(utcMs: number, tz: string): { y: number; mo: number; d: number } {
	const dtf = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const [y, mo, d] = dtf.format(new Date(utcMs)).split("-").map(Number);
	return { y, mo, d };
}

function parseHHMM(s: string): { h: number; m: number } {
	const match = s.trim().match(/^(\d{1,2}):(\d{2})$/);
	if (!match) throw new Error(`Invalid HH:MM time "${s}"`);
	const h = Number(match[1]);
	const m = Number(match[2]);
	if (h > 23 || m > 59) throw new Error(`Invalid HH:MM time "${s}"`);
	return { h, m };
}

/**
 * Compute the working-hours windows (one per local day) that overlap
 * [windowStartMs, windowEndMs).
 */
export function workingWindows(
	windowStartMs: number,
	windowEndMs: number,
	hours: WorkingHours,
): Interval[] {
	const { h: sh, m: sm } = parseHHMM(hours.start);
	const { h: eh, m: em } = parseHHMM(hours.end);
	const out: Interval[] = [];

	// Walk local days via each day's local noon (immune to DST 23/25h days).
	let cursor = windowStartMs - DAY_MS; // start one day early to catch overlap
	const hardStop = windowEndMs + DAY_MS;
	while (cursor < hardStop) {
		const { y, mo, d } = localDateParts(cursor, hours.tz);
		const dayStart = wallTimeToUtc(y, mo, d, sh, sm, hours.tz);
		const dayEnd = wallTimeToUtc(y, mo, d, eh, em, hours.tz);
		const start = Math.max(dayStart, windowStartMs);
		const end = Math.min(dayEnd, windowEndMs);
		if (end > start) out.push({ start, end });
		cursor = wallTimeToUtc(y, mo, d, 12, 0, hours.tz) + DAY_MS;
	}
	return mergeIntervals(out);
}

/**
 * Free slots = working windows minus busy intervals (each padded by
 * minGapMinutes on both sides). Returned slots are the full free gaps —
 * any start time with start + duration <= end fits. Sorted, capped at 20.
 */
export function findFreeSlots(opts: {
	busy: Interval[];
	windowStartMs: number;
	windowEndMs: number;
	durationMinutes: number;
	workingHours?: WorkingHours;
	minGapMinutes?: number;
}): Interval[] {
	const durationMs = opts.durationMinutes * 60_000;
	if (durationMs <= 0) return [];
	const gapMs = (opts.minGapMinutes ?? 0) * 60_000;

	const padded = mergeIntervals(
		opts.busy.map((iv) => ({ start: iv.start - gapMs, end: iv.end + gapMs })),
	);
	const windows = workingWindows(
		opts.windowStartMs,
		opts.windowEndMs,
		opts.workingHours ?? DEFAULT_WORKING_HOURS,
	);

	const slots: Interval[] = [];
	for (const win of windows) {
		let cursor = win.start;
		for (const busy of padded) {
			if (busy.end <= cursor) continue;
			if (busy.start >= win.end) break;
			if (busy.start - cursor >= durationMs) {
				slots.push({ start: cursor, end: busy.start });
			}
			cursor = Math.max(cursor, busy.end);
			if (cursor >= win.end) break;
		}
		if (win.end - cursor >= durationMs) {
			slots.push({ start: cursor, end: win.end });
		}
		if (slots.length >= MAX_SLOTS) break;
	}
	return slots.slice(0, MAX_SLOTS);
}
