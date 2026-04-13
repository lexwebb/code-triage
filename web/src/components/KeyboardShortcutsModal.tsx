import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export default function KeyboardShortcutsModal({ open, onClose }: KeyboardShortcutsModalProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="top-[10%] max-h-[min(70vh,520px)] max-w-lg translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton
      >
        <DialogHeader className="border-b border-border px-4 py-3 text-left">
          <DialogTitle id="shortcuts-title">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="max-h-[min(65vh,480px)] space-y-5 overflow-y-auto px-4 py-3 text-sm text-foreground">
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">General</h3>
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Open this help</dt>
                <dd><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">?</kbd></dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Close dialog</dt>
                <dd><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">Esc</kbd></dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Next / previous PR in sidebar</dt>
                <dd className="text-right">
                  <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">]</kbd>
                  {" / "}
                  <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">[</kbd>
                </dd>
              </div>
            </dl>
          </section>
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Review threads tab</h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Ignored while typing in a field. Focus a thread with <kbd className="rounded bg-muted px-1 font-mono">j</kbd>
              {" "}/ <kbd className="rounded bg-muted px-1 font-mono">k</kbd> first.
            </p>
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Focus next / previous thread</dt>
                <dd>
                  <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">j</kbd>
                  {" / "}
                  <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">k</kbd>
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Expand or collapse thread</dt>
                <dd>
                  <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">Enter</kbd>
                  {" / "}
                  <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">Space</kbd>
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Send suggested reply</dt>
                <dd><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">r</kbd></dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Resolve thread</dt>
                <dd><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">x</kbd></dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Dismiss (local)</dt>
                <dd><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">d</kbd></dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Fix with Claude</dt>
                <dd><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">f</kbd></dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Re-evaluate</dt>
                <dd><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">e</kbd></dd>
              </div>
            </dl>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
