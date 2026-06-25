// Binding-only calendar read surface — F-017 (2026-06-22).
//
// A first-party consumer (the PWA's BFF Worker) binds to this Worker with a
// service binding scoped to the named entrypoint `CalendarReadService` and calls
// it Worker-to-Worker: `env.<binding>.fetch(new Request("https://cal/calendar/view?from=…&to=…"))`.
//
// Trust model: service-binding calls do NOT pass through the default export's
// Cloudflare Access middleware (workers/app.ts) — the binding itself (same
// Cloudflare account, operator-configured) IS the trust boundary. This entrypoint
// is deliberately distinct from the Access-gated UI/API routes and exposes ONLY
// read-only calendar data: it never touches MailboxDO and carries no write/RSVP
// path. (Strict DO separation — hard rule #2 — is preserved: CalendarDO only.)
//
// RRULE note: recurrence is already expanded at ingest (poller → expandIcs over
// the rolling window), so the `events` table holds concrete instances. This read
// just returns rows in range — no per-request expansion.

import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { getCalendarStub } from "./poller";
import type { Env } from "../types";

// Advisory default colors per known source so the PWA's calendar filter has
// stable hues out of the box; the PWA may override. Any unrecognized feed id
// gets a deterministic fallback (below) so `color` is ALWAYS populated.
const SOURCE_COLORS: Record<string, string> = {
	proton: "#6d4aff",
	outlook: "#0078d4",
	icloud: "#34c759",
	block: "#f6a821",
};

// Deterministic per-id color so `/calendars` always returns a `color` (F-018 (a):
// keeps the PWA's legend exact instead of falling back to its own palette).
function colorFor(id: string): string {
	const known = SOURCE_COLORS[id];
	if (known) return known;
	let hue = 0;
	for (let i = 0; i < id.length; i++) hue = (hue * 31 + id.charCodeAt(i)) % 360;
	return `hsl(${hue}, 65%, 55%)`;
}

// Retained data window (spec §5: rolling −7d … +90d, re-expanded each poll). A
// request whose range can't overlap it gets a typed `range_outside_window`.
const WINDOW_PAST_MS = 7 * 86_400_000;
const WINDOW_FUTURE_MS = 90 * 86_400_000;

// Typed failure model (F-018 #5): stable HTTP status + machine-readable `code`,
// so the PWA can map the useful cases to better UX than a generic failure.
// Body is `{ error: { code, message } }`. Closed set of codes:
//   invalid_request      400 — missing/unparseable `from`/`to`, or `to` <= `from`
//   range_outside_window 422 — range falls entirely outside the retained window
type ErrorCode = "invalid_request" | "range_outside_window";
function errorBody(code: ErrorCode, message: string) {
	return { error: { code, message } };
}

// One normalized item shape for both feed events and agent blocks. Block-only
// fields (status/last_error/attendees) are optional; event-only `recurrence_id`
// is optional too.
type ViewItem = {
	uid: string;
	source: string; // feed id (proton|outlook|icloud) or "block"
	kind: "event" | "block";
	start: string; // ISO 8601 UTC
	end: string;
	all_day: boolean;
	busy: boolean;
	summary: string | null; // null for busy-only feeds (e.g. Outlook)
	recurrence_id?: string | null;
	status?: string; // blocks: pending|partial|confirmed
	last_error?: string | null; // blocks: non-null = invites never went out
	attendees?: Array<{ account: string; partstat: string; replied_at: string | null }>;
};

export const calendarReadApp = new Hono<{ Bindings: Env }>();

// Merged, normalized calendar view over [from, to): feed events + agent blocks +
// staleness warnings. Optional `?calendars=` is a comma-separated allow-list of
// sources to include (feed ids and/or "block"); omitted = all.
calendarReadApp.get("/calendar/view", async (c) => {
	const fromStr = c.req.query("from");
	const toStr = c.req.query("to");
	const fromMs = fromStr ? Date.parse(fromStr) : Number.NaN;
	const toMs = toStr ? Date.parse(toStr) : Number.NaN;
	if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
		return c.json(
			errorBody("invalid_request", "from and to are required ISO 8601 timestamps"),
			400,
		);
	}
	if (toMs <= fromMs) {
		return c.json(errorBody("invalid_request", "to must be after from"), 400);
	}
	// No overlap with the retained window → nothing can ever be returned; signal it
	// distinctly so the PWA can say "that range isn't available" rather than show
	// an empty calendar as if it were genuinely free.
	const now = Date.now();
	if (toMs <= now - WINDOW_PAST_MS || fromMs >= now + WINDOW_FUTURE_MS) {
		return c.json(
			errorBody(
				"range_outside_window",
				"requested range is outside the retained window (about −7 to +90 days)",
			),
			422,
		);
	}

	const calParam = c.req.query("calendars");
	const allow = calParam
		? new Set(
				calParam
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			)
		: null;

	const stub = getCalendarStub(c.env);
	const [eventRows, blockRows, cals] = await Promise.all([
		stub.listEvents({ fromMs, toMs, limit: 1000 }),
		stub.listBlocksWithAttendees({ fromMs, toMs }),
		stub.listCalendars(),
	]);

	const events: ViewItem[] = [];
	for (const e of eventRows) {
		if (allow && !allow.has(e.feed_id)) continue;
		events.push({
			uid: e.uid,
			source: e.feed_id,
			kind: "event",
			start: new Date(e.dtstart).toISOString(),
			end: new Date(e.dtend).toISOString(),
			all_day: e.all_day === 1,
			busy: e.transparency === "OPAQUE",
			summary: e.summary,
			recurrence_id: e.recurrence_id,
		});
	}
	for (const b of blockRows) {
		if (b.status === "cancelled") continue; // cancelled holds don't render
		if (allow && !allow.has("block")) continue;
		events.push({
			uid: b.uid,
			source: "block",
			kind: "block",
			start: new Date(b.dtstart).toISOString(),
			end: new Date(b.dtend).toISOString(),
			all_day: false,
			busy: ["pending", "partial", "confirmed"].includes(b.status),
			summary: b.title,
			status: b.status,
			last_error: b.last_error,
			attendees: b.attendees.map((a) => ({
				account: a.feed_id,
				partstat: a.partstat,
				replied_at: a.replied_at ? new Date(a.replied_at).toISOString() : null,
			})),
		});
	}
	events.sort((a, b) => a.start.localeCompare(b.start));

	// feed_warnings reuses listCalendars' freshness rule (24h, Outlook 48h, or any
	// last_error) so the PWA can caveat stale feeds the same way the agent does.
	const feed_warnings = cals.calendars
		.filter((cal) => !cal.fresh)
		.map((cal) => ({
			feed_id: cal.id,
			stale_hours: cal.stale_hours, // -1 = never fetched
			last_error: cal.last_error,
		}));

	return c.json({
		range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
		events,
		feed_warnings,
	});
});

// Registered calendars for the PWA's filter. No secrets (ics_url/invite_email
// omitted); carries ingest health so the PWA can flag stale/erroring feeds.
calendarReadApp.get("/calendars", async (c) => {
	const { calendars } = await getCalendarStub(c.env).listCalendars();
	return c.json({
		calendars: calendars.map((cal) => ({
			id: cal.id,
			display_name: cal.label,
			color: colorFor(cal.id), // always populated (known palette or deterministic fallback)
			detail_level: cal.detail_level,
			event_count: cal.event_count,
			fresh: cal.fresh,
			stale_hours: cal.stale_hours,
			last_changed: cal.last_changed ? new Date(cal.last_changed).toISOString() : null,
			last_error: cal.last_error,
		})),
	});
});

export class CalendarReadService extends WorkerEntrypoint<Env> {
	fetch(request: Request): Response | Promise<Response> {
		return calendarReadApp.fetch(request, this.env, this.ctx);
	}
}
