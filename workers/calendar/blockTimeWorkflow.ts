// BlockTimeWorkflow (docs/AGENTIC-CALENDAR-SPEC.md §8). One instance per
// block; instance id = block UID. Canonical human-in-the-loop Workflows
// pattern: independently retried steps, free hibernating waits, waitForEvent
// for the asynchronous client acceptances arriving via the email() dispatch.
//
// The block row is written by the block_time tool BEFORE the workflow spawns
// (pending blocks must count as busy with zero race), so the first step here
// only verifies it exists.

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { getCalendarStub } from "./poller";
import { guestWorkflowKey } from "./guests";
import { sendImip, sendImipToGuest, type InviteParams } from "./send-invite";
import { sendEmail } from "../email-sender";
import type { FeedRow } from "./calendarDO";
import type { Env } from "../types";

export interface BlockTimeParams {
	uid: string;
	title: string;
	description?: string;
	dtstart: number;
	dtend: number;
}

type BlockGuestRow = { guest_email: string; partstat: string; replied_at: number | null };

export class BlockTimeWorkflow extends WorkflowEntrypoint<Env, BlockTimeParams> {
	async run(event: WorkflowEvent<BlockTimeParams>, step: WorkflowStep) {
		try {
			await this.runBlock(event, step);
		} catch (e) {
			try {
				await getCalendarStub(this.env).recordBlockError(
					event.payload.uid,
					`Invite workflow errored: ${(e as Error).message}`,
				);
			} catch {
				// swallow — the badge is best-effort; the thrown error is what matters
			}
			throw e;
		}
	}

	private async runBlock(event: WorkflowEvent<BlockTimeParams>, step: WorkflowStep) {
		const { uid, title, description, dtstart, dtend } = event.payload;

		const { feeds, guests } = (await step.do("load-targets", async () => {
			const stub = getCalendarStub(this.env);
			const block = await stub.getBlock(uid);
			if (!block) throw new Error(`Block ${uid} not found — was it cancelled before start?`);
			return { feeds: await stub.listFeeds(), guests: block.guests };
		})) as { feeds: FeedRow[]; guests: BlockGuestRow[] };

		const inviteParams: Omit<InviteParams, "method"> = {
			uid,
			sequence: 0,
			title,
			...(description ? { description } : {}),
			dtstartMs: dtstart,
			dtendMs: dtend,
		};

		const sendOutcomes = await Promise.allSettled(
			feeds.map((feed) =>
				step.do(
					`send-imip-${feed.id}`,
					{ retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
					async () => {
						const stub = getCalendarStub(this.env);
						if (await stub.wasInviteSent(uid, feed.id, 0)) return;
						await sendImip(this.env, feed, { method: "REQUEST", ...inviteParams });
						await stub.markInviteSent(uid, feed.id, 0);
					},
				),
			),
		);

		const guestSendOutcomes = await Promise.allSettled(
			guests.map((guest) =>
				step.do(
					`send-imip-${guestWorkflowKey(guest.guest_email)}`,
					{ retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
					async () => {
						const stub = getCalendarStub(this.env);
						if (await stub.wasGuestInviteSent(uid, guest.guest_email, 0)) return;
						await sendImipToGuest(this.env, guest.guest_email, {
							method: "REQUEST",
							...inviteParams,
						});
						await stub.markGuestInviteSent(uid, guest.guest_email, 0);
					},
				),
			),
		);

		const sentFeeds = feeds.filter((_, i) => sendOutcomes[i].status === "fulfilled");
		const sentGuests = guests.filter((_, i) => guestSendOutcomes[i].status === "fulfilled");
		const totalTargets = feeds.length + guests.length;
		const totalSent = sentFeeds.length + sentGuests.length;

		if (totalTargets > 0 && totalSent === 0) {
			throw new Error(
				`All ${totalTargets} invite send legs failed, no invites went out for block ${uid}`,
			);
		}

		const firstRoundFeeds = await Promise.allSettled(
			sentFeeds.map((feed) =>
				step.waitForEvent(`await-${feed.id}`, {
					type: `reply-${feed.id}`,
					timeout: "24 hours",
				}),
			),
		);

		const firstRoundGuests = await Promise.allSettled(
			sentGuests.map((guest) =>
				step.waitForEvent(`await-${guestWorkflowKey(guest.guest_email)}`, {
					type: `reply-${guestWorkflowKey(guest.guest_email)}`,
					timeout: "24 hours",
				}),
			),
		);

		const unansweredFeeds = sentFeeds.filter((_, i) => firstRoundFeeds[i].status === "rejected");
		const unansweredGuests = sentGuests.filter(
			(_, i) => firstRoundGuests[i].status === "rejected",
		);

		if (unansweredFeeds.length > 0 || unansweredGuests.length > 0) {
			await Promise.allSettled([
				...unansweredFeeds.map((feed) =>
					step.do(
						`send-nag-${feed.id}`,
						{ retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
						async () => {
							await sendImip(this.env, feed, { method: "REQUEST", ...inviteParams });
						},
					),
				),
				...unansweredGuests.map((guest) =>
					step.do(
						`send-nag-${guestWorkflowKey(guest.guest_email)}`,
						{ retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
						async () => {
							await sendImipToGuest(this.env, guest.guest_email, {
								method: "REQUEST",
								...inviteParams,
							});
						},
					),
				),
			]);

			await Promise.allSettled([
				...unansweredFeeds.map((feed) =>
					step.waitForEvent(`await-${feed.id}-2`, {
						type: `reply-${feed.id}`,
						timeout: "48 hours",
					}),
				),
				...unansweredGuests.map((guest) =>
					step.waitForEvent(`await-${guestWorkflowKey(guest.guest_email)}-2`, {
						type: `reply-${guestWorkflowKey(guest.guest_email)}`,
						timeout: "48 hours",
					}),
				),
			]);
		}

		const finalStatus = await step.do("finalize-status", async () => {
			return getCalendarStub(this.env).recomputeBlockStatus(uid);
		});

		if (finalStatus === "partial") {
			await step.do("notify-partial", async () => {
				await notifyPartial(this.env, uid, title, dtstart);
			});
		}
	}
}

async function notifyPartial(
	env: Env,
	uid: string,
	title: string,
	dtstartMs: number,
): Promise<void> {
	const to = env.OPERATOR_NOTIFY_ADDR;
	if (!to) return;

	const block = await getCalendarStub(env).getBlock(uid);
	const declinedFeeds =
		block?.attendees.filter((a) => a.partstat === "DECLINED").map((a) => a.feed_id) ?? [];
	const declinedGuests =
		block?.guests.filter((g) => g.partstat === "DECLINED").map((g) => g.guest_email) ?? [];
	const unansweredFeeds =
		block?.attendees.filter((a) => a.partstat === "NEEDS-ACTION").map((a) => a.feed_id) ?? [];
	const unansweredGuests =
		block?.guests.filter((g) => g.partstat === "NEEDS-ACTION").map((g) => g.guest_email) ?? [];

	const lines = [
		`Time block "${title}" (${new Date(dtstartMs).toISOString()}) finalized as PARTIAL — not every invitee accepted.`,
		declinedFeeds.length ? `Declined (feeds): ${declinedFeeds.join(", ")}` : "",
		declinedGuests.length ? `Declined (guests): ${declinedGuests.join(", ")}` : "",
		unansweredFeeds.length ? `No response (feeds): ${unansweredFeeds.join(", ")}` : "",
		unansweredGuests.length ? `No response (guests): ${unansweredGuests.join(", ")}` : "",
		`uid: ${uid}`,
	].filter(Boolean);

	await sendEmail(env.EMAIL, {
		to,
		from: env.ORGANIZER_ADDR,
		subject: `Calendar block not fully accepted: ${title}`,
		text: lines.join("\n"),
	});
}
