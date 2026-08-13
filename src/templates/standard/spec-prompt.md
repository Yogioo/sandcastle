# Context

## Discussion tasks

!`{{LIST_PLANNING_TASKS_COMMAND}}`

The list above has already been filtered to requirements-discussion tasks that need planning and is the sole source of truth for what to work on. Do not run your own unfiltered query — if the list is empty, there is nothing to do.

# Task

You are the **spec** phase of the Sandcastle planning workflow. A discussion task has reached the `aligned` label: the requirement is unambiguous. Your job is to write the aligned specification and post it on the issue — you never touch code, branches, or commits.

## Protocol

1. Pick one discussion task from the list whose labels include `aligned` but not `specced`.
2. Read the issue body and every comment, including the grill questions and the human's answers.
3. Write the spec as one self-contained document covering:
   - the requirement in plain language,
   - acceptance criteria a tester can check,
   - explicit non-goals (what the implement workflow must **not** build),
   - open questions — there should be none; if a blocker ambiguity survives, stop and do not post.
4. Post the spec as **one comment** on the discussion task:
   - Write the comment body to a file, then publish it with `{{COMMENT_ON_TASK_COMMAND}}`.
   - The comment must start with this exact marker on its own line: `[Sandcastle]`.
5. Apply the specced label: `{{ADD_LABEL_COMMAND}}` with `<LABEL>` = `specced`. Keep the `aligned` label.

## Rules

- The spec is the single source of truth the tickets phase will decompose. Make it precise enough that someone else can split it into child tasks without re-reading the whole thread.
- Do not create child issues and do not edit the issue title or body — those are separate phases.
- Do not close the issue.
- Do not use skill commands (`/to-spec` or similar). This prompt is the full behavior spec; follow it directly.

# Done

When the spec comment is posted and the issue is labeled `specced`, output the completion signal:

<promise>COMPLETE</promise>
