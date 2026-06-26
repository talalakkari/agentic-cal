// Inbound calendar dispatch (docs/AGENTIC-CALENDAR-SPEC.md §7.1, §7.4).
// receiveEmail() calls isCalendarInbound() right after parsing; calendar
// traffic NEVER creates mailbox threads, mailbox traffic NEVER touches
// CalendarDO. Since the single-address consolidation the ORGANIZER address is
// also the monitored inbox, so dispatch is purely PAYLOAD-based: a text/calendar
// part carrying an inbound iTIP method (REPLY/COUNTER/CANCEL) is the entry
// signal, and UID ownership — does the iTIP UID match one of our blocks? —
// decides whether it is actually ours. Everything else (plain mail, bounces,
// OOO autoreplies, foreign-UID iTIP) falls through to the inbox. Zero mail loss.

import type { Email } from "postal-mime";
import { hasInboundItipMethod, parseImip } from "./imip";
import { getCalendarStub, workflowIdForUid } from "./poller";
import type { Env } from "../types";

/** Decode a postal-mime part body to text. */
function partToText(content: ArrayBuffer | string): string {
	return typeof content === "string"
		? content
		: new TextDecoder().decode(content);
}

/** Find the text/calendar payload of a parsed message, if any. */
export function findCalendarPart(parsed: Email): string | null {
	for (const att of parsed.attachments ?? []) {
		const isCalendar =
			att.mimeType?.toLowerCase().includes("text/calendar") ||
			att.mimeType?.toLowerCase().includes("application/ics") ||
			(att.filename ?? "").toLowerCase().endsWith(".ics");
		if (isCalendar) return partToText(att.content);
	}
	// Some clients put the ICS straight into the text body.
	const text = parsed.text ?? "";
	if (text.includes("BEGIN:VCALENDAR")) {
		const start = text.indexOf("BEGIN:VCALENDAR");
		const end = text.lastIndexOf("END:VCALENDAR");
		if (end > start) return text.slice(start, end + "END:VCALENDAR".length);
	}
	return null;
}

/**
 * Dispatch predicate (post single-address consolidation): a message diverts to
 * the calendar path ONLY when it carries an inbound iTIP method
 * (REPLY/COUNTER/CANCEL) in a text/calendar part. We no longer shortcut on the
 * recipient address — the ORGANIZER is now the monitored inbox too,
 * so an address match would swallow ordinary mail. Whether a matched payload is
 * actually ours is decided downstream by UID ownership in handleCalendarInbound.
 */
export function isCalendarInbound(parsed: Email): boolean {
	const calPart = findCalendarPart(parsed);
	return calPart !== null && hasInboundItipMethod(calPart);
}

/**
 * Handle calendar-path inbound mail. Never throws — calendar traffic must
 * never bounce back into Email Routing retries.
 *
 * Returns "handled" when the message was consumed by the calendar path (an iTIP
 * payload whose UID matches one of our blocks), or "fallthrough" when it turns
 * out NOT to be ours — a UID matching none of our blocks, or a calendar part we
 * can't parse. Now that the ORGANIZER address is the monitored inbox, ownership
 * is the ONLY discriminator: anything not provably ours must continue to the
 * mailbox path or it would be silently lost mail.
 */
export async function handleCalendarInbound(
	parsed: Email,
	rawEmail: ArrayBuffer | ArrayBufferView,
	env: Env,
): Promise<"handled" | "fallthrough"> {
	const sender = parsed.from?.address?.toLowerCase() ?? "unknown";
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");

	try {
		const calPart = findCalendarPart(parsed);
		if (!calPart) {
			// The entry predicate guarantees a calendar part; if one is somehow
			// absent here the inbox owns the mail — never drop it now that the
			// ORGANIZER address is a real, monitored mailbox.
			return "fallthrough";
		}

		let reply;
		try {
			reply = parseImip(calPart);
		} catch (e) {
			// A calendar part we can't parse isn't provably ours — the inbox owns
			// it. It stays visible in the monitored mailbox rather than being
			// silently archived (as the phantom-organizer model used to do).
			console.log(`Inbound with malformed ICS from ${sender}: falling through to mailbox (${(e as Error).message})`);
			return "fallthrough";
		}

		// Ownership is the only discriminator now that ORGANIZER == inbox: if the
		// UID matches none of our blocks it is not our event — forwarded RSVPs,
		// replies to meetings the operator organized elsewhere, any foreign iTIP.
		// The inbox must receive it.
		const stub = getCalendarStub(env);
		const block = await stub.getBlock(reply.uid);
		if (!block) {
			console.log(`iTIP ${reply.method} for foreign uid ${reply.uid} — not one of our blocks, falling through to mailbox`);
			return "fallthrough";
		}

		// Snapshot every raw client REPLY to one of our blocks as a parser
		// fixture (spec §12 Phase 3).
		await archiveRaw(env, `inbound-replies/${stamp}-${sender}.eml`, rawEmail);

		if (reply.method !== "REPLY") {
			console.log(`Calendar inbound from ${sender}: METHOD:${reply.method} (uid ${reply.uid}) — archived, no action in v1`);
			return "handled";
		}
		if (!reply.partstat) {
			console.log(`Calendar REPLY from ${sender} (uid ${reply.uid}) has no PARTSTAT — ignored`);
			return "handled";
		}

		// Map the reply to a feed. The iTIP ATTENDEE address is authoritative: it
		// echoes the exact invited address this REPLY answers (RFC 5546), so it
		// distinguishes feeds even when one mail account fronts several addresses
		// and sends every RSVP from a single envelope From. Match the ATTENDEE
		// first; fall back to the From sender only when the reply carries no
		// matching ATTENDEE. (From-first mis-attributed a Proton acceptance to the
		// iCloud feed whenever Proton sent both accounts' replies from the iCloud
		// address — 2026-06-25.)
		const feeds = await stub.listFeeds();
		const feed =
			(reply.attendeeEmail
				? feeds.find(
						(f) => f.invite_email.toLowerCase() === reply.attendeeEmail,
					)
				: undefined) ??
			feeds.find((f) => f.invite_email.toLowerCase() === sender);
		console.log(
			`Calendar REPLY match: uid=${reply.uid} from=${sender} attendee=${reply.attendeeEmail ?? "none"} -> feed=${feed?.id ?? "NONE"} partstat=${reply.partstat}`,
		);
		if (!feed) {
			console.warn(`Calendar REPLY (uid ${reply.uid}) from ${sender} attendee ${reply.attendeeEmail ?? "none"}: no feed matches — archived only`);
			return "handled";
		}

		await stub.recordReply(reply.uid, feed.id, reply.partstat);
		console.log(`Calendar REPLY: ${feed.id} -> ${reply.partstat} for ${reply.uid}`);

		// Wake the block's workflow if it's still waiting on this account.
		await notifyWorkflow(env, reply.uid, feed.id, reply.partstat);
		return "handled";
	} catch (e) {
		console.error(`Calendar inbound from ${sender} failed:`, (e as Error).message);
		try {
			await archiveRaw(env, `inbound-misc/${stamp}-${sender}-error.eml`, rawEmail);
		} catch {
			// archiving is best-effort
		}
		// Unexpected failure on a message we matched: keep it on the calendar
		// path (archived above) rather than risk double-processing.
		return "handled";
	}
}

async function archiveRaw(
	env: Env,
	key: string,
	raw: ArrayBuffer | ArrayBufferView,
): Promise<void> {
	await env.SNAPSHOTS.put(key, raw, {
		httpMetadata: { contentType: "message/rfc822" },
	});
}

async function notifyWorkflow(
	env: Env,
	uid: string,
	feedId: string,
	partstat: string,
): Promise<void> {
	try {
		const instance = await env.BLOCK_WORKFLOW.get(workflowIdForUid(uid));
		// Event type must be colon-free: Workflows' sendEvent rejects a `:` in the
		// type with `invalid_event_type`, even when the workflow is actively
		// waiting on it. Must match the hyphenated type the workflow registers in
		// waitForEvent (`reply-<feed>`), not `reply:<feed>`.
		await instance.sendEvent({
			type: `reply-${feedId}`,
			payload: { partstat },
		});
	} catch (e) {
		// Workflow may have finished (nag timeout elapsed) or never existed for
		// re-polled historical blocks. The DO already recorded the reply.
		console.log(`Workflow notify skipped for ${uid}: ${(e as Error).message}`);
	}
}
