# Diff View Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom diff renderer in DiffView.tsx with `react-diff-view` to fix cross-line syntax highlighting, add first-class inline comment widgets, and enable a unified/split view toggle.

**Architecture:** The existing `PullFile.patch` string feeds into `react-diff-view`'s `parseDiff()` to produce hunks, which render via `<Diff>` and `<Hunk>` components. Syntax highlighting uses `refractor` (Prism-based) for cross-line tokenization. Inline comments and the comment box mount via the `widgets` prop. A new `diffViewType` store field drives the global unified/split toggle.

**Tech Stack:** react-diff-view, refractor, Prism CSS theme, Zustand, Tailwind CSS v4

**Spec:** `docs/superpowers/specs/2026-04-14-diff-view-upgrade-design.md`

---

### Task 1: Install dependencies

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: Install react-diff-view and refractor**

```bash
cd /Users/lex/src/cr-watch/web && yarn add react-diff-view refractor
```

- [ ] **Step 2: Verify installation**

```bash
cd /Users/lex/src/cr-watch/web && node -e "require('react-diff-view'); require('refractor'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Check for TypeScript types**

```bash
cd /Users/lex/src/cr-watch/web && ls node_modules/react-diff-view/index.d.ts node_modules/refractor/index.d.ts 2>/dev/null || echo "may need @types packages"
```

If types are missing, install `@types/react-diff-view` or create a minimal `.d.ts` shim in `web/src/`.

- [ ] **Step 4: Commit**

```bash
cd /Users/lex/src/cr-watch && git add web/package.json web/yarn.lock
git commit -m "feat(web): add react-diff-view and refractor dependencies"
```

---

### Task 2: Add store field for diff view type

**Files:**
- Modify: `web/src/store/types.ts:53-134` (PrDetailSlice interface)
- Modify: `web/src/store/prDetailSlice.ts:45-48,87,401`

- [ ] **Step 1: Add fields to PrDetailSlice interface**

In `web/src/store/types.ts`, add to the `PrDetailSlice` interface after the existing `// Diff view` comment block (after line 90):

```typescript
  // Diff view
  commentingLine: { line: number; side: "LEFT" | "RIGHT" } | null;
  commentBody: string;
  commentSubmitting: boolean;
  diffViewType: "unified" | "split";
```

Add the action after `submitInlineComment` (after line 134):

```typescript
  setDiffViewType: (type: "unified" | "split") => void;
```

- [ ] **Step 2: Add default value and action in slice**

In `web/src/store/prDetailSlice.ts`, add after line 48 (`commentSubmitting: false,`):

```typescript
  diffViewType: "unified",
```

Add the action after the `submitInlineComment` implementation (after line 417):

```typescript
  setDiffViewType: (type) => set({ diffViewType: type }),
```

- [ ] **Step 3: Build to verify types**

```bash
cd /Users/lex/src/cr-watch/web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/lex/src/cr-watch && git add web/src/store/types.ts web/src/store/prDetailSlice.ts
git commit -m "feat(web): add diffViewType store field for unified/split toggle"
```

---

### Task 3: Create dark theme CSS overrides

**Files:**
- Create: `web/src/diff-dark.css`
- Modify: `web/src/index.css`

- [ ] **Step 1: Create the dark theme CSS file**

Create `web/src/diff-dark.css`:

```css
/* react-diff-view base styles */
@import "react-diff-view/style/index.css";

/* Dark theme overrides scoped to .diff-dark wrapper */
.diff-dark {
  --diff-background-color: transparent;
  --diff-text-color: #d1d5db;
  --diff-code-insert-background-color: rgba(34, 197, 94, 0.1);
  --diff-code-delete-background-color: rgba(239, 68, 68, 0.1);
  --diff-code-insert-text-color: #86efac;
  --diff-code-delete-text-color: #fca5a5;
  --diff-gutter-insert-background-color: rgba(34, 197, 94, 0.15);
  --diff-gutter-delete-background-color: rgba(239, 68, 68, 0.15);
  --diff-gutter-color: #6b7280;
  --diff-hunk-header-background-color: rgba(59, 130, 246, 0.1);
  --diff-hunk-header-color: #60a5fa;
  --diff-selection-background-color: rgba(59, 130, 246, 0.3);
  --diff-omit-gutter-line-color: transparent;
}

/* Ensure diff table fills width and uses monospace */
.diff-dark .diff {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.75rem;
  line-height: 1.5;
}

/* Gutter hover for "click to comment" affordance */
.diff-dark .diff-gutter:hover {
  cursor: pointer;
  background-color: rgba(59, 130, 246, 0.2);
}

/* Prism/refractor dark syntax colors (One Dark inspired) */
.diff-dark .token.comment,
.diff-dark .token.prolog,
.diff-dark .token.doctype,
.diff-dark .token.cdata {
  color: #7c8594;
}
.diff-dark .token.punctuation {
  color: #abb2bf;
}
.diff-dark .token.property,
.diff-dark .token.tag,
.diff-dark .token.boolean,
.diff-dark .token.number,
.diff-dark .token.constant,
.diff-dark .token.symbol {
  color: #d19a66;
}
.diff-dark .token.selector,
.diff-dark .token.attr-name,
.diff-dark .token.string,
.diff-dark .token.char,
.diff-dark .token.builtin {
  color: #98c379;
}
.diff-dark .token.operator,
.diff-dark .token.entity,
.diff-dark .token.url {
  color: #56b6c2;
}
.diff-dark .token.atrule,
.diff-dark .token.attr-value,
.diff-dark .token.keyword {
  color: #c678dd;
}
.diff-dark .token.function,
.diff-dark .token.class-name {
  color: #61afef;
}
.diff-dark .token.regex,
.diff-dark .token.important,
.diff-dark .token.variable {
  color: #e06c75;
}
```

- [ ] **Step 2: Import it in index.css**

Add to the top of `web/src/index.css`, after the existing imports:

```css
@import "./diff-dark.css";
```

- [ ] **Step 3: Build to verify CSS loads**

```bash
cd /Users/lex/src/cr-watch/web && npx vite build 2>&1 | tail -5
```

Expected: build succeeds with no CSS errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/lex/src/cr-watch && git add web/src/diff-dark.css web/src/index.css
git commit -m "feat(web): add dark theme CSS for react-diff-view"
```

---

### Task 4: Rewrite DiffView.tsx with react-diff-view

**Files:**
- Modify: `web/src/components/DiffView.tsx` (full rewrite of internals)

This is the main task. The component keeps the same default export and store integration but replaces all rendering internals.

- [ ] **Step 1: Rewrite DiffView.tsx**

Replace the full contents of `web/src/components/DiffView.tsx` with:

```tsx
import { Fragment, useEffect, useMemo, useRef } from "react";
import { parseDiff, Diff, Hunk, tokenize, getChangeKey } from "react-diff-view";
import type { HunkData, ChangeData, GutterOptions } from "react-diff-view";
import { refractor } from "refractor";
import tsxLang from "refractor/lang/tsx.js";
import tsLang from "refractor/lang/typescript.js";
import jsxLang from "refractor/lang/jsx.js";
import jsLang from "refractor/lang/javascript.js";
import pythonLang from "refractor/lang/python.js";
import goLang from "refractor/lang/go.js";
import rustLang from "refractor/lang/rust.js";
import javaLang from "refractor/lang/java.js";
import cssLang from "refractor/lang/css.js";
import jsonLang from "refractor/lang/json.js";
import yamlLang from "refractor/lang/yaml.js";
import bashLang from "refractor/lang/bash.js";
import sqlLang from "refractor/lang/sql.js";
import markdownLang from "refractor/lang/markdown.js";
import rubyLang from "refractor/lang/ruby.js";
import swiftLang from "refractor/lang/swift.js";
import kotlinLang from "refractor/lang/kotlin.js";
import cLang from "refractor/lang/c.js";
import cppLang from "refractor/lang/cpp.js";
import csharpLang from "refractor/lang/csharp.js";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import Comment from "./Comment";
import { useAppStore } from "../store";

// Register languages with refractor
refractor.register(tsxLang);
refractor.register(tsLang);
refractor.register(jsxLang);
refractor.register(jsLang);
refractor.register(pythonLang);
refractor.register(goLang);
refractor.register(rustLang);
refractor.register(javaLang);
refractor.register(cssLang);
refractor.register(jsonLang);
refractor.register(yamlLang);
refractor.register(bashLang);
refractor.register(sqlLang);
refractor.register(markdownLang);
refractor.register(rubyLang);
refractor.register(swiftLang);
refractor.register(kotlinLang);
refractor.register(cLang);
refractor.register(cppLang);
refractor.register(csharpLang);

function getLanguage(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    css: "css", html: "html", json: "json", yaml: "yaml", yml: "yaml",
    md: "markdown", sh: "bash", sql: "sql", swift: "swift", kt: "kotlin",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  };
  return ext ? map[ext] : undefined;
}

function InlineCommentBox({ onCancel }: { onCancel: () => void }) {
  const body = useAppStore((s) => s.commentBody);
  const submitting = useAppStore((s) => s.commentSubmitting);
  const setBody = useAppStore((s) => s.setCommentBody);
  const submit = useAppStore((s) => s.submitInlineComment);
  const detail = useAppStore((s) => s.detail);
  const selectedFile = useAppStore((s) => s.selectedFile);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="my-2 ml-8 border border-blue-500/30 rounded-lg bg-gray-900 overflow-hidden">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Leave a comment..."
        className="w-full bg-transparent text-xs text-gray-300 p-3 resize-none focus:outline-none min-h-[80px]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) {
            void submit(detail!.headSha, selectedFile!);
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="flex items-center justify-between px-3 py-2 border-t border-gray-800 bg-gray-800/30">
        <span className="text-xs text-gray-600">Cmd+Enter to submit, Esc to cancel</span>
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1 text-gray-400 hover:text-gray-300"
          >
            Cancel
          </button>
          <Button variant="blue" size="xs" onClick={() => body.trim() && void submit(detail!.headSha, selectedFile!)} disabled={!body.trim() || submitting}>
            {submitting ? "Posting..." : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Build a widgets map for inline comments and the active comment box. */
function buildWidgets(
  hunks: HunkData[],
  fileComments: Array<{ id: number; line: number; path: string; [key: string]: unknown }>,
  commentingLine: { line: number; side: "LEFT" | "RIGHT" } | null,
  onCancelComment: () => void,
): Record<string, React.ReactElement> {
  const widgets: Record<string, React.ReactElement> = {};
  const allChanges = hunks.flatMap((h) => h.changes);

  // Group comments by line number
  const commentsByLine: Record<number, typeof fileComments> = {};
  for (const c of fileComments) {
    if (!commentsByLine[c.line]) commentsByLine[c.line] = [];
    commentsByLine[c.line].push(c);
  }

  for (const change of allChanges) {
    const key = getChangeKey(change);
    const lineNum = getLineFromChange(change);
    const lineComments = lineNum ? commentsByLine[lineNum] : undefined;
    const isCommentTarget = commentingLine && isChangeForCommentingLine(change, commentingLine);

    if (lineComments || isCommentTarget) {
      widgets[key] = (
        <div className="bg-gray-900/50">
          {lineComments?.map((comment) => (
            <Comment key={comment.id} comment={comment as never} />
          ))}
          {isCommentTarget && (
            <InlineCommentBox onCancel={onCancelComment} />
          )}
        </div>
      );
    }
  }

  return widgets;
}

function getLineFromChange(change: ChangeData): number | null {
  if (change.type === "insert") return change.lineNumber;
  if (change.type === "delete") return change.lineNumber;
  if (change.type === "normal") return change.newLineNumber;
  return null;
}

function isChangeForCommentingLine(
  change: ChangeData,
  commentingLine: { line: number; side: "LEFT" | "RIGHT" },
): boolean {
  if (commentingLine.side === "LEFT" && change.type === "delete") {
    return change.lineNumber === commentingLine.line;
  }
  if (commentingLine.side === "RIGHT") {
    if (change.type === "insert") return change.lineNumber === commentingLine.line;
    if (change.type === "normal") return change.newLineNumber === commentingLine.line;
  }
  return false;
}

export default function DiffView() {
  const selectedFile = useAppStore((s) => s.selectedFile);
  const files = useAppStore((s) => s.files);
  const comments = useAppStore((s) => s.comments);
  const selectedPR = useAppStore((s) => s.selectedPR);
  const detail = useAppStore((s) => s.detail);
  const commentingLine = useAppStore((s) => s.commentingLine);
  const setCommentingLine = useAppStore((s) => s.setCommentingLine);
  const diffViewType = useAppStore((s) => s.diffViewType);
  const setDiffViewType = useAppStore((s) => s.setDiffViewType);

  const file = files.find((f) => f.filename === selectedFile);
  const fileComments = comments.filter((c) => c.path === selectedFile);

  if (!file || !selectedPR || !detail) return null;
  if (!file.patch) {
    return <div className="text-gray-500 text-sm p-4">No diff available for this file.</div>;
  }

  // Prepend a minimal git diff header so parseDiff can parse a single-file patch
  const diffText = `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}`;
  const [parsed] = parseDiff(diffText, { nearbySequences: "zip" });
  const { hunks } = parsed;

  const language = getLanguage(file.filename);
  const tokens = useMemo(() => {
    if (!language || !hunks.length) return undefined;
    try {
      return tokenize(hunks, {
        highlight: true,
        refractor,
        language,
      });
    } catch {
      // Language not registered or tokenization failed — fall back to no highlighting
      return undefined;
    }
  }, [hunks, language]);

  const widgets = buildWidgets(hunks, fileComments, commentingLine, () => setCommentingLine(null));

  const handleGutterClick = ({ change }: GutterOptions) => {
    if (!change) return;
    if (change.type === "delete") {
      setCommentingLine({ line: change.lineNumber, side: "LEFT" });
    } else if (change.type === "insert") {
      setCommentingLine({ line: change.lineNumber, side: "RIGHT" });
    } else if (change.type === "normal") {
      setCommentingLine({ line: change.newLineNumber, side: "RIGHT" });
    }
  };

  return (
    <div className="diff-dark">
      <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-2 flex items-center justify-between">
        <span className="text-sm text-gray-300 font-mono">{file.filename}</span>
        <div className="flex items-center gap-0.5 bg-gray-800 rounded-lg p-0.5">
          <button
            className={cn(
              "px-2 py-0.5 text-xs rounded-md transition-colors",
              diffViewType === "unified"
                ? "bg-gray-700 text-white"
                : "text-gray-400 hover:text-gray-300",
            )}
            onClick={() => setDiffViewType("unified")}
          >
            Unified
          </button>
          <button
            className={cn(
              "px-2 py-0.5 text-xs rounded-md transition-colors",
              diffViewType === "split"
                ? "bg-gray-700 text-white"
                : "text-gray-400 hover:text-gray-300",
            )}
            onClick={() => setDiffViewType("split")}
          >
            Split
          </button>
        </div>
      </div>
      <Diff
        viewType={diffViewType}
        diffType={parsed.type}
        hunks={hunks}
        tokens={tokens}
        widgets={widgets}
        gutterEvents={{ onClick: handleGutterClick }}
      >
        {(hunks) =>
          hunks.map((hunk) => (
            <Hunk key={hunk.content} hunk={hunk} />
          ))
        }
      </Diff>
    </div>
  );
}
```

- [ ] **Step 2: Build to verify types compile**

```bash
cd /Users/lex/src/cr-watch/web && npx tsc --noEmit
```

Expected: no errors. If there are type issues with react-diff-view's exports (e.g., missing `GutterOptions` type), adjust the import to use the actual exported types, or inline the type:

```typescript
// Fallback if GutterOptions isn't exported:
const handleGutterClick = ({ change }: { change: ChangeData }) => {
```

- [ ] **Step 3: Commit**

```bash
cd /Users/lex/src/cr-watch && git add web/src/components/DiffView.tsx
git commit -m "feat(web): rewrite DiffView with react-diff-view

Replaces custom patch parser and per-line highlight.js with
react-diff-view's Diff/Hunk components, refractor-based cross-line
syntax highlighting, first-class widget system for inline comments,
and unified/split view toggle."
```

---

### Task 5: Verify full build and smoke test

**Files:** None (verification only)

- [ ] **Step 1: Full build**

```bash
cd /Users/lex/src/cr-watch && yarn build:all
```

Expected: builds cleanly with no errors.

- [ ] **Step 2: Dev server smoke test**

```bash
cd /Users/lex/src/cr-watch && yarn dev
```

Open the web UI, navigate to a PR with file changes:
1. Verify the diff renders with syntax highlighting (colors on keywords, strings, etc.)
2. Verify the unified/split toggle button works in the file header
3. Click a gutter line number — the inline comment box should appear below that line
4. Verify existing review comments display inline at their correct lines
5. Check that the dark theme looks consistent (green/red backgrounds for adds/removes, dark gutter)

- [ ] **Step 3: Fix any visual issues**

Likely tweaks:
- If the diff table is too wide / has horizontal scroll issues, add `overflow-x: auto` to the `.diff-dark` wrapper
- If refractor language resolution fails silently for some extensions, the diff still renders — just without highlighting
- If CSS variable names don't match exactly what react-diff-view expects, inspect the rendered DOM and adjust `diff-dark.css` accordingly

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
cd /Users/lex/src/cr-watch && git add -A
git commit -m "fix(web): polish diff view styling and type adjustments"
```

---

### Task 6: Clean up unused highlight.js import from DiffView

**Files:**
- Verify: `web/src/components/DiffView.tsx` — should no longer import `highlight.js`
- Verify: `web/src/components/Comment.tsx` — still imports `rehype-highlight` (keep)

- [ ] **Step 1: Verify highlight.js is only used by Comment.tsx**

```bash
cd /Users/lex/src/cr-watch/web && grep -r "highlight.js\|hljs" src/ --include="*.tsx" --include="*.ts"
```

Expected: only `Comment.tsx` references remain (via `rehype-highlight`). The old DiffView hljs imports should be gone since Task 4 replaced the file.

- [ ] **Step 2: Verify highlight.js stays in package.json**

`highlight.js` must remain in `web/package.json` because `rehype-highlight` (used by `Comment.tsx`) depends on it at runtime. No changes needed.

- [ ] **Step 3: Final full build**

```bash
cd /Users/lex/src/cr-watch && yarn build:all
```

Expected: clean build, no warnings about unused imports.
