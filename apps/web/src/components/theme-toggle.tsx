import { Monitor, MoonStar, Sun } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme, type Theme } from "@/theme";

const CHOICES: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** Shared theme control for the shell, the palette, and settings. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Theme: ${theme}`}
        className={[
          "inline-flex size-control-md items-center justify-center max-md:size-11",
          "rounded-md text-muted-foreground",
          "transition-colors duration-control ease-out-quiet",
          "hover:bg-muted hover:text-foreground",
        ].join(" ")}
      >
        {theme === "light" ? (
          <Sun className="size-4" aria-hidden="true" />
        ) : theme === "dark" ? (
          <MoonStar className="size-4" aria-hidden="true" />
        ) : (
          <Monitor className="size-4" aria-hidden="true" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => setTheme(value as Theme)}
        >
          {CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
