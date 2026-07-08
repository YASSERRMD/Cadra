import { describe, expect, it } from "vitest";

import { generateCapabilityManifest } from "./capabilities.js";
import { CURRENT_SCHEMA_VERSION } from "./envelope.js";
import { sceneNodeKindSchema } from "./scene-node.js";

describe("generateCapabilityManifest", () => {
  it("carries the current schema version", () => {
    const manifest = generateCapabilityManifest();
    expect(manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("produces a JSON-serializable object", () => {
    const manifest = generateCapabilityManifest();
    expect(() => JSON.stringify(manifest)).not.toThrow();
  });

  it("lists exactly the scene node kinds sceneNodeKindSchema accepts", () => {
    const manifest = generateCapabilityManifest();
    const kinds = manifest.primitives.map((primitive) => primitive.kind);
    expect(kinds.sort()).toEqual([...sceneNodeKindSchema.options].sort());
  });

  it("gives every primitive a non-empty animatableProperties list including the shared transform", () => {
    const manifest = generateCapabilityManifest();
    for (const primitive of manifest.primitives) {
      expect(primitive.animatableProperties.length).toBeGreaterThan(0);
      expect(primitive.animatableProperties).toEqual(
        expect.arrayContaining(["transform.position", "transform.rotation", "transform.scale"]),
      );
    }
  });

  it("gives the camera primitive its lens and look-at properties", () => {
    const manifest = generateCapabilityManifest();
    const camera = manifest.primitives.find((primitive) => primitive.kind === "camera");
    expect(camera?.animatableProperties).toEqual(
      expect.arrayContaining(["target", "fov", "near", "far"]),
    );
  });

  it("gives the light primitive its color and intensity properties", () => {
    const manifest = generateCapabilityManifest();
    const light = manifest.primitives.find((primitive) => primitive.kind === "light");
    expect(light?.animatableProperties).toEqual(expect.arrayContaining(["color", "intensity"]));
  });

  it("gives the text primitive its color and fontSize properties", () => {
    const manifest = generateCapabilityManifest();
    const text = manifest.primitives.find((primitive) => primitive.kind === "text");
    expect(text?.animatableProperties).toEqual(expect.arrayContaining(["color", "fontSize"]));
  });

  it("lists all 17 easing names, exactly one of which ('hold') is non-continuous", () => {
    const manifest = generateCapabilityManifest();
    expect(manifest.easings).toHaveLength(17);

    const hold = manifest.easings.find((easing) => easing.name === "hold");
    expect(hold?.continuous).toBe(false);

    const nonContinuous = manifest.easings.filter((easing) => !easing.continuous);
    expect(nonContinuous).toEqual([{ name: "hold", continuous: false }]);
  });

  it("includes linear and every easeIn/Out/InOut curve by name", () => {
    const manifest = generateCapabilityManifest();
    const names = manifest.easings.map((easing) => easing.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "linear",
        "easeInCubic",
        "easeOutCubic",
        "easeInOutCubic",
        "easeInExpo",
        "easeOutExpo",
        "easeInOutExpo",
        "easeInBack",
        "easeOutBack",
        "easeInOutBack",
        "easeInElastic",
        "easeOutElastic",
        "easeInOutElastic",
        "easeInBounce",
        "easeOutBounce",
        "easeInOutBounce",
        "hold",
      ]),
    );
  });

  it("never populates codecs itself, leaving the field undefined for a higher-level consumer to merge in", () => {
    const manifest = generateCapabilityManifest();
    expect(manifest.codecs).toBeUndefined();
  });
});
