/**
 * Thrown when resolving a composition would recurse into itself via a chain
 * of `compositionRef` nodes (e.g. A embeds B, B embeds A). `chain` lists the
 * composition ids visited, in order, ending with the id that would have
 * closed the cycle, so the message can show the exact reference path rather
 * than just naming the repeated id.
 */
export class CompositionCycleError extends Error {
  constructor(public readonly chain: readonly string[]) {
    super(`Composition reference cycle detected: ${chain.join(" -> ")}`);
    this.name = "CompositionCycleError";
  }
}

/** Thrown when a `compositionRef` node names a composition id absent from the `Project`. */
export class CompositionNotFoundError extends Error {
  constructor(public readonly compositionId: string) {
    super(`No composition with id "${compositionId}" was found in the project.`);
    this.name = "CompositionNotFoundError";
  }
}
