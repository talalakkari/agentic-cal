// Time blocks — agent-created block_time holds with per-account acceptance state.
// Split out of the Feeds page into its own /calendar/blocks view. Backed by
// /api/v1/calendar/blocks (returns every block); we filter by status, sort
// newest-created-first, and paginate client-side — the dataset is bounded to one
// operator's rolling window, so there is no need for server-side paging.
// Rendered inside the calendar layout (app/routes/calendar.tsx).

import { Badge, Button, Loader, Select, useKumoToastManager } from "@cloudflare/kumo";
import { CaretLeftIcon, CaretRightIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { CalendarBlock } from "~/services/api";
import { useCalendarBlocks, useCancelCalendarBlock } from "~/queries/calendar";

export function meta() {
	return [{ title: "Time blocks" }];
}

const BLOCK_STATUS_BADGE: Record<
	CalendarBlock["status"],
	"success" | "beta" | "secondary" | "outline"
> = {
	confirmed: "success",
	partial: "beta",
	pending: "secondary",
	cancelled: "outline",
};

const PARTSTAT_GLYPH: Record<string, string> = {
	ACCEPTED: "✓",
	DECLINED: "✗",
	TENTATIVE: "~",
	"NEEDS-ACTION": "…",
};

// Status filter values. "active" hides cancelled (the default — keeps the list
// clean); "all" shows everything; the rest are exact-status matches.
const STATUS_FILTERS = ["active", "all", "pending", "partial", "confirmed", "cancelled"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_LABEL: Record<StatusFilter, string> = {
	active: "Active (hide cancelled)",
	all: "All",
	pending: "Pending",
	partial: "Partial",
	confirmed: "Confirmed",
	cancelled: "Cancelled",
};

const PAGE_SIZES = [10, 15, 20, 50];

function matchesFilter(status: CalendarBlock["status"], filter: StatusFilter): boolean {
	if (filter === "all") return true;
	if (filter === "active") return status !== "cancelled";
	return status === filter;
}

function formatRange(startIso: string, endIso: string): string {
	const fmt = new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
	const timeFmt = new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
	return `${fmt.format(new Date(startIso))} – ${timeFmt.format(new Date(endIso))}`;
}

// Compact page list with first/last anchors and ellipses, e.g. 1 … 4 5 6 … 20.
function buildPageItems(current: number, total: number): Array<number | "ellipsis"> {
	if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
	const items: Array<number | "ellipsis"> = [1];
	const start = Math.max(2, current - 1);
	const end = Math.min(total - 1, current + 1);
	if (start > 2) items.push("ellipsis");
	for (let i = start; i <= end; i++) items.push(i);
	if (end < total - 1) items.push("ellipsis");
	items.push(total);
	return items;
}

function BlockRow({
	block,
	onCancel,
}: {
	block: CalendarBlock;
	onCancel: (block: CalendarBlock) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-3 border-t border-kumo-line px-5 py-3 first:border-t-0">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium text-kumo-default">
						{block.title}
					</span>
					<Badge variant={BLOCK_STATUS_BADGE[block.status]}>{block.status}</Badge>
					{block.last_error && <Badge variant="destructive">invite failed</Badge>}
				</div>
				<div className="text-sm text-kumo-subtle">
					{formatRange(block.start, block.end)}
				</div>
				{block.last_error && (
					<div className="mt-1 text-xs text-kumo-danger">
						No invites sent — {block.last_error}
					</div>
				)}
			</div>
			<div className="flex items-center gap-2 text-xs text-kumo-subtle">
				{block.attendees.map((a) => (
					<span
						key={a.account}
						title={`${a.account}: ${a.partstat}`}
						className="rounded-full border border-kumo-line px-2 py-0.5"
					>
						{a.account} {PARTSTAT_GLYPH[a.partstat] ?? "?"}
					</span>
				))}
			</div>
			{block.status !== "cancelled" && (
				<Button
					variant="ghost"
					size="sm"
					shape="square"
					icon={<TrashIcon size={16} />}
					aria-label={`Cancel block ${block.title}`}
					onClick={() => onCancel(block)}
				/>
			)}
		</div>
	);
}

export default function CalendarBlocksRoute() {
	const toastManager = useKumoToastManager();
	const { data, isLoading } = useCalendarBlocks();
	const cancelBlock = useCancelCalendarBlock();

	const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
	const [pageSize, setPageSize] = useState(10);
	const [page, setPage] = useState(1);

	const allBlocks = data?.blocks ?? [];

	// Filter by status, then sort newest-created-first.
	const filtered = useMemo(
		() =>
			allBlocks
				.filter((b) => matchesFilter(b.status, statusFilter))
				.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
		[allBlocks, statusFilter],
	);

	const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
	const currentPage = Math.min(page, totalPages);

	// Snap back into range if the filter/size shrinks the result set below `page`.
	useEffect(() => {
		if (page > totalPages) setPage(totalPages);
	}, [page, totalPages]);

	const startIdx = (currentPage - 1) * pageSize;
	const pageBlocks = filtered.slice(startIdx, startIdx + pageSize);
	const rangeStart = filtered.length === 0 ? 0 : startIdx + 1;
	const rangeEnd = Math.min(startIdx + pageSize, filtered.length);

	const handleCancel = async (block: CalendarBlock) => {
		if (!window.confirm(`Cancel "${block.title}" on every calendar?`)) return;
		try {
			await cancelBlock.mutateAsync(block.uid);
			toastManager.add({ title: "Cancellation sent to all calendars" });
		} catch (err) {
			toastManager.add({
				title: (err as Error).message || "Failed to cancel block",
				variant: "error",
			});
		}
	};

	return (
		<div className="mx-auto max-w-2xl">
			<div className="mb-1 text-lg font-semibold text-kumo-default">Time blocks</div>
			<p className="mb-4 text-sm text-kumo-subtle">
				Blocks created by the agent (block_time). Each goes out as an email invite to
				every account — the glyphs show who has accepted.
			</p>

			{/* Toolbar: status filter + rows per page */}
			<div className="mb-3 flex flex-wrap items-center gap-4">
				<label className="flex items-center gap-2 text-sm text-kumo-subtle">
					Status
					<Select
						aria-label="Filter by status"
						value={statusFilter}
						onValueChange={(value) => {
							if (value && (STATUS_FILTERS as readonly string[]).includes(value)) {
								setStatusFilter(value as StatusFilter);
								setPage(1);
							}
						}}
					>
						{STATUS_FILTERS.map((s) => (
							<Select.Option key={s} value={s}>
								{STATUS_LABEL[s]}
							</Select.Option>
						))}
					</Select>
				</label>
				<label className="flex items-center gap-2 text-sm text-kumo-subtle">
					Per page
					<Select
						aria-label="Rows per page"
						value={String(pageSize)}
						onValueChange={(value) => {
							if (value) {
								setPageSize(Number(value));
								setPage(1);
							}
						}}
					>
						{PAGE_SIZES.map((n) => (
							<Select.Option key={n} value={String(n)}>
								{n}
							</Select.Option>
						))}
					</Select>
				</label>
			</div>

			{isLoading ? (
				<div className="flex justify-center py-20">
					<Loader size="lg" />
				</div>
			) : allBlocks.length === 0 ? (
				<div className="rounded-xl border border-kumo-line bg-kumo-base px-5 py-8 text-center text-sm text-kumo-subtle">
					No blocks yet — ask the agent to block time.
				</div>
			) : filtered.length === 0 ? (
				<div className="rounded-xl border border-kumo-line bg-kumo-base px-5 py-8 text-center text-sm text-kumo-subtle">
					No blocks match this filter.
				</div>
			) : (
				<>
					<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
						{pageBlocks.map((block) => (
							<BlockRow key={block.uid} block={block} onCancel={handleCancel} />
						))}
					</div>

					{/* Footer: count + pager */}
					<div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-kumo-subtle">
						<span>
							Showing {rangeStart}–{rangeEnd} of {filtered.length}
						</span>
						{totalPages > 1 && (
							<div className="flex items-center gap-1">
								<Button
									variant="ghost"
									size="sm"
									shape="square"
									icon={<CaretLeftIcon size={16} />}
									aria-label="Previous page"
									disabled={currentPage === 1}
									onClick={() => setPage((p) => Math.max(1, p - 1))}
								/>
								{buildPageItems(currentPage, totalPages).map((item, i) =>
									item === "ellipsis" ? (
										<span key={`e${i}`} className="px-1 text-kumo-subtle">
											…
										</span>
									) : (
										<Button
											key={item}
											variant={item === currentPage ? "primary" : "ghost"}
											size="sm"
											aria-label={`Page ${item}`}
											aria-current={item === currentPage ? "page" : undefined}
											onClick={() => setPage(item)}
										>
											{item}
										</Button>
									),
								)}
								<Button
									variant="ghost"
									size="sm"
									shape="square"
									icon={<CaretRightIcon size={16} />}
									aria-label="Next page"
									disabled={currentPage === totalPages}
									onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
								/>
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}
