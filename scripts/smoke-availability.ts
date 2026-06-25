// Smoke test for workers/calendar/availability.ts (npx tsx scripts/smoke-availability.ts).
// Exercises interval merging, working-hours windows in a real timezone, free
// slot math with duration + min-gap padding.

import {
	findFreeSlots,
	mergeIntervals,
	workingWindows,
} from "../workers/calendar/availability";

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`ok: ${msg}`);
}

const T = (s: string) => Date.parse(s);

// ── mergeIntervals ──
const merged = mergeIntervals([
	{ start: 10, end: 20 },
	{ start: 15, end: 25 },
	{ start: 30, end: 40 },
	{ start: 40, end: 50 }, // adjacent → merged
	{ start: 5, end: 3 }, // inverted → dropped
]);
assert(
	merged.length === 2 && merged[0].end === 25 && merged[1].end === 50,
	`mergeIntervals collapses overlaps + adjacency (got ${JSON.stringify(merged)})`,
);

// ── workingWindows: one PDT day, 08:00–18:00 = 15:00Z–01:00Z(+1) ──
const winStart = T("2026-06-15T00:00:00Z");
const winEnd = T("2026-06-16T00:00:00Z");
const windows = workingWindows(winStart, winEnd, {
	start: "08:00",
	end: "18:00",
	tz: "America/Los_Angeles",
});
// June 15 08:00 PDT = 15:00Z; window clips at 16th 00:00Z (= Jun 15 17:00 PDT)
assert(
	windows.length === 2,
	`PDT working hours straddle the UTC day boundary -> 2 windows in a UTC day (got ${windows.length})`,
);
assert(
	new Date(windows[1].start).toISOString() === "2026-06-15T15:00:00.000Z",
	`08:00 PDT converts to 15:00Z (got ${new Date(windows[1].start).toISOString()})`,
);

// ── findFreeSlots: busy 9-10 and 13-15 PDT on Jun 15 ──
const busy = [
	{ start: T("2026-06-15T16:00:00Z"), end: T("2026-06-15T17:00:00Z") }, // 9-10 PDT
	{ start: T("2026-06-15T20:00:00Z"), end: T("2026-06-15T22:00:00Z") }, // 13-15 PDT
];
const slots = findFreeSlots({
	busy,
	windowStartMs: T("2026-06-15T07:00:00Z"), // pre-working-hours
	windowEndMs: T("2026-06-16T02:00:00Z"), // past 18:00 PDT (= 01:00Z+1)
	durationMinutes: 60,
	workingHours: { start: "08:00", end: "18:00", tz: "America/Los_Angeles" },
});
// Expected gaps: 08-09 PDT (15-16Z), 10-13 PDT (17-20Z), 15-18 PDT (22-01Z)
assert(slots.length === 3, `three free gaps >= 60min (got ${slots.length}: ${JSON.stringify(slots.map(s => [new Date(s.start).toISOString(), new Date(s.end).toISOString()]))})`);
assert(
	new Date(slots[1].start).toISOString() === "2026-06-15T17:00:00.000Z" &&
		new Date(slots[1].end).toISOString() === "2026-06-15T20:00:00.000Z",
	"middle gap is 10:00-13:00 PDT",
);

// min_gap 30min padding shrinks the 10-13 gap to 10:30-12:30 (still >= 60min)
const padded = findFreeSlots({
	busy,
	windowStartMs: T("2026-06-15T07:00:00Z"),
	windowEndMs: T("2026-06-16T02:00:00Z"),
	durationMinutes: 60,
	workingHours: { start: "08:00", end: "18:00", tz: "America/Los_Angeles" },
	minGapMinutes: 30,
});
const middle = padded.find(
	(s) => new Date(s.start).toISOString() === "2026-06-15T17:30:00.000Z",
);
assert(!!middle, "min_gap_minutes pads busy intervals (gap starts 10:30 PDT)");
// 08-09 gap shrinks to 08:00-08:30 (< 60min) → dropped
assert(padded.length === 2, `padding drops the now-too-small morning gap (got ${padded.length})`);

// duration too long for any gap → no slots
const none = findFreeSlots({
	busy,
	windowStartMs: T("2026-06-15T07:00:00Z"),
	windowEndMs: T("2026-06-16T02:00:00Z"),
	durationMinutes: 600,
	workingHours: { start: "08:00", end: "18:00", tz: "America/Los_Angeles" },
});
assert(none.length === 0, "no slots when duration exceeds every gap");

// ── DST boundary: clocks fall back 02:00 Nov 1 2026 (PDT→PST). ──
const dstWindows = workingWindows(
	T("2026-10-30T00:00:00Z"),
	T("2026-11-03T00:00:00Z"),
	{ start: "08:00", end: "18:00", tz: "America/Los_Angeles" },
);
const oct31 = dstWindows.find((w) =>
	new Date(w.start).toISOString().startsWith("2026-10-31T15:00"),
);
const nov1 = dstWindows.find((w) =>
	new Date(w.start).toISOString().startsWith("2026-11-01T16:00"),
);
assert(!!oct31, "Oct 31 (before fall-back) 08:00 PDT = 15:00Z");
assert(!!nov1, "Nov 1 (08:00 is after the 2am fall-back) 08:00 PST = 16:00Z");

console.log("\nAll availability assertions passed.");
