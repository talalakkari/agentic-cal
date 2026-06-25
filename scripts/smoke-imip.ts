// Smoke test for the iMIP write/read path (npx tsx scripts/smoke-imip.ts):
// ICS authoring (folding, escaping, structure), METHOD:REPLY parsing, the
// payload-based email() dispatch predicate, and the UID-ownership routing in
// handleCalendarInbound — all run against real postal-mime parsing.

import PostalMime from "postal-mime";
// Fixtures use example.com — the values are arbitrary; the assertions only check
// structure (folding, escaping, dispatch), not the specific domain.
import { buildIcs, parseImip, hasInboundItipMethod } from "../workers/calendar/imip";
import { findCalendarPart, isCalendarInbound, handleCalendarInbound } from "../workers/calendar/inbound";
import { workflowIdForUid } from "../workers/calendar/poller";
import type { Env } from "../workers/types";

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`ok: ${msg}`);
}

// ── buildIcs ──
const ics = buildIcs({
	method: "REQUEST",
	uid: "01J9ZK7M3QX@calendar.example.com",
	sequence: 0,
	dtstartMs: Date.parse("2026-06-18T21:00:00Z"),
	dtendMs: Date.parse("2026-06-18T23:00:00Z"),
	summary:
		"Deep work; FISPM proposal, drafting — a deliberately long summary line to force RFC 5545 folding behavior over seventy-five octets",
	organizerAddr: "calendar@example.com",
	organizerName: "T9 Calendar",
	attendeeEmail: "me@proton.example",
	attendeeName: "Personal",
});

assert(ics.includes("METHOD:REQUEST"), "METHOD:REQUEST present");
assert(ics.includes("UID:01J9ZK7M3QX@calendar.example.com"), "UID present");
assert(ics.includes("DTSTART:20260618T210000Z"), "DTSTART formatted as ICS UTC");
assert(ics.includes("\\;"), "semicolons escaped in SUMMARY");
assert(ics.includes("\\,"), "commas escaped in SUMMARY");
assert(
	ics.includes("ORGANIZER;CN=T9 Calendar:mailto:calendar@example.com"),
	"ORGANIZER aligned with sending address",
);
assert(
	/ATTENDEE;CN=Personal;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE/.test(ics),
	"single ATTENDEE with RSVP=TRUE",
);
const encoder = new TextEncoder();
const overlong = ics
	.split("\r\n")
	.filter((line) => encoder.encode(line).length > 75);
assert(overlong.length === 0, `all lines folded to <=75 octets (got ${overlong.length} overlong)`);
// Folded lines must reassemble to the original logical line
const unfolded = ics.replace(/\r\n[ \t]/g, "");
assert(
	unfolded.includes("SUMMARY:Deep work\\; FISPM proposal\\, drafting"),
	"folded SUMMARY unfolds intact",
);

const cancel = buildIcs({
	method: "CANCEL",
	uid: "01J9ZK7M3QX@calendar.example.com",
	sequence: 1,
	dtstartMs: Date.parse("2026-06-18T21:00:00Z"),
	dtendMs: Date.parse("2026-06-18T23:00:00Z"),
	summary: "Deep work",
	organizerAddr: "calendar@example.com",
	organizerName: "T9 Calendar",
	attendeeEmail: "me@proton.example",
	attendeeName: "Personal",
});
assert(
	cancel.includes("METHOD:CANCEL") &&
		cancel.includes("STATUS:CANCELLED") &&
		cancel.includes("SEQUENCE:1"),
	"CANCEL carries STATUS:CANCELLED + bumped SEQUENCE",
);

// ── parseImip on a typical client REPLY ──
const replyIcs = [
	"BEGIN:VCALENDAR",
	"VERSION:2.0",
	"PRODID:-//Proton AG//web-calendar 5.0//EN",
	"METHOD:REPLY",
	"BEGIN:VEVENT",
	"UID:01J9ZK7M3QX@calendar.example.com",
	"SEQUENCE:0",
	"DTSTAMP:20260618T210500Z",
	"ATTENDEE;PARTSTAT=ACCEPTED;CN=Personal:mailto:me@proton.example",
	"ORGANIZER;CN=T9 Calendar:mailto:calendar@example.com",
	"END:VEVENT",
	"END:VCALENDAR",
].join("\r\n");

const parsedReply = parseImip(replyIcs);
assert(parsedReply.method === "REPLY", "REPLY method parsed");
assert(parsedReply.uid === "01J9ZK7M3QX@calendar.example.com", "UID extracted");
assert(parsedReply.partstat === "ACCEPTED", "PARTSTAT=ACCEPTED extracted");
assert(parsedReply.attendeeEmail === "me@proton.example", "attendee mailto extracted");
assert(hasInboundItipMethod(replyIcs), "hasInboundItipMethod matches REPLY");
assert(!hasInboundItipMethod(ics), "outbound REQUEST is not inbound traffic");

// ── workflow instance id derivation (regression: instance.invalid_id) ──
// Block UIDs are RFC-5545 form (<ulid>@calendar.<domain>); Workflows instance
// ids only allow [A-Za-z0-9_-], so the raw UID makes create() throw.
{
	const uid = "01J9ZK7M3QX@calendar.example.com";
	const wfId = workflowIdForUid(uid);
	assert(/^[A-Za-z0-9_-]+$/.test(wfId), `workflow id is Workflows-legal (got "${wfId}")`);
	assert(!wfId.includes("@") && !wfId.includes("."), "workflow id has no @ or . (the invalid_id chars)");
	assert(workflowIdForUid(uid) === wfId, "workflow id derivation is deterministic");
	assert(workflowIdForUid("01ABC@calendar.example.com") !== wfId, "distinct uids map to distinct workflow ids");
}

// ── dispatch predicate against real postal-mime parses (payload-based) ──
// Post single-address consolidation: the ORGANIZER address is BOTH organizer and the
// monitored inbox, so dispatch keys on the payload (an inbound iTIP method),
// never on the recipient address. Ownership (UID matches a block) is proven
// downstream in handleCalendarInbound.

// Minimal env/stub double for the calendar DO path. getCalendarStub(env) reads
// env.CALENDAR_DO.get(idFromName(...)); we return a stub whose getBlock answers
// only for ownedUid, and we capture recordReply calls.
function makeFakeEnv(opts: {
	ownedUid: string | null;
	feeds: Array<{ id: string; invite_email: string; label: string }>;
}) {
	const recorded: Array<{ uid: string; feedId: string; partstat: string }> = [];
	const stub = {
		getBlock: async (uid: string) =>
			opts.ownedUid && uid === opts.ownedUid ? { uid } : null,
		listFeeds: async () => opts.feeds,
		recordReply: async (uid: string, feedId: string, partstat: string) => {
			recorded.push({ uid, feedId, partstat });
		},
	};
	const env = {
		CALENDAR_DO: { idFromName: () => "default", get: () => stub },
		SNAPSHOTS: { put: async () => {} },
		BLOCK_WORKFLOW: { get: async () => ({ sendEvent: async () => {} }) },
		ORGANIZER_ADDR: "calendar@example.com",
	} as unknown as Env;
	return { env, recorded };
}

async function main() {
	const normalMail = [
		"From: alice@example.com",
		"To: hello@example.com",
		"Subject: lunch?",
		"Content-Type: text/plain",
		"",
		"Want to grab lunch Thursday? BEGIN:VCALENDAR is mentioned but not real.",
	].join("\r\n");
	const parsedNormal = await new PostalMime().parse(normalMail);
	assert(!isCalendarInbound(parsedNormal), "plain mail stays on the mailbox path");

	// The consolidation's crux: plain mail addressed to the ORGANIZER (now the
	// monitored inbox) must NOT divert — no calendar part, so it reaches the inbox.
	const plainToOrganizer = [
		"From: alice@example.com",
		"To: calendar@example.com",
		"Subject: anything",
		"Content-Type: text/plain",
		"",
		"Out of office.",
	].join("\r\n");
	const parsedPlainToOrganizer = await new PostalMime().parse(plainToOrganizer);
	assert(
		!isCalendarInbound(parsedPlainToOrganizer),
		"plain mail to the ORGANIZER address falls through to the inbox (no address shortcut)",
	);

	const replyMail = [
		"From: me@proton.example",
		"To: calendar@example.com",
		"Subject: Re: Deep work",
		'Content-Type: multipart/mixed; boundary="b1"',
		"",
		"--b1",
		"Content-Type: text/plain",
		"",
		"Accepted: Deep work",
		"--b1",
		'Content-Type: text/calendar; charset=utf-8; method=REPLY',
		"",
		replyIcs,
		"--b1--",
	].join("\r\n");
	const parsedImipMail = await new PostalMime().parse(replyMail);
	const calPart = findCalendarPart(parsedImipMail);
	assert(!!calPart && calPart.includes("METHOD:REPLY"), "text/calendar part extracted from MIME");
	assert(isCalendarInbound(parsedImipMail), "iMIP REPLY mail diverts to the calendar path (payload-based)");

	// ── UID-ownership branches in handleCalendarInbound (fake env/stub) ──
	const rawReply = new TextEncoder().encode(replyMail);
	const feeds = [{ id: "feed-proton", invite_email: "me@proton.example", label: "Personal" }];
	const OUR_UID = "01J9ZK7M3QX@calendar.example.com";

	// our-UID REPLY → consumed by the calendar path + RSVP recorded
	{
		const { env, recorded } = makeFakeEnv({ ownedUid: OUR_UID, feeds });
		const verdict = await handleCalendarInbound(parsedImipMail, rawReply, env);
		assert(verdict === "handled", "our-UID REPLY is consumed by the calendar path");
		assert(
			recorded.length === 1 &&
				recorded[0].uid === OUR_UID &&
				recorded[0].feedId === "feed-proton" &&
				recorded[0].partstat === "ACCEPTED",
			"our-UID REPLY records the RSVP against the matching feed",
		);
	}

	// foreign-UID REPLY (UID matches no block) → falls through to the inbox, nothing recorded
	{
		const { env, recorded } = makeFakeEnv({ ownedUid: null, feeds });
		const verdict = await handleCalendarInbound(parsedImipMail, rawReply, env);
		assert(verdict === "fallthrough", "foreign-UID REPLY falls through to the inbox");
		assert(recorded.length === 0, "foreign-UID REPLY records nothing");
	}

	console.log("\nAll iMIP assertions passed.");
}

main();
