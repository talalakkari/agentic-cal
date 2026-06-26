// Calendar layout — shared chrome for the calendar section: back-to-Mailboxes
// link, title, and a Calendar | Feeds | Time blocks toggle. The index child
// (calendar-view.tsx) is the month/week/day/list view; `feeds` (calendar-feeds.tsx)
// is feed hookup + health; `blocks` (calendar-blocks.tsx) is the agent time-blocks
// list with status filter + pagination. See app/routes.ts.

import { ArrowLeftIcon, CalendarBlankIcon } from "@phosphor-icons/react";
import { Link as RouterLink, NavLink, Outlet } from "react-router";

const seg = (isActive: boolean) =>
	`px-3 py-1 text-sm rounded-md no-underline transition-colors ${
		isActive
			? "bg-kumo-fill text-kumo-default font-medium"
			: "text-kumo-subtle hover:text-kumo-default"
	}`;

export default function CalendarLayout() {
	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-6xl px-4 py-8 md:px-6 md:py-10">
				<div className="mb-6">
					<RouterLink
						to="/"
						className="mb-2 inline-flex items-center gap-1 text-sm text-kumo-subtle no-underline hover:text-kumo-default"
					>
						<ArrowLeftIcon size={14} /> Mailboxes
					</RouterLink>
					<div className="flex items-center justify-between gap-3">
						<h1 className="flex items-center gap-2 text-2xl font-bold text-kumo-default">
							<CalendarBlankIcon size={26} /> Calendar
						</h1>
						<nav className="inline-flex rounded-lg border border-kumo-line bg-kumo-base p-0.5">
							<NavLink to="/calendar" end className={({ isActive }) => seg(isActive)}>
								Calendar
							</NavLink>
							<NavLink to="/calendar/feeds" className={({ isActive }) => seg(isActive)}>
								Feeds
							</NavLink>
							<NavLink to="/calendar/blocks" className={({ isActive }) => seg(isActive)}>
								Time blocks
							</NavLink>
						</nav>
					</div>
				</div>
				<Outlet />
			</div>
		</div>
	);
}
