import type { Composition, Project } from "./timeline.js";

/** Input to `createProject`. `compositions` defaults to an empty array. */
export interface CreateProjectInput {
  id: string;
  name: string;
  compositions?: Composition[];
}

/**
 * Constructs a new `Project`. This is a plain data constructor: it does not
 * generate an id for you (pass one, e.g. from `createIdGenerator`) and it
 * does not mutate `input` or the `compositions` array passed in.
 */
export function createProject(input: CreateProjectInput): Project {
  return {
    id: input.id,
    name: input.name,
    compositions: input.compositions ? [...input.compositions] : [],
  };
}
