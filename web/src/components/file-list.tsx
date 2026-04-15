import { cn } from "../lib/utils";
import { MessageSquare } from "lucide-react";
import { useAppStore } from "../store";

interface FileListProps {
  onSelectFile?: (path: string) => void;
}

export default function FileList({ onSelectFile }: FileListProps) {
  const files = useAppStore((s) => s.files);
  const selectedFile = useAppStore((s) => s.selectedFile);
  const storeSelectFile = useAppStore((s) => s.selectFile);
  const comments = useAppStore((s) => s.comments);
  const selectFile = onSelectFile ?? storeSelectFile;
  const commentsByFile: Record<string, number> = {};
  for (const c of comments) {
    commentsByFile[c.path] = (commentsByFile[c.path] || 0) + 1;
  }

  return (
    <div className="border-b border-gray-800">
      <div className="px-6 py-2 text-xs text-gray-500 uppercase tracking-wide">
        Files changed ({files.length})
      </div>
      <div className="max-h-48 overflow-y-auto">
        {files.map((file) => (
          <button
            key={file.filename}
            onClick={() => selectFile(file.filename)}
            className={cn("w-full text-left px-6 py-1.5 text-sm hover:bg-gray-800/50 flex items-center justify-between", selectedFile === file.filename ? "bg-gray-800/70 text-white" : "text-gray-300")}
          >
            <span className="font-mono text-xs truncate">{file.filename}</span>
            <span className="flex items-center gap-2 shrink-0 ml-2">
              {(commentsByFile[file.filename] ?? 0) > 0 && (
                <span className="text-xs text-yellow-400 flex items-center gap-1">
                  {commentsByFile[file.filename]} <MessageSquare size={12} />
                </span>
              )}
              <span className="text-green-400 text-xs">+{file.additions}</span>
              <span className="text-red-400 text-xs">-{file.deletions}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
