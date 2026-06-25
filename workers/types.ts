// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	// Delivered as Worker secrets, not committed to wrangler.jsonc — keeps the
	// public repo generic and stops Workers Builds from overwriting dashboard
	// values. OPERATOR: set these in Settings → Variables and Secrets.
	//   DOMAINS=example.com  ORGANIZER_ADDR=calendar@example.com
	//   AI_GATEWAY_ID=<gateway name>  ("" = call Workers AI directly)
	DOMAINS: string;
	ORGANIZER_ADDR: string;
	AI_GATEWAY_ID: string;
	// Optional: where to email a heads-up when a block finalizes as `partial`
	// (a decline). Unset ⇒ no notification (the /calendar view still shows it).
	OPERATOR_NOTIFY_ADDR?: string;
}
