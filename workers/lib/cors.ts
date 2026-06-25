// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { cors } from "hono/cors";

/**
 * Shared CORS policy for the JSON APIs (mailbox + calendar).
 *
 * Same-origin browser requests send no `Origin` header and are allowed; any
 * cross-origin request is rejected (no `Access-Control-Allow-Origin` echoed),
 * which also blocks the CSRF preflight for state-changing JSON calls. localhost
 * is allowed for the Vite dev server. This is applied to BOTH the mailbox API
 * and the calendar API so neither surface is left without the guard.
 */
export const corsOptions: Parameters<typeof cors>[0] = {
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for the Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch {
			/* invalid origin */
		}
		// Block all other cross-origin requests. The app is served from the same
		// origin as the API, so legitimate browser requests never send an Origin
		// header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
};
