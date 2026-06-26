// Calendar feed queries — backed by /api/v1/calendar/* (workers/calendar/routes.ts).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, {
	type CalendarBlock,
	type CalendarEvent,
	type CalendarFeed,
	type CalendarFeedStats,
} from "~/services/api";
import { queryKeys } from "./keys";

export function useCalendarFeeds() {
	return useQuery<CalendarFeed[]>({
		queryKey: queryKeys.calendar.feeds,
		queryFn: () => api.listCalendarFeeds(),
	});
}

export function useCalendarStats() {
	return useQuery<{ feeds: CalendarFeedStats[] }>({
		queryKey: queryKeys.calendar.stats,
		queryFn: () => api.getCalendarStats(),
		refetchInterval: 60_000, // staleness/state changes as the cron runs
	});
}

export function useRegisterCalendarFeed() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (feed: {
			id: string;
			label: string;
			ics_url: string;
			invite_email: string;
			detail_level?: "busy" | "full";
		}) => api.registerCalendarFeed(feed),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.calendar.feeds });
			qc.invalidateQueries({ queryKey: queryKeys.calendar.stats });
		},
	});
}

export function useDeleteCalendarFeed() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteCalendarFeed(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.calendar.feeds });
			qc.invalidateQueries({ queryKey: queryKeys.calendar.stats });
		},
	});
}

export function usePollCalendarFeeds() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.pollCalendarFeeds(),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.calendar.feeds });
			qc.invalidateQueries({ queryKey: queryKeys.calendar.stats });
		},
	});
}

export function useCalendarBlocks() {
	return useQuery<{ blocks: CalendarBlock[] }>({
		queryKey: queryKeys.calendar.blocks,
		queryFn: () => api.listCalendarBlocks(),
		refetchInterval: 60_000, // acceptance state changes as REPLYs arrive
	});
}

/**
 * Polled feed events within [fromIso, toIso] (ISO 8601). The calendar view fetches
 * the visible window; `limit` is generous since a month grid can hold many events.
 */
export function useCalendarEvents(fromIso: string, toIso: string) {
	return useQuery<{ events: CalendarEvent[] }>({
		queryKey: queryKeys.calendar.events(fromIso, toIso),
		queryFn: () =>
			api.listCalendarEvents({ from: fromIso, to: toIso, limit: "1000" }),
		refetchInterval: 60_000, // new events land as the poller cron runs
	});
}

export function useCancelCalendarBlock() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (uid: string) => api.cancelCalendarBlock(uid),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.calendar.blocks });
		},
	});
}

/** Permanently delete one cancelled block's record. */
export function usePurgeCalendarBlock() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (uid: string) => api.purgeCalendarBlock(uid),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.calendar.blocks });
		},
	});
}

/** Bulk: permanently delete every cancelled block. */
export function usePurgeCancelledBlocks() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.purgeCancelledCalendarBlocks(),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.calendar.blocks });
		},
	});
}
