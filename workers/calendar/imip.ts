// iMIP / iTIP payloads (RFC 5546 over RFC 6047). Pure module — ICS authoring
// and METHOD:REPLY parsing, no Cloudflare imports, testable in Node.
// Make-or-break rules per docs/AGENTIC-CALENDAR-SPEC.md §7.2:
//   - one attendee per outbound message; the shared UID is what makes it
//     "the same event" across accounts
//   - ORGANIZER must align with the sending domain or Outlook distrusts it
//   - SEQUENCE bumps on every reschedule/cancel
//   - RFC 5545 line folding: <=75 octets, CRLF + space continuation

import ICAL from "ical.js";

export type ImipMethod = "REQUEST" | "CANCEL";

export interface IcsEventInput {
	method: ImipMethod;
	uid: string;
	sequence: number;
	dtstartMs: number;
	dtendMs: number;
	summary: string;
	organizerAddr: string;
	organizerName: string;
	attendeeEmail: string;
	attendeeName: string;
}

/** Escape TEXT property values per RFC 5545 §3.3.11. */
function escapeText(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r?\n/g, "\\n");
}

/** Format epoch ms as an ICS UTC date-time (YYYYMMDDTHHMMSSZ). */
function icsUtc(ms: number): string {
	return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Fold a content line to <=75 octets per line (RFC 5545 §3.1). Folding is
 * byte-based; continuation lines start with a single space.
 */
function foldLine(line: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(line).length <= 75) return line;

	const out: string[] = [];
	let current = "";
	let currentBytes = 0;
	let limit = 75;
	for (const ch of line) {
		const chBytes = encoder.encode(ch).length;
		if (currentBytes + chBytes > limit) {
			out.push(current);
			current = " ";
			currentBytes = 1;
			limit = 75;
		}
		current += ch;
		currentBytes += chBytes;
	}
	if (current) out.push(current);
	return out.join("\r\n");
}

/**
 * Author a single-VEVENT iCalendar object for an iMIP message. Exactly one
 * attendee — the caller sends one email per account.
 */
export function buildIcs(input: IcsEventInput): string {
	const status = input.method === "CANCEL" ? "CANCELLED" : "CONFIRMED";
	const lines = [
		"BEGIN:VCALENDAR",
		"PRODID:-//T9i//t9-agentic-cal//EN",
		"VERSION:2.0",
		`METHOD:${input.method}`,
		"BEGIN:VEVENT",
		`UID:${input.uid}`,
		`SEQUENCE:${input.sequence}`,
		`DTSTAMP:${icsUtc(Date.now())}`,
		`DTSTART:${icsUtc(input.dtstartMs)}`,
		`DTEND:${icsUtc(input.dtendMs)}`,
		`SUMMARY:${escapeText(input.summary)}`,
		`ORGANIZER;CN=${escapeText(input.organizerName)}:mailto:${input.organizerAddr}`,
		`ATTENDEE;CN=${escapeText(input.attendeeName)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${input.attendeeEmail}`,
		`STATUS:${status}`,
		"TRANSP:OPAQUE",
		"END:VEVENT",
		"END:VCALENDAR",
	];
	return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ── Inbound REPLY parsing ──────────────────────────────────────────

export type PartStat = "ACCEPTED" | "DECLINED" | "TENTATIVE" | "NEEDS-ACTION";

export interface ImipReply {
	method: string; // REPLY | COUNTER | CANCEL | ...
	uid: string;
	attendeeEmail: string | null;
	partstat: PartStat | null;
}

/**
 * Parse the calendar part of an inbound iMIP message. Throws on unparseable
 * input — callers archive the raw message and drop.
 */
export function parseImip(icsText: string): ImipReply {
	const comp = new ICAL.Component(ICAL.parse(icsText));
	const method = String(comp.getFirstPropertyValue("method") ?? "").toUpperCase();
	const vevent = comp.getFirstSubcomponent("vevent");
	if (!vevent) throw new Error("calendar part has no VEVENT");

	const uid = String(vevent.getFirstPropertyValue("uid") ?? "");
	if (!uid) throw new Error("VEVENT has no UID");

	let attendeeEmail: string | null = null;
	let partstat: PartStat | null = null;
	const attendee = vevent.getFirstProperty("attendee");
	if (attendee) {
		const value = String(attendee.getFirstValue() ?? "");
		attendeeEmail = value.replace(/^mailto:/i, "").toLowerCase() || null;
		const ps = String(attendee.getParameter("partstat") ?? "").toUpperCase();
		if (["ACCEPTED", "DECLINED", "TENTATIVE", "NEEDS-ACTION"].includes(ps)) {
			partstat = ps as PartStat;
		}
	}

	return { method, uid, attendeeEmail, partstat };
}

/** True when the ICS text carries an iTIP method that belongs to us. */
export function hasInboundItipMethod(icsText: string): boolean {
	return /METHOD\s*:\s*(REPLY|COUNTER|CANCEL)/i.test(icsText);
}
