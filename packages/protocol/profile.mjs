// SPDX-License-Identifier: Apache-2.0

/**
 * A collection profile is data, not a protocol default.
 * The caller supplies the name, root, and reserve quotas.
 */

export function parseCollectionProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("collection profile must be an object");
  const profile = value;
  if (typeof profile.name !== "string" || profile.name.length === 0) throw new Error("collection profile needs a name");
  if (typeof profile.namePrefix !== "string") throw new Error("collection profile needs a namePrefix");
  if (!Number.isInteger(profile.supply) || profile.supply < 1) throw new Error("collection profile supply must be a positive integer");
  if (!Number.isInteger(profile.first) || profile.first < 0) throw new Error("collection profile first must be a non-negative integer");
  if (typeof profile.schema !== "string" || profile.schema.length === 0) throw new Error("collection profile needs a schema");
  if (typeof profile.itemType !== "string" || profile.itemType.length === 0) throw new Error("collection profile needs an itemType");
  if (typeof profile.root !== "string" || !/^[0-9a-f]{64}$/.test(profile.root)) throw new Error("collection profile root must be 64 hex characters");
  if (!Number.isInteger(profile.reserveExtra) || profile.reserveExtra < 0) throw new Error("collection profile reserveExtra must be a non-negative integer");
  if (!Array.isArray(profile.reserveGroups) || profile.reserveGroups.length === 0) throw new Error("collection profile needs reserveGroups");
  const reserveGroups = profile.reserveGroups.map((group) => {
    if (!group || typeof group.trait_type !== "string" || typeof group.value !== "string" || !Number.isInteger(group.count) || group.count < 1) {
      throw new Error("each reserve group needs trait_type, value, and a positive count");
    }
    return { trait_type: group.trait_type, value: group.value, count: group.count };
  });
  const reserveCount = reserveGroups.reduce((sum, group) => sum + group.count, 0) + profile.reserveExtra;
  if (reserveCount > profile.supply) throw new Error("collection profile reserve is larger than the supply");
  return {
    name: profile.name,
    namePrefix: profile.namePrefix,
    supply: profile.supply,
    first: profile.first,
    schema: profile.schema,
    itemType: profile.itemType,
    root: profile.root,
    reserveGroups,
    reserveExtra: profile.reserveExtra,
    reserveCount,
    saleCount: profile.supply - reserveCount,
  };
}
