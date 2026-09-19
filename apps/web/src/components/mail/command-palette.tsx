import { Check, CornerUpLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import {
  COMMAND_GROUPS,
  type CommandChoice,
  type MailCommand,
} from "@/mail/commands";

/*
 * The command palette (SPEC F11): one searchable dialog over the shared
 * command registry. Opening and filtering stay local, unavailable commands
 * show their reason, Escape exits a nested choice before closing, and the
 * dialog traps and restores focus through the shared Radix dialog.
 */

/** What the palette shows: the command list, or one command's chooser. */
type Page =
  | { kind: "root" }
  | { kind: "choices"; title: string; choices: CommandChoice[] };

/**
 * A word-prefix filter. cmdk's fuzzy filter ranks "Open the selected
 * message" above "Theme…" for the query "theme", because loose letter
 * sequences score. Palette users type word starts, so every query word
 * must begin a word of the command text. All matches score equally, which
 * keeps the registry's group order.
 */
export function prefixFilter(value: string, search: string): number {
  const query = search.toLowerCase().trim().split(/\s+/).filter((term) => term.length > 0);
  if (query.length === 0) {
    return 1;
  }
  const words = value.toLowerCase().split(/\s+/);
  return query.every((term) => words.some((word) => word.startsWith(term))) ? 1 : 0;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: MailCommand[];
  /**
   * Runs once the dialog has fully unmounted. It owns focus restoration,
   * because Radix would otherwise refocus the opener unconditionally and
   * overrun whatever focus a command placed (SPEC F11).
   */
  onRestoreFocus: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
  onRestoreFocus,
}: CommandPaletteProps) {
  const [page, setPage] = useState<Page>({ kind: "root" });
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Every opening starts from the full command list.
  useEffect(() => {
    if (open) {
      setPage({ kind: "root" });
    }
  }, [open]);

  // The page identity: changing it remounts the input with a clear query.
  // The remounted input needs focus placed back on it.
  const pageKey = page.kind === "root" ? "root" : `choices:${page.title}`;
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open, pageKey]);

  /**
   * Escape leaves a nested choice first; only a second Escape closes.
   * Radix runs this before its own dismissal decision, and preventing the
   * event keeps the dialog open.
   */
  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (page.kind === "choices") {
      event.preventDefault();
      setPage({ kind: "root" });
    }
  };

  const activate = (command: MailCommand) => {
    if (command.unavailableReason !== null) {
      return;
    }
    if (command.choices !== undefined) {
      setPage({ kind: "choices", title: command.label.replace(/…$/, ""), choices: command.choices() });
      return;
    }
    onOpenChange(false);
    command.run?.();
  };

  const activateChoice = (choice: CommandChoice) => {
    onOpenChange(false);
    choice.run();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Raycast-style top placement, reusing the shared dialog surface
        // (SPEC section 6). The entry animation stays a fade plus 4px.
        className="top-[12%] flex max-w-xl translate-y-0 flex-col gap-0 overflow-hidden p-0"
        onEscapeKeyDown={handleEscapeKeyDown}
        onCloseAutoFocus={(event) => {
          // Radix schedules its own opener refocus after the exit
          // animation, too late for any rAF placed at close time. Prevent
          // it and apply the restore order at exactly this moment instead.
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogTitle className="sr-only">Commands</DialogTitle>
        <DialogDescription className="sr-only">
          Search commands by name. Up and Down move between results. Enter
          runs the selected command. Escape closes the palette or leaves a
          choice.
        </DialogDescription>
        <Command key={pageKey} loop={false} filter={prefixFilter}>
          <CommandInput
            ref={inputRef}
            className="pe-7"
            placeholder={page.kind === "root" ? "Type a command…" : `Search ${page.title.toLowerCase()}…`}
          />
          <CommandList>
            <CommandEmpty>No matching commands.</CommandEmpty>
            {page.kind === "root"
              ? COMMAND_GROUPS.map((group) => {
                  const groupCommands = commands.filter(
                    (command) => command.group === group.id,
                  );
                  if (groupCommands.length === 0) {
                    return null;
                  }
                  return (
                    <CommandGroup key={group.id} heading={group.title}>
                      {groupCommands.map((command) => (
                        <CommandItem
                          key={command.id}
                          value={`${command.id} ${command.label} ${(command.keywords ?? []).join(" ")}`}
                          keywords={command.keywords}
                          disabled={
                            command.unavailableReason !== null ||
                            (command.choices === undefined && command.run === undefined)
                          }
                          onSelect={() => activate(command)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{command.label}</span>
                            {(command.unavailableReason ?? command.scopeNote) !== null && (
                              <span className="block truncate text-muted-foreground">
                                {command.unavailableReason ?? command.scopeNote}
                              </span>
                            )}
                          </span>
                          {command.shortcut !== undefined && (
                            <Kbd aria-hidden="true">{command.shortcut.key}</Kbd>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  );
                })
              : (
                  <>
                    <CommandGroup heading={page.title}>
                      <CommandItem
                        value="back to all commands back"
                        onSelect={() => {
                          setPage({ kind: "root" });
                        }}
                      >
                        <CornerUpLeft aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">Back to all commands</span>
                        <Kbd aria-hidden="true">esc</Kbd>
                      </CommandItem>
                    </CommandGroup>
                    {choicePages(page.choices).map((group) => (
                      <CommandGroup key={group.heading ?? "choices"} heading={group.heading ?? undefined}>
                        {group.choices.map((choice) => (
                          <CommandItem
                            key={choice.id}
                            value={`${choice.id} ${choice.label} ${choice.group ?? ""} ${(choice.keywords ?? []).join(" ")}`}
                            keywords={choice.keywords}
                            onSelect={() => activateChoice(choice)}
                          >
                            <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                            {choice.current === true && (
                              <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                                <Check aria-hidden="true" className="size-3.5" />
                                <span className="sr-only">Current</span>
                              </span>
                            )}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ))}
                  </>
                )}
          </CommandList>
          <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd aria-hidden="true">↑</Kbd>
              <Kbd aria-hidden="true">↓</Kbd>
              move
            </span>
            <span className="flex items-center gap-1">
              <Kbd aria-hidden="true">↵</Kbd>
              run
            </span>
            <span className="flex items-center gap-1">
              <Kbd aria-hidden="true">esc</Kbd>
              {page.kind === "choices" ? "leave choice" : "close"}
            </span>
          </footer>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** Groups a chooser's options under their headings, in the given order. */
function choicePages(
  choices: CommandChoice[],
): Array<{ heading: string | null; choices: CommandChoice[] }> {
  const groups: Array<{ heading: string | null; choices: CommandChoice[] }> = [];
  for (const choice of choices) {
    const heading = choice.group ?? null;
    const last = groups.at(-1);
    if (last !== undefined && last.heading === heading) {
      last.choices.push(choice);
    } else {
      groups.push({ heading, choices: [choice] });
    }
  }
  return groups;
}
