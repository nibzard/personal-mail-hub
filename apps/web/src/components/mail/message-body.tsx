import { useLayoutEffect, useState } from "react";
import type { ReaderColors } from "@/mail/render";
import { cn } from "@/lib/utils";

/*
 * The sanitized body surface (SPEC F3 and section 9). The prepared document
 * renders inside a sandboxed frame without scripts or same-origin rights;
 * its own content security policy allows only inline styles and, on request,
 * data and remote images. Links open as new tabs with no window control.
 */

/** Reads the theme roles the rendered message inherits. */
export function useReaderColors(): ReaderColors {
  const [colors, setColors] = useState<ReaderColors>(readColors);

  // The theme is a class switch on <html>; watch it so the frame follows a
  // theme change without a reload.
  useLayoutEffect(() => {
    const update = () => setColors(readColors());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return colors;
}

function readColors(): ReaderColors {
  const styles = getComputedStyle(document.documentElement);
  const role = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: role("--surface"),
    foreground: role("--surface-foreground"),
    mutedForeground: role("--muted-foreground"),
    accent: role("--accent"),
    border: role("--border"),
    font: getComputedStyle(document.body).fontFamily,
  };
}

export interface SanitizedMessageFrameProps {
  /** A complete document from `prepareMessageDocument`. */
  document: string;
  className?: string;
}

/** The sandbox that shows one prepared message document. */
export function SanitizedMessageFrame({ document: srcDoc, className }: SanitizedMessageFrameProps) {
  return (
    <iframe
      srcDoc={srcDoc}
      title="Message body"
      // No scripts and no same-origin rights inside the message; popups are
      // the only escape, and hardened anchors open them without control.
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className={cn("w-full border-0 bg-surface", className)}
    />
  );
}
