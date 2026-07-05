import { CURRENT_SCHEMA_VERSION } from "./envelope.js";

/**
 * Migration hook stub.
 *
 * There is only one schema version so far, so there is nothing to migrate
 * yet. This module exists so a later phase can register a real migration
 * function per version bump (e.g. rewriting an old document shape into the
 * current one) without any caller of `migrateSceneDocument` needing to
 * change: the function signature and the registry-lookup structure are
 * already in place, only the registry's contents grow.
 *
 * A migration function receives the raw, not-yet-validated document body
 * (the part of the envelope after `schemaVersion` is known) for its
 * `fromVersion`, and must return a document body shaped for the next schema
 * version. `migrateSceneDocument` is responsible for chaining migrations
 * together until `CURRENT_SCHEMA_VERSION` is reached; individual migration
 * functions only need to know how to step forward exactly one version.
 */
export type SceneMigration = (document: unknown) => unknown;

/**
 * Registry of migrations, keyed by the version a migration steps *from*.
 * Empty until a second schema version exists and a migration is registered
 * for stepping from version 1 to version 2.
 */
const MIGRATIONS = new Map<number, SceneMigration>();

/**
 * Migrates `document` (the raw body of a scene envelope, before or after
 * `schemaVersion` validation) from `fromVersion` up to
 * `CURRENT_SCHEMA_VERSION`, applying every registered migration in between
 * in order.
 *
 * When `fromVersion` already equals `CURRENT_SCHEMA_VERSION`, `document` is
 * returned unchanged: this is the only path exercised today, since no other
 * schema version exists yet.
 *
 * @throws {Error} if `fromVersion` is newer than `CURRENT_SCHEMA_VERSION`, or
 *   if stepping forward from `fromVersion` would require a migration that is
 *   not yet registered.
 */
export function migrateSceneDocument(document: unknown, fromVersion: number): unknown {
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return document;
  }

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Cannot migrate a document from schema version ${fromVersion}: it is newer than the ` +
        `current supported version ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  let migrated = document;
  let version = fromVersion;
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS.get(version);
    if (migration === undefined) {
      throw new Error(
        `No migration registered to step a document from schema version ${version} to ` +
          `${version + 1}.`,
      );
    }
    migrated = migration(migrated);
    version += 1;
  }

  return migrated;
}
