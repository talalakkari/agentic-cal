// Smoke test for workers/calendar/ics.ts — runs in plain Node (npx tsx
// scripts/smoke-ics.ts). Exercises RRULE expansion, EXDATE, RECURRENCE-ID
// overrides, all-day events, TRANSP, and VTIMEZONE/TZID conversion.

import { expandIcs } from "../workers/calendar/ics";

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//smoke//test//EN
BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
TZNAME:PDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
TZNAME:PST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:simple-1@test
DTSTAMP:20260601T000000Z
DTSTART:20260615T170000Z
DTEND:20260615T180000Z
SUMMARY:Simple one-off
END:VEVENT
BEGIN:VEVENT
UID:weekly-1@test
DTSTAMP:20260601T000000Z
DTSTART;TZID=America/Los_Angeles:20260601T090000
DTEND;TZID=America/Los_Angeles:20260601T100000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8
EXDATE;TZID=America/Los_Angeles:20260615T090000
SUMMARY:Weekly standup
END:VEVENT
BEGIN:VEVENT
UID:weekly-1@test
DTSTAMP:20260601T000000Z
RECURRENCE-ID;TZID=America/Los_Angeles:20260622T090000
DTSTART;TZID=America/Los_Angeles:20260622T140000
DTEND;TZID=America/Los_Angeles:20260622T150000
SUMMARY:Weekly standup (moved)
END:VEVENT
BEGIN:VEVENT
UID:allday-1@test
DTSTAMP:20260601T000000Z
DTSTART;VALUE=DATE:20260620
DTEND;VALUE=DATE:20260621
TRANSP:TRANSPARENT
SUMMARY:Public holiday
END:VEVENT
BEGIN:VEVENT
UID:outside-window@test
DTSTAMP:20260601T000000Z
DTSTART:20270115T170000Z
DTEND:20270115T180000Z
SUMMARY:Far future, must be excluded
END:VEVENT
END:VCALENDAR
`;

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`ok: ${msg}`);
}

// Window: 2026-06-05 → 2026-09-03 (90 days)
const windowStart = Date.parse("2026-06-05T00:00:00Z");
const windowEnd = Date.parse("2026-09-03T00:00:00Z");
const events = expandIcs(ICS, windowStart, windowEnd);

const byUid = (uid: string) => events.filter((e) => e.uid === uid);

assert(byUid("simple-1@test").length === 1, "simple event included once");
assert(
	byUid("outside-window@test").length === 0,
	"event outside window excluded",
);

const weekly = byUid("weekly-1@test").sort((a, b) => a.dtstart - b.dtstart);
// COUNT=8 from Jun 1; Jun 1 is before windowStart → 7 in window; minus 1 EXDATE = 6
assert(
	weekly.length === 6,
	`weekly: 6 occurrences after window clip + EXDATE (got ${weekly.length})`,
);
assert(
	!weekly.some((e) => new Date(e.dtstart).toISOString().startsWith("2026-06-15")),
	"EXDATE 2026-06-15 honored",
);

const moved = weekly.find((e) => e.summary === "Weekly standup (moved)");
assert(!!moved, "RECURRENCE-ID override applied");
assert(
	new Date(moved!.dtstart).toISOString() === "2026-06-22T21:00:00.000Z",
	`override moved to 14:00 PDT = 21:00Z (got ${new Date(moved!.dtstart).toISOString()})`,
);

// TZID conversion: 09:00 PDT = 16:00 UTC
const first = weekly[0];
assert(
	new Date(first.dtstart).toISOString() === "2026-06-08T16:00:00.000Z",
	`TZID America/Los_Angeles converted (09:00 PDT -> 16:00Z, got ${new Date(first.dtstart).toISOString()})`,
);
assert(first.tz_original === "America/Los_Angeles", "tz_original retained");

const holiday = byUid("allday-1@test")[0];
assert(!!holiday && holiday.all_day === 1, "all-day flag set");
assert(holiday.transparency === "TRANSPARENT", "TRANSP=TRANSPARENT captured");
assert(
	holiday.dtend - holiday.dtstart === 24 * 60 * 60 * 1000,
	"all-day event spans one day");

console.log(`\nAll assertions passed (${events.length} events expanded).`);
