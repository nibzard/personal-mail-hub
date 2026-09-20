import { describe, expect, it } from "vitest";
import {
  describeInstant,
  fromLocalInputValue,
  laterTodayChoice,
  toLocalInputValue,
  tomorrowChoice,
} from "../src/home/reminder-times.ts";

/*
 * The reminder presets (SPEC F13): a preset must never resolve to a past
 * time, a chosen local time must be a real calendar time, and the preview
 * names the resolved instant with its offset, so a daylight-saving
 * transition never saves silently.
 */

describe("the reminder time choices", () => {
  it("offers today at 18:00 only while it stays ahead", () => {
    // 10:00 local: 18:00 is eight hours out.
    const morning = new Date(2026, 8, 20, 10, 0);
    const laterToday = laterTodayChoice(morning);
    expect(laterToday).not.toBeNull();
    expect(laterToday!.getHours()).toBe(18);
    expect(laterToday!.getMinutes()).toBe(0);
    expect(laterToday!.getDate()).toBe(20);

    // 17:50 local: ten minutes ahead is inside the quarter-hour lead, so
    // the preset is not offered.
    expect(laterTodayChoice(new Date(2026, 8, 20, 17, 50))).toBeNull();
    // 19:00 local: 18:00 is past, so the preset is not offered.
    expect(laterTodayChoice(new Date(2026, 8, 20, 19, 0))).toBeNull();
  });

  it("always offers tomorrow at 09:00", () => {
    const tomorrow = tomorrowChoice(new Date(2026, 8, 20, 23, 30));
    expect(tomorrow.getDate()).toBe(21);
    expect(tomorrow.getHours()).toBe(9);
    expect(tomorrow.getMinutes()).toBe(0);
    // The last day of a month rolls over correctly.
    const roll = tomorrowChoice(new Date(2026, 9, 31, 8, 0));
    expect(roll.getMonth()).toBe(10);
    expect(roll.getDate()).toBe(1);
  });

  it("parses a chosen local time and refuses a date the calendar skips", () => {
    const parsed = fromLocalInputValue("2026-09-22T14:30");
    expect(parsed).not.toBeNull();
    expect(parsed!.getFullYear()).toBe(2026);
    expect(parsed!.getMonth()).toBe(8);
    expect(parsed!.getDate()).toBe(22);
    expect(parsed!.getHours()).toBe(14);
    expect(parsed!.getMinutes()).toBe(30);

    // February 30 normalizes to March 2 inside Date; that must not save.
    expect(fromLocalInputValue("2026-02-30T09:00")).toBeNull();
    expect(fromLocalInputValue("13:00")).toBeNull();
    expect(fromLocalInputValue("")).toBeNull();
  });

  it("round-trips an instant through the input format", () => {
    const instant = new Date(2026, 8, 22, 9, 5);
    const value = toLocalInputValue(instant);
    expect(value).toBe("2026-09-22T09:05");
    const parsed = fromLocalInputValue(value);
    expect(parsed).not.toBeNull();
    expect(parsed!.getTime()).toBe(instant.getTime());
  });

  it("names the resolved instant with its date, time, and offset", () => {
    // A summer instant in Berlin sits two hours ahead of UTC; the preview
    // says so.
    const summer = new Date("2026-07-01T12:00:00Z");
    const text = describeInstant(summer, "Europe/Berlin");
    expect(text).toContain("Jul");
    expect(text).toContain("2:00 PM");
    expect(text).toContain("GMT+2");
    expect(text).toContain("Europe/Berlin");

    // The winter counterpart shows GMT+1, so a transition is visible.
    const winter = new Date("2026-01-01T12:00:00Z");
    expect(describeInstant(winter, "Europe/Berlin")).toContain("GMT+1");
  });
});
