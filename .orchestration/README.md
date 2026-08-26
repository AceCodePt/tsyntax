# `.orchestration/`

This project's orchestration, deliberately **inside the worktree and tracked**.

Never place these beside the bare repo. A bare repo has no working tree, so
anything next to it is outside version control by construction - no history, no
backup, and no ability to differ per branch.

Hooks are named after **what happened**, not what to do. Two dispatchers fire them
from this one directory under one env-var contract (`TASK_NAME`, `BRANCH_NAME`,
`WORKTREE_PATH`, `WORKTREE_NAME`):

- the **CLI** fires task-lifecycle events: `pre-task-create`, `post-task-create`,
  `pre-task-cleanup`, `post-task-cleanup`, `pre-branch-delete`
- the **daemon** fires agent-lifecycle events: `session-idle` - the verification hook, run
  when a task's session settles

The working agent declares a task done by **committing its work to the branch** - git is
the only state that records it. `session-idle` is the verification hook the daemon runs on
that committed branch: exit 0 passes **and commits anything the agent left uncommitted**;
non-zero fails and the output is fed back to the agent by the daemon, which retries up to
`verify.retryCap` before marking the task needs-review. A **missing** hook means
the work is accepted without verification - the hook is the opt-in, and its
absence is the implicit unverified state.

The verification hook that runs is the version **committed on the base branch**, never the
working-tree copy, so edit the hook and commit it before dispatching. To configure
it, copy the machine-level `session-idle` template (`~/.config/orch/hooks/session-idle.example`)
to `hooks/session-idle`, make it executable,
and put the project's real checks above the commit block (e.g.
`pnpm check && pnpm test`, `cargo clippy -- -D warnings && cargo test`,
`ruff check . && pytest -q`); the template exits non-zero on purpose until then.

A project with no database legitimately needs no `post-task-create`. Absent hooks
are fine, and so is a missing `session-idle`: it means the project's tasks are
accepted without verification.

Like the verification hook, the task-lifecycle hooks run the version **committed on the base
branch** — a working-tree edit, or a hook committed only on a task branch, never
runs. Edit a hook and commit it on the base branch before dispatching.

`config.json` holds project policy: `baseBranch`, the `verify` block
(`retryCap`), and — if you want the daemon
to dispatch `todo` tasks itself — a `scheduler` block (`enabled` + `maxConcurrent`,
the per-project cap). Like the verification hook, the **committed copy on the base branch** is the
authority: `orch project scheduler <n>` writes the working-tree copy for you to
review and commit. A machine-wide cap across all projects lives outside the repo in
`~/.config/orch/daemon.json` (`orch daemon budget`).

Reference templates for every hook live outside the repo in
`~/.config/orch/hooks/*.example` (installed by `orch init`) — one per lifecycle
hook, the `session-idle` verification hook, and one per opencode server event
(the vocabulary in `src/orch/opencode_events.py`). On init, the project-relevant
set of those `.example` references (session-idle, the five task-lifecycle hooks,
and one per opencode server event) is also dropped into this `hooks/` directory,
so the two match. They are inert and gitignored (`*.example` below), not real
hooks: enabling one is still a copy-to-real-name, `chmod +x`, and commit.
