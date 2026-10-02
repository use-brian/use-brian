#!/usr/bin/env python3
"""Hash source snapshot and explicitly supplied build artifacts; never invent binaries.
Example: python3 provenance.py --artifact windows=/trusted/build/Brian.NativeFixture.exe
Hashes establish identity, not a reproducible-build attestation or cohort acceptance.
"""
import argparse, hashlib, json, pathlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
NATIVE=ROOT/'apps/app-desktop/native/computer-control'
p=argparse.ArgumentParser();p.add_argument('--artifact',action='append',default=[],metavar='PLATFORM=PATH');a=p.parse_args()
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
source={platform:{'path':str(path.relative_to(ROOT)),'sha256':digest(path)} for platform,path in {
    'macos':NATIVE/'Fixture.swift','windows':NATIVE/'windows/Fixture/Program.cs','linux':NATIVE/'linux/fixture.py'}.items()}
artifacts=[]
for item in a.artifact:
    platform,path=item.split('=',1)
    if platform not in source: p.error('platform must be macos, windows, or linux')
    path=pathlib.Path(path).resolve(strict=True)
    artifacts.append(dict(platform=platform,path=str(path),sha256=digest(path),sourceSha256=source[platform]['sha256'],binding='operator-supplied build artifact; hash is not build attestation'))
print(json.dumps(dict(schema='brian.fixture.provenance.v1',appId='com.usebrian.NativeComputerFixture',
    tasksSha256=digest(pathlib.Path(__file__).with_name('tasks.v1.json')),sources=source,artifacts=artifacts,
    appSetAcceptance='pending independent review; all variants share one fixture cohort'),indent=2))
