# Templates do not share code

Each directory under `src/templates/<name>/` is a self-contained unit. Files inside it — `main.mts`, prompts, markdown, anything else — may not import from each other, from a `templates/_shared/` module, or from any internal Sandcastle source. Duplication between templates is expected and welcome.

The rule is about Sandcastle's _own_ code: templates depend on the published `@yogioo/sandcastle` package (the root export and its `./sandboxes/*` subpaths), never on its internals or on each other. A template may still import a third-party npm package — e.g. the `parallel-planner` templates import [Zod](https://zod.dev) for `Output.object`'s schema — as long as `init`'s next-steps tell the user to install it.

Motivation: a template directory is the unit of distribution. `sandcastle init <template>` copies the directory verbatim into the user's `.sandcastle/`, and the result has to run against nothing but `@yogioo/sandcastle` plus whatever third-party packages `init` told the user to install. A shared helper would either need to be inlined at copy time (complicating `init`) or promoted to a public export (growing the package's API surface to support template internals). Beyond the copy-time constraint, a shared helper becomes a junk drawer of flags as needs diverge. Distinct orchestration shapes now live as **workflow recipes** *inside* **standard** (ADR 0030), not as cross-template imports.

This ADR exists because the question recurs in PRs — e.g. a contributor proposing `import { extractPlanIssues } from "@yogioo/sandcastle/utils"` to dedupe a `<plan>…</plan>` regex parse between `parallel-planner` and `parallel-planner-with-review`. The answer is: copy the helper into each template's `main.mts`.

## Considered Options

1. **Promote shared helpers to public exports** (`@yogioo/sandcastle/utils`) — rejected. Grows the public API to support template internals, locks in helper signatures the wider ecosystem doesn't need, and couples templates to each other through the package.
2. **Internal `src/templates/_shared/` module bundled into `init` output** — rejected. Makes `init` a dependency-walking copy rather than a directory copy, and reintroduces the cross-template coupling that prevents free divergence.
3. **Prompt-include directive for shared markdown** (`{{include ../_shared/foo.md}}`) — rejected. Same coupling problem at the prompt layer. Shared markdown that several *recipes* need still lives in each recipe folder, or once in **standard** when it is part of the running workflow.
4. **Each template directory is self-contained, imports only `@yogioo/sandcastle`** (chosen). One-line rule, easy to apply on review, keeps `init` a pure directory copy, and lets each template evolve independently.

## Consequences

- New helpers used by more than one template are copied into each template's `main.mts`, not extracted.
- Shared markdown (e.g. coding standards) is duplicated per template, not referenced.
- Public exports are added for end-user use cases, never to satisfy a template's internal needs.
- `sandcastle init <template>` remains a verbatim copy of `src/templates/<name>/` — no dependency resolution, no inlining step.
- **Workflow recipes** live inside **standard** (ADR 0030). That is still one template directory, not `templates/_shared/`.
