// Outbound iMIP sender (docs/AGENTIC-CALENDAR-SPEC.md §7.3). One attendee per
// message; all messages for a block share the UID. The MIME envelope is
// multipart/mixed: a text/plain body plus the iCalendar object as a named .ics
// part typed `text/calendar; method=...` (RFC 6047) — clients recognize a
// text/calendar part carrying an iTIP method as an invitation, and Proton in
// particular keys off the .ics part being present.
//
// NOTE: mimetext's addMessage() only accepts text/html|text/plain (it throws
// MIMETEXT_INVALID_MESSAGE_TYPE on text/calendar), and its asRaw() only ever
// builds a multipart/alternative from those two — so the calendar entity must
// be emitted via addAttachment(), whose content-type is validated by mime-types
// and accepts text/calendar. See F-013.

import { createMimeMessage } from "mimetext";
import { EmailMessage } from "cloudflare:email";
import { buildIcs, type ImipMethod } from "./imip";
import type { FeedRow } from "./calendarDO";
import type { Env } from "../types";

const ORGANIZER_NAME = "T9 Calendar";

export interface InviteParams {
	method: ImipMethod;
	uid: string;
	sequence: number;
	title: string;
	dtstartMs: number;
	dtendMs: number;
}

function formatWhen(startMs: number, endMs: number): string {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	});
	return `${fmt.format(new Date(startMs))} – ${fmt.format(new Date(endMs))}`;
}

export async function sendImip(
	env: Env,
	feed: FeedRow,
	params: InviteParams,
): Promise<void> {
	const ics = buildIcs({
		method: params.method,
		uid: params.uid,
		sequence: params.sequence,
		dtstartMs: params.dtstartMs,
		dtendMs: params.dtendMs,
		summary: params.title,
		organizerAddr: env.ORGANIZER_ADDR,
		organizerName: ORGANIZER_NAME,
		attendeeEmail: feed.invite_email,
		attendeeName: feed.label,
	});

	const isCancel = params.method === "CANCEL";
	const subject = isCancel ? `Cancelled: ${params.title}` : params.title;
	const textBody = isCancel
		? `${params.title} (${formatWhen(params.dtstartMs, params.dtendMs)}) has been cancelled.`
		: `${params.title}\n${formatWhen(params.dtstartMs, params.dtendMs)}\n\nThis time block was created by the T9 calendar agent. Accept to add it to this calendar.`;

	const msg = createMimeMessage();
	msg.setSender({ name: ORGANIZER_NAME, addr: env.ORGANIZER_ADDR });
	msg.setRecipient(feed.invite_email);
	msg.setSubject(subject);
	msg.addMessage({ contentType: "text/plain", data: textBody });
	// The iMIP payload: a text/calendar part carrying the iTIP method. Emitted as
	// an attachment because mimetext rejects text/calendar via addMessage (F-013).
	msg.addAttachment({
		filename: isCancel ? "cancel.ics" : "invite.ics",
		contentType: `text/calendar; method=${params.method}; charset=UTF-8`,
		data: btoa(unescape(encodeURIComponent(ics))), // base64 of UTF-8 bytes
	});

	const message = new EmailMessage(
		env.ORGANIZER_ADDR,
		feed.invite_email,
		msg.asRaw(),
	);
	// The send_email binding accepts raw EmailMessage alongside the structured
	// API used by workers/email-sender.ts.
	await (env.EMAIL as unknown as { send(m: EmailMessage): Promise<unknown> }).send(
		message,
	);
}
