// Calendar HTTP surface (feed registration + inspection). Mounted behind the
// app-wide Cloudflare Access middleware in workers/app.ts — same single trust
// boundary as the mailbox API and /mcp.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { getCalendarStub, pollFeeds } from "./poller";
import { toolCancelBlock } from "./tools";
import { corsOptions } from "../lib/cors";
import type { Env } from "../types";

const feedInputSchema = z.object({
	id: z.string().min(1).max(32),
	label: z.string().min(1).max(100),
	ics_url: z.string().min(8),
	invite_email: z.string().email(),
	detail_level: z.enum(["busy", "full"]).optional(),
});

export const calendarApp = new Hono<{ Bindings: Env }>();

// Same CORS/CSRF guard the mailbox API uses. The calendar app is mounted
// separately on the main Hono app (workers/app.ts) and is matched before the
// mailbox app, so it would otherwise never see the mailbox API's middleware.
calendarApp.use("*", cors(corsOptions));

calendarApp.get("/feeds", async (c) => {
	const feeds = await getCalendarStub(c.env).listFeeds();
	// Don't echo the secret publish URLs back out; show enough to identify them.
	return c.json(
		feeds.map((f) => ({
			...f,
			ics_url: `${f.ics_url.slice(0, 40)}…`,
		})),
	);
});

calendarApp.post("/feeds", async (c) => {
	const parsed = feedInputSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
	}
	try {
		const feed = await getCalendarStub(c.env).registerFeed(parsed.data);
		return c.json({ ...feed, ics_url: `${feed.ics_url.slice(0, 40)}…` }, 201);
	} catch (e) {
		return c.json({ error: (e as Error).message }, 400);
	}
});

calendarApp.delete("/feeds/:id", async (c) => {
	const result = await getCalendarStub(c.env).deleteFeed(c.req.param("id"));
	return c.json(result, result.deleted ? 200 : 404);
});

// Manual poll trigger — same code path as the cron. Lets the operator verify a
// newly registered feed immediately instead of waiting up to 10 minutes.
calendarApp.post("/poll", async (c) => {
	const results = await pollFeeds(c.env);
	return c.json({ results });
});

calendarApp.get("/events", async (c) => {
	const events = await getCalendarStub(c.env).listEvents({
		feedId: c.req.query("feed") || undefined,
		fromMs: c.req.query("from") ? Date.parse(c.req.query("from")!) : undefined,
		toMs: c.req.query("to") ? Date.parse(c.req.query("to")!) : undefined,
		limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
	});
	return c.json({ events });
});

calendarApp.get("/stats", async (c) => {
	return c.json(await getCalendarStub(c.env).getStats());
});

// ── Blocks (status view; creation happens via the agent/MCP tools) ──

calendarApp.get("/blocks", async (c) => {
	const blocks = await getCalendarStub(c.env).listBlocksWithAttendees({
		fromMs: c.req.query("from") ? Date.parse(c.req.query("from")!) : undefined,
		toMs: c.req.query("to") ? Date.parse(c.req.query("to")!) : undefined,
		status: c.req.query("status") || undefined,
	});
	return c.json({
		blocks: blocks.map((b) => ({
			uid: b.uid,
			title: b.title,
			start: new Date(b.dtstart).toISOString(),
			end: new Date(b.dtend).toISOString(),
			status: b.status,
			last_error: b.last_error,
			created_at: new Date(b.created_at).toISOString(),
			attendees: b.attendees.map((a) => ({
				account: a.feed_id,
				partstat: a.partstat,
				replied_at: a.replied_at ? new Date(a.replied_at).toISOString() : null,
			})),
		})),
	});
});

calendarApp.delete("/blocks/:uid", async (c) => {
	const result = await toolCancelBlock(c.env, { uid: c.req.param("uid") });
	return c.json(result, "error" in result ? 404 : 200);
});
