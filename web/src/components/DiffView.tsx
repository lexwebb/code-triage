import { useEffect, useRef } from "react";
import { parseDiff, Diff, Hunk, tokenize, getChangeKey } from "react-diff-view";
import type { HunkData, ChangeData, ChangeEventArgs } from "react-diff-view";
import { refractor } from "refractor/core";
// refractor's exports map: "./*" -> "./lang/*.js", so "refractor/tsx" -> "lang/tsx.js"
import tsxLang from "refractor/tsx";
import tsLang from "refractor/typescript";
import jsxLang from "refractor/jsx";
import jsLang from "refractor/javascript";
import pythonLang from "refractor/python";
import goLang from "refractor/go";
import rustLang from "refractor/rust";
import javaLang from "refractor/java";
import cssLang from "refractor/css";
import jsonLang from "refractor/json";
import yamlLang from "refractor/yaml";
import bashLang from "refractor/bash";
import sqlLang from "refractor/sql";
import markdownLang from "refractor/markdown";
import rubyLang from "refractor/ruby";
import swiftLang from "refractor/swift";
import kotlinLang from "refractor/kotlin";
import cLang from "refractor/c";
import cppLang from "refractor/cpp";
import csharpLang from "refractor/csharp";
import type { ReviewComment } from "../types";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import Comment from "./Comment";
import { useAppStore } from "../store";

// Adapter: refractor v5 highlight() returns a Root node, but react-diff-view's
// tokenizer expects highlight() to return an array of child nodes.
const refractorAdapter = {
  highlight: (code: string, language: string) => refractor.highlight(code, language).children,
};

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

/** Build a widgets map for inline comments and the active comment box. */
function buildWidgets(
  hunks: HunkData[],
  fileComments: ReviewComment[],
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
            <Comment key={comment.id} comment={comment} />
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

  // Parse diff and tokenize — hooks must be called unconditionally (before early returns)
  const patch = file?.patch;
  const filename = file?.filename;
  const language = filename ? getLanguage(filename) : undefined;

  let diffData = null as ReturnType<typeof parseDiff>[number] | null;
  if (patch && filename) {
    const diffText = `diff --git a/${filename} b/${filename}\n--- a/${filename}\n+++ b/${filename}\n${patch}`;
    [diffData] = parseDiff(diffText, { nearbySequences: "zip" });
  }

  const maybeHunks = diffData?.hunks;
  let tokens: ReturnType<typeof tokenize> | undefined;
  if (language && maybeHunks?.length) {
    try {
      tokens = tokenize(maybeHunks, {
        highlight: true,
        refractor: refractorAdapter,
        language,
      });
    } catch {
      // Language not registered or tokenization failed — render without highlighting
    }
  }

  if (!file || !selectedPR || !detail) return null;
  if (!file.patch || !diffData || !maybeHunks) {
    return <div className="text-gray-500 text-sm p-4">No diff available for this file.</div>;
  }

  const widgets = buildWidgets(maybeHunks, fileComments, commentingLine, () => setCommentingLine(null));

  const handleGutterClick = ({ change }: ChangeEventArgs) => {
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
        diffType={diffData.type}
        hunks={maybeHunks}
        tokens={tokens}
        widgets={widgets}
        gutterEvents={{ onClick: handleGutterClick }}
      >
        {(displayHunks) =>
          displayHunks.map((hunk) => (
            <Hunk key={hunk.content} hunk={hunk} />
          ))
        }
      </Diff>
    </div>
  );
}
