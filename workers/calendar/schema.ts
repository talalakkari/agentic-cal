// CalendarDO schema — strictly separate from the mailbox schema (workers/db/schema.ts).
// No cross-DO foreign keys, no shared tables. See docs/AGENTIC-CALENDAR-SPEC.md §5.

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const feeds = sqliteTable("feeds", {
	id: text("id").primaryKey(), // 'proton' | 'outlook' | 'icloud'
	label: text("label").notNull(),
	ics_url: text("ics_url").notNull(), // secret publish URL
	invite_email: text("invite_email").notNull(), // address to send iMIP invites to
	detail_level: text("detail_level").notNull().default("busy"), // 'busy' | 'full'
	etag: text("etag"),
	last_fetched: integer("last_fetched"),
	last_changed: integer("last_changed"),
	last_error: text("last_error"),
});

export const events = sqliteTable("events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	feed_id: text("feed_id")
		.notNull()
		.references(() => feeds.id),
	uid: text("uid").notNull(),
	recurrence_id: text("recurrence_id"), // RECURRENCE-ID for instance overrides
	dtstart: integer("dtstart").notNull(), // epoch ms UTC
	dtend: integer("dtend").notNull(),
	all_day: integer("all_day").notNull().default(0),
	transparency: text("transparency").notNull().default("OPAQUE"),
	summary: text("summary"), // NULL when feed is busy-only
	tz_original: text("tz_original"),
	is_own_block: integer("is_own_block").notNull().default(0),
});

export const blocks = sqliteTable("blocks", {
	uid: text("uid").primaryKey(), // '<ulid>@calendar.<domain>'
	title: text("title").notNull(),
	dtstart: integer("dtstart").notNull(),
	dtend: integer("dtend").notNull(),
	sequence: integer("sequence").notNull().default(0),
	status: text("status").notNull().default("pending"), // pending|partial|confirmed|cancelled
	workflow_id: text("workflow_id"),
	// Set when the invite workflow fails to start or errors out — a pending block
	// with a non-null last_error did NOT send invites and must not be mistaken for
	// a healthy pending block (the failure mode that hid the original block_time bug).
	last_error: text("last_error"),
	created_by: text("created_by"),
	created_at: integer("created_at").notNull(),
});

export const blockAttendees = sqliteTable("block_attendees", {
	uid: text("uid")
		.notNull()
		.references(() => blocks.uid),
	feed_id: text("feed_id")
		.notNull()
		.references(() => feeds.id),
	partstat: text("partstat").notNull().default("NEEDS-ACTION"), // ACCEPTED|DECLINED|TENTATIVE|NEEDS-ACTION
	replied_at: integer("replied_at"),
});
