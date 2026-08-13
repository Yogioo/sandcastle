# Custom base image abstraction layer

## Context

Contributors have proposed an abstraction layer for composing Dockerfiles or managing base images programmatically — for example `ISandboxEnvironment` / `IAgentHarness` interfaces that wrap image selection and package installation.

## Decision

Sandcastle does not provide an abstraction layer for composing Dockerfiles or managing base images programmatically.

- The `.sandcastle/Dockerfile` is scaffolded into the user's project during `sandcastle init` and is fully user-owned from that point — users can change the base image, add packages, or restructure it however they need.
- An abstraction layer would add complexity for something already achievable by editing the Dockerfile directly.
- Docker is only one of several sandbox providers Sandcastle supports (also Daytona, E2B) — building a Dockerfile composition system couples the init layer too tightly to Docker.
- The init script should give a working starting point, not try to cover every possible tool or stack.

Control is inverted towards the user. Sandcastle scaffolds a sensible default; the user owns the result.

## Prior requests

- #283 — rejected

## Consequences

- Image customization happens by editing the scaffolded `.sandcastle/Dockerfile` directly.
- UID alignment uses build-time `ARG` injection (ADR 0014), not a programmatic image-composition API.
