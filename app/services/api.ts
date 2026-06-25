// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email, Folder, Mailbox } from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

export interface CalendarFeed {
	id: string;
	label: string;
	ics_url: string; // truncated by the server — secret URLs are never echoed in full
	invite_email: string;
	detail_level: "busy" | "full";
	etag: string | null;
	last_fetched: number | null;
	last_changed: number | null;
	last_error: string | null;
}

export interface CalendarFeedStats {
	id: string;
	label: string;
	detail_level: string;
	event_count: number;
	last_fetched: number | null;
	last_changed: number | null;
	last_error: string | null;
}

// A polled feed event (raw CalendarDO.listEvents row — times are epoch ms UTC,
// unlike CalendarBlock which the /blocks route ISO-formats). summary is null for
// busy-only feeds; is_own_block=1 marks our own blocks re-ingested via a feed.
export interface CalendarEvent {
	id: number;
	feed_id: string;
	uid: string;
	recurrence_id: string | null;
	dtstart: number; // epoch ms UTC
	dtend: number;
	all_day: number; // 0 | 1
	transparency: string;
	summary: string | null;
	tz_original: string | null;
	is_own_block: number; // 0 | 1
}

export interface CalendarBlock {
	uid: string;
	title: string;
	start: string; // ISO 8601
	end: string;
	status: "pending" | "partial" | "confirmed" | "cancelled";
	// Non-null when the invite workflow failed to start/errored: the block holds
	// the slot but no invites went out. Surfaced as a distinct "invite failed" badge.
	last_error: string | null;
	created_at: string;
	attendees: Array<{
		account: string;
		partstat: "ACCEPTED" | "DECLINED" | "TENTATIVE" | "NEEDS-ACTION";
		replied_at: string | null;
	}>;
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[] }>("/api/v1/config"),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) => post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),

	// Calendar feeds (CalendarDO — see workers/calendar/routes.ts)
	listCalendarFeeds: () => get<CalendarFeed[]>("/api/v1/calendar/feeds"),
	registerCalendarFeed: (feed: {
		id: string;
		label: string;
		ics_url: string;
		invite_email: string;
		detail_level?: "busy" | "full";
	}) => post<CalendarFeed>("/api/v1/calendar/feeds", feed),
	deleteCalendarFeed: (id: string) =>
		del<{ deleted: boolean }>(`/api/v1/calendar/feeds/${id}`),
	pollCalendarFeeds: () =>
		post<{ results: Array<{ feedId: string; status: string; events?: number }> }>(
			"/api/v1/calendar/poll",
		),
	getCalendarStats: () =>
		get<{ feeds: CalendarFeedStats[] }>("/api/v1/calendar/stats"),
	listCalendarEvents: (params: {
		from?: string;
		to?: string;
		feed?: string;
		limit?: string;
	}) => get<{ events: CalendarEvent[] }>("/api/v1/calendar/events", { params }),
	listCalendarBlocks: () =>
		get<{ blocks: CalendarBlock[] }>("/api/v1/calendar/blocks"),
	cancelCalendarBlock: (uid: string) =>
		del<{ uid: string; status: string }>(`/api/v1/calendar/blocks/${uid}`),
};

export default api;
