import { describe, expect, it } from "vitest";
import type { TeamOverviewSnapshot } from "../api";
import { reconcileMemberSummariesForDisplay } from "./reconcile-member-summaries";

type Row = NonNullable<TeamOverviewSnapshot["memberSummaries"]>[number];

describe("reconcileMemberSummariesForDisplay", () => {
  it("relabels and merges rows when memberLinks join identities", () => {
    const rows: Row[] = [
      {
        memberLabel: "alice",
        identityHints: [{ kind: "github", login: "alice" }],
        workingOn: [
          {
            title: "PR A",
            entityKind: "pr",
            entityIdentifier: "o/r#1",
          },
        ],
        waiting: [],
        comingUp: [],
      },
      {
        memberLabel: "Bob Tables",
        identityHints: [{ kind: "linear", userId: "u1", name: "Bob Tables" }],
        workingOn: [
          {
            title: "Ticket",
            entityKind: "ticket",
            entityIdentifier: "ENG-1",
          },
        ],
        waiting: [],
        comingUp: [],
      },
    ];

    const out = reconcileMemberSummariesForDisplay(rows, [
      { label: "Bob Tables", githubLogins: ["alice"], linearUserIds: ["u1"], linearNames: ["Bob Tables"] },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.memberLabel).toBe("Bob Tables");
    expect(out[0]!.workingOn).toHaveLength(2);
  });
});
