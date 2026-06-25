// Feed poller — runs on the cron trigger (every 10 min; Outlook's server-side
// cache makes faster polling pointless). Per docs/AGENTIC-CALENDAR-SPEC.md §6:
//   1. Conditional GET using ETag/Last-Modified mirrored in KV (short-circuits
//      without waking the DO on 304).
//   2. On 200: raw body -> R2 snapshot, parse + expand, replace window rows.
//   3. On failure: record last_error, keep stale data (stale > empty).

import { expandIcs } from "./ics";
import type { CalendarDO, FeedRow } from "./calendarDO";
import type { Env } from "../types";

// Rolling expansion window: past 7 days -> future 90 days.
const WINDOW_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_FUTURE_MS = 90 * 24 * 60 * 60 * 1000;

interface FeedCacheEntry {
	etag?: string;
	lastModified?: string;
}

export function getCalendarStub(env: Env) {
	return env.CALENDAR_DO.get(
		env.CALENDAR_DO.idFromName("default"),
	) as unknown as DurableObjectStub<CalendarDO>;
}

/**
 * Map a block's iCal UID to a Cloudflare Workflows instance id. Workflow
 * instance ids only allow `[A-Za-z0-9_-]`, but our UIDs are RFC-5545 form
 * (`<ulid>@calendar.<domain>`) — the `@` and `.` make `BLOCK_WORKFLOW.create`
 * throw `instance.invalid_id`. Deterministic, so create/get/terminate all agree.
 */
export function workflowIdForUid(uid: string): string {
	return uid.replace(/[^A-Za-z0-9_-]/g, "_");
}

export async function pollFeeds(env: Env): Promise<
	Array<{ feedId: string; status: string; events?: number }>
> {
	const stub = getCalendarStub(env);
	const feedList = await stub.listFeeds();
	const results: Array<{ feedId: string; status: string; events?: number }> = [];

	// Sequential, not parallel: three small feeds every 10 minutes — simplicity
	// wins, and it keeps a single slow provider from masking another's error.
	for (const feed of feedList) {
		try {
			results.push(await pollOneFeed(env, stub, feed));
		} catch (e) {
			const message = (e as Error).message || String(e);
			console.error(`Feed poll failed for ${feed.id}:`, message);
			await stub.recordFeedError(feed.id, message);
			results.push({ feedId: feed.id, status: `error: ${message}` });
		}
	}

	return results;
}

async function pollOneFeed(
	env: Env,
	stub: DurableObjectStub<CalendarDO>,
	feed: FeedRow,
): Promise<{ feedId: string; status: string; events?: number }> {
	const cacheKey = `feed:${feed.id}`;
	const cached = await env.FEED_CACHE.get<FeedCacheEntry>(cacheKey, "json");

	const headers = new Headers({ "User-Agent": "t9-agentic-cal/1.0 (+ics-poller)" });
	if (cached?.etag) headers.set("If-None-Match", cached.etag);
	if (cached?.lastModified) headers.set("If-Modified-Since", cached.lastModified);

	const response = await fetch(feed.ics_url, { headers, redirect: "follow" });

	if (response.status === 304) {
		await stub.recordFeedSuccess(feed.id, { changed: false });
		return { feedId: feed.id, status: "not-modified" };
	}

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} fetching feed`);
	}

	const body = await response.text();

	// Raw snapshot to R2 before parsing — audit everything cheaply (spec §2.8),
	// and a parse failure still leaves evidence of what the provider sent.
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	await env.SNAPSHOTS.put(`snapshots/${feed.id}/${timestamp}.ics`, body, {
		httpMetadata: { contentType: "text/calendar" },
	});

	const now = Date.now();
	const windowStart = now - WINDOW_PAST_MS;
	const windowEnd = now + WINDOW_FUTURE_MS;
	const events = expandIcs(body, windowStart, windowEnd);

	// Busy-only feeds must not retain titles even if the provider leaks them.
	if (feed.detail_level !== "full") {
		for (const ev of events) ev.summary = null;
	}

	const { inserted } = await stub.replaceFeedWindow(feed.id, events);

	const etag = response.headers.get("ETag");
	const lastModified = response.headers.get("Last-Modified");
	await env.FEED_CACHE.put(
		cacheKey,
		JSON.stringify({
			etag: etag ?? undefined,
			lastModified: lastModified ?? undefined,
		} satisfies FeedCacheEntry),
	);

	await stub.recordFeedSuccess(feed.id, { etag, changed: true });
	return { feedId: feed.id, status: "updated", events: inserted };
}
