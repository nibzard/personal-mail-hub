import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  describeInstant,
  fromLocalInputValue,
  laterTodayChoice,
  toLocalInputValue,
  tomorrowChoice,
} from "@/home/reminder-times";

/*
 * The reminder chooser (SPEC F13): the two presets and a chosen date and
 * time, each showing the resolved date, time, and timezone before anything
 * saves. A preset that would resolve to a past time is not offered, and a
 * chosen time must lie in the future.
 */

/** One reminder as it saves: the resolved instant and the interpreting zone. */
export interface ReminderChoice {
  dueAt: string;
  timeZone: string;
}

export function ReminderPanel({
  timeZone,
  busy = false,
  onChoose,
}: {
  timeZone: string;
  busy?: boolean;
  onChoose: (choice: ReminderChoice) => void;
}) {
  const now = new Date();
  const laterToday = laterTodayChoice(now);
  const tomorrow = tomorrowChoice(now);
  const [customValue, setCustomValue] = useState("");
  const custom = fromLocalInputValue(customValue);
  const customFuture = custom !== null && custom.getTime() > now.getTime();

  return (
    <div
      role="group"
      aria-label="Choose a reminder time"
      className="flex flex-col gap-1.5 rounded-md border bg-surface p-2"
    >
      <p className="text-muted-foreground">
        The reminder returns this message inside the app, in your zone ({timeZone}).
      </p>
      {laterToday !== null ? (
        <PresetRow
          label="Later today"
          resolved={describeInstant(laterToday, timeZone)}
          disabled={busy}
          onChoose={() => onChoose({ dueAt: laterToday.toISOString(), timeZone })}
        />
      ) : (
        <p className="px-1 text-muted-foreground">
          Later today is past 6:00 PM here, so it is not offered. Tomorrow is.
        </p>
      )}
      <PresetRow
        label="Tomorrow"
        resolved={describeInstant(tomorrow, timeZone)}
        disabled={busy}
        onChoose={() => onChoose({ dueAt: tomorrow.toISOString(), timeZone })}
      />
      <div className="flex flex-col gap-1 px-1">
        <label className="text-muted-foreground" htmlFor="reminder-custom-time">
          Choose date and time
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="reminder-custom-time"
            type="datetime-local"
            className="max-w-64"
            min={toLocalInputValue(now)}
            value={customValue}
            disabled={busy}
            onChange={(event) => setCustomValue(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            disabled={busy || !customFuture}
            onClick={() => {
              if (customFuture && custom !== null) {
                onChoose({ dueAt: custom.toISOString(), timeZone });
              }
            }}
          >
            Set reminder
          </Button>
        </div>
        <p aria-live="polite" className="min-h-5 text-muted-foreground">
          {custom === null
            ? customValue.length === 0
              ? "The resolved time appears here before saving."
              : "Enter a valid date and time."
            : customFuture
              ? `Saves ${describeInstant(custom, timeZone)}.`
              : "Choose a time in the future."}
        </p>
      </div>
    </div>
  );
}

function PresetRow({
  label,
  resolved,
  disabled,
  onChoose,
}: {
  label: string;
  resolved: string;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      <span className="min-w-0 flex-1">
        <span className="font-medium">{label}</span>
        <span className="block text-muted-foreground">Saves {resolved}.</span>
      </span>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onChoose}>
        Set reminder
      </Button>
    </div>
  );
}
