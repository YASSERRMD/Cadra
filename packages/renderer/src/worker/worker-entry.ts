import { installWorkerHostMessageListener } from "./worker-host.js";

/**
 * Real entry point for the worker `createWorkerRenderer`'s default
 * `createWorker` constructs (`new Worker(new URL("./worker-entry.js", ...))`,
 * see `worker-renderer.ts`). Wires a real `WorkerHost` up to this worker's
 * global `onmessage`, driving a real `Renderer` (via `createRenderer`)
 * against the `OffscreenCanvas` the main thread transfers in on `init`.
 *
 * Not imported by anything else in this package: a bundler resolves it only
 * through the `new URL(...)` reference above, as the source of a separate
 * worker chunk. Not exercised by this package's tests either, for the same
 * reason `installWorkerHostMessageListener` itself is not: there is no real
 * worker global scope to run it in inside this Node/Vitest environment.
 */
installWorkerHostMessageListener();
