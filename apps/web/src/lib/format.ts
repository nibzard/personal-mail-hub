/*
 * Display formatters for list rows and the reader summary. Dates render in
 * the device locale; empty values render as empty text, never as "null".
 */

const TIME_OF_DAY = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const MONTH_AND_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const COUNTS = new Intl.NumberFormat();
const SIZES = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function parse(iso: string | null): Date | null {
  if (iso === null) {
    return null;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/** Row time: time today, month and day this year, date with the year before. */
export function formatListTime(iso: string | null): string {
  const date = parse(iso);
  if (date === null) {
    return "";
  }
  const now = new Date();
  if (sameDay(date, now)) {
    return TIME_OF_DAY.format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return MONTH_AND_DAY.format(date);
  }
  return WITH_YEAR.format(date);
}

/** Reader time: one full, unambiguous local date and time. */
export function formatFullTime(iso: string | null): string {
  const date = parse(iso);
  return date === null ? "" : FULL.format(date);
}

/** Counts with locale separators, for example 1,234. */
export function formatCount(value: number): string {
  return COUNTS.format(value);
}

/** Byte sizes with binary units, for example 1.4 MB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${COUNTS.format(bytes)} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${SIZES.format(value)} ${units[unit]}`;
}

/** The display name of one address: the name, else the bare address. */
export function senderLabel(address: { address: string; name?: string | null } | null): string {
  if (address === null) {
    return "Unknown sender";
  }
  const name = address.name?.trim();
  return name !== undefined && name.length > 0 ? name : address.address;
}

/** Ages of sync and queue records, for example "45s", "12 min", "3 h". */
export function formatAge(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "unknown";
  }
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)} h`;
  }
  return `${Math.floor(seconds / 86_400)} d`;
}
