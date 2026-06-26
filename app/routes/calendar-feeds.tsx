// Calendar feed management — register the Proton/Outlook/iCloud ICS publish
// URLs, trigger a poll, and watch feed health. Backed by /api/v1/calendar/*;
// secret URLs are write-only (the server only ever echoes a truncated form).
// Rendered inside the calendar layout (app/routes/calendar.tsx) at /calendar/feeds.

import {
	Badge,
	Button,
	Input,
	Loader,
	Select,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import type { CalendarFeed, CalendarFeedStats } from "~/services/api";
import {
	useCalendarFeeds,
	useCalendarStats,
	useDeleteCalendarFeed,
	usePollCalendarFeeds,
	useRegisterCalendarFeed,
} from "~/queries/calendar";

export function meta() {
	return [{ title: "Calendar Feeds" }];
}

interface ProviderTemplate {
	id: string;
	label: string;
	defaultDetail: "busy" | "full";
	hint: string;
}

const PROVIDERS: ProviderTemplate[] = [
	{
		id: "proton",
		label: "Proton",
		defaultDetail: "full",
		hint: "Proton Calendar → Settings → Share calendar via link → full event details",
	},
	{
		id: "outlook",
		label: "Outlook (work)",
		defaultDetail: "busy",
		hint: "Outlook → Settings → Calendar → Shared calendars → Publish a calendar → ICS link. Microsoft caches the feed — expect hours of lag.",
	},
	{
		id: "icloud",
		label: "iCloud (iPad)",
		defaultDetail: "full",
		hint: "Apple Calendar → calendar info → Public Calendar → copy the webcal:// link (converted automatically)",
	},
];

function timeAgo(ms: number | null): string {
	if (!ms) return "never";
	const mins = Math.round((Date.now() - ms) / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function FeedCard({
	template,
	feed,
	stats,
}: {
	template: ProviderTemplate;
	feed: CalendarFeed | undefined;
	stats: CalendarFeedStats | undefined;
}) {
	const toastManager = useKumoToastManager();
	const registerFeed = useRegisterCalendarFeed();
	const deleteFeed = useDeleteCalendarFeed();
	const pollFeeds = usePollCalendarFeeds();

	const [icsUrl, setIcsUrl] = useState("");
	const [inviteEmail, setInviteEmail] = useState("");
	const [detail, setDetail] = useState<"busy" | "full">(template.defaultDetail);

	useEffect(() => {
		if (feed) {
			setInviteEmail(feed.invite_email);
			setDetail(feed.detail_level);
		}
	}, [feed]);

	const isRegistered = !!feed;

	const handleSave = async (e: FormEvent) => {
		e.preventDefault();
		if (!icsUrl || !inviteEmail) {
			toastManager.add({
				title: "ICS URL and invite email are both required",
				variant: "error",
			});
			return;
		}
		try {
			await registerFeed.mutateAsync({
				id: template.id,
				label: template.label,
				ics_url: icsUrl.trim(),
				invite_email: inviteEmail.trim(),
				detail_level: detail,
			});
			setIcsUrl("");
			toastManager.add({ title: `${template.label} feed saved` });
			// Validate the link immediately (U1): poll now and surface this feed's
			// result, so a bad URL is caught at paste time instead of silently at
			// the next 10-minute cron.
			try {
				const { results } = await pollFeeds.mutateAsync();
				const r = results.find((x) => x.feedId === template.id);
				if (r?.status.startsWith("error")) {
					toastManager.add({ title: `${template.label}: ${r.status}`, variant: "error" });
				} else if (r) {
					toastManager.add({
						title: `${template.label}: ${r.status}${r.events !== undefined ? ` (${r.events} events)` : ""}`,
					});
				}
			} catch {
				/* poll is best-effort; the feed card's health still surfaces errors */
			}
		} catch (err) {
			toastManager.add({
				title: (err as Error).message || "Failed to save feed",
				variant: "error",
			});
		}
	};

	const handleDelete = async () => {
		if (
			!window.confirm(
				`Remove the ${template.label} feed? This deletes its cached events and removes it from every time block (the blocks stay, but ${template.label}'s accept status is dropped). You can re-register a new link afterward.`,
			)
		)
			return;
		try {
			await deleteFeed.mutateAsync(template.id);
			setIcsUrl("");
			setInviteEmail("");
			toastManager.add({ title: `${template.label} feed removed` });
		} catch {
			toastManager.add({ title: "Failed to remove feed", variant: "error" });
		}
	};

	return (
		<div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<h2 className="text-base font-semibold text-kumo-default">
						{template.label}
					</h2>
					{isRegistered ? (
						stats?.last_error ? (
							<Badge variant="destructive">error</Badge>
						) : (
							<Badge variant="success">
								{stats ? `${stats.event_count} events` : "registered"}
							</Badge>
						)
					) : (
						<Badge variant="secondary">not configured</Badge>
					)}
				</div>
				{isRegistered && (
					<Button
						variant="ghost"
						size="sm"
						shape="square"
						icon={<TrashIcon size={16} />}
						aria-label={`Remove ${template.label} feed`}
						onClick={handleDelete}
					/>
				)}
			</div>

			{isRegistered && (
				<div className="mt-2 text-sm text-kumo-subtle">
					<span>Fetched {timeAgo(feed.last_fetched)}</span>
					<span> · changed {timeAgo(feed.last_changed)}</span>
					<span> · invites → {feed.invite_email}</span>
					<span> · {feed.detail_level}</span>
					<div className="truncate font-mono text-xs mt-1">{feed.ics_url}</div>
					{stats?.last_error && (
						<div className="mt-1 text-kumo-danger text-xs">
							{stats.last_error}
						</div>
					)}
				</div>
			)}

			<p className="mt-3 text-xs text-kumo-subtle">{template.hint}</p>

			<form onSubmit={handleSave} className="mt-3 flex flex-col gap-2">
				<Input
					aria-label={`${template.label} ICS URL`}
					placeholder={
						isRegistered
							? "Paste a new URL to replace the stored one"
							: "https://… or webcal://… publish link"
					}
					value={icsUrl}
					onValueChange={setIcsUrl}
				/>
				<div className="flex flex-wrap items-center gap-2">
					<div className="min-w-48 flex-1">
						<Input
							aria-label={`${template.label} invite email`}
							placeholder="address invites are sent to"
							type="email"
							value={inviteEmail}
							onValueChange={setInviteEmail}
						/>
					</div>
					<Select
						aria-label={`${template.label} detail level`}
						value={detail}
						onValueChange={(value) => {
							if (value === "busy" || value === "full") setDetail(value);
						}}
					>
						<Select.Option value="busy">busy-only</Select.Option>
						<Select.Option value="full">full detail</Select.Option>
					</Select>
					<Button
						type="submit"
						variant="primary"
						size="sm"
						loading={registerFeed.isPending}
					>
						{isRegistered ? "Update" : "Register"}
					</Button>
				</div>
			</form>
		</div>
	);
}

export default function CalendarFeedsRoute() {
	const toastManager = useKumoToastManager();
	const { data: feeds, isLoading } = useCalendarFeeds();
	const { data: statsData } = useCalendarStats();
	const pollFeeds = usePollCalendarFeeds();

	const feedById = new Map((feeds ?? []).map((f) => [f.id, f]));
	const statsById = new Map((statsData?.feeds ?? []).map((s) => [s.id, s]));

	const handlePoll = async () => {
		try {
			const { results } = await pollFeeds.mutateAsync();
			const summary = results.length
				? results
						.map(
							(r) =>
								`${r.feedId}: ${r.status}${r.events !== undefined ? ` (${r.events} events)` : ""}`,
						)
						.join(" · ")
				: "No feeds registered yet";
			toastManager.add({ title: summary });
		} catch (err) {
			toastManager.add({
				title: (err as Error).message || "Poll failed",
				variant: "error",
			});
		}
	};

	return (
		<div className="mx-auto max-w-2xl">
			<div className="mb-6 flex items-start justify-between gap-3">
				<p className="text-sm text-kumo-subtle">
					Read-only ICS publish links, aggregated every 10 minutes into one
					availability view. The agent never writes to these calendars — blocks
					go out as email invites.
				</p>
				<Button
					variant="secondary"
					icon={<ArrowsClockwiseIcon size={16} />}
					loading={pollFeeds.isPending}
					onClick={handlePoll}
				>
					Poll now
				</Button>
			</div>

			{isLoading ? (
				<div className="flex justify-center py-20">
					<Loader size="lg" />
				</div>
			) : (
				<div className="flex flex-col gap-4">
					{PROVIDERS.map((template) => (
						<FeedCard
							key={template.id}
							template={template}
							feed={feedById.get(template.id)}
							stats={statsById.get(template.id)}
						/>
					))}
				</div>
			)}
		</div>
	);
}
