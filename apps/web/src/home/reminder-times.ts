/*
 * Reminder time choices (SPEC F13): **Later today**, **Tomorrow**, and a
 * chosen date and time. The presets resolve in the device's zone, the choice
 * freezes both the resolved instant and the zone that interpreted it, and the
 * interface shows the resolved date, time, and offset before anything saves.
 * A preset that would resolve to a past time is not offered.
 */

/** Minutes a preset must stay in the future to be offered at all. */
const PRESET_MIN_LEAD_MS = 15 * 60 * 1000;

/** The zone this device runs in; `UTC` when the runtime reports none. */
export function localTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.length > 0 ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Today at 18:00 local, or `null` when that is less than a quarter hour
 * away. Tomorrow's preset takes over, so no offered preset is in the past.
 */
export function laterTodayChoice(now: Date): Date | null {
  const target = new Date(now);
  target.setHours(18, 0, 0, 0);
  return target.getTime() - now.getTime() >= PRESET_MIN_LEAD_MS ? target : null;
}

/** Tomorrow at 09:00 local. Always in the future. */
export function tomorrowChoice(now: Date): Date {
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(9, 0, 0, 0);
  return target;
}

/** The resolved instant of a `datetime-local` value, or `null` when invalid. */
export function fromLocalInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
  // A date the calendar does not hold, such as February 30, normalizes to the
  // next month instead of failing; that silent shift must not save.
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }
  return candidate;
}

/** One `datetime-local` value of an instant, in the device's zone. */
export function toLocalInputValue(instant: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(
    instant.getHours(),
  )}:${pad(instant.getMinutes())}`;
}

/**
 * The resolved date, time, and offset of one instant in its zone, the text
 * the plan requires before a reminder saves. During a daylight-saving
 * transition the offset shown is the one the browser resolved, so an
 * ambiguous local time never saves silently.
 */
export function describeInstant(instant: Date, timeZone: string): string {
  let text: string;
  let offset: string;
  try {
    text = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(instant);
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone,
      timeZoneName: "shortOffset",
    }).formatToParts(instant);
    offset = parts.find((part) => part.type === "timeZoneName")?.value ?? "UTC";
  } catch {
    text = instant.toISOString();
    offset = "UTC";
  }
  return `${text} (${offset}, ${timeZone})`;
}
