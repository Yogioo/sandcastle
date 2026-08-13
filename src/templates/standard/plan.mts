// Planning workflow — grill → spec → tickets on discussion tasks
//
// This template drives the planning workflow on one discussion task at a
// time. The implement workflow (main.mts) never lists discussion tasks, and
// this entry never lists ready tasks. Started by `sandcastle plan`, never
// by `sandcastle`.
//
// TODO(planning-loop): the host loop is not implemented yet — probe the
// discussion-task list on the host, run exactly one planning phase
// (grill / spec / tickets) per iteration, and idle-poll (no sandbox) while
// waiting on a human.
//
// Usage:
//   Run the generated file at the path printed by `sandcastle init`.

import { run, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoDir = process.cwd();
const workflowDir = fileURLToPath(new URL(".", import.meta.url));

// Same list command the implementer prompt interpolates. Idle polling runs
// it on the host so an empty backlog does not start an agent.
const LIST_TASKS_COMMAND = "{{LIST_TASKS_COMMAND}}";

const grillPromptFile = join(workflowDir, "grill-prompt.md");
const specPromptFile = join(workflowDir, "spec-prompt.md");
const ticketsPromptFile = join(workflowDir, "tickets-prompt.md");

// Placeholder factory calls — the host loop will pass these to run().
const agent = claudeCode();
const sandbox = docker();

console.log(
  "Planning workflow entry — the grill → spec → tickets loop is not implemented yet.",
);
