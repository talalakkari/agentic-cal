// Minimal ULID (Crockford base32, 48-bit time + 80-bit randomness).
// Block UIDs are `<ulid>@calendar.<domain>` so they sort by creation time
// (spec §7.2). Uniqueness and sortability are what matter here, not strict
// spec-grade random distribution.

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
	let time = "";
	let t = now;
	for (let i = 0; i < 10; i++) {
		time = ENCODING[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let rand = "";
	for (let i = 0; i < 16; i++) {
		rand += ENCODING[bytes[i] % 32];
	}
	return time + rand;
}
