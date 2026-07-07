import type { LayerElement, LayerElementType, LayerStyle } from "@cadra/core";
import { z } from "zod";

/**
 * Zod mirror of `LayerElement`/`LayerStyle` in `@cadra/core`'s
 * `scene-graph/layer-element.ts`: a curated, typed subset of HTML/CSS
 * restricted to exactly what Satori itself implements. Validating this here
 * (rather than trusting an agent-authored `layer` tree to already be
 * well-formed) is Phase 48's own "validate the layer spec in the schema
 * with clear diagnostics" requirement: an unsupported element type, or a
 * style value outside a property's own real CSS grammar (e.g. `display`
 * being anything other than `"flex"`/`"none"`), is rejected with a
 * `path`-addressed diagnostic at parse time, the same as every other
 * scene node kind's own fields.
 *
 * A `number | string` CSS value (e.g. `width`, `padding`) is modeled as
 * `z.union([z.number(), z.string()])` throughout: Satori accepts a bare
 * number as an implicit pixel value or a CSS length/percentage string
 * (`"50%"`, `"1rem"`), and this schema does not further constrain the
 * string form's own grammar (parsing arbitrary CSS length syntax is
 * Satori's own job at render time, not this schema's).
 */

/** A compile-time-only equality check between two types, with no runtime cost. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `T` to be exactly the literal type `true`, or the file fails to typecheck. */
type AssertTrue<T extends true> = T;

const cssLength = z.union([z.number(), z.string()]);

/** The three element kinds `LayerElement` supports, mirroring `LayerElementType`. */
export const layerElementTypeSchema = z
  .enum(["div", "span", "img"])
  .describe("Which of the three supported element kinds this layer element is.");

type _CheckLayerElementType = AssertTrue<
  AssertEqual<z.infer<typeof layerElementTypeSchema>, LayerElementType>
>;

/** A curated, typed subset of CSS, mirroring `LayerStyle`. */
export const layerStyleSchema = z
  .strictObject({
    display: z.enum(["flex", "none"]).optional(),
    position: z.enum(["relative", "absolute", "static"]).optional(),
    top: cssLength.optional(),
    right: cssLength.optional(),
    bottom: cssLength.optional(),
    left: cssLength.optional(),

    width: cssLength.optional(),
    height: cssLength.optional(),
    minWidth: cssLength.optional(),
    minHeight: cssLength.optional(),
    maxWidth: cssLength.optional(),
    maxHeight: cssLength.optional(),

    margin: cssLength.optional(),
    marginTop: cssLength.optional(),
    marginRight: cssLength.optional(),
    marginBottom: cssLength.optional(),
    marginLeft: cssLength.optional(),
    padding: cssLength.optional(),
    paddingTop: cssLength.optional(),
    paddingRight: cssLength.optional(),
    paddingBottom: cssLength.optional(),
    paddingLeft: cssLength.optional(),

    flexDirection: z.enum(["row", "row-reverse", "column", "column-reverse"]).optional(),
    flexWrap: z.enum(["wrap", "nowrap", "wrap-reverse"]).optional(),
    flexGrow: z.number().optional(),
    flexShrink: z.number().optional(),
    flexBasis: cssLength.optional(),
    alignItems: z.enum(["stretch", "center", "flex-start", "flex-end", "baseline", "normal"]).optional(),
    alignContent: z.string().optional(),
    alignSelf: z.string().optional(),
    justifyContent: z
      .enum(["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"])
      .optional(),
    gap: cssLength.optional(),
    rowGap: cssLength.optional(),
    columnGap: cssLength.optional(),

    color: z.string().optional(),
    fontFamily: z.string().optional(),
    fontSize: cssLength.optional(),
    fontWeight: z.number().optional(),
    fontStyle: z.enum(["normal", "italic"]).optional(),
    lineHeight: cssLength.optional(),
    letterSpacing: cssLength.optional(),
    textAlign: z.enum(["start", "end", "left", "right", "center", "justify"]).optional(),
    textTransform: z.enum(["none", "lowercase", "uppercase", "capitalize"]).optional(),
    textOverflow: z.enum(["clip", "ellipsis"]).optional(),
    textDecoration: z.string().optional(),
    whiteSpace: z.enum(["normal", "pre", "pre-wrap", "pre-line", "nowrap"]).optional(),
    wordBreak: z.enum(["normal", "break-all", "break-word", "keep-all"]).optional(),
    textShadow: z.string().optional(),

    backgroundColor: z.string().optional(),
    backgroundImage: z.string().optional(),
    backgroundPosition: z.string().optional(),
    backgroundSize: z.string().optional(),
    backgroundRepeat: z.enum(["repeat", "repeat-x", "repeat-y", "no-repeat"]).optional(),

    border: z.string().optional(),
    borderWidth: cssLength.optional(),
    borderColor: z.string().optional(),
    borderStyle: z.enum(["solid", "dashed"]).optional(),
    borderRadius: cssLength.optional(),
    borderTopLeftRadius: cssLength.optional(),
    borderTopRightRadius: cssLength.optional(),
    borderBottomLeftRadius: cssLength.optional(),
    borderBottomRightRadius: cssLength.optional(),

    boxShadow: z.string().optional(),
    opacity: z.number().optional(),
    overflow: z.enum(["visible", "hidden"]).optional(),

    transform: z.string().optional(),
    transformOrigin: z.string().optional(),

    objectFit: z.enum(["fill", "contain", "cover", "none", "scale-down"]).optional(),
    objectPosition: z.string().optional(),
  })
  .describe("A curated, typed subset of CSS restricted to exactly what Satori itself implements.");

type _CheckLayerStyle = AssertTrue<AssertEqual<z.infer<typeof layerStyleSchema>, LayerStyle>>;

/**
 * One node in a layer's element tree, mirroring `LayerElement`. Genuinely
 * self-recursive (an element's own `children` can contain more elements of
 * this same schema), unlike every other recursive `children` field in
 * `scene-node.ts` (each of those only forward-references the *outer*
 * `sceneNodeSchema` discriminated union, defined later, never itself) - so
 * this needs `z.lazy` plus an explicit `z.ZodType<LayerElement>` annotation
 * (Zod's own documented pattern for a schema that references its own
 * name), rather than that file's `get children()` getter trick, which only
 * breaks a *forward* reference, not true self-reference.
 */
export const layerElementSchema: z.ZodType<LayerElement> = z.lazy(() =>
  z.strictObject({
    id: z
      .string()
      .optional()
      .describe(
        "Optional stable identifier, unique within one layer tree. A lookup key for a SatoriNode's " +
          "own elementAnimations, not read by Satori itself at all.",
      ),
    type: layerElementTypeSchema,
    style: layerStyleSchema.optional(),
    children: z
      .array(z.union([layerElementSchema, z.string()]))
      .readonly()
      .optional()
      .describe(
        "Text content and/or nested elements, in document order. Satori paints later siblings " +
          "on top of earlier ones; there is no z-index in SVG.",
      ),
    src: z
      .string()
      .optional()
      .describe("img only: the image source, a data: URI (recommended) or an http(s):// URL."),
    width: z.number().optional().describe("img only, in layer units."),
    height: z.number().optional().describe("img only, in layer units."),
    lang: z
      .string()
      .optional()
      .describe("BCP-47-ish language tag forcing which locale-specific font/shaping Satori uses."),
  }),
);

type _CheckLayerElement = AssertTrue<AssertEqual<z.infer<typeof layerElementSchema>, LayerElement>>;
