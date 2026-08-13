# Large bundled workflow templates

## Context

Requests recur to ship large, opinionated third-party workflow templates as built-in `sandcastle init` options — for example a "superpowers"/"freecc" template that bundles its own set of skill files, coding standards, and multi-phase prompts.

## Decision

Sandcastle does not ship large, opinionated third-party workflow templates as built-in `sandcastle init` options.

The built-in **workflow templates** are **standard** and **blank**: minimal, framework-agnostic starting points, not an encoding of any particular external methodology. Other orchestration shapes are **workflow recipes** inside **standard**, not extra init menu entries (see ADR 0030). The init-menu-as-shape-catalog stance in earlier revisions of this ADR is superseded by that decision.

A bundled superpowers-style template is a different thing: it ships a large tree of skill markdown, review prompts, and standards that track an external project's conventions. In-tree, that becomes a maintenance burden (the bundled copies drift from upstream) and an implicit endorsement of one workflow over others. It's also big — dozens of files — relative to the focused templates around it.

The extension points already cover this:

- **The `custom` template / scaffold path** lets a user bring their own prompts and structure at init time.
- **The template directory format is plain files**, so an opinionated workflow can be distributed as its own template pack or repo and dropped in, versioned on its own cadence rather than pinned to Sandcastle's releases.

Large external workflows live outside the curated built-in template set.

## Prior requests

- #627 — "Python node with freecc superpowers"

## Consequences

- Built-in templates stay minimal and self-contained (see ADR 0009).
- Opinionated workflows distribute as external template packs or user-owned `custom` scaffolds.
