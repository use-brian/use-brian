import test from 'node:test';
import assert from 'node:assert/strict';
import { frameworkVectors } from './electron-framework-binding-vectors.mjs';
import { sourceGuards,runFrameworkTests } from './electron-framework-binding.test-harness.mjs';
test('framework verifier is all-slice artifact membership, never fabricated kernel or authority',()=>{sourceGuards();});
test('framework corpus covers binding, geometry, fuse/ASAR and all-architecture refusal',()=>{
  const cases=frameworkVectors();
  assert.equal(new Set(cases.map(v=>v.name)).size,cases.length);
  for(const name of ['fat-false','fat-true','readonly','eight-state-wire','js-data-const-16777228','inventory-64-membership-not-completeness']) assert(cases.find(v=>v.name===name)?.expected.match,name);
  for(const name of ['partial-inventory-true','only-second-approved-false','wire-divergence-true','digest-divergence-false','second-slice-page-true','inventory-duplicate','rebound-unused','rebound-asarVersion','rebound-fuseUnsigned','special-tamper-7','js-writable-16777228']) assert.equal(cases.find(v=>v.name===name)?.expected.match,false,name);
});
test('portable test is explicitly not Swift or native execution',()=>{
  const result=runFrameworkTests('--portable'); assert.equal(result.swiftRuns,0); assert.equal(result.nativeAcceptance,false); assert(result.vectors>100);
});
