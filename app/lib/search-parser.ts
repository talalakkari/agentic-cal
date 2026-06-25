// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Parse a Gmail-style search query into structured filters.
 *
 * Supported operators:
 *   from:user@example.com    — filter by sender
 *   to:user@example.com      — filter by recipient
 *   subject:hello             — filter by subject
 *   in:inbox / in:sent        — filter by folder
 *   is:unread / is:read       — filter by read status
 *   is:starred                — filter by starred status
 *   has:attachment             — filter by attachment presence
 *   before:2025-01-01         — emails before date
 *   after:2025-01-01          — emails after date
 *
 * Quoted values are supported: from:"John Doe" subject:"Re: Hello"
 * Everything that isn't an operator becomes the free-text query.
 */

export interface ParsedSearch {
	query: string;
	from?: string;
	to?: string;
	subject?: string;
	folder?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
	date_start?: string;
	date_end?: string;
}

// Matches operator:value or operator:"quoted value"
const OPERATOR_RE =
	/\b(from|to|subject|in|is|has|before|after):(?:"([^"]*?)"|(\S+))/gi;

export function parseSearchQuery(input: string): ParsedSearch {
	const result: ParsedSearch = { query: "" };

	// Extract all operators
	let remaining = input;
	let match: RegExpExecArray | null;

	// Reset lastIndex since we reuse the regex
	OPERATOR_RE.lastIndex = 0;
	const matches: { fullMatch: string; op: string; value: string }[] = [];

	while ((match = OPERATOR_RE.exec(input)) !== null) {
		const op = match[1].toLowerCase();
		const value = match[2] ?? match[3]; // quoted or unquoted
		matches.push({ fullMatch: match[0], op, value });
	}

	// Remove matched operators from the input to get the free-text query
	for (const m of matches) {
		remaining = remaining.replace(m.fullMatch, "");
	}

	// Clean up remaining text as the free-text query
	result.query = remaining.replace(/\s+/g, " ").trim();

	// Apply operators
	for (const { op, value } of matches) {
		switch (op) {
			case "from":
				result.from = value;
				break;
			case "to":
				result.to = value;
				break;
			case "subject":
				result.subject = value;
				break;
			case "in":
				result.folder = value.toLowerCase();
				break;
			case "is":
				switch (value.toLowerCase()) {
					case "unread":
						result.is_read = false;
						break;
					case "read":
						result.is_read = true;
						break;
					case "starred":
						result.is_starred = true;
						break;
					case "unstarred":
						result.is_starred = false;
						break;
				}
				break;
			case "has":
				if (value.toLowerCase() === "attachment") {
					result.has_attachment = true;
				}
				break;
			case "before":
				result.date_end = normalizeDate(value);
				break;
			case "after":
				result.date_start = normalizeDate(value);
				break;
		}
	}

	return result;
}

/**
 * Normalize a date string to ISO format. Accepts YYYY-MM-DD or various
 * Date-parseable strings.
 */
function normalizeDate(value: string): string | undefined {
	try {
		const d = new Date(value);
		if (isNaN(d.getTime())) return undefined;
		return d.toISOString();
	} catch {
		return undefined;
	}
}
