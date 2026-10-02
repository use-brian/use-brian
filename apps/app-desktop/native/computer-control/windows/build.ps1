# Requires .NET 8 SDK. Produces adjacent, framework-dependent Windows x64 executables.
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    dotnet run --project BoundaryTests -c Release
    if ($LASTEXITCODE -ne 0) { throw 'Portable boundary tests failed' }
    foreach ($project in @('Helper/Brian.NativeHelper.csproj', 'Fixture/Brian.NativeFixture.csproj')) {
        dotnet publish $project -c Release -r win-x64 --self-contained false -p:UseAppHost=true -o out/win-x64
        if ($LASTEXITCODE -ne 0) { throw "Publish failed: $project" }
    }
    Write-Output "Helper: $PSScriptRoot/out/win-x64/Brian.NativeHelper.exe"
    Write-Output 'Windows native acceptance gates remain unverified by this build.'
} finally { Pop-Location }
