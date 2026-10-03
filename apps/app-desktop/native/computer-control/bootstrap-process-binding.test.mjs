import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { vectors, sourceGuards, run } from './bootstrap-process-binding.test-harness.mjs';

test('new collector is unwired, fixed self/parent only, offline and non-authorizing', () => {
  sourceGuards();
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  // Parent may later compile/call data-only diagnostics. The dispatcher barrier,
  // not module presence in build.sh, is the enduring authority invariant.
  assert(helper.includes('dispatcher.response(request, clock: sourceClock)'));
  assert(helper.includes('let dispatcher = ObservationDispatcher { Broker(trust: trust) }'));
});
test('Mac v5 compiler regression: every validity check retains the public Swift offline option', () => {
  // Source regression, NOT a replacement for the operator's Mac SDK typecheck.
  const code = sourceGuards().replace(/\/\/[^\n]*/g, '');
  assert(!code.includes('kSecCSNoNetworkAccess'), 'C spelling is not a Swift global');
  assert(code.includes('var offlineStrict: SecCSFlags { SecCSFlags(rawValue: kSecCSStrictValidate).union(.noNetworkAccess) }'));
  assert(code.includes('let flags = offlineStrict.union(SecCSFlags(rawValue: own ? 0 : kSecCSCheckNestedCode))'));
  assert(code.includes('SecStaticCodeCheckValidity(code, offlineStrict.union(SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)), r)'));
  assert.equal((code.match(/SecCodeCheckValidity\(guest, offlineStrict, r\)/g) ?? []).length, 2);
  for (const selected of ['associated', 'selected']) assert(code.includes(`SecStaticCodeCheckValidity(${selected}, flags, r)`));
  assert(!code.includes('1 << 29'), 'No guessed raw-bit compatibility shim');
});

test('both captured framework checks use the independently bound approval, never a fabricated kernel hash', () => {
  const source = sourceGuards();
  assert(source.includes('ElectronFrameworkBinding.bind(capturedFramework: bytes.bytes, approval: approval)'));
  assert(source.includes('framework(parentInfo.selected, approval: approval)'));
  assert(source.includes('framework(finalParentInfo.selected, approval: approval)'));
  assert(source.includes('finalFrameworkArchitectures == frameworkArchitectures'));
  assert(source.indexOf('let approval = try BootstrapApproval.bind') < source.indexOf('framework(parentInfo.selected, approval: approval)'));
  const framework = source.slice(source.indexOf('func framework('), source.indexOf('func run()'));
  assert(!framework.includes('KernelExpectation'));
  assert(!framework.includes('mainCDHash:'));
  assert(source.includes('let loadedImageAuthentication = false'));
  assert(source.includes('let completeInventoryProvenance = false'));
});

test('every snapshot field is represented; clock, identity and mapped source are not injectable', () => {
  const source = sourceGuards();
  for (const field of ['raw.pid','raw.user','raw.unique_id','raw.parent_unique_id','raw.exec_idversion',
    'raw.signing_status','raw.slice_offset','raw.executable_uuid','raw.main_cdhash']) assert(source.includes(field), field);
  assert(source.includes('before == after'));
  assert(source.includes('5_000_000_000'));
  assert(source.includes('now >= start, now - start < Self.nanoseconds'));
  assert(source.includes('No parameter for an arbitrary PID'));
  assert(!source.includes('BRIAN_KERNEL_UNTRUSTED_DATA'));
  assert(!/static func collect\([^)]*(path|pid|clock|mapped|snapshot)/.test(source));
});
test('public Security API provenance is pinned; architecture is only read after all page hashes', () => {
  const source = sourceGuards();
  assert(source.includes('ef677c3d667a44e1737c1b0245e9ed04d11c51c1'));
  assert(source.includes('There is NO public kSecCodeInfoArchitecture result'));
  assert(source.includes('snapshot.offset <= Int64(Int32.max)'));
  assert(source.includes('kSecCodeInfoUnique as String] as? Data, hash.count == 20'));
  assert(source.includes('kSecCodeInfoDigestAlgorithm'));
  assert(source.includes('key.startIndex..<key.endIndex'));
  const cases = vectors();
  assert(cases.find(v => v.name === 'golden').expected.digest);
  assert.equal(cases.filter(v => v.name.startsWith('whole-key-') && v.expected.error).length, 5);
  assert(cases.find(v => v.name === 'architecture-only-not-library-acceptance').expected.architecture);
});
test('helper entitlement profile is closed and executable-page protection cannot be disabled', () => {
  const source = sourceGuards();
  assert(source.includes('"com.apple.security.cs.disable-executable-page-protection"'));
  assert(source.includes('if helper && !Set(dictionary.keys).isSubset(of: Set(forbidden))'));
  const assertions = readFileSync(new URL('./BootstrapProcessBindingPolicyTests.swift', import.meta.url), 'utf8');
  assert(assertions.includes('com.apple.private.skip-library-validation'));
  assert(assertions.includes('com.apple.security.cs.disable-executable-page-protection'));
});

test('portable results cannot be mistaken for Security execution or native type checking', () => {
  assert.deepEqual(run('--portable'), { vectors: 359, matches: 36, swiftRuns: 0, macOSSyntaxParsed: false, nativeSecurityTypechecked: false });
  assert.throws(() => run('--mock-security'));
  const runner = readFileSync(new URL('./bootstrap-process-binding.test-harness.mjs', import.meta.url), 'utf8');
  assert(runner.includes("for(const optimization of [[],['-O']])"));
  assert(runner.includes("'-frontend','-parse','-target','arm64-apple-macos14.0'"));
  assert(!/func SecCode|class ProcessTrust|struct ProcessIdentity/.test(runner));
});

test('every own/main/framework signer uses the fixed Developer ID Application requirement', () => {
  const source = sourceGuards(), code = source.replace(/\/\/[^\n]*/g,'');
  assert(source.includes('SecPolicyCreateAppleExternalDeveloperOptionalExpiry'));
  assert(code.includes('enum SignerRole: Equatable { case helper, parent, framework }'));
  assert(!code.includes('trust.teamRequirement('));
  assert.equal((code.match(/SecRequirementCreateWithString\(/g) ?? []).length, 1);
  assert(code.includes('requirement(own ? .helper : .parent)'));
  assert(code.includes('requirement(.framework)'));
  const builder = code.slice(code.indexOf('static func requirementText'), code.indexOf('static func entitlements'));
  assert(builder.includes('team.utf8.count == 10'));
  assert(builder.includes('(65...90).contains($0) || (48...57).contains($0)'));
  assert(builder.includes('certificate 1[field.1.2.840.113635.100.6.2.6] exists'));
  assert(builder.includes('certificate leaf[field.1.2.840.113635.100.6.1.13] exists'));
  assert(builder.includes('ai.usebrian.desktop'));
  assert(!/ or |identifier:|profile:|requirement:|catch/.test(builder));
});
test('parent DYLD environment entitlement is forbidden; architecture CD structural profiles agree', () => {
  const source = sourceGuards(), start = source.indexOf('let common ='), end = source.indexOf('let forbidden =', start);
  const entitlementSets = source.slice(start, end);
  assert(entitlementSets.slice(0, entitlementSets.indexOf('let electronExceptions')).includes('com.apple.security.cs.allow-dyld-environment-variables'));
  assert(!entitlementSets.slice(entitlementSets.indexOf('let electronExceptions')).includes('allow-dyld-environment-variables'));
  const cdfCases = vectors().filter(v => v.name.startsWith('cdf-profile-'));
  assert.equal(cdfCases.length, 31);
  assert(cdfCases.every(v => v.expected.error));
  assert(vectors().find(v => v.name === 'cdf-supported-flags-and-exec').expected.architecture);
});

test('selected XML/DER presence is used only after full special-slot verification and on final revalidation', () => {
  const source=sourceGuards();
  assert(source.includes('xmlEntitlementsPresent = slots.contains(5)'));
  assert(source.includes('derEntitlementsPresent = slots.contains(7)'));
  assert(source.includes('image.xmlEntitlementsPresent || image.derEntitlementsPresent'));
  assert(source.includes('guard value == nil, raw == nil'));
  assert(source.includes('guard value != nil'));
  assert(source.includes('for info in [metadata.associated, metadata.selected]'));
  assert(source.includes('try consistentMetadata(metadata.associated, metadata.selected)'));
  const cases=vectors();
  for (const helper of [true,false]) {
    for (const slots of ['5','7','5-7']) {
      assert(cases.find(v=>v.name===`entitlements-${helper}-${slots}-missing`).expected.error);
      assert(cases.find(v=>v.name===`entitlements-${helper}-${slots}-raw-unknown-type`).expected.error);
      assert(cases.find(v=>v.name===`entitlements-${helper}-${slots}-dictionary`).expected.entitlements);
    }
    assert(cases.find(v=>v.name===`entitlements-${helper}-absent-missing`).expected.entitlements);
    assert(cases.find(v=>v.name===`entitlements-${helper}-absent-dictionary`).expected.error);
  }
  assert(cases.find(v=>v.name==='entitlements-selected-only-4096').expected.entitlements);
  assert(cases.find(v=>v.name==='entitlements-selected-only-20480').expected.error);
  assert(cases.find(v=>v.name==='entitlements-hidden-DER-index').expected.error);
});
