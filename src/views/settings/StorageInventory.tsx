import { useEffect, useState, type ReactNode } from "react";
import { Symbol } from "../../components/Symbol";
import { formatBytes } from "../../lib/usage";
import { folderName, projectKey } from "../../lib/core";
import * as api from "../../lib/tauri";

type StorageProject = {
  name: string;
  path: string;
  bytes: number | null;
  chats: number | null;
  worktrees: { path: string; branch: string; bytes: number | null }[];
};

type StorageCloud = {
  id: string;
  name: string;
  path: string;
  host: string;
  chats: number | null;
};

/** Local projects, their chats and open worktrees, plus the cloud projects on paired machines. */
export function StorageInventory() {
  const [local, setLocal] = useState<StorageProject[] | null>(null);
  const [cloud, setCloud] = useState<StorageCloud[] | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .listProjects()
      .then(async (projects) => {
        const rows = await Promise.all(
          projects.map(async (project) => {
            const [chats, size, listed] = await Promise.all([
              api.listConversations(project.path).then((rows) => rows.length).catch(() => null),
              api.projectRemoval(project.path).catch(() => null),
              api.gitWorktrees(project.path).catch(() => [] as api.GitWorktree[]),
            ]);
            const branchFor = new Map(
              listed.map((row) => [
                projectKey(row.path),
                row.detached ? "detached" : row.branch?.trim() || folderName(row.path),
              ]),
            );
            const trees = (size?.worktree_sizes ?? []).map((row) => ({
              path: row.path,
              branch: branchFor.get(projectKey(row.path)) || folderName(row.path),
              bytes: row.bytes,
            }));
            return {
              name: project.name || folderName(project.path),
              path: project.path,
              bytes: size ? size.project : null,
              chats,
              worktrees: trees,
            };
          }),
        );
        if (!alive) return;
        // A linked worktree can also be saved as its own project. It belongs under the main checkout.
        const linked = new Set(rows.flatMap((row) => row.worktrees.map((tree) => projectKey(tree.path))));
        setLocal(rows.filter((row) => !linked.has(projectKey(row.path))).sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => {
        if (alive) setLocal([]);
      });
    void api
      .listRemoteProjects()
      .then(async (projects) => {
        const machines = await api.listMachines().catch(() => []);
        const hostFor = new Map(machines.map((machine) => [machine.id, machine.host]));
        const rows = await Promise.all(
          projects.map(async (project) => {
            const chats = await api
              .hostedSidebarCached(project.mount_path)
              .then((cached) => cached.conversations.length)
              .catch(() => null);
            return {
              id: project.id,
              name: project.name || folderName(project.remote_path),
              path: project.remote_path,
              host: hostFor.get(project.machine_id) || "",
              chats,
            };
          }),
        );
        if (alive) setCloud(rows.sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => {
        if (alive) setCloud([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const worktrees = (local ?? []).reduce((sum, row) => sum + row.worktrees.length, 0);
  const chats = (local ?? []).reduce((sum, row) => sum + (row.chats ?? 0), 0);
  const cloudChats = (cloud ?? []).reduce((sum, row) => sum + (row.chats ?? 0), 0);
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-3 divide-x divide-line/55 overflow-hidden rounded-xl border border-line/45 bg-panel">
        <CountTile label="Projects" value={local == null ? "—" : String(local.length)} />
        <CountTile label="Chats" value={local == null ? "—" : String(chats)} />
        <CountTile label="Worktrees" value={local == null ? "—" : String(worktrees)} />
      </div>
      <StorageGroup
        title="On this Mac"
        empty={local == null ? "Checking…" : "No saved projects yet."}
        rows={local}
        render={(project) => (
          <ProjectLine
            key={project.path}
            icon="folder"
            name={project.name}
            hint={project.path}
            size={project.bytes}
            count={project.chats}
            chips={project.worktrees.map((tree) => ({
              label: tree.branch,
              detail: tree.bytes == null ? "" : formatBytes(tree.bytes),
            }))}
          />
        )}
      />
      <StorageGroup
        title="Cloud"
        note={cloud && cloud.length > 0 ? `${cloudChats} ${cloudChats === 1 ? "chat" : "chats"}` : undefined}
        empty={cloud == null ? "Checking…" : "No cloud projects yet."}
        rows={cloud}
        render={(project) => (
          <ProjectLine
            key={project.id}
            icon="cloud"
            name={project.name}
            hint={project.host || project.path}
            title={project.host ? `${project.host} · ${project.path}` : project.path}
            count={project.chats}
          />
        )}
      />
    </div>
  );
}

function CountTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3.5 py-3">
      <div className="text-[18px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-ink">{value}</div>
      <div className="mt-1 text-[11px] text-muted">{label}</div>
    </div>
  );
}

function StorageGroup<T>({
  title,
  note,
  empty,
  rows,
  render,
}: {
  title: string;
  note?: string;
  empty: string;
  rows: T[] | null;
  render: (row: T) => ReactNode;
}) {
  return (
    <section className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h3 className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{title}</h3>
        {note ? <div className="text-[11px] text-muted">{note}</div> : null}
      </div>
      <div className="divide-y divide-line/55 overflow-hidden rounded-xl border border-line/45 bg-panel">
        {!rows || rows.length === 0 ? <p className="m-0 px-3.5 py-3 text-[12px] text-muted">{empty}</p> : rows.map(render)}
      </div>
    </section>
  );
}

function ProjectLine({
  icon,
  name,
  hint,
  title,
  size,
  count,
  chips = [],
}: {
  icon: string;
  name: string;
  hint: string;
  title?: string;
  size?: number | null;
  count: number | null;
  chips?: { label: string; detail: string }[];
}) {
  return (
    <div className="grid gap-1 px-3.5 py-2 hover:bg-wash" title={title ?? hint}>
      <div className="flex min-w-0 items-center gap-2">
        <Symbol name={icon} className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{name}</span>
        {size != null ? <span className="shrink-0 text-[11px] tabular-nums text-muted">{formatBytes(size)}</span> : null}
        <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-muted">{count == null ? "—" : count}</span>
      </div>
      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1 pl-5">
          {chips.map((chip) => (
            <span
              key={chip.label}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-inset px-1.5 py-0.5 text-[11px] text-muted"
            >
              <Symbol name="arrow.triangle.branch" className="size-2.5 shrink-0" />
              <span className="truncate">{chip.label}</span>
              {chip.detail ? <span className="shrink-0 tabular-nums text-muted/80">{chip.detail}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
