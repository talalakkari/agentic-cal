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
import { sendImip } from "./send-invite";
import { sendEmail } from "../email-sender";
import type { FeedRow } from "./calendarDO";
import type { Env } from "../types";

export interface BlockTimeParams {
	uid: string;
	title: string;
	dtstart: number;
	dtend: number;
}

export class BlockTimeWorkflow extends WorkflowEntrypoint<Env, BlockTimeParams> {
	async run(event: WorkflowEvent<BlockTimeParams>, step: WorkflowStep) {
		try {
			await this.runBlock(event, step);
		} catch (e) {
			// Terminal workflow failure (e.g. invite send exhausted its retries):
			// flag the block so a stuck-pending block surfaces a reason instead of
			// looking healthy. Best-effort + guarded against cancelled blocks
			// (recordBlockError skips status='cancelled'), so a cancel-time
			// termination is never mislabeled a failure. Re-throw so Workflows
			// still records the instance as errored.
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
		const { uid, title, dtstart, dtend } = event.payload;

		// Step names are deterministic (no timestamps) — they key replay.
		const feeds = (await step.do("load-feeds", async () => {
			const stub = getCalendarStub(this.env);
			const block = await stub.getBlock(uid);
			if (!block) throw new Error(`Block ${uid} not found — was it cancelled before start?`);
			return stub.listFeeds();
		})) as FeedRow[];

		// Send the REQUEST to every feed as an INDEPENDENT leg. allSettled (not a
		// sequential await loop) so a leg that exhausts its retries can't abort the
		// other legs or fail the whole run(), which would mislabel the block
		// "invite failed" even when other feeds were invited, and on replay re-fire
		// the succeeded legs (spec §8 known limitation, "B"). Each leg is also
		// DB-guarded (wasInviteSent/markInviteSent) so a replay never re-emits an
		// invite already sent: the idempotency belt to step memoization (part b).
		const sendOutcomes = await Promise.allSettled(
			feeds.map((feed) =>
				step.do(
					`send-imip-${feed.id}`,
					{ retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
					async () => {
						const stub = getCalendarStub(this.env);
						if (await stub.wasInviteSent(uid, feed.id, 0)) return; // already sent (replay)
						await sendImip(this.env, feed, {
							method: "REQUEST",
							uid,
							sequence: 0,
							title,
							dtstartMs: dtstart,
							dtendMs: dtend,
						});
						await stub.markInviteSent(uid, feed.id, 0);
					},
				),
			),
		);

		const sentFeeds = feeds.filter((_, i) => sendOutcomes[i].status === "fulfilled");

		// Only a TOTAL send failure (feeds existed but every leg failed -> no
		// invites went out at all) throws: surfacing the existing "invite failed"
		// badge via the outer run() catch -> recordBlockError, and letting Workflows
		// retry the run to re-attempt the sends. A partial failure does NOT throw:
		// the legs that sent proceed through the normal accept lifecycle below.
		if (feeds.length > 0 && sentFeeds.length === 0) {
			throw new Error(
				`All ${feeds.length} invite send legs failed, no invites went out for block ${uid}`,
			);
		}

		// Wait only on feeds whose invite actually went out (routed in by the
		// email() dispatch layer; timeouts reject, replies resolve). A failed-send
		// feed never got an invite, so its attendee row stays NEEDS-ACTION and the
		// block finalizes `partial`: the honest signal.
		const firstRound = await Promise.allSettled(
			sentFeeds.map((feed) =>
				// Event type is colon-free: a `:` makes sendEvent throw
				// invalid_event_type (see inbound.ts notifyWorkflow). Keep in sync.
				step.waitForEvent(`await-${feed.id}`, {
					type: `reply-${feed.id}`,
					timeout: "24 hours",
				}),
			),
		);

		const unanswered = sentFeeds.filter((_, i) => firstRound[i].status === "rejected");
		if (unanswered.length > 0) {
			// Nag = re-send the same invite (same UID/SEQUENCE, clients surface it
			// again rather than duplicating), then wait once more. allSettled so a
			// failing nag leg can't fail the run(). NOT DB-guarded: the nag is an
			// intentional same-sequence re-send (a reminder), distinct from the
			// replay re-send the marker suppresses on the initial leg.
			await Promise.allSettled(
				unanswered.map((feed) =>
					step.do(
						`send-nag-${feed.id}`,
						{ retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
						async () => {
							await sendImip(this.env, feed, {
								method: "REQUEST",
								uid,
								sequence: 0,
								title,
								dtstartMs: dtstart,
								dtendMs: dtend,
							});
						},
					),
				),
			);
			await Promise.allSettled(
				unanswered.map((feed) =>
					step.waitForEvent(`await-${feed.id}-2`, {
						type: `reply-${feed.id}`,
						timeout: "48 hours",
					}),
				),
			);
		}

		// Recompute from block_attendees — REPLY handling already updated the
		// rows as events arrived; DECLINED finalizes as `partial`, the agent
		// decides what to do (spec §11.7 — no auto-cancel).
		const finalStatus = await step.do("finalize-status", async () => {
			return getCalendarStub(this.env).recomputeBlockStatus(uid);
		});

		// Surface a decline to the operator (U3): `partial` means at least one
		// account responded but not all accepted (includes any DECLINED). No-op
		// unless OPERATOR_NOTIFY_ADDR is configured.
		if (finalStatus === "partial") {
			await step.do("notify-partial", async () => {
				await notifyPartial(this.env, uid, title, dtstart);
			});
		}
	}
}

/**
 * Email the operator a one-line heads-up when a block doesn't get full
 * acceptance. Best-effort and config-gated; the /calendar status view is the
 * always-on surface for this.
 */
async function notifyPartial(
	env: Env,
	uid: string,
	title: string,
	dtstartMs: number,
): Promise<void> {
	const to = env.OPERATOR_NOTIFY_ADDR;
	if (!to) return; // notifications disabled

	const block = await getCalendarStub(env).getBlock(uid);
	const declined =
		block?.attendees.filter((a) => a.partstat === "DECLINED").map((a) => a.feed_id) ?? [];
	const unanswered =
		block?.attendees.filter((a) => a.partstat === "NEEDS-ACTION").map((a) => a.feed_id) ?? [];

	const lines = [
		`Time block "${title}" (${new Date(dtstartMs).toISOString()}) finalized as PARTIAL — not every calendar accepted.`,
		declined.length ? `Declined: ${declined.join(", ")}` : "",
		unanswered.length ? `No response: ${unanswered.join(", ")}` : "",
		`uid: ${uid}`,
	].filter(Boolean);

	await sendEmail(env.EMAIL, {
		to,
		from: env.ORGANIZER_ADDR,
		subject: `Calendar block not fully accepted: ${title}`,
		text: lines.join("\n"),
	});
}
