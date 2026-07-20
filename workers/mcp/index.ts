// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	toolListMailboxes,
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
	toolDeleteEmail,
	toolSendReply,
	toolSendEmail,
	toolMarkEmailRead,
	toolMoveEmail,
} from "../lib/tools";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "../../shared/folders";
import {
	toolGetAvailability,
	toolFindFreeSlots,
	toolBlockTime,
	toolGetBlockStatus,
	toolCancelBlock,
	toolDeleteBlock,
	toolPurgeCancelledBlocks,
	toolListBlocks,
	toolListCalendars,
	toolListCalendarEvents,
} from "../calendar/tools";
import type { Env } from "../types";

/** Wrap a plain result object into MCP content format. */
function mcpText(result: unknown) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(result, null, 2) },
		],
	};
}

/** Wrap an error string into MCP error format. */
function mcpError(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true as const,
	};
}

/**
 * Wrap a result that may contain an `error` field into MCP format,
 * automatically setting isError when appropriate.
 */
function mcpResult(result: Record<string, unknown>) {
	if ("error" in result) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			isError: true as const,
		};
	}
	return mcpText(result);
}

/**
 * EmailMCP — exposes email tools over the Model Context Protocol.
 *
 * Clients (ProtoAgent, Claude Code, Cursor, etc.) connect to the
 * `/mcp` endpoint and can list mailboxes, read/search emails,
 * draft replies, send messages, and manage folders.
 */
export class EmailMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "agentic-inbox",
		version: "1.0.0",
	});

	async init() {
		const env = this.env;

		/**
		 * Verify a mailbox exists in R2 before operating on it.
		 * Returns an MCP error response if the mailbox is not found, or null if valid.
		 */
		const verifyMailbox = async (mailboxId: string) => {
			const obj = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
			if (!obj) {
				return mcpError(`Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`);
			}
			return null;
		};

		// ── list_mailboxes ─────────────────────────────────────────
		this.server.tool(
			"list_mailboxes",
			"List all available mailboxes",
			{},
			async () => {
				const result = await toolListMailboxes(env);
				return mcpText(result);
			},
		);

		// ── list_emails ────────────────────────────────────────────
		this.server.tool(
			"list_emails",
			"List emails in a mailbox folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
			{
				mailboxId: z
					.string()
					.describe("The mailbox email address (e.g. user@example.com)"),
				folder: z
					.string()
					.default(Folders.INBOX)
					.describe(FOLDER_TOOL_DESCRIPTION),
				limit: z
					.number()
					.default(20)
					.describe("Maximum number of emails to return"),
				page: z
					.number()
					.default(1)
					.describe("Page number for pagination"),
			},
			async ({ mailboxId, folder, limit, page }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolListEmails(env, mailboxId, { folder, limit, page });
				return mcpText(result);
			},
		);

		// ── get_email ──────────────────────────────────────────────
		this.server.tool(
			"get_email",
			"Get a single email with its full body content. Use this to read the actual content of an email.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to retrieve"),
			},
			async ({ mailboxId, emailId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolGetEmail(env, mailboxId, emailId);
				if ("error" in result) {
					return {
						content: [{ type: "text" as const, text: "Email not found" }],
						isError: true,
					};
				}
				return mcpText(result);
			},
		);

		// ── get_thread ─────────────────────────────────────────────
		this.server.tool(
			"get_thread",
			"Get all emails in a conversation thread. Returns all messages sorted chronologically.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				threadId: z
					.string()
					.describe("The thread_id to retrieve all messages for"),
			},
			async ({ mailboxId, threadId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolGetThread(env, mailboxId, threadId);
				return mcpText(result);
			},
		);

		// ── search_emails ──────────────────────────────────────────
		this.server.tool(
			"search_emails",
			"Search for emails matching a query across subject and body fields.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				query: z.string().describe("Search query to match against subject and body"),
				folder: z
					.string()
					.optional()
					.describe("Optional folder to restrict search to"),
			},
			async ({ mailboxId, query, folder }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSearchEmails(env, mailboxId, { query, folder });
				return mcpText(result);
			},
		);

		// ── draft_reply ────────────────────────────────────────────
		this.server.tool(
			"draft_reply",
			"Draft a reply to an email and save it to the Drafts folder. Does NOT send — saves a draft for review.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line (usually 'Re: ...')"),
				bodyHtml: z
					.string()
					.describe("The HTML body of the reply"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDraftReply(env, mailboxId, {
					originalEmailId,
					to,
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
				});
				return mcpResult(result);
			},
		);

		// ── create_draft ───────────────────────────────────────────
		this.server.tool(
			"create_draft",
			"Create a new draft email. Can be a new email or a reply draft.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				to: z
					.string()
					.optional()
					.describe("Recipient email address (optional for early drafts)"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the draft"),
				in_reply_to: z
					.string()
					.optional()
					.describe("The ID of the email this draft is replying to (optional)"),
				thread_id: z
					.string()
					.optional()
					.describe("Thread ID to attach this draft to (optional)"),
			},
			async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDraftEmail(env, mailboxId, {
					to: to || "",
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
					in_reply_to,
					thread_id,
				});
				if ("error" in result) {
					return mcpResult(result);
				}
				// Map the response to match the original create_draft output shape
				return mcpText({
					status: "draft_created",
					draftId: result.draftId,
					threadId: result.threadId,
					message: "Draft created in Drafts folder.",
				});
			},
		);

		// ── update_draft ───────────────────────────────────────────
		this.server.tool(
			"update_draft",
			"Update an existing draft email's content.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				draftId: z.string().describe("The ID of the draft to update"),
				to: z
					.string()
					.optional()
					.describe("Updated recipient email address"),
				subject: z.string().optional().describe("Updated subject line"),
				bodyHtml: z.string().optional().describe("Updated HTML body"),
			},
			async ({ mailboxId, draftId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolUpdateDraft(env, mailboxId, {
					draftId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					if (result.error === "Draft not found") {
						return {
							content: [{ type: "text" as const, text: "Draft not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── delete_email ───────────────────────────────────────────
		this.server.tool(
			"delete_email",
			"Permanently delete an email by ID.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to delete"),
			},
			async ({ mailboxId, emailId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDeleteEmail(env, mailboxId, emailId);
				return mcpResult(result);
			},
		);

		// ── send_reply ─────────────────────────────────────────────
		this.server.tool(
			"send_reply",
			"Send a reply to an email. Only call after drafting and getting confirmation.",
			{
				mailboxId: z.string().describe("The mailbox email address to send from"),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the reply"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSendReply(env, mailboxId, {
					originalEmailId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					// Preserve the original MCP error format for send failures
					if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
						return {
							content: [{ type: "text" as const, text: result.error }],
							isError: true,
						};
					}
					if (result.error === "Original email not found") {
						return {
							content: [{ type: "text" as const, text: "Original email not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── send_email ─────────────────────────────────────────────
		this.server.tool(
			"send_email",
			"Send a new email (not a reply). Only call after getting confirmation.",
			{
				mailboxId: z.string().describe("The mailbox email address to send from"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the email"),
			},
			async ({ mailboxId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSendEmail(env, mailboxId, {
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
						return {
							content: [{ type: "text" as const, text: result.error }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── mark_email_read ────────────────────────────────────────
		this.server.tool(
			"mark_email_read",
			"Mark an email as read or unread.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				read: z.boolean().describe("true to mark as read, false for unread"),
			},
			async ({ mailboxId, emailId, read }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolMarkEmailRead(env, mailboxId, emailId, read);
				return mcpText(result);
			},
		);

		// ── move_email ─────────────────────────────────────────────
		this.server.tool(
			"move_email",
			"Move an email to a different folder (inbox, sent, draft, archive, trash).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				folderId: z
					.string()
					.describe(MOVE_FOLDER_TOOL_DESCRIPTION),
			},
			async ({ mailboxId, emailId, folderId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolMoveEmail(env, mailboxId, emailId, folderId);
				if ("error" in result) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ error: "Failed to move email" }),
							},
						],
						isError: true,
					};
				}
				return mcpText(result);
			},
		);

		// ════ Calendar tools (docs/AGENTIC-CALENDAR-SPEC.md §9.2) ════
		// Aggregated busy/free across the registered ICS feeds (CalendarDO).
		// Times are ISO 8601 with offset in and out; the server normalizes to
		// UTC — callers never do timezone math.

		// ── get_availability ───────────────────────────────────────
		this.server.tool(
			"get_availability",
			"Get busy intervals across all calendars (Proton/Outlook/iCloud feeds plus agent-created blocks) for a time window. feed_warnings lists feeds whose data is stale or erroring — caveat answers accordingly. Returns only BUSY time: FREE/transparent events are excluded by design, so use list_calendar_events when the question is what is on the calendar rather than when it is blocked. Calendar data is retained for ±365 days, but one request may span at most 92 days.",
			{
				window_start: z
					.string()
					.describe("Window start, ISO 8601 (e.g. 2026-06-15T00:00:00-07:00)"),
				window_end: z.string().describe("Window end, ISO 8601"),
			},
			async (args) => {
				const result = await toolGetAvailability(env, args);
				return mcpResult(result);
			},
		);

		// ── find_free_slots ────────────────────────────────────────
		this.server.tool(
			"find_free_slots",
			"Find free time slots of at least duration_minutes within a window, intersected with working hours (default 08:00-18:00 America/Los_Angeles). Each returned slot is a full free gap — any start time with start + duration <= slot end fits. Sorted, max 20 slots.",
			{
				duration_minutes: z
					.number()
					.describe("Minimum slot duration in minutes"),
				window_start: z.string().describe("Window start, ISO 8601"),
				window_end: z.string().describe("Window end, ISO 8601"),
				working_hours: z
					.object({
						start: z.string().describe('Daily start "HH:MM" local'),
						end: z.string().describe('Daily end "HH:MM" local'),
						tz: z.string().describe("IANA timezone, e.g. America/Los_Angeles"),
					})
					.optional()
					.describe("Override the default working hours"),
				min_gap_minutes: z
					.number()
					.optional()
					.describe("Padding to leave around existing busy intervals"),
			},
			async (args) => {
				const result = await toolFindFreeSlots(env, args);
				return mcpResult(result);
			},
		);

		// ── block_time ─────────────────────────────────────────────
		this.server.tool(
			"block_time",
			"Block time across ALL calendars by emailing standards-compliant invites (iMIP) to each account. Asynchronous: returns immediately with status 'pending' (the slot counts as busy right away); acceptance per account is tracked by a workflow — check with get_block_status. Refuses with the conflict list if the window overlaps busy time, unless force is true.",
			{
				start: z.string().describe("Block start, ISO 8601"),
				end: z.string().describe("Block end, ISO 8601"),
				title: z.string().describe("Event title shown on all calendars"),
				force: z
					.boolean()
					.optional()
					.describe("Book even if the window conflicts with busy time"),
			},
			async (args) => {
				const result = await toolBlockTime(env, args);
				return mcpResult(result);
			},
		);

		// ── get_block_status ───────────────────────────────────────
		this.server.tool(
			"get_block_status",
			"Get a block's status (pending | partial | confirmed | cancelled) and per-account acceptance state (ACCEPTED | DECLINED | TENTATIVE | NEEDS-ACTION).",
			{
				uid: z.string().describe("The block uid returned by block_time"),
			},
			async (args) => {
				const result = await toolGetBlockStatus(env, args);
				return mcpResult(result);
			},
		);

		// ── cancel_block ───────────────────────────────────────────
		this.server.tool(
			"cancel_block",
			"Cancel a block: sends METHOD:CANCEL with a bumped SEQUENCE to every account (calendars remove the event) and stops the acceptance workflow.",
			{
				uid: z.string().describe("The block uid to cancel"),
			},
			async (args) => {
				const result = await toolCancelBlock(env, args);
				return mcpResult(result);
			},
		);

		// ── delete_block ───────────────────────────────────────────
		this.server.tool(
			"delete_block",
			"Permanently delete a CANCELLED block's record (removes it from the Time blocks view entirely). Refuses unless the block is already cancelled, so cancel_block it first. Use only on the operator's explicit request, for cleaning up stale or test blocks.",
			{
				uid: z.string().describe("The block uid to delete (must be cancelled)"),
			},
			async (args) => {
				const result = await toolDeleteBlock(env, args);
				return mcpResult(result);
			},
		);

		// ── purge_cancelled_blocks ─────────────────────────────────
		this.server.tool(
			"purge_cancelled_blocks",
			"Permanently delete EVERY cancelled block's record in one shot (bulk cleanup). Only cancelled blocks are removed; active ones are untouched. Returns the count purged. Use only on the operator's explicit request.",
			{},
			async () => {
				const result = await toolPurgeCancelledBlocks(env);
				return mcpResult(result);
			},
		);

		// ── list_blocks ────────────────────────────────────────────
		this.server.tool(
			"list_blocks",
			"List agent-created blocks, optionally filtered by time window and status (pending | partial | confirmed | cancelled).",
			{
				window_start: z.string().optional().describe("ISO 8601 window start"),
				window_end: z.string().optional().describe("ISO 8601 window end"),
				status: z.string().optional().describe("Filter by block status"),
			},
			async (args) => {
				const result = await toolListBlocks(env, args);
				return mcpResult(result);
			},
		);

		// ── list_calendar_events ───────────────────────────────────
		this.server.tool(
			"list_calendar_events",
			"List the actual events on the calendars in a window — each with uid, feed_id, start/end (ISO 8601), all_day, busy, and summary. Read-only. Use this for \"what's on my calendar?\", \"what do I have Thursday?\", or any question about what the events ARE. Prefer get_availability instead when the question is only about free/busy time, and find_free_slots when you need bookable gaps. This tool is the only one that shows FREE/transparent events (all-day markers, OOO, holidays): get_availability filters those out by design, so an event can be absent there and still be on the calendar. summary is null on busy-only feeds (feed policy, not a missing title). is_own_block marks a feed's copy of a block the agent created. truncated:true means the limit was hit and more events exist.",
			{
				window_start: z
					.string()
					.describe("Window start, ISO 8601 (e.g. 2026-06-15T00:00:00-07:00)"),
				window_end: z.string().describe("Window end, ISO 8601"),
				feed_id: z
					.string()
					.optional()
					.describe("Restrict to one calendar feed id (see list_calendars); omit for all"),
				limit: z
					.number()
					.optional()
					.describe("Max events to return (default 200, capped at 1000)"),
			},
			async (args) => {
				const result = await toolListCalendarEvents(env, args);
				return mcpResult(result);
			},
		);

		// ── list_calendars ─────────────────────────────────────────
		this.server.tool(
			"list_calendars",
			"List the registered calendar feeds and their ingest health: id, label, detail_level (busy|full), event_count (events currently in the retained ±365 day window), last_fetched/last_changed (ISO 8601 or null), stale_hours (-1 = never fetched), fresh (recently fetched AND no error), and last_error. Read-only. Use this when asked which calendars you can see or whether they are current/connected — do NOT infer calendar connectivity from an empty get_availability result (a connected calendar can simply have no events in the queried window).",
			{},
			async () => {
				const result = await toolListCalendars(env);
				return mcpResult(result);
			},
		);
	}
}
