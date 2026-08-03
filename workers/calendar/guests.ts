// Ad-hoc block_time guests: normalization + workflow step keys.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize, validate, dedupe, and drop emails that match a feed invite address. */
export function normalizeGuestEmails(
	raw: string[] | undefined,
	feedInviteEmails: string[],
): string[] {
	if (!raw?.length) return [];
	const feedSet = new Set(feedInviteEmails.map((e) => e.toLowerCase()));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		const email = item.trim().toLowerCase();
		if (!email) continue;
		if (!EMAIL_RE.test(email)) {
			throw new Error(`Invalid guest email: ${item}`);
		}
		if (feedSet.has(email) || seen.has(email)) continue;
		seen.add(email);
		out.push(email);
	}
	return out;
}

/**
 * Stable, colon-free workflow step / event suffix for a guest email.
 * Must stay in sync between BlockTimeWorkflow and inbound notifyWorkflow.
 */
export function guestWorkflowKey(email: string): string {
	const norm = email.toLowerCase().trim();
	let h = 2166136261;
	for (let i = 0; i < norm.length; i++) {
		h ^= norm.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return `guest-${(h >>> 0).toString(16)}`;
}

/** Display name for iMIP ATTENDEE CN on ad-hoc guests. */
export function guestDisplayName(email: string): string {
	const local = email.split("@")[0] ?? "Guest";
	return local.replace(/[._-]+/g, " ").trim() || "Guest";
}
