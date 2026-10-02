/**
 * NON-AUTHORIZING, policy-only comparator for ONE OBSERVED envelope profile.
 * No I/O, logging, reserialization, generalized DER evaluation or authentication.
 * The production verifyLibraryConstraintPolicy() wrapper remains unsupported.
 *
 * Native evidence (read-only, user supplied; not independently authenticated):
 * fixtures/mac-library-constraint.arm64-macos26.v1.json, 183-byte generic blob;
 * macOS 26.6.2 / 25G83, arm64, SDK 26.5, Apple clang 21.0.0
 * (2100.1.1.101), Node 25.5.0. Ad-hoc, never executed, no kernel/CMS proof.
 * One sample does NOT establish compatibility across OS versions or enforcement.
 * Synthetic extensions/negative cases in tests are NOT additional native evidence.
 *
 * Independently grounded public Apple sources, read at these exact pins:
 * https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/EXTERNAL_HEADERS/CoreEntitlements/CoreEntitlementsPriv.h
 *   CCDER_ENTITLEMENTS = SEQUENCE | CONSTRUCTED | APPLICATION: wire tag 0x70.
 * https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/EXTERNAL_HEADERS/corecrypto/ccder.h
 * https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/EXTERNAL_HEADERS/corecrypto/ccasn1.h
 *   ASN.1 tag values/class bits: INTEGER 2, OCTET STRING 4, UTF8String 12,
 *   SEQUENCE 16, CONSTRUCTED 0x20, APPLICATION 0x40, CONTEXT_SPECIFIC 0x80.
 *   Thus 0xb0 is context-specific constructed tag 16; this alone does NOT
 *   establish its dictionary semantics. Dictionary use here is observed only.
 * https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/EXTERNAL_HEADERS/CoreEntitlements/Serialization.h
 *   Dictionaries contain ordered key/value tuples; primitives include integers,
 *   strings, arrays and data. This header is NOT a complete wire specification.
 * https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/EXTERNAL_HEADERS/CoreEntitlements/Entitlements.h
 * https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/EXTERNAL_HEADERS/CoreEntitlements/der_vm.h
 *   CEVersion enum/API results and dictionary_tag/sorted VM parameters do NOT
 *   independently map this wire INTEGER 1 or describe LWCR metadata meanings.
 * https://github.com/apple-oss-distributions/Security/blob/97c3a4296c1ea06b0fe1877a7e616aa84450b5b2/OSX/libsecurity_codesigning/lib/LWCRHelper.mm
 *   defaultDeveloperIDLWCR uses validation-category/team-identifier;
 *   defaultAdhocLWCR uses cdhash/$in. Actual deserialization is delegated to
 *   sec_LWCR withData:withError: (TLE), not implemented in this public source.
 * https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/osfmk/kern/cs_blobs.h
 *   Library slot 11, generic magic 0xfade8181, Developer ID category 6.
 * https://developer.apple.com/documentation/security/defining-launch-environment-and-library-constraints
 *   Top-level implicit AND; category 6 = Developer ID; team is a string;
 *   cdhash is binary data, $in is membership in a list of data values.
 *
 * LIMITATION: meanings of ccat=0, comp=1, vers=1 were NOT independently grounded
 * in these public sources. 'reqs' is observed to wrap the original plist facts;
 * its general semantics likewise remain unproven. Do not expand these names to
 * guessed category/compatibility/version semantics. We compare their EXACT
 * observed spelling/order/types/values, plus outer INTEGER 1; no other envelope.
 *
 * Supported shape (all lengths definite and shortest, no trailing bytes):
 * fade8181 + BE length of WHOLE blob;
 * 70(INTEGER 1, b0(
 *   SEQUENCE(UTF8 'ccat', INTEGER 0),
 *   SEQUENCE(UTF8 'comp', INTEGER 1),
 *   SEQUENCE(UTF8 'reqs', b0(
 *     SEQUENCE(UTF8 'cdhash', b0(SEQUENCE(UTF8 '$in', SEQUENCE(OCTET[20]...)))),
 *     SEQUENCE(UTF8 'team-identifier', UTF8 expectedTeam),
 *     SEQUENCE(UTF8 'validation-category', INTEGER 6))),
 *   SEQUENCE(UTF8 'vers', INTEGER 1))).
 * Key order is fixed to the observed ASCII order, NOT a generalized DER SET sort.
 * $in ARRAY order is immaterial to documented membership, not dictionary order.
 *
 * Caller must supply an INDEPENDENT trusted expected team/inventory, never derive
 * expectations from this blob. That provenance cannot be established by this API.
 * A match cannot authenticate slot -11, a CodeDirectory, kernel CDHash, actual
 * slice/exec generation, CMS/certificate/team, loaded code, or native enforcement.
 * No signer/bootstrap/helper admission integration. No claim of production trust.
 */

import { types } from 'node:util';

export const observedLibraryConstraintProfile = 'user-arm64-macos26-v1-envelope-only';
export const policyComparisonLimits = Object.freeze({ bytes: 4096, hashes: 64, depth: 9, nodes: 128 });
const fail = () => {
  const error = new Error('Library constraint policy comparison rejected: unsupported profile, malformed input, or inventory mismatch');
  error.code = 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_COMPARISON';
  throw error;
};
// Capture the native entry points used at the caller-data boundary. This assumes
// trusted intrinsics at module initialization; it is NOT a hostile-code sandbox.
// util.types brand checks reject proxies (even revoked) without running traps.
const { isProxy, isUint8Array, isSharedArrayBuffer } = types;
const { getPrototypeOf, getOwnPropertyDescriptor, getOwnPropertyDescriptors } = Object;
const { apply, ownKeys } = Reflect;
const isArray = Array.isArray, isBuffer = Buffer.isBuffer, allocateBuffer = Buffer.alloc;
const bufferPrototype = Buffer.prototype, objectPrototype = Object.prototype;
const typedArrayPrototype = getPrototypeOf(Uint8Array.prototype);
const nativeBuffer = getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const nativeLength = getOwnPropertyDescriptor(typedArrayPrototype, 'length').get;
const nativeSet = typedArrayPrototype.set;
function copyOrdinaryBuffer(value, minimum, maximum) {
  // Require a real native byte view AND ordinary Buffer prototype. Buffer's
  // prototype-based brand alone would also accept a spoofed Uint16Array/object.
  // Reject custom/proxy prototype chains before isBuffer can traverse them.
  if (isProxy(value) || !isUint8Array(value) || getPrototypeOf(value) !== bufferPrototype || !isBuffer(value)) fail();
  const backing = apply(nativeBuffer, value, []), length = apply(nativeLength, value, []);
  if (isSharedArrayBuffer(backing) || length < minimum || length > maximum) fail();
  const copy = allocateBuffer(length);
  // TypedArray#set's native typed-array source path uses internal slots, not
  // caller .buffer/.length/valueOf/iterator/index getters. No Buffer.from(input)
  // or array-like copying, and allocation is bounded by the intrinsic length.
  apply(nativeSet, copy, [value]);
  return copy;
}
function expectations(value) {
  if (!value || isProxy(value)) fail();
  const prototype = getPrototypeOf(value);
  if (prototype !== objectPrototype && prototype !== null) fail();
  const keys = ownKeys(value);
  if (keys.length !== 2 || !keys.includes('teamIdentifier') || !keys.includes('cdHashes')) fail();
  const descriptors = getOwnPropertyDescriptors(value);
  if (keys.some(k => !Object.hasOwn(descriptors[k], 'value'))) fail();
  const team = descriptors.teamIdentifier.value, list = descriptors.cdHashes.value;
  if (typeof team !== 'string' || !/^[A-Z0-9]{10}$/.test(team) || isProxy(list) || !isArray(list)) fail();
  // Real arrays have a nonconfigurable own data length; inspect descriptors only.
  const length = getOwnPropertyDescriptor(list, 'length').value;
  if (length < 1 || length > policyComparisonLimits.hashes || ownKeys(list).length !== length + 1) fail();
  const hashes = new Set();
  for (let i = 0; i < length; i++) {
    const item = getOwnPropertyDescriptor(list, String(i));
    if (!item || !Object.hasOwn(item, 'value')) fail();
    // Detach expectations; no returned references or mutable internal aliases.
    const hex = copyOrdinaryBuffer(item.value, 20, 20).toString('hex');
    if (hashes.has(hex)) fail();
    hashes.add(hex);
  }
  return { team: Buffer.from(team, 'ascii'), hashes };
}

/**
 * compareObservedLibraryConstraintPolicy(rawGenericBlob, {teamIdentifier, cdHashes})
 * requires Buffer bytes, a 10-character uppercase ASCII alphanumeric team, and
 * a dense array of 1..64 unique Buffer(20) expected CDHashes. Shared buffers
 * (including cross-realm backing stores), proxies and accessor expectation fields
 * reject. Buffers must have the ordinary Buffer prototype and native Uint8Array
 * brand. Own Buffer property hooks are ignored, never evaluated; native backing
 * and length govern the bounded copy. No caller-provided coercion is performed.
 * Returns frozen, data-only MATCH evidence WITHOUT hashes/team/input references.
 * Throws one value-free scoped error on mismatch, malformed or unsupported data.
 * Neither arbitrary raw bytes nor metadata accompanying them convey authority.
 */
export function compareObservedLibraryConstraintPolicy(rawGenericBlob, expected) {
  try {
    return compareData(rawGenericBlob, expected);
  } catch {
    // Includes unexpected synchronous native/reflection/validation errors. Never
    // propagate a caller's error text, cause, stack or raw hash through this API.
    fail();
  }
}
function compareData(rawGenericBlob, expected) {
  const inventory = expectations(expected);
  const b = copyOrdinaryBuffer(rawGenericBlob, 8, policyComparisonLimits.bytes);
  if (b.readUInt32BE(0) !== 0xfade8181 || b.readUInt32BE(4) !== b.length) fail();
  let nodes = 0;
  // Fixed-schema parser, not recursive arbitrary ASN.1. Every nested view is
  // bounded by its parent. Budgets remain explicit even for this fixed depth.
  function take(parent, tag) {
    if (++nodes > policyComparisonLimits.nodes || parent.depth + 1 > policyComparisonLimits.depth || parent.end - parent.at < 2) fail();
    if (b[parent.at++] !== tag) fail(); // Includes high-tag-number/unknown tags.
    let length = b[parent.at++];
    if (length & 0x80) {
      const count = length & 0x7f;
      if (count < 1 || count > 2 || parent.end - parent.at < count || b[parent.at] === 0) fail();
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + b[parent.at++];
      if (length < 128 || (count === 2 && length < 256)) fail();
    }
    if (length > parent.end - parent.at) fail();
    const result = { at: parent.at, end: parent.at + length, depth: parent.depth + 1 };
    parent.at += length;
    return result;
  }
  function end(view) { if (view.at !== view.end) fail(); }
  function primitive(parent, tag) {
    const view = take(parent, tag);
    return b.subarray(view.at, view.end);
  }
  function integer(parent, value) {
    const bytes = primitive(parent, 0x02);
    // Only nonnegative single-octet 0/1/6 in this profile: rejects empty,
    // redundant sign octets, negative integers, BOOLEANs and alternate values.
    if (bytes.length !== 1 || bytes[0] !== value) fail();
  }
  function pair(parent, key) {
    const view = take(parent, 0x30);
    // Known keys and team are ASCII, a strict subset of UTF-8. Byte equality
    // rejects invalid/overlong UTF-8, NULs, BOMs and Unicode lookalikes outright;
    // no replacement-character decoding or normalization can occur.
    if (!primitive(view, 0x0c).equals(Buffer.from(key, 'ascii'))) fail();
    return view;
  }
  function integerPair(parent, key, value) {
    const view = pair(parent, key); integer(view, value); end(view);
  }
  const input = { at: 8, end: b.length, depth: 0 };
  const root = take(input, 0x70); end(input);
  integer(root, 1);
  const envelope = take(root, 0xb0); end(root);
  integerPair(envelope, 'ccat', 0);
  integerPair(envelope, 'comp', 1);
  const reqsPair = pair(envelope, 'reqs'), reqs = take(reqsPair, 0xb0); end(reqsPair);
  const hashPair = pair(reqs, 'cdhash'), hashDict = take(hashPair, 0xb0); end(hashPair);
  const inPair = pair(hashDict, '$in'), list = take(inPair, 0x30); end(inPair); end(hashDict);
  const actual = new Set();
  while (list.at < list.end) {
    if (actual.size >= policyComparisonLimits.hashes) fail();
    const item = primitive(list, 0x04);
    if (item.length !== 20) fail();
    const hex = item.toString('hex');
    if (actual.has(hex) || !inventory.hashes.has(hex)) fail();
    actual.add(hex);
  }
  if (actual.size === 0 || actual.size !== inventory.hashes.size) fail();
  const teamPair = pair(reqs, 'team-identifier');
  if (!primitive(teamPair, 0x0c).equals(inventory.team)) fail();
  end(teamPair);
  integerPair(reqs, 'validation-category', 6); end(reqs);
  integerPair(envelope, 'vers', 1); end(envelope);
  return Object.freeze({ kind: 'observed-policy-comparison', profile: observedLibraryConstraintProfile,
    policyMatchesSuppliedInventory: true, matchedHashCount: actual.size,
    productionAuthority: false, slotAuthentication: false, kernelAuthentication: false,
    cmsAuthentication: false, loadedImageAuthentication: false, nativeEnforcement: false });
}
