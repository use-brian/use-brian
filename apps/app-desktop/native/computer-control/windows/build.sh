#!/usr/bin/env bash
# On Linux without dotnet: nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#dotnet-sdk_8 --command bash ./build.sh
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
dotnet run --project BoundaryTests -c Release
for project in Helper/Brian.NativeHelper.csproj Fixture/Brian.NativeFixture.csproj; do
  dotnet publish "$project" -c Release -r win-x64 --self-contained false -p:UseAppHost=true -o out/win-x64
done
printf '%s\n' 'Launch binary: out/win-x64/Brian.NativeHelper.exe' 'Cross-compilation does NOT pass Windows native acceptance gates.'
