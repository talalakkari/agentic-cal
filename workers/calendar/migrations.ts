// CalendarDO migrations — own migration list, shared runner.
// Schema per docs/AGENTIC-CALENDAR-SPEC.md §5.

import type { Migration } from "../durableObject/migrations";

export const calendarMigrations: Migration[] = [
	{
		name: "1_calendar_initial",
		sql: `
            CREATE TABLE feeds (
                id            TEXT PRIMARY KEY,
                label         TEXT NOT NULL,
                ics_url       TEXT NOT NULL,
                invite_email  TEXT NOT NULL,
                detail_level  TEXT NOT NULL DEFAULT 'busy',
                etag          TEXT,
                last_fetched  INTEGER,
                last_changed  INTEGER,
                last_error    TEXT
            );

            CREATE TABLE events (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                feed_id       TEXT NOT NULL REFERENCES feeds(id),
                uid           TEXT NOT NULL,
                recurrence_id TEXT,
                dtstart       INTEGER NOT NULL,
                dtend         INTEGER NOT NULL,
                all_day       INTEGER NOT NULL DEFAULT 0,
                transparency  TEXT NOT NULL DEFAULT 'OPAQUE',
                summary       TEXT,
                tz_original   TEXT,
                is_own_block  INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_events_time ON events (dtstart, dtend);
            CREATE INDEX idx_events_uid  ON events (uid);

            CREATE TABLE blocks (
                uid           TEXT PRIMARY KEY,
                title         TEXT NOT NULL,
                dtstart       INTEGER NOT NULL,
                dtend         INTEGER NOT NULL,
                sequence      INTEGER NOT NULL DEFAULT 0,
                status        TEXT NOT NULL DEFAULT 'pending',
                workflow_id   TEXT,
                created_by    TEXT,
                created_at    INTEGER NOT NULL
            );

            CREATE TABLE block_attendees (
                uid           TEXT NOT NULL REFERENCES blocks(uid),
                feed_id       TEXT NOT NULL REFERENCES feeds(id),
                partstat      TEXT NOT NULL DEFAULT 'NEEDS-ACTION',
                replied_at    INTEGER,
                PRIMARY KEY (uid, feed_id)
            );
        `,
	},
	{
		// Block-level failure signal: a pending block whose invite workflow failed
		// to start (or errored) gets last_error set so it's no longer indistinguishable
		// from a healthy pending block on the dashboard / in get_block_status.
		name: "2_add_block_last_error",
		sql: `ALTER TABLE blocks ADD COLUMN last_error TEXT;`,
	},
	{
		// Per-leg invite idempotency marker: the highest SEQUENCE for which a
		// REQUEST invite has been sent to this attendee. The BlockTimeWorkflow's
		// send legs consult it so a Workflows replay never re-emits an invite that
		// already went out (spec §8 part b). NULL = never sent.
		name: "3_add_block_attendee_invite_sent_seq",
		sql: `ALTER TABLE block_attendees ADD COLUMN invite_sent_seq INTEGER;`,
	},
];
