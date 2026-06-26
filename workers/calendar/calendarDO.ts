// CalendarDO — unified availability store. One instance ("default") for v1.
// Lives beside MailboxDO in the same Worker with ZERO schema coupling: no
// cross-DO foreign keys, no shared tables, no direct DO-to-DO calls.
// See docs/AGENTIC-CALENDAR-SPEC.md §5.

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, gte, lt, inArray, sql } from "drizzle-orm";
import * as schema from "./schema";
import { applyMigrations } from "../durableObject/migrations";
import { calendarMigrations } from "./migrations";
import type { ExpandedEvent } from "./ics";
import type { Env } from "../types";

export type FeedId = string;

export interface FeedInput {
	id: FeedId; // 'proton' | 'outlook' | 'icloud'
	label: string;
	ics_url: string;
	invite_email: string;
	detail_level?: "busy" | "full";
}

export interface FeedRow {
	id: FeedId;
	label: string;
	ics_url: string;
	invite_email: string;
	detail_level: string;
	etag: string | null;
	last_fetched: number | null;
	last_changed: number | null;
	last_error: string | null;
}

const FEED_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

export class CalendarDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, calendarMigrations, this.ctx.storage);
	}

	// ── Feed registration ──────────────────────────────────────────

	async registerFeed(input: FeedInput): Promise<FeedRow> {
		if (!FEED_ID_PATTERN.test(input.id)) {
			throw new Error(
				`Invalid feed id "${input.id}" — use 1-32 chars of a-z, 0-9, '-', '_'`,
			);
		}
		// Normalize webcal:// (iCloud public links) to https:// for fetch().
		const icsUrl = input.ics_url.replace(/^webcal:\/\//i, "https://");
		if (!/^https:\/\//i.test(icsUrl)) {
			throw new Error("ics_url must be an https:// or webcal:// URL");
		}
		if (!input.invite_email.includes("@")) {
			throw new Error("invite_email must be an email address");
		}
		const detail = input.detail_level === "full" ? "full" : "busy";

		await this.db
			.insert(schema.feeds)
			.values({
				id: input.id,
				label: input.label,
				ics_url: icsUrl,
				invite_email: input.invite_email,
				detail_level: detail,
			})
			.onConflictDoUpdate({
				target: schema.feeds.id,
				set: {
					label: input.label,
					ics_url: icsUrl,
					invite_email: input.invite_email,
					detail_level: detail,
				},
			});

		const [row] = await this.db
			.select()
			.from(schema.feeds)
			.where(eq(schema.feeds.id, input.id));
		return row as FeedRow;
	}

	async listFeeds(): Promise<FeedRow[]> {
		return (await this.db.select().from(schema.feeds)) as FeedRow[];
	}

	async deleteFeed(id: FeedId): Promise<{ deleted: boolean }> {
		// Force delete. Both events and block_attendees FK feeds(id), so a feed that
		// still has either row would refuse to delete (the "Failed to remove feed"
		// case: a feed can have 0 events but a block_attendees row per agent block).
		// Drop the feed's events and its block_attendees rows, then the feed itself,
		// then recompute every block that lost an attendee so its status reflects
		// only the accounts that remain.
		const affected = await this.db
			.select({ uid: schema.blockAttendees.uid })
			.from(schema.blockAttendees)
			.where(eq(schema.blockAttendees.feed_id, id));
		await this.db.delete(schema.events).where(eq(schema.events.feed_id, id));
		await this.db
			.delete(schema.blockAttendees)
			.where(eq(schema.blockAttendees.feed_id, id));
		const result = await this.db
			.delete(schema.feeds)
			.where(eq(schema.feeds.id, id));
		for (const uid of new Set(affected.map((a) => a.uid))) {
			await this.recomputeBlockStatus(uid);
		}
		return { deleted: (result as { rowsAffected?: number }).rowsAffected !== 0 };
	}

	// ── Poller support ─────────────────────────────────────────────

	/**
	 * Replace ALL of the feed's rows with the freshly expanded set in one
	 * transaction. Simple-and-correct beats incremental-and-clever (spec §5):
	 * the poller re-expands the whole window on every successful poll, so a full
	 * per-feed delete + re-insert is the correct primitive. (A windowed delete
	 * keyed on dtstart would mismatch expandIcs's overlap test — which includes
	 * events that start before the window but reach into it — leaving duplicate
	 * spanning events on each poll and orphaned rows that never get collected.)
	 * Rows whose UID matches one of our own blocks are flagged so they aren't
	 * double-counted as external busy time.
	 *
	 * Note: storage.sql.exec here is the Durable Object SqlStorage API with
	 * `?` bind parameters — required because storage.transactionSync() only
	 * accepts a synchronous closure, which rules out the async drizzle API
	 * inside the transaction.
	 */
	async replaceFeedWindow(
		feedId: FeedId,
		events: ExpandedEvent[],
	): Promise<{ inserted: number }> {
		const ownUids = new Set(
			(await this.db.select({ uid: schema.blocks.uid }).from(schema.blocks)).map(
				(r) => r.uid,
			),
		);

		const sqlStorage = this.ctx.storage.sql;
		this.ctx.storage.transactionSync(() => {
			// Full per-feed replace (see the method doc): the DO SqlStorage API
			// with a bound `?` parameter — not a shell call.
			sqlStorage.exec("DELETE FROM events WHERE feed_id = ?", feedId);
			for (const ev of events) {
				sqlStorage.exec(
					`INSERT INTO events (feed_id, uid, recurrence_id, dtstart, dtend, all_day, transparency, summary, tz_original, is_own_block)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					feedId,
					ev.uid,
					ev.recurrence_id,
					ev.dtstart,
					ev.dtend,
					ev.all_day,
					ev.transparency,
					ev.summary,
					ev.tz_original,
					ownUids.has(ev.uid) ? 1 : 0,
				);
			}
		});

		return { inserted: events.length };
	}

	async recordFeedSuccess(
		feedId: FeedId,
		opts: { etag?: string | null; changed: boolean },
	): Promise<void> {
		const now = Date.now();
		await this.db
			.update(schema.feeds)
			.set({
				last_fetched: now,
				last_error: null,
				...(opts.changed ? { last_changed: now } : {}),
				...(opts.etag !== undefined ? { etag: opts.etag } : {}),
			})
			.where(eq(schema.feeds.id, feedId));
	}

	async recordFeedError(feedId: FeedId, message: string): Promise<void> {
		// Keep stale event data — stale beats empty (spec §6). Only the error
		// marker changes; staleness surfaces later via feed_warnings.
		await this.db
			.update(schema.feeds)
			.set({ last_error: message.slice(0, 500) })
			.where(eq(schema.feeds.id, feedId));
	}

	// ── Blocks (Phase 3/4) ─────────────────────────────────────────

	/**
	 * Write a tentative block + one NEEDS-ACTION attendee row per feed.
	 * Pending blocks count as busy immediately (see getAvailability).
	 */
	async createBlock(input: {
		uid: string;
		title: string;
		dtstart: number;
		dtend: number;
		workflow_id?: string;
		created_by?: string;
	}): Promise<void> {
		const feedRows = await this.db.select().from(schema.feeds);
		const sqlStorage = this.ctx.storage.sql;
		this.ctx.storage.transactionSync(() => {
			sqlStorage.exec(
				`INSERT INTO blocks (uid, title, dtstart, dtend, sequence, status, workflow_id, created_by, created_at)
				 VALUES (?, ?, ?, ?, 0, 'pending', ?, ?, ?)`,
				input.uid,
				input.title,
				input.dtstart,
				input.dtend,
				input.workflow_id ?? null,
				input.created_by ?? null,
				Date.now(),
			);
			for (const feed of feedRows) {
				sqlStorage.exec(
					`INSERT INTO block_attendees (uid, feed_id, partstat) VALUES (?, ?, 'NEEDS-ACTION')`,
					input.uid,
					feed.id,
				);
			}
		});
	}

	/**
	 * Conflict-check + create in one atomic critical section. Wrapping both in
	 * blockConcurrencyWhile serializes them against any other delivery to this DO,
	 * closing the TOCTOU where two concurrent block_time calls could each pass the
	 * conflict check and both book the same slot. Returns the conflicts (and does
	 * NOT create) when the window is busy and `force` is not set.
	 */
	async createBlockIfFree(input: {
		uid: string;
		title: string;
		dtstart: number;
		dtend: number;
		force?: boolean;
		created_by?: string;
	}): Promise<{
		created: boolean;
		conflicts: Array<{ start: number; end: number; source: string; summary: string | null }>;
	}> {
		return this.ctx.blockConcurrencyWhile(async () => {
			if (!input.force) {
				const conflicts = await this.findConflicts(input.dtstart, input.dtend);
				if (conflicts.length > 0) {
					return { created: false, conflicts };
				}
			}
			await this.createBlock({
				uid: input.uid,
				title: input.title,
				dtstart: input.dtstart,
				dtend: input.dtend,
				created_by: input.created_by,
			});
			return { created: true, conflicts: [] };
		});
	}

	async getBlock(uid: string): Promise<{
		uid: string;
		title: string;
		dtstart: number;
		dtend: number;
		sequence: number;
		status: string;
		last_error: string | null;
		attendees: Array<{ feed_id: string; partstat: string; replied_at: number | null }>;
	} | null> {
		const [block] = await this.db
			.select()
			.from(schema.blocks)
			.where(eq(schema.blocks.uid, uid));
		if (!block) return null;
		const attendees = await this.db
			.select()
			.from(schema.blockAttendees)
			.where(eq(schema.blockAttendees.uid, uid));
		return {
			uid: block.uid,
			title: block.title,
			dtstart: block.dtstart,
			dtend: block.dtend,
			sequence: block.sequence,
			status: block.status,
			last_error: block.last_error,
			attendees: attendees.map((a) => ({
				feed_id: a.feed_id,
				partstat: a.partstat,
				replied_at: a.replied_at,
			})),
		};
	}

	async listBlocks(opts: {
		fromMs?: number;
		toMs?: number;
		status?: string;
	}): Promise<Array<typeof schema.blocks.$inferSelect>> {
		const conditions = [
			opts.fromMs !== undefined ? gte(schema.blocks.dtend, opts.fromMs) : undefined,
			opts.toMs !== undefined ? lt(schema.blocks.dtstart, opts.toMs) : undefined,
			opts.status ? eq(schema.blocks.status, opts.status) : undefined,
		].filter((c): c is NonNullable<typeof c> => c !== undefined);
		return this.db
			.select()
			.from(schema.blocks)
			.where(conditions.length ? and(...conditions) : undefined)
			.orderBy(schema.blocks.dtstart);
	}

	/** Blocks + per-account acceptance state, for the status view. */
	async listBlocksWithAttendees(opts: {
		fromMs?: number;
		toMs?: number;
		status?: string;
	}): Promise<
		Array<
			typeof schema.blocks.$inferSelect & {
				attendees: Array<{ feed_id: string; partstat: string; replied_at: number | null }>;
			}
		>
	> {
		const blockRows = await this.listBlocks(opts);
		if (blockRows.length === 0) return [];
		const attendeeRows = await this.db
			.select()
			.from(schema.blockAttendees)
			.where(
				inArray(
					schema.blockAttendees.uid,
					blockRows.map((b) => b.uid),
				),
			);
		const byUid = new Map<string, Array<{ feed_id: string; partstat: string; replied_at: number | null }>>();
		for (const a of attendeeRows) {
			const list = byUid.get(a.uid) ?? [];
			list.push({ feed_id: a.feed_id, partstat: a.partstat, replied_at: a.replied_at });
			byUid.set(a.uid, list);
		}
		return blockRows.map((b) => ({ ...b, attendees: byUid.get(b.uid) ?? [] }));
	}

	/** Overlapping busy time (for block_time conflict detection). */
	async findConflicts(
		dtstart: number,
		dtend: number,
	): Promise<Array<{ start: number; end: number; source: string; summary: string | null }>> {
		const { busy } = await this.getAvailability(dtstart, dtend);
		return busy.filter((b) => b.end > dtstart && b.start < dtend);
	}

	/**
	 * Record an attendee REPLY and recompute the block's status.
	 * Returns false when the uid doesn't belong to any of our blocks.
	 */
	async recordReply(
		uid: string,
		feedId: FeedId,
		partstat: string,
	): Promise<boolean> {
		const [block] = await this.db
			.select()
			.from(schema.blocks)
			.where(eq(schema.blocks.uid, uid));
		if (!block) return false;

		await this.db
			.update(schema.blockAttendees)
			.set({ partstat, replied_at: Date.now() })
			.where(
				and(
					eq(schema.blockAttendees.uid, uid),
					eq(schema.blockAttendees.feed_id, feedId),
				),
			);
		await this.recomputeBlockStatus(uid);
		return true;
	}

	/**
	 * pending -> all NEEDS-ACTION outstanding; confirmed -> every attendee
	 * accepted; partial -> mixed/declined (spec §11.7: no auto-cancel — the
	 * agent sees per-account state and decides). Cancelled is terminal.
	 */
	async recomputeBlockStatus(uid: string): Promise<string> {
		const [block] = await this.db
			.select()
			.from(schema.blocks)
			.where(eq(schema.blocks.uid, uid));
		if (!block || block.status === "cancelled") return block?.status ?? "cancelled";

		const attendees = await this.db
			.select()
			.from(schema.blockAttendees)
			.where(eq(schema.blockAttendees.uid, uid));

		let status = "pending";
		if (attendees.length > 0) {
			const accepted = attendees.filter((a) => a.partstat === "ACCEPTED").length;
			const responded = attendees.filter((a) => a.partstat !== "NEEDS-ACTION").length;
			if (accepted === attendees.length) status = "confirmed";
			else if (responded > 0) status = "partial";
		}

		if (status !== block.status) {
			await this.db
				.update(schema.blocks)
				.set({ status })
				.where(eq(schema.blocks.uid, uid));
		}
		return status;
	}

	async cancelBlock(uid: string): Promise<{ ok: boolean; sequence: number }> {
		const [block] = await this.db
			.select()
			.from(schema.blocks)
			.where(eq(schema.blocks.uid, uid));
		if (!block) return { ok: false, sequence: 0 };
		const sequence = block.sequence + 1;
		await this.db
			.update(schema.blocks)
			.set({ status: "cancelled", sequence })
			.where(eq(schema.blocks.uid, uid));
		return { ok: true, sequence };
	}

	async setBlockWorkflowId(uid: string, workflowId: string): Promise<void> {
		await this.db
			.update(schema.blocks)
			.set({ workflow_id: workflowId })
			.where(eq(schema.blocks.uid, uid));
	}

	/**
	 * Flag a block whose invite workflow failed to start or errored. The block
	 * still holds the slot (counts as busy), but a non-null last_error tells the
	 * dashboard / get_block_status that invites did NOT go out. Skips cancelled
	 * blocks so a normal cancel-time workflow termination isn't mislabeled a failure.
	 */
	async recordBlockError(uid: string, message: string): Promise<void> {
		await this.db
			.update(schema.blocks)
			.set({ last_error: message.slice(0, 500) })
			.where(and(eq(schema.blocks.uid, uid), sql`${schema.blocks.status} != 'cancelled'`));
	}

	// ── Availability (Phase 2) ─────────────────────────────────────

	/**
	 * Busy intervals + feed staleness warnings for a window.
	 * Busy = external events (OPAQUE, not our own re-polled blocks) PLUS our
	 * blocks in pending/partial/confirmed — a pending block counts as busy
	 * immediately so the agent can't double-book a slot it just blocked.
	 */
	async getAvailability(
		windowStartMs: number,
		windowEndMs: number,
	): Promise<{
		busy: Array<{ start: number; end: number; source: string; summary: string | null }>;
		feed_warnings: Array<{ feed_id: string; stale_hours: number; last_error: string | null }>;
	}> {
		const eventRows = await this.db
			.select()
			.from(schema.events)
			.where(
				and(
					eq(schema.events.transparency, "OPAQUE"),
					eq(schema.events.is_own_block, 0),
					gte(schema.events.dtend, windowStartMs),
					lt(schema.events.dtstart, windowEndMs),
				),
			);

		const blockRows = await this.db
			.select()
			.from(schema.blocks)
			.where(
				and(
					gte(schema.blocks.dtend, windowStartMs),
					lt(schema.blocks.dtstart, windowEndMs),
				),
			);

		const busy = [
			...eventRows.map((e) => ({
				start: e.dtstart,
				end: e.dtend,
				source: e.feed_id,
				summary: e.summary,
			})),
			...blockRows
				.filter((b) => ["pending", "partial", "confirmed"].includes(b.status))
				.map((b) => ({
					start: b.dtstart,
					end: b.dtend,
					source: "block",
					summary: b.title as string | null,
				})),
		].sort((a, b) => a.start - b.start);

		// Staleness thresholds per spec §6: 24h, except Outlook 48h (Microsoft
		// caches published feeds server-side). Stale or erroring feeds surface
		// as warnings so the agent caveats its answers.
		const now = Date.now();
		const feedRows = await this.db.select().from(schema.feeds);
		const feed_warnings = feedRows
			.map((f) => {
				const thresholdHours = f.id === "outlook" ? 48 : 24;
				const staleHours = f.last_fetched
					? (now - f.last_fetched) / 3_600_000
					: Number.POSITIVE_INFINITY;
				return { feed: f, staleHours, thresholdHours };
			})
			.filter(
				({ feed, staleHours, thresholdHours }) =>
					staleHours > thresholdHours || feed.last_error !== null,
			)
			.map(({ feed, staleHours }) => ({
				feed_id: feed.id,
				stale_hours: Number.isFinite(staleHours)
					? Math.round(staleHours * 10) / 10
					: -1, // -1 = never fetched
				last_error: feed.last_error,
			}));

		return { busy, feed_warnings };
	}

	// ── Read / debug surface (Phase 2 builds availability on top) ──

	async listEvents(opts: {
		feedId?: FeedId;
		fromMs?: number;
		toMs?: number;
		limit?: number;
	}): Promise<(typeof schema.events.$inferSelect)[]> {
		const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
		const conditions = [
			opts.feedId ? eq(schema.events.feed_id, opts.feedId) : undefined,
			opts.fromMs !== undefined ? gte(schema.events.dtend, opts.fromMs) : undefined,
			opts.toMs !== undefined ? lt(schema.events.dtstart, opts.toMs) : undefined,
		].filter((c): c is NonNullable<typeof c> => c !== undefined);

		return this.db
			.select()
			.from(schema.events)
			.where(conditions.length ? and(...conditions) : undefined)
			.orderBy(schema.events.dtstart)
			.limit(limit);
	}

	async getStats(): Promise<{
		feeds: Array<{
			id: string;
			label: string;
			detail_level: string;
			event_count: number;
			last_fetched: number | null;
			last_changed: number | null;
			last_error: string | null;
		}>;
	}> {
		const feedRows = await this.db.select().from(schema.feeds);
		const counts = await this.db
			.select({
				feed_id: schema.events.feed_id,
				n: sql<number>`COUNT(*)`,
			})
			.from(schema.events)
			.groupBy(schema.events.feed_id);
		const countMap = new Map(counts.map((c) => [c.feed_id, c.n]));

		return {
			feeds: feedRows.map((f) => ({
				id: f.id,
				label: f.label,
				detail_level: f.detail_level,
				event_count: countMap.get(f.id) ?? 0,
				last_fetched: f.last_fetched,
				last_changed: f.last_changed,
				last_error: f.last_error,
			})),
		};
	}

	/**
	 * Registered feeds + ingest health, for the `list_calendars` tool — so the
	 * agent can answer "what calendars can you see / are they current?" directly
	 * instead of (wrongly) inferring connectivity from an empty availability set.
	 * Read-only; deliberately omits secrets (ics_url) and invite_email. `fresh`
	 * uses the same staleness rule as getAvailability (24h, Outlook 48h).
	 */
	async listCalendars(): Promise<{
		calendars: Array<{
			id: string;
			label: string;
			detail_level: string;
			event_count: number;
			last_fetched: number | null;
			last_changed: number | null;
			stale_hours: number; // -1 = never fetched
			fresh: boolean;
			last_error: string | null;
		}>;
	}> {
		const { feeds } = await this.getStats();
		const now = Date.now();
		return {
			calendars: feeds.map((f) => {
				const thresholdHours = f.id === "outlook" ? 48 : 24;
				const staleHours = f.last_fetched
					? (now - f.last_fetched) / 3_600_000
					: Number.POSITIVE_INFINITY;
				return {
					id: f.id,
					label: f.label,
					detail_level: f.detail_level,
					event_count: f.event_count,
					last_fetched: f.last_fetched,
					last_changed: f.last_changed,
					stale_hours: Number.isFinite(staleHours) ? Math.round(staleHours * 10) / 10 : -1,
					fresh: Number.isFinite(staleHours) && staleHours <= thresholdHours && f.last_error === null,
					last_error: f.last_error,
				};
			}),
		};
	}
}
