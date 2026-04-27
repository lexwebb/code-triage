import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { autoMemberLinkDisplayLabel } from "../../../src/team/member-identity";
import type { AppConfigPayload, TeamMemberSummaryIdentityHint } from "../api";
import { trpcClient } from "../lib/trpc";
import { mergeTeamMemberLink, uncoveredIdentityHints } from "../lib/team-member-identity";
import { useAppStore } from "../store";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type MemberLink = AppConfigPayload["team"]["memberLinks"][number];

const EMPTY_MEMBER_LINKS: MemberLink[] = [];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayLabel: string;
  identityHints: TeamMemberSummaryIdentityHint[] | undefined;
  /** Optional; member summaries update from config client-side without snapshot refresh. */
  onSaved?: () => void;
};

const multiSelectClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-sm text-zinc-200 " +
  "focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500";

export function TeamMemberLinkDialog({
  open,
  onOpenChange,
  displayLabel,
  identityHints,
  onSaved: onSavedProp,
}: Props) {
  const config = useAppStore((s) => s.config);
  const [selectedGh, setSelectedGh] = useState<string[]>([]);
  const [selectedLinearIds, setSelectedLinearIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memberLinks = config?.team?.memberLinks ?? EMPTY_MEMBER_LINKS;
  const toCover = uncoveredIdentityHints(identityHints, memberLinks);

  const directoryQuery = useQuery({
    queryKey: ["teamMemberDirectory"],
    queryFn: () => trpcClient.teamMemberDirectory.query(),
    enabled: open,
    staleTime: 300_000,
  });

  const ghOptions = useMemo(() => {
    const base = directoryQuery.data?.githubLogins ?? [];
    const extra = new Set(base);
    for (const login of selectedGh) extra.add(login);
    if (identityHints) {
      for (const h of identityHints) {
        if (h.kind === "github") extra.add(h.login);
      }
    }
    return [...extra].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }, [directoryQuery.data?.githubLogins, selectedGh, identityHints]);

  const linearOptions = useMemo(() => {
    const base = directoryQuery.data?.linearUsers ?? [];
    const byId = new Map(base.map((u) => [u.id, u]));
    if (identityHints) {
      for (const h of identityHints) {
        if (h.kind === "linear" && h.userId && !byId.has(h.userId)) {
          byId.set(h.userId, { id: h.userId, name: h.name || h.userId });
        }
      }
    }
    return [...byId.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }, [directoryQuery.data?.linearUsers, identityHints]);

  const linearNamesForPreview = useMemo(
    () =>
      linearOptions
        .filter((u) => selectedLinearIds.includes(u.id))
        .map((u) => u.name.trim())
        .filter(Boolean),
    [linearOptions, selectedLinearIds],
  );

  const previewLabel = useMemo(
    () =>
      autoMemberLinkDisplayLabel({
        githubLogins: selectedGh,
        linearUserIds: selectedLinearIds,
        linearNames: linearNamesForPreview,
      }),
    [selectedGh, selectedLinearIds, linearNamesForPreview],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    const uncovered = uncoveredIdentityHints(identityHints, memberLinks);
    const gh = new Set<string>();
    const lids = new Set<string>();
    const linearUsers = directoryQuery.data?.linearUsers;

    for (const h of uncovered) {
      if (h.kind === "github") {
        gh.add(h.login);
      } else {
        if (h.userId) {
          lids.add(h.userId);
        } else if (linearUsers) {
          const m = linearUsers.find(
            (u) => u.name.trim().toLowerCase() === h.name.trim().toLowerCase(),
          );
          if (m) lids.add(m.id);
        }
      }
    }
    setSelectedGh([...gh]);
    setSelectedLinearIds([...lids]);
  }, [open, identityHints, memberLinks, directoryQuery.data]);

  async function handleSave() {
    const root = config?.root?.trim();
    if (!root) {
      setError("Config not loaded.");
      return;
    }

    const linearNames = linearNamesForPreview;

    const entry: MemberLink = {
      label: autoMemberLinkDisplayLabel({
        githubLogins: [...selectedGh],
        linearUserIds: [...selectedLinearIds],
        linearNames,
      }),
      githubLogins: [...selectedGh],
      linearUserIds: [...selectedLinearIds],
      linearNames,
    };

    if (
      (entry.githubLogins?.length ?? 0) === 0
      && (entry.linearNames?.length ?? 0) === 0
      && (entry.linearUserIds?.length ?? 0) === 0
    ) {
      setError("Select at least one GitHub user or Linear teammate.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const merged = mergeTeamMemberLink(memberLinks, entry);
      await trpcClient.configSave.mutate({
        root,
        team: { memberLinks: merged },
      });
      const next = (await trpcClient.configGet.query()) as unknown as {
        config: AppConfigPayload;
      };
      useAppStore.setState({ config: next.config });
      onSavedProp?.();
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const ghLoading = directoryQuery.isLoading;
  const ghEmpty = !ghLoading && ghOptions.length === 0;
  const linEmpty = !directoryQuery.isLoading && linearOptions.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-lg" showCloseButton>
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Link teammate identities</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Choose GitHub org members and Linear workspace users to merge into one teammate row. The display name is derived
            automatically (Linear names, then GitHub logins). This updates Settings → Team → member links; the list below
            updates immediately.
          </DialogDescription>
        </DialogHeader>
        {toCover.length > 0 && (
          <p className="text-xs text-zinc-500">
            Suggested from snapshot:{" "}
            <span className="font-mono text-zinc-400">
              {toCover.map((h) => (h.kind === "github" ? h.login : h.userId || h.name)).join(", ")}
            </span>
          </p>
        )}
        {directoryQuery.data?.githubError ? (
          <p className="text-xs text-amber-300/90">GitHub directory: {directoryQuery.data.githubError}</p>
        ) : null}
        {directoryQuery.data?.linearError ? (
          <p className="text-xs text-amber-300/90">Linear directory: {directoryQuery.data.linearError}</p>
        ) : null}
        {displayLabel.trim() ? (
          <p className="text-xs text-zinc-500">
            Row in snapshot: <span className="font-medium text-zinc-300">{displayLabel}</span>
          </p>
        ) : null}
        <div className="space-y-4">
          <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2">
            <span className="text-xs text-zinc-500">Display name (auto)</span>
            <p className="text-sm font-medium text-zinc-100">{previewLabel}</p>
          </div>

          <div className="space-y-1">
            <span className="text-xs text-zinc-400">GitHub users</span>
            <p className="text-[10px] text-zinc-600">Hold Cmd (Mac) or Ctrl (Windows) to select multiple.</p>
            {ghLoading ? (
              <p className="text-xs text-zinc-500">Loading org members…</p>
            ) : ghEmpty ? (
              <p className="text-xs text-zinc-600">
                No org members found for tracked repos. Ensure repo owners are orgs you belong to and your token can list
                members.
              </p>
            ) : (
              <select
                multiple
                size={Math.min(10, Math.max(5, ghOptions.length))}
                className={multiSelectClass}
                value={selectedGh}
                onChange={(e) => setSelectedGh([...e.target.selectedOptions].map((o) => o.value))}
              >
                {ghOptions.map((login) => (
                  <option key={login} value={login}>
                    {login}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="space-y-1">
            <span className="text-xs text-zinc-400">Linear users</span>
            {directoryQuery.isLoading ? (
              <p className="text-xs text-zinc-500">Loading workspace directory…</p>
            ) : linEmpty ? (
              <p className="text-xs text-zinc-600">
                No Linear users loaded. Add a Linear API key in settings, or check the error above.
              </p>
            ) : (
              <select
                multiple
                size={Math.min(10, Math.max(5, linearOptions.length))}
                className={multiSelectClass}
                value={selectedLinearIds}
                onChange={(e) => setSelectedLinearIds([...e.target.selectedOptions].map((o) => o.value))}
              >
                {linearOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.id})
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        {error ? <p className="text-xs text-red-300">{error}</p> : null}
        <DialogFooter className="border-zinc-800 bg-zinc-950 sm:justify-end">
          <Button type="button" variant="outline" className="border-zinc-700" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" className="bg-blue-600 hover:bg-blue-500" disabled={saving} onClick={() => void handleSave()}>
            {saving ? "Saving…" : "Save link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
