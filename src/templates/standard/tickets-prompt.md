# Context

## Discussion tasks

!`{{LIST_PLANNING_TASKS_COMMAND}}`

The list above has already been filtered to requirements-discussion tasks that need planning and is the sole source of truth for what to work on. Do not run your own unfiltered query — if the list is empty, there is nothing to do.

# Task

You are the **tickets** phase of the Sandcastle planning workflow. A discussion task has reached the `specced` label: its spec is posted as a comment. Your job is to decompose the spec into child **ready tasks** for the implement workflow — you never touch code, branches, or commits.

## Protocol

1. Pick one discussion task from the list whose labels include `specced` but not `planned`.
2. Read the spec comment (it starts with `[Sandcastle]`) and the issue body.
3. Split the spec into child tasks. Each child must be:
   - independently implementable — small enough for one implement iteration,
   - verifiable — it states how a tester confirms it is done,
   - linked back to this parent issue in its body.
4. Create each child task with `{{CREATE_TASK_COMMAND}}`. Children are **ready tasks**: they must carry the `Sandcastle` label so the implement workflow's list picks them up. Write each child body to a file before creating.
5. Apply the planned label to the parent: `{{ADD_LABEL_COMMAND}}` with `<LABEL>` = `planned`. Keep `aligned` and `specced`.
6. Post a summary comment on the parent listing every child task you created, with links:
   - Write the comment body to a file, then publish it with `{{COMMENT_ON_TASK_COMMAND}}`.
   - The comment must start with this exact marker on its own line: `[Sandcastle]`.

## Rules

- The parent issue stays **open** — it is the epic for its children. Do not close it.
- Do not create children for work already covered by an existing issue; link the existing issue instead.
- If the spec is too vague to decompose, do not create anything. Post a comment asking the human to reopen the grill, and stop.
- Do not use skill commands (`/to-tickets` or similar). This prompt is the full behavior spec; follow it directly.

# Done

When every child is created, the parent is labeled `planned`, and the summary comment is posted, output the completion signal:

<promise>COMPLETE</promise>
