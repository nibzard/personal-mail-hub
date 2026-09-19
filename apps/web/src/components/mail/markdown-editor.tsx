import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/*
 * The Markdown editor (SPEC F6): CodeMirror 6 with Markdown highlighting
 * and wrapped lines. The Markdown source is the truth; every change reports
 * upward unchanged, and outside updates (a conflict resolved against the
 * server copy) replace the document only when they differ.
 *
 * Single-key shortcuts stay inactive here: `.cm-content` is editable, so
 * the shell's scope guard already treats its keys as text input (SPEC F11).
 */

/** One restrained theme over the app's semantic color roles (SPEC F12). */
const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--surface-foreground)",
    backgroundColor: "var(--surface)",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    fontSize: "1rem",
    lineHeight: "1.625",
  },
  ".cm-content": {
    padding: "0.625rem 0.75rem",
    caretColor: "var(--accent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--muted) 60%, transparent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--selection)",
  },
});

/** Markdown roles tinted through the same roles the reader uses. */
const editorHighlights = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.1875rem", color: "var(--foreground)" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.0625rem", color: "var(--foreground)" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--muted-foreground)" },
  { tag: [t.quote], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.monospace], backgroundColor: "var(--muted)", borderRadius: "0.125rem" },
  { tag: t.processingInstruction, color: "var(--muted-foreground)" },
]);

/** Editability changes at runtime, so it lives in a compartment. */
const editability = new Compartment();

export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  /** True while a queued send locks the draft against edits (SPEC F7). */
  readOnly?: boolean;
  /** The name assistive technology announces for the text area. */
  label: string;
  className?: string;
}

export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  label,
  className,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // The mount effect must not restart on every keystroke, so the initial
  // document reads through a ref instead of the prop.
  const initialValue = useRef(value);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const view = new EditorView({
      state: EditorState.create({
        doc: initialValue.current,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          editorTheme,
          syntaxHighlighting(editorHighlights),
          EditorView.lineWrapping,
          editability.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.contentAttributes.of({
            "aria-label": label,
            "data-testid": "markdown-source",
            spellcheck: "true",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view is built once per editor surface; the label names it for
    // its whole life.
  }, [label]);

  // A read-only switch reconfigures the living view, keeping history.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) {
      return;
    }
    view.dispatch({
      effects: editability.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  // Outside values replace the document only when they truly differ, so
  // typing never fights the sync effect.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) {
      return;
    }
    if (value !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={cn("min-h-0 overflow-hidden rounded-md border border-input", className)}
    />
  );
}
