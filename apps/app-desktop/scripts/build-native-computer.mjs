import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../native/computer-control/', import.meta.url))
export const linuxRuntimeFiles = ['contract.py', 'x11.py', 'xinput.py', 'safety.py', 'atspi_backend.py', 'helper.py', 'fixture.py']
/** Build-time commands only. No runtime, renderer or model-supplied executables. */
export function buildCommands(platform) {
  if (platform === 'darwin') return [
    ['bash', ['build.sh'], root],
    // Build-host-only read-only verifier; never bundled or given desktop authority.
    ['xcrun', ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations',
      '-mmacosx-version-min=14.0', 'BootstrapInventoryVerifier.c', '-framework', 'Security', '-framework', 'CoreFoundation',
      '-o', 'build/brian-bootstrap-inventory-verifier'], root],
  ]
  if (platform === 'win32') return [
    ['dotnet', ['run', '--project', 'BoundaryTests', '-c', 'Release'], resolve(root, 'windows')],
    ...['Helper/Brian.NativeHelper.csproj', 'Fixture/Brian.NativeFixture.csproj'].map(project =>
      ['dotnet', ['publish', project, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'false', '-p:UseAppHost=true', '-o', 'out/win-x64'], resolve(root, 'windows')]),
  ]
  if (platform === 'linux') return [
    ['python3', ['-Es', '-m', 'py_compile', ...linuxRuntimeFiles], resolve(root, 'linux')],
    ['python3', ['-Es', '-m', 'unittest', 'discover', '-s', 'tests', '-v'], resolve(root, 'linux')],
  ]
  throw new Error('Unsupported native helper build target')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = process.argv[2] ?? process.platform
  const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }
  // Package signing owns the final helper after approved anchor stamping. Keep
  // standalone build.sh's optional signing out of the packaging build path.
  if (platform === 'darwin') delete env.CODESIGN_IDENTITY
  for (const [command, args, cwd] of buildCommands(platform)) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false, env })
    if (result.error || result.status !== 0) { console.error('Native helper build failed'); process.exit(1) }
  }
  console.log('Native helper built. Signing, native-session and model acceptance gates remain separate.')
}
