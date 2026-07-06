/**
 * Zod input schema for `update_scene`'s "patch" mode: one or more structural
 * edits (add a node, update a node's own fields, remove a node), addressed
 * by the stable scene-node `id`s a prior `get_scene`/`create_scene` call
 * already returned.
 *
 * Each operation maps directly onto one of `@cadra/core`'s tree-operations
 * primitives (`addNode`, `updateNode`, `removeNode`; see `./scene-patch.ts`
 * for the outer `Project`-level navigation that locates the right clip
 * before delegating to them), so the shape here is deliberately close to
 * those functions' own parameters rather than a generic JSON-patch dialect:
 * an agent that has just read a `SceneNode` back from `get_scene` can build
 * one of these operations by eye, without learning a separate patch
 * mini-language.
 */
import { sceneNodeSchema } from "@cadra/schema";
import { z } from "zod";

/**
 * Adds `node` as a new child of the existing node `parentId`. `node` is the
 * complete new node (including its own `id`, which must not already exist
 * anywhere in the scene; `update_scene` surfaces a clear diagnostic rather
 * than silently creating a duplicate id if it does).
 */
export const addNodeOperationSchema = z.strictObject({
  type: z.literal("addNode").describe("Add a new node as a child of an existing node."),
  parentId: z.string().describe("Id of the existing node to append the new node under."),
  node: sceneNodeSchema.describe("The complete new node to add, including its own unique id."),
});

/**
 * Updates the node `nodeId` by shallow-merging `fields` onto its existing
 * fields: any field named in `fields` replaces that field's current value
 * outright (this is not a deep merge; e.g. providing `transform` replaces
 * the whole `transform` object, not just one of its sub-fields), and every
 * field not named in `fields` is left exactly as it was.
 *
 * `fields` deliberately excludes `id`, `kind`, and `children`: `id` is how
 * this operation (and every other patch operation) addresses the node in the
 * first place, so it cannot be changed out from under itself; `kind`
 * determines which other fields are even legal on this node (changing a
 * `mesh` into a `light` node is a structural replacement, not an update, so
 * it is not supported by this operation); and `children` has its own
 * dedicated operations (`addNode`/`removeNode`) rather than being
 * wholesale-replaceable here, so a patch cannot accidentally drop an
 * unrelated subtree by omission.
 */
/** Field names `updateNodeOperationSchema.fields` rejects outright, each for its own reason; see the schema's own doc above. */
const FORBIDDEN_UPDATE_FIELD_NAMES = ["id", "kind", "children"] as const;

export const updateNodeOperationSchema = z.strictObject({
  type: z.literal("updateNode").describe("Update one or more of an existing node's own fields."),
  nodeId: z.string().describe("Id of the existing node to update."),
  fields: z
    .looseObject({})
    .refine(
      (fields) => FORBIDDEN_UPDATE_FIELD_NAMES.every((forbidden) => !(forbidden in fields)),
      {
        message:
          `'fields' must not include ${FORBIDDEN_UPDATE_FIELD_NAMES.map((name) => `'${name}'`).join(", ")}. ` +
          "Use a different patch operation for those (addNode/removeNode for children, a fresh " +
          "node for a kind change); 'id' cannot change since it is how this operation addresses " +
          "the node in the first place.",
      },
    )
    .describe(
      "Fields to shallow-merge onto the existing node (e.g. { name, transform, visible, " +
        "content, fontSize, color, ... } depending on the node's kind). Must not include " +
        "'id', 'kind', or 'children'; validated against the node's own kind after merging.",
    ),
});

/** Removes the node `nodeId` (and its entire subtree) from its parent. The scene's root clip node itself cannot be removed this way; see `SceneNodeNotFoundError` from `@cadra/core`. */
export const removeNodeOperationSchema = z.strictObject({
  type: z.literal("removeNode").describe("Remove an existing node (and its subtree) from its parent."),
  nodeId: z.string().describe("Id of the existing node to remove."),
});

/** One structural edit within an `update_scene` "patch" mode call. */
export const scenePatchOperationSchema = z.discriminatedUnion("type", [
  addNodeOperationSchema,
  updateNodeOperationSchema,
  removeNodeOperationSchema,
]);

/** One structural edit within an `update_scene` "patch" mode call; the validated shape of {@link scenePatchOperationSchema}. */
export type ScenePatchOperation = z.infer<typeof scenePatchOperationSchema>;
