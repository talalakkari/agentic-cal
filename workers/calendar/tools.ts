// Calendar tool implementations shared by the MCP server (primary client:
// Hermes/Grok) and the EmailAgent. Contract per docs/AGENTIC-CALENDAR-SPEC.md
// §9.2 — all times ISO 8601 in/out, the server does the timezone math, and
// contract stability matters more than anything else here.

import {
	DEFAULT_WORKING_HOURS,
	findFreeSlots,
	mergeIntervals,
	type WorkingHours,
} from "./availability";
import { getCalendarStub, workflowIdForUid } from "./poller";
import { sendImip } from "./send-invite";
import { ulid } from "./ulid";
import type { Env } from "../types";

// Largest span a single tool call may request. This is a RESPONSE-SIZE cap, not
// the extent of the data: the retained window is ±365 days (workers/calendar/
// window.ts, widened by F-018). The cap matters because CalendarDO.getAvailability
// runs unbounded — no LIMIT — so a multi-year request would return every busy
// interval in one payload, straight into an agent's context.
//
// Raising it therefore requires bounding getAvailability first; until then this
// stays put. (The comment here previously read "events only exist −7d/+90d",
// which stopped being true at F-018 and made the cap look like a data limit.)
const MAX_WINDOW_MS = 92 * 24 * 60 * 60 * 1000;

function parseIso(label: string, value: string): number {
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) {
		throw new Error(`${label} is not a valid ISO 8601 timestamp: "${value}"`);
	}
	return ms;
}

function parseWindow(windowStart: string, windowEnd: string) {
	const startMs = parseIso("window_start", windowStart);
	const endMs = parseIso("window_end", windowEnd);
	if (endMs <= startMs) throw new Error("window_end must be after window_start");
	if (endMs - startMs > MAX_WINDOW_MS) {
		throw new Error(
			"Window too large — a single request may span at most 92 days. Calendar data itself is retained for ±365 days, so query it in shorter ranges.",
		);
	}
	return { startMs, endMs };
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function toolGetAvailability(
	env: Env,
	args: { window_start: string; window_end: string },
): Promise<Record<string, unknown>> {
	try {
		const { startMs, endMs } = parseWindow(args.window_start, args.window_end);
		const { busy, feed_warnings } = await getCalendarStub(env).getAvailability(
			startMs,
			endMs,
		);
		return {
			busy: busy.map((b) => ({
				start: iso(b.start),
				end: iso(b.end),
				source: b.source,
				...(b.summary ? { summary: b.summary } : {}),
			})),
			feed_warnings,
		};
	} catch (e) {
		return { error: (e as Error).message };
	}
}

export async function toolFindFreeSlots(
	env: Env,
	args: {
		duration_minutes: number;
		window_start: string;
		window_end: string;
		working_hours?: { start: string; end: string; tz: string };
		min_gap_minutes?: number;
	},
): Promise<Record<string, unknown>> {
	try {
		const { startMs, endMs } = parseWindow(args.window_start, args.window_end);
		if (!Number.isFinite(args.duration_minutes) || args.duration_minutes <= 0) {
			throw new Error("duration_minutes must be a positive number");
		}

		const { busy, feed_warnings } = await getCalendarStub(env).getAvailability(
			startMs,
			endMs,
		);
		const workingHours: WorkingHours = args.working_hours ?? DEFAULT_WORKING_HOURS;

		const slots = findFreeSlots({
			busy: mergeIntervals(busy),
			windowStartMs: startMs,
			windowEndMs: endMs,
			durationMinutes: args.duration_minutes,
			workingHours,
			minGapMinutes: args.min_gap_minutes,
		});

		return {
			slots: slots.map((s) => ({ start: iso(s.start), end: iso(s.end) })),
			working_hours: workingHours,
			feed_warnings,
		};
	} catch (e) {
		return { error: (e as Error).message };
	}
}

/**
 * list_calendar_events — the concrete events in a window, as opposed to the
 * busy *intervals* get_availability returns.
 *
 * These are deliberately not the same question. get_availability answers "when
 * am I unavailable?", so at the DO level it filters to `transparency = OPAQUE`
 * and drops own-block copies, and it merges what remains into anonymous
 * intervals. That makes it structurally unable to answer "what is on my
 * calendar?": a FREE/TRANSPARENT event (all-day markers, "OOO", holidays,
 * tentative holds) is on the calendar but never appears in a busy list.
 *
 * So this reads the events table directly and keeps everything, carrying `busy`
 * per event rather than using it as a filter. Own-block copies — the feed's
 * echo of a block the agent created — are included, because they genuinely are
 * on the calendar; `is_own_block` is set on those so a caller that also holds
 * list_blocks output can reconcile the two instead of double-reporting.
 *
 * `summary` is null for busy-only feeds (e.g. Outlook at detail_level=busy);
 * that is a feed policy, not a missing title.
 */
export async function toolListCalendarEvents(
	env: Env,
	args: {
		window_start: string;
		window_end: string;
		feed_id?: string;
		limit?: number;
	},
): Promise<Record<string, unknown>> {
	try {
		const { startMs, endMs } = parseWindow(args.window_start, args.window_end);
		if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit <= 0)) {
			throw new Error("limit must be a positive number");
		}
		const limit = args.limit ?? 200;

		const stub = getCalendarStub(env);
		// feed_id is pushed into the query rather than filtered after the fact, so
		// it interacts correctly with `limit` (filtering post-limit would silently
		// return fewer rows than the caller asked for).
		const [rows, { calendars }] = await Promise.all([
			stub.listEvents({
				fromMs: startMs,
				toMs: endMs,
				limit,
				...(args.feed_id ? { feedId: args.feed_id } : {}),
			}),
			stub.listCalendars(),
		]);

		return {
			events: rows.map((e) => ({
				uid: e.uid,
				feed_id: e.feed_id,
				start: iso(e.dtstart),
				end: iso(e.dtend),
				all_day: e.all_day === 1,
				busy: e.transparency === "OPAQUE",
				summary: e.summary,
				...(e.is_own_block === 1 ? { is_own_block: true } : {}),
			})),
			// The DO clamps `limit` to 1000. Saying so beats letting a caller read a
			// truncated list as a complete one.
			...(rows.length >= limit
				? {
						truncated: true,
						note: `Stopped at the ${limit}-event limit — there may be more events in this window. Narrow the window or raise limit.`,
					}
				: {}),
			feed_warnings: calendars
				.filter((c) => !c.fresh)
				.map((c) => ({
					feed_id: c.id,
					stale_hours: c.stale_hours,
					last_error: c.last_error,
				})),
		};
	} catch (e) {
		return { error: (e as Error).message };
	}
}

/**
 * list_calendars — read-only feed registry + ingest health (spec §9.2). Lets
 * the agent answer "what calendars can you see / are they fresh?" directly,
 * rather than inferring connectivity from an empty get_availability result.
 */
export async function toolListCalendars(env: Env): Promise<Record<string, unknown>> {
	try {
		const { calendars } = await getCalendarStub(env).listCalendars();
		return {
			calendars: calendars.map((c) => ({
				id: c.id,
				label: c.label,
				detail_level: c.detail_level,
				event_count: c.event_count,
				last_fetched: c.last_fetched ? iso(c.last_fetched) : null,
				last_changed: c.last_changed ? iso(c.last_changed) : null,
				stale_hours: c.stale_hours,
				fresh: c.fresh,
				last_error: c.last_error,
			})),
		};
	} catch (e) {
		return { error: (e as Error).message };
	}
}

// ── Write path (Phase 4) ───────────────────────────────────────────

function organizerDomain(env: Env): string {
	const domain = env.ORGANIZER_ADDR?.split("@")[1];
	if (!domain) {
		throw new Error(
			"ORGANIZER_ADDR is not configured — set it as a Worker secret (e.g. calendar@example.com)",
		);
	}
	return domain;
}

function blockToJson(block: {
	uid: string;
	title: string;
	dtstart: number;
	dtend: number;
	sequence?: number;
	status: string;
	last_error?: string | null;
	attendees?: Array<{ feed_id: string; partstat: string; replied_at: number | null }>;
}) {
	return {
		uid: block.uid,
		title: block.title,
		start: iso(block.dtstart),
		end: iso(block.dtend),
		status: block.status,
		// A pending block with workflow_failed=true is holding the slot but its
		// invites never went out — distinct from a healthy pending block.
		...(block.last_error ? { workflow_failed: true, last_error: block.last_error } : {}),
		...(block.attendees
			? {
					attendees: block.attendees.map((a) => ({
						account: a.feed_id,
						partstat: a.partstat,
						replied_at: a.replied_at ? iso(a.replied_at) : null,
					})),
				}
			: {}),
	};
}

/**
 * block_time — asynchronous by design (spec §9.2): writes the tentative
 * block (busy immediately), spawns BlockTimeWorkflow to run the invite
 * lifecycle, returns `pending` without waiting for acceptances.
 */
export async function toolBlockTime(
	env: Env,
	args: { start: string; end: string; title: string; force?: boolean },
): Promise<Record<string, unknown>> {
	try {
		const startMs = parseIso("start", args.start);
		const endMs = parseIso("end", args.end);
		if (endMs <= startMs) throw new Error("end must be after start");
		if (!args.title?.trim()) throw new Error("title is required");

		const stub = getCalendarStub(env);
		const feeds = await stub.listFeeds();
		if (feeds.length === 0) {
			throw new Error("No calendar feeds registered — register feeds before blocking time");
		}

		const uid = `${ulid()}@calendar.${organizerDomain(env)}`;
		// Atomic conflict-check + create (single DO critical section) so two
		// concurrent block_time calls can't both book the same slot.
		const { created, conflicts } = await stub.createBlockIfFree({
			uid,
			title: args.title.trim(),
			dtstart: startMs,
			dtend: endMs,
			force: args.force,
			created_by: "mcp",
		});
		if (!created) {
			return {
				status: "conflict",
				conflicts: conflicts.map((c) => ({
					start: iso(c.start),
					end: iso(c.end),
					source: c.source,
					...(c.summary ? { summary: c.summary } : {}),
				})),
				hint: "The window overlaps existing busy time. Pass force: true to book anyway.",
			};
		}

		// The block row already exists (busy now). If the invite workflow can't
		// start, flag the block so it isn't mistaken for a healthy pending block —
		// the exact failure mode that silently swallowed the original block_time bug.
		let instance: { id: string };
		try {
			instance = await env.BLOCK_WORKFLOW.create({
				id: workflowIdForUid(uid),
				params: { uid, title: args.title.trim(), dtstart: startMs, dtend: endMs },
			});
		} catch (e) {
			const message = `Invite workflow failed to start: ${(e as Error).message}`;
			await stub.recordBlockError(uid, message);
			return {
				uid,
				status: "pending",
				workflow_failed: true,
				error: message,
				note: "The block was created and counts as busy, but NO invites were sent. Cancel and retry, or investigate before relying on it.",
			};
		}
		await stub.setBlockWorkflowId(uid, instance.id);

		return {
			uid,
			status: "pending",
			conflicts: [],
			// Honest about the async write path (F-013): the block counts as busy now,
			// but invites are sent in the background and are NOT yet confirmed here. The
			// agent must not tell the user invites went out until get_block_status shows
			// the block is not workflow_failed.
			note: "Block created and now counts as busy. Invites are being sent to each account in the background — delivery is NOT yet confirmed. Verify with get_block_status (a workflow_failed/last_error there means no invites went out) before telling the user invites were sent.",
		};
	} catch (e) {
		return { error: (e as Error).message };
	}
}

export async function toolGetBlockStatus(
	env: Env,
	args: { uid: string },
): Promise<Record<string, unknown>> {
	try {
		const block = await getCalendarStub(env).getBlock(args.uid);
		if (!block) return { error: `No block with uid ${args.uid}` };
		return blockToJson(block);
	} catch (e) {
		return { error: (e as Error).message };
	}
}

/**
 * cancel_block — METHOD:CANCEL to every account with a bumped SEQUENCE;
 * plain DO update + email sends, no workflow needed (spec §8 notes).
 */
export async function toolCancelBlock(
	env: Env,
	args: { uid: string },
): Promise<Record<string, unknown>> {
	try {
		const stub = getCalendarStub(env);
		const block = await stub.getBlock(args.uid);
		if (!block) return { error: `No block with uid ${args.uid}` };
		if (block.status === "cancelled") {
			return { uid: args.uid, status: "cancelled", note: "Already cancelled" };
		}

		const { sequence } = await stub.cancelBlock(args.uid);

		// Stop the acceptance workflow if it's still waiting.
		try {
			const instance = await env.BLOCK_WORKFLOW.get(workflowIdForUid(args.uid));
			await instance.terminate();
		} catch {
			// already finished or never started — fine
		}

		const feeds = await stub.listFeeds();
		const failures: string[] = [];
		for (const feed of feeds) {
			try {
				await sendImip(env, feed, {
					method: "CANCEL",
					uid: args.uid,
					sequence,
					title: block.title,
					dtstartMs: block.dtstart,
					dtendMs: block.dtend,
				});
			} catch (e) {
				failures.push(`${feed.id}: ${(e as Error).message}`);
			}
		}

		return {
			uid: args.uid,
			status: "cancelled",
			...(failures.length ? { cancel_send_failures: failures } : {}),
		};
	} catch (e) {
		return { error: (e as Error).message };
	}
}

export async function toolListBlocks(
	env: Env,
	args: { window_start?: string; window_end?: string; status?: string },
): Promise<Record<string, unknown>> {
	try {
		const blocks = await getCalendarStub(env).listBlocks({
			fromMs: args.window_start ? parseIso("window_start", args.window_start) : undefined,
			toMs: args.window_end ? parseIso("window_end", args.window_end) : undefined,
			status: args.status,
		});
		return { blocks: blocks.map(blockToJson) };
	} catch (e) {
		return { error: (e as Error).message };
	}
}

/**
 * delete_block: permanently remove a CANCELLED block's record (the agent-facing
 * counterpart to the Time blocks page purge). Refuses unless the block is already
 * cancelled (its workflow is terminated and providers were notified via
 * METHOD:CANCEL), so a purge can never orphan a live workflow or a provider
 * invite. To remove an active block, cancel_block it first, then delete_block.
 */
export async function toolDeleteBlock(
	env: Env,
	args: { uid: string },
): Promise<Record<string, unknown>> {
	try {
		const deleted = await getCalendarStub(env).deleteBlock(args.uid);
		if (!deleted) {
			return {
				error: `Block ${args.uid} not found or not cancelled. Cancel it first (cancel_block), then delete_block.`,
			};
		}
		return { uid: args.uid, deleted: true };
	} catch (e) {
		return { error: (e as Error).message };
	}
}

/**
 * purge_cancelled_blocks: permanently delete every cancelled block's record in
 * one shot (the bulk cleanup behind the Time blocks "Purge cancelled" button).
 * Safe: only cancelled blocks are touched. Returns the count removed.
 */
export async function toolPurgeCancelledBlocks(
	env: Env,
): Promise<Record<string, unknown>> {
	try {
		const purged = await getCalendarStub(env).purgeCancelledBlocks();
		return { purged };
	} catch (e) {
		return { error: (e as Error).message };
	}
}
