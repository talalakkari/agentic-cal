// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { parseSearchQuery } from "~/lib/search-parser";
import api from "~/services/api";
import type { Email } from "~/types";
import { queryKeys } from "./keys";

export const SEARCH_PAGE_SIZE = 25;

interface SearchResponse {
	emails: Email[];
	totalCount: number;
}

export function useSearchEmails(
	mailboxId: string | undefined,
	query: string,
	page: number,
) {
	return useQuery<{ results: Email[]; totalCount: number }>({
		queryKey: mailboxId && query
			? queryKeys.search.results(mailboxId, query, page)
			: ["search", "_disabled"],
		queryFn: async () => {
			const parsed = parseSearchQuery(query);
			const params: Record<string, string> = {
				page: String(page),
				limit: String(SEARCH_PAGE_SIZE),
			};
			if (parsed.query) params.query = parsed.query;
			if (parsed.from) params.from = parsed.from;
			if (parsed.to) params.to = parsed.to;
			if (parsed.subject) params.subject = parsed.subject;
			if (parsed.folder) params.folder = parsed.folder;
			if (parsed.date_start) params.date_start = parsed.date_start;
			if (parsed.date_end) params.date_end = parsed.date_end;
			if (parsed.is_read !== undefined)
				params.is_read = String(parsed.is_read);
			if (parsed.is_starred !== undefined)
				params.is_starred = String(parsed.is_starred);
			if (parsed.has_attachment) params.has_attachment = "true";

			const data = await api.searchEmails(mailboxId!, params) as
				| SearchResponse
				| Email[];
			if (data && typeof data === "object" && "emails" in data) {
				return {
					results: (data as SearchResponse).emails ?? [],
					totalCount: (data as SearchResponse).totalCount ?? 0,
				};
			}
			const arr = Array.isArray(data) ? data : [];
			return { results: arr, totalCount: arr.length };
		},
		enabled: !!mailboxId && !!query,
	});
}
