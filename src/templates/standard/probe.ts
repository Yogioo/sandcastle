// Planning-probe helpers for the standard workflow's planning entry
// (plan.mts). The helpers are plain functions so the generated plan.mts
// stays thin and the grill→spec→tickets state machine is testable.
//
// The planning workflow processes one discussion task per iteration and
// runs exactly one planning phase per iteration. This module maps a task's
// labels + comments to the next phase the host should run:
//
//   grill   — ask questions on the issue (the task was never grilled, or
//             the human replied to the latest agent comment)
//   spec    — the grill frontier is empty (label `aligned`), post the spec
//   tickets — the spec was posted (label `specced`), create child tasks
//   wait    — the latest comment is the agent's and the task is not
//             aligned: waiting on a human, so the host idles (no sandbox)
//
// The host probe must not require GitHub author identity: agent comments
// start with a fixed marker, so "latest comment lacks the marker" means a
// human replied.

/** Prefix every agent comment must start with. Human comments lack it. */
export const AGENT_COMMENT_MARKER = "[Sandcastle]";

/** The next planning phase for a discussion task. */
export type PlanningPhase = "grill" | "spec" | "tickets" | "wait";

export interface DiscussionTask {
  /** Tracker id (GitHub issue number, beads id). */
  readonly number: string | number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly comments: readonly string[];
}

const isAgentComment = (comment: string): boolean =>
  comment.startsWith(AGENT_COMMENT_MARKER);

/**
 * Decide the next planning phase for a discussion task from its labels and
 * comments. `planned` tasks are expected to be absent from the planning
 * list; defensively they resolve to `wait` rather than re-running a phase.
 */
export const probePlanningPhase = (task: {
  labels: readonly string[];
  comments: readonly string[];
}): PlanningPhase => {
  const { labels, comments } = task;

  if (labels.includes("planned")) return "wait";

  // The label state machine wins over comments: once the grill frontier is
  // empty (`aligned`) the next phase is spec, and once the spec is posted
  // (`specced`) the next phase is tickets.
  if (labels.includes("aligned") && !labels.includes("specced")) {
    return "spec";
  }
  if (labels.includes("specced")) return "tickets";

  // Not aligned yet: grill unless the latest comment is the agent's —
  // then the agent is waiting on the human and the host idles.
  const latest = comments.at(-1);
  if (latest === undefined || !isAgentComment(latest)) return "grill";
  return "wait";
};
