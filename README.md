# Cadra

Cadra is a code-first, agent-first 3D video animation framework and studio
built on Three.js and WebGPU. It provides deterministic server-side rendering
to MP4, live in-browser WebGPU playback, and a unified scene DSL that both a
visual studio and any MCP-capable agent can author.

The goal is a single scene description that works everywhere: a human can
build it visually in the studio, an agent can generate or edit it through the
MCP server or agent SDK, and the same description renders identically whether
it is played live in a browser or rendered headlessly to a deterministic MP4
file.

## Package map

| Package             | Responsibility                                                        |
| ------------------- | --------------------------------------------------------------------- |
| `@cadra/core`       | Scene graph, deterministic clock, timeline, primitives, interpolation |
| `@cadra/schema`     | Zod DSL, JSON Schema, parser and diagnostics                          |
| `@cadra/renderer`   | Three.js WebGPU renderer and scene-graph reconciler                   |
| `@cadra/player`     | Live transport, preview, OffscreenCanvas worker, audio sync           |
| `@cadra/encode`     | WebCodecs capture, encode, and muxing                                 |
| `@cadra/headless`   | Deterministic headless render and orchestration                       |
| `@cadra/agent-sdk`  | Typed builder and text-to-scene interface                             |
| `@cadra/mcp-server` | MCP tools for authoring, rendering, and assets                        |
| `@cadra/providers`  | Generative video provider adapters                                    |
| `apps/studio`       | Visual editor                                                         |
| `apps/cli`          | Command line render                                                   |

This phase stands up an empty but production-grade monorepo skeleton for the
packages above. No framework logic has landed yet.

## Getting started

```bash
pnpm install
pnpm -w build
pnpm -w test
pnpm -w lint
pnpm -w typecheck
```

This repository is a pnpm workspace managed with Turborepo. Packages live
under `packages/*` and applications live under `apps/*`, as described in the
package map above.
