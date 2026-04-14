import { Fragment, useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.min.css";
import { Button } from "./ui/button";
import Comment from "./Comment";
import { useAppStore } from "../store";

interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

function parsePatch(patch: string): DiffLine[] {
  const lines = patch.split("\n");
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({ type: "header", content: line, oldLine: null, newLine: null });
    } else if (line.startsWith("+")) {
      result.push({ type: "add", content: line.slice(1), oldLine: null, newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      result.push({ type: "remove", content: line.slice(1), oldLine, newLine: null });
      oldLine++;
    } else {
      result.push({ type: "context", content: line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }

  return result;
}

function getLanguage(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
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

export default function DiffView() {
  const selectedFile = useAppStore((s) => s.selectedFile);
  const files = useAppStore((s) => s.files);
  const comments = useAppStore((s) => s.comments);
  const selectedPR = useAppStore((s) => s.selectedPR);
  const detail = useAppStore((s) => s.detail);
  const commentingLine = useAppStore((s) => s.commentingLine);
  const setCommentingLine = useAppStore((s) => s.setCommentingLine);

  const file = files.find((f) => f.filename === selectedFile);
  const fileComments = comments.filter((c) => c.path === selectedFile);

  const codeRef = useRef<HTMLTableElement>(null);

  const patch = file?.patch;
  const filename = file?.filename;

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.querySelectorAll("code[data-highlight]").forEach((el) => {
        hljs.highlightElement(el as HTMLElement);
      });
    }
  }, [patch, filename]);

  if (!file || !selectedPR || !detail) return null;

  const diffLines = parsePatch(file.patch);
  const language = getLanguage(file.filename);

  const commentsByLine: Record<number, typeof fileComments> = {};
  for (const c of fileComments) {
    if (!commentsByLine[c.line]) commentsByLine[c.line] = [];
    commentsByLine[c.line].push(c);
  }

  if (!file.patch) {
    return <div className="text-gray-500 text-sm p-4">No diff available for this file.</div>;
  }

  return (
    <div className="font-mono text-xs">
      <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-4 py-2 text-sm text-gray-300">
        {file.filename}
      </div>
      <table ref={codeRef} className="w-full border-collapse">
        <tbody>
          {diffLines.map((line, i) => {
            if (line.type === "header") {
              return (
                <tr key={i} className="bg-blue-500/10">
                  <td colSpan={3} className="px-4 py-1 text-blue-400 select-none">
                    {line.content}
                  </td>
                </tr>
              );
            }

            const bgClass =
              line.type === "add"
                ? "bg-green-500/10"
                : line.type === "remove"
                  ? "bg-red-500/10"
                  : "";

            const textClass =
              line.type === "add"
                ? "text-green-300"
                : line.type === "remove"
                  ? "text-red-300"
                  : "text-gray-300";

            const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
            const lineNum = line.newLine ?? line.oldLine ?? 0;
            const lineComments = lineNum ? commentsByLine[lineNum] || [] : [];
            const side = line.type === "remove" ? "LEFT" as const : "RIGHT" as const;
            const isCommenting = commentingLine?.line === lineNum && commentingLine?.side === side;

            return (
              <Fragment key={i}>
                <tr className={cn(bgClass, "group")}>
                  <td
                    className="w-12 text-right pr-2 text-gray-600 select-none align-top cursor-pointer relative"
                    onClick={() => line.oldLine ? setCommentingLine({ line: line.oldLine, side: "LEFT" }) : undefined}
                    title={line.oldLine ? "Click to comment on this line" : undefined}
                  >
                    {line.oldLine ?? ""}
                    {line.oldLine && (
                      <span className="absolute left-0 top-0 text-blue-500/40 group-hover:text-blue-400 text-xs transition-colors">+</span>
                    )}
                  </td>
                  <td
                    className="w-12 text-right pr-2 text-gray-600 select-none align-top cursor-pointer relative"
                    onClick={() => line.newLine ? setCommentingLine({ line: line.newLine, side: "RIGHT" }) : undefined}
                    title={line.newLine ? "Click to comment on this line" : undefined}
                  >
                    {line.newLine ?? ""}
                    {line.newLine && (
                      <span className="absolute left-0 top-0 text-blue-500/40 group-hover:text-blue-400 text-xs transition-colors">+</span>
                    )}
                  </td>
                  <td className={cn("pl-4 pr-4 whitespace-pre", textClass)}>
                    <span className="select-none text-gray-600 mr-2">{prefix}</span>
                    <code data-highlight className={language ? `language-${language}` : ""}>
                      {line.content}
                    </code>
                    {lineComments.map((comment) => (
                      <Comment key={comment.id} comment={comment} />
                    ))}
                  </td>
                </tr>
                {isCommenting && (
                  <tr>
                    <td colSpan={3} className="p-0">
                      <InlineCommentBox
                        onCancel={() => setCommentingLine(null)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
