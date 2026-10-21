import { join } from "node:path";
import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { openDatabase } from "../storage/sqlite.ts";
import { hash, type ReleaseManifest } from "./release-policy.ts";
import { validate } from "./requests.ts";

export const ReleaseDigest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Artifact = Type.Object(
  { digest: ReleaseDigest, package: Type.String({ pattern: "^/nix/store/[a-z0-9]{32}-[^/\\s]+$" }) },
  { additionalProperties: false },
);
export type ReleaseArtifact = import("typebox").Static<typeof Artifact>;
const Selection = Type.Object(
  {
    format: Type.Literal(1),
    evaluator: Type.String(),
    current: Artifact,
    previous: Type.Optional(Artifact),
    next: Type.Optional(Artifact),
    phase: Type.Enum(["stable", "trying"]),
    approved: Type.Array(ReleaseDigest, { maxItems: 8, uniqueItems: true }),
    retained: Type.Array(Artifact, { minItems: 1, maxItems: 8 }),
    lastError: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export type ReleaseSelection = import("typebox").Static<typeof Selection>;

export function initialSelection(base: ReleaseManifest): ReleaseSelection {
  const current = { package: base.package, digest: hash(base.package) };
  return { format: 1, evaluator: base.package, current, phase: "stable", approved: [], retained: [current] };
}
export function selection(value: unknown, base: ReleaseManifest): ReleaseSelection {
  const state = validate(Selection, value);
  const retained = (item: ReleaseArtifact) =>
    state.retained.some((old) => old.digest === item.digest && old.package === item.package);
  if (
    state.evaluator !== base.package ||
    !retained(state.current) ||
    (state.previous !== undefined && !retained(state.previous)) ||
    new Set(state.retained.map((item) => item.digest)).size !== state.retained.length ||
    new Set(state.retained.map((item) => item.package)).size !== state.retained.length ||
    (state.phase === "trying") !== (state.next !== undefined) ||
    (state.next !== undefined && !retained(state.next))
  )
    throw new Error(
      "release selection is inconsistent or belongs to another evaluator; an owner-reviewed handoff is required",
    );
  return state;
}
export function recoveredSelection(state: ReleaseSelection): ReleaseSelection {
  if (state.phase !== "trying") return state;
  const stable = { ...state };
  delete stable.next;
  return {
    ...stable,
    phase: "stable",
    lastError: "Interrupted activation: recovered the retained stable release. No external effects were undone.",
  };
}
export function compatibleRelease(base: ReleaseManifest, candidate: ReleaseManifest): void {
  if (
    candidate.schema !== base.schema ||
    candidate.source.compatibility !== base.source.compatibility ||
    JSON.stringify(candidate.source.files.map((file) => file.path)) !==
      JSON.stringify(base.source.files.map((file) => file.path))
  )
    throw new Error(
      "unsupported release: schema, native implementations or protected policy differ; no automatic migration or rollback",
    );
}

/** The owning connection uses this too; release code never opens a second live connection. */
export async function unfinishedWork(database: SqliteExecutor): Promise<number> {
  const row = await database.get<{ n: number }>(
    "SELECT (SELECT count(*) FROM pi_tasks WHERE status <> 'terminal')" +
      " + (SELECT count(*) FROM pi_submissions WHERE status IN ('queued', 'placed'))" +
      " + (SELECT count(*) FROM pal_admissions WHERE state = 'admitting')" +
      " + (SELECT count(*) FROM pal_chats WHERE state = 'provisioning')" +
      " + (SELECT count(*) FROM pal_projects WHERE state = 'provisioning')" +
      " + (SELECT count(*) FROM pal_workspaces WHERE state = 'provisioning')" +
      " + (SELECT count(*) FROM pal_workspace_purges WHERE completed_at IS NULL)" +
      " + (SELECT count(*) FROM pal_command_approvals WHERE state = 'pending') AS n",
  );
  return row?.n ?? 0;
}

/** Only after the child has exited. No migrations, backup restore or reconciliation in the supervisor. */
export async function stoppedReleaseIdle(dataRoot: string, schema: number): Promise<void> {
  const database = await openDatabase(join(dataRoot, "pal.sqlite"));
  try {
    const version = await database.get<{ n: number }>("SELECT max(version) AS n FROM pal_migrations");
    if (version?.n !== schema) throw new Error("the stopped database schema is incompatible; activation refused");
    if (await unfinishedWork(database))
      throw new Error("unfinished work needs its retained release; activation refused");
    const integrity = await database.get<{ integrity_check: string }>("PRAGMA integrity_check");
    if (integrity?.integrity_check !== "ok") throw new Error("database integrity check failed; activation refused");
  } finally {
    await database.close();
  }
}
