<#
.SYNOPSIS
  Idempotent backup, read-only check/dry-run, build/deploy apply, and SHA-256-verified
  revert/rollback workflow for Antigravity Orchestrator / Executor custom model picker support.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/orchestrator-custom-models.ps1 --check
  powershell -ExecutionPolicy Bypass -File scripts/orchestrator-custom-models.ps1 --dry-run
  powershell -ExecutionPolicy Bypass -File scripts/orchestrator-custom-models.ps1 -Backup -Apply
  powershell -ExecutionPolicy Bypass -File scripts/orchestrator-custom-models.ps1 --revert
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$Backup,
  [switch]$Apply,
  [switch]$Check,
  [switch]$DryRun,
  [Alias('Revert')][switch]$Rollback,
  [string]$BackupDir = '',
  [string]$BackupRoot = 'D:\APP\antigravity-add-model-backups',
  [string]$ResourcesDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\antigravity\resources' } else { '' }),
  [string]$RepoDir = '',
  [string]$UserProfileDir = $(if ($env:USERPROFILE) { $env:USERPROFILE } else { '' }),
  [switch]$PatchLanguageServer,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$ExtraArgs = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

for ($i = 0; $i -lt $ExtraArgs.Count; $i++) {
  $arg = $ExtraArgs[$i]
  switch -Exact ($arg.ToLowerInvariant()) {
    '--backup' { $Backup = $true }
    '--apply' { $Apply = $true }
    '--check' { $Check = $true }
    '--dry-run' { $DryRun = $true }
    '--dryrun' { $DryRun = $true }
    '--revert' { $Rollback = $true }
    '--rollback' { $Rollback = $true }
    '--patch-language-server' { $PatchLanguageServer = $true }
    '--resources' {
      if ($i + 1 -ge $ExtraArgs.Count) { throw 'Missing value for --resources' }
      $i++
      $ResourcesDir = $ExtraArgs[$i]
    }
    '--backup-dir' {
      if ($i + 1 -ge $ExtraArgs.Count) { throw 'Missing value for --backup-dir' }
      $i++
      $BackupDir = $ExtraArgs[$i]
    }
    '--backup-root' {
      if ($i + 1 -ge $ExtraArgs.Count) { throw 'Missing value for --backup-root' }
      $i++
      $BackupRoot = $ExtraArgs[$i]
    }
    '--repo-dir' {
      if ($i + 1 -ge $ExtraArgs.Count) { throw 'Missing value for --repo-dir' }
      $i++
      $RepoDir = $ExtraArgs[$i]
    }
    '--user-profile-dir' {
      if ($i + 1 -ge $ExtraArgs.Count) { throw 'Missing value for --user-profile-dir' }
      $i++
      $UserProfileDir = $ExtraArgs[$i]
    }
    default {
      throw "Unknown argument: $arg. Supported flags: -Backup/--backup, -Apply/--apply, -Check/--check, -DryRun/--dry-run, -Revert/-Rollback/--revert/--rollback."
    }
  }
}

if (-not ($Backup -or $Apply -or $Check -or $DryRun -or $Rollback)) {
  throw 'Specify at least one action: -Backup (--backup), -Apply (--apply), -Check (--check), -DryRun (--dry-run), or -Revert/-Rollback (--revert).'
}
if ($Rollback -and ($Backup -or $Apply -or $Check -or $DryRun)) {
  throw '-Revert/-Rollback cannot be combined with -Backup, -Apply, -Check, or -DryRun.'
}
if ($DryRun -and $Apply) {
  $Check = $true
  $Apply = $false
}
if ([string]::IsNullOrWhiteSpace($ResourcesDir)) {
  throw 'ResourcesDir could not be resolved; pass -ResourcesDir explicitly.'
}

$RepoRoot = if ([string]::IsNullOrWhiteSpace($RepoDir)) {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
} else {
  [System.IO.Path]::GetFullPath($RepoDir)
}
$ResolvedResourcesDir = [System.IO.Path]::GetFullPath($ResourcesDir)
$ResolvedBackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
$ResolvedUserProfileDir = if (-not [string]::IsNullOrWhiteSpace($UserProfileDir)) {
  [System.IO.Path]::GetFullPath($UserProfileDir)
} else {
  ''
}

function Get-Sha256Lower {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralPath).Hash.ToLowerInvariant()
}

function Get-AntigravityRunningProcesses {
  param([Parameter(Mandatory = $true)][string]$TargetResourcesDir)

  $installRoot = [System.IO.Path]::GetDirectoryName($TargetResourcesDir)
  $installPrefix = if ($installRoot) {
    $installRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  } else {
    ''
  }
  $defaultResourcesDir = if ($env:LOCALAPPDATA) {
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\antigravity\resources'))
  } else {
    ''
  }
  $isDefaultTarget = $defaultResourcesDir -and $TargetResourcesDir.Equals($defaultResourcesDir, [System.StringComparison]::OrdinalIgnoreCase)

  $hits = @()
  foreach ($proc in (Get-Process -ErrorAction SilentlyContinue)) {
    $matched = $false
    if ($proc.Path) {
      if ($installPrefix -and $proc.Path.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $matched = $true
      }
    } elseif ($isDefaultTarget -and ($proc.ProcessName -match '^(Antigravity|language_server)')) {
      $matched = $true
    }
    if ($matched) {
      $hits += "$($proc.ProcessName) (PID $($proc.Id))"
    }
  }
  return $hits
}

function Assert-AntigravityNotRunning {
  param([Parameter(Mandatory = $true)][string]$TargetResourcesDir)

  $running = @(Get-AntigravityRunningProcesses -TargetResourcesDir $TargetResourcesDir)
  if ($running.Count -gt 0) {
    throw "Antigravity is currently running ($($running -join ', ')). Close Antigravity and stop all language_server processes before modifying $TargetResourcesDir."
  }
}

function New-UniqueBackupDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [string]$ExplicitDir = ''
  )

  if (-not [string]::IsNullOrWhiteSpace($ExplicitDir)) {
    $candidate = [System.IO.Path]::GetFullPath($ExplicitDir)
    if (Test-Path -LiteralPath $candidate) {
      $existingItems = @(Get-ChildItem -LiteralPath $candidate -Force -ErrorAction SilentlyContinue)
      if ($existingItems.Count -gt 0) {
        throw "BackupDir already exists and is non-empty: $candidate"
      }
    } else {
      New-Item -ItemType Directory -Path $candidate -Force | Out-Null
    }
    return $candidate
  }

  if (-not (Test-Path -LiteralPath $RootDir)) {
    New-Item -ItemType Directory -Path $RootDir -Force | Out-Null
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $base = Join-Path $RootDir "orchestrator-$stamp"
  $candidate = $base
  $suffix = 1
  while (Test-Path -LiteralPath $candidate) {
    $candidate = "$base-$suffix"
    $suffix++
  }
  New-Item -ItemType Directory -Path $candidate -Force | Out-Null
  return $candidate
}

function Get-BackupTargets {
  param([Parameter(Mandatory = $true)][string]$TargetResourcesDir)

  $targets = [System.Collections.Generic.List[hashtable]]::new()
  $targets.Add(@{ Rel = 'repo\src\customPreload.ts'; Src = (Join-Path $RepoRoot 'src\customPreload.ts'); Required = $true })
  $targets.Add(@{ Rel = 'repo\src\modelActions.ts'; Src = (Join-Path $RepoRoot 'src\modelActions.ts'); Required = $true })
  $targets.Add(@{ Rel = 'repo\src\modelStore.ts'; Src = (Join-Path $RepoRoot 'src\modelStore.ts'); Required = $true })
  $targets.Add(@{ Rel = 'repo\src\proxy.ts'; Src = (Join-Path $RepoRoot 'src\proxy.ts'); Required = $true })
  $targets.Add(@{ Rel = 'repo\src\proxy\modelCatalog.ts'; Src = (Join-Path $RepoRoot 'src\proxy\modelCatalog.ts'); Required = $true })
  $targets.Add(@{ Rel = 'repo\src\proxy\subagentRouting.ts'; Src = (Join-Path $RepoRoot 'src\proxy\subagentRouting.ts'); Required = $true })
  $targets.Add(@{ Rel = 'repo\src\proxy\customRequest.ts'; Src = (Join-Path $RepoRoot 'src\proxy\customRequest.ts'); Required = $true })
  $targets.Add(@{ Rel = 'repo\src\__tests__\preload-compatibility.test.ts'; Src = (Join-Path $RepoRoot 'src\__tests__\preload-compatibility.test.ts'); Required = $true })
  $targets.Add(@{ Rel = 'repo\scripts\orchestrator-custom-models.ps1'; Src = (Join-Path $RepoRoot 'scripts\orchestrator-custom-models.ps1'); Required = $false })
  $targets.Add(@{ Rel = 'repo\dist\customPreload.js'; Src = (Join-Path $RepoRoot 'dist\customPreload.js'); Required = $false })
  $targets.Add(@{ Rel = 'repo\dist\customPreload.js.map'; Src = (Join-Path $RepoRoot 'dist\customPreload.js.map'); Required = $false })
  $targets.Add(@{ Rel = 'repo\dist\customPreload.d.ts'; Src = (Join-Path $RepoRoot 'dist\customPreload.d.ts'); Required = $false })
  $targets.Add(@{ Rel = 'repo\package.json'; Src = (Join-Path $RepoRoot 'package.json'); Required = $true })
  $targets.Add(@{ Rel = 'repo\CHANGELOG.md'; Src = (Join-Path $RepoRoot 'CHANGELOG.md'); Required = $true })
  if (-not [string]::IsNullOrWhiteSpace($ResolvedUserProfileDir)) {
    $targets.Add(@{ Rel = 'user\.gemini\antigravity\custom_models.json'; Src = (Join-Path $ResolvedUserProfileDir '.gemini\antigravity\custom_models.json'); Required = $false })
    $targets.Add(@{ Rel = 'user\.gemini\antigravity\custom_model_identities.json'; Src = (Join-Path $ResolvedUserProfileDir '.gemini\antigravity\custom_model_identities.json'); Required = $false })
    $targets.Add(@{ Rel = 'user\.gemini\config\config.json'; Src = (Join-Path $ResolvedUserProfileDir '.gemini\config\config.json'); Required = $false })
  }
  $targets.Add(@{ Rel = 'local\Programs\antigravity\resources\app.asar'; Src = (Join-Path $TargetResourcesDir 'app.asar'); Required = $true })
  $targets.Add(@{ Rel = 'local\Programs\antigravity\resources\.antigravity-model-patch\state.json'; Src = (Join-Path $TargetResourcesDir '.antigravity-model-patch\state.json'); Required = $false })
  $targets.Add(@{ Rel = 'local\Programs\antigravity\resources\bin\language_server.exe'; Src = (Join-Path $TargetResourcesDir 'bin\language_server.exe'); Required = $false })
  return $targets
}

function Invoke-Check {
  param(
    [Parameter(Mandatory = $true)][string]$TargetResourcesDir,
    [switch]$IsDryRun
  )

  $modeLabel = if ($IsDryRun) { 'dry-run' } else { 'check' }
  Write-Host "[$modeLabel] Inspecting target resources: $TargetResourcesDir"

  $running = @(Get-AntigravityRunningProcesses -TargetResourcesDir $TargetResourcesDir)
  if ($running.Count -gt 0) {
    Write-Host "[$modeLabel] Active Antigravity processes detected: $($running.Count) (read-only check is safe; close app before -Apply or --revert)."
  } else {
    Write-Host "[$modeLabel] No active Antigravity processes detected."
  }

  $null = Get-Command node -ErrorAction Stop
  $deployScript = Join-Path $RepoRoot 'scripts\deploy.mjs'
  & node $deployScript '--resources' $TargetResourcesDir '--check'
  if ($LASTEXITCODE -ne 0) {
    throw "deploy.mjs --check reported an unpatched or out-of-sync installation (exit code $LASTEXITCODE)."
  }

  $distPreload = Join-Path $RepoRoot 'dist\customPreload.js'
  $asarPath = Join-Path $TargetResourcesDir 'app.asar'
  $inspectScript = @'
const fs = require('fs');
const path = require('path');
const args = process.argv[1] === '-' ? process.argv.slice(2) : process.argv.slice(1);
const [repoRoot, distPreloadPath, asarPath] = args;
const markers = [
  'installMainWorldBridge',
  'buildMainWorldFetchInterceptorSource',
  'injectCustomOrchestratorModelRoles',
  'normalizeCascadeClientModelConfigs',
  'webFrame.executeJavaScript',
];
function reportFile(label, content) {
  let missing = 0;
  for (const m of markers) {
    const ok = content.includes(m);
    if (!ok) missing++;
    console.log(`  [${ok ? 'MATCH' : 'MISSING'}] ${label} :: ${m}`);
  }
  return missing;
}
let distMissing = 0;
if (!fs.existsSync(distPreloadPath)) {
  console.log(`  [MISSING] ${distPreloadPath} (not built)`);
  distMissing = markers.length;
} else {
  distMissing = reportFile('dist/customPreload.js', fs.readFileSync(distPreloadPath, 'utf8'));
}
let asarMissing = 0;
try {
  const { createRequire } = require('module');
  const req = createRequire(path.join(repoRoot, 'package.json'));
  const asar = req('@electron/asar');
  const preloadContent = asar.extractFile(asarPath, 'dist/preload.js').toString('utf8');
  asarMissing = reportFile('app.asar :: dist/preload.js', preloadContent);
  try {
    const utilsContent = asar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
    const isolated = /contextIsolation\s*:\s*true/.test(utilsContent);
    console.log(`  [INFO] app.asar :: dist/utils.js :: contextIsolation: ${isolated}`);
  } catch {}
} catch (err) {
  console.log(`  [MISSING] app.asar :: dist/preload.js (${err.message})`);
  asarMissing = markers.length;
}
process.stdout.write(`MARKER_SUMMARY distMissing=${distMissing} asarMissing=${asarMissing}\n`);
'@
  $markerOutput = @($inspectScript | & node - $RepoRoot $distPreload $asarPath)
  foreach ($line in $markerOutput) {
    if ($line -notmatch '^MARKER_SUMMARY ') {
      Write-Host $line
    }
  }
  $summaryLine = $markerOutput | Where-Object { $_ -match '^MARKER_SUMMARY distMissing=(\d+) asarMissing=(\d+)$' } | Select-Object -Last 1
  $distMissingCount = if ($summaryLine -and $summaryLine -match 'distMissing=(\d+)') { [int]$Matches[1] } else { 1 }
  $asarMissingCount = if ($summaryLine -and $summaryLine -match 'asarMissing=(\d+)') { [int]$Matches[1] } else { 1 }
  if ($distMissingCount -gt 0) {
    throw "Repo build artifact dist\customPreload.js is missing $distMissingCount required marker(s). Run 'npm run build' first."
  }
  if ($asarMissingCount -gt 0) {
    Write-Host "[WARN] Installed app.asar is outdated or missing $asarMissingCount main-world bridge marker(s); close Antigravity and run -Backup -Apply."
    if (-not $IsDryRun) {
      throw "Installed app.asar is missing $asarMissingCount required marker(s). Close Antigravity and run -Backup -Apply."
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($ResolvedUserProfileDir)) {
    $modelsJsonPath = Join-Path $ResolvedUserProfileDir '.gemini\antigravity\custom_models.json'
    if (Test-Path -LiteralPath $modelsJsonPath -PathType Leaf) {
      try {
        $parsed = Get-Content -LiteralPath $modelsJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $modelsArr = if ($parsed -is [System.Array]) {
          @($parsed)
        } elseif ($parsed -and $parsed.PSObject.Properties['models'] -and ($parsed.models -is [System.Array])) {
          @($parsed.models)
        } else {
          @()
        }
        $seenIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        $enabledUnique = 0
        $disabledCount = 0
        $duplicateCount = 0
        $missingDisplayCount = 0
        foreach ($m in $modelsArr) {
          if (-not $m) { continue }
          $isEnabled = -not ($m.PSObject.Properties['enabled'] -and ($m.enabled -eq $false))
          if (-not $isEnabled) {
            $disabledCount++
            continue
          }
          $rawId = if ($m.PSObject.Properties['name'] -and $m.name) {
            [string]$m.name
          } elseif ($m.PSObject.Properties['id'] -and $m.id) {
            [string]$m.id
          } elseif ($m.PSObject.Properties['externalModelName'] -and $m.externalModelName) {
            [string]$m.externalModelName
          } else {
            ''
          }
          $normId = $rawId.Trim()
          if (-not $normId) { continue }
          if (-not $normId.StartsWith('models/')) { $normId = "models/$normId" }
          if (-not $seenIds.Add($normId)) {
            $duplicateCount++
            continue
          }
          $enabledUnique++
          $hasDisplay = $m.PSObject.Properties['displayName'] -and (-not [string]::IsNullOrWhiteSpace([string]$m.displayName))
          if (-not $hasDisplay) {
            $missingDisplayCount++
          }
        }
        Write-Host "[$modeLabel] custom_models.json summary (secrets redacted): total=$($modelsArr.Count), enabledUnique=$enabledUnique, disabled=$disabledCount, duplicates=$duplicateCount, fallbackToId=$missingDisplayCount"
      } catch {
        Write-Host "[$modeLabel] custom_models.json is invalid or unreadable ($($_.Exception.Message)); runtime will safely fall back to built-in Gemini models."
      }
    } else {
      Write-Host "[$modeLabel] custom_models.json not found at $modelsJsonPath; runtime will list built-in Gemini models only."
    }
  }

  if ($IsDryRun) {
    $targets = Get-BackupTargets -TargetResourcesDir $TargetResourcesDir
    $existingTargets = @($targets | Where-Object { Test-Path -LiteralPath $_.Src -PathType Leaf })
    Write-Host "[dry-run] Would back up $($existingTargets.Count) files to $ResolvedBackupRoot\orchestrator-<timestamp>, run 'npm run build', deploy compiled bundle to $TargetResourcesDir\app.asar, and verify with 'deploy.mjs --check'. No files were modified."
  } else {
    Write-Host '[done] Check passed.'
  }
}

function Invoke-Backup {
  param(
    [string]$TargetBackupDir = '',
    [Parameter(Mandatory = $true)][string]$TargetResourcesDir
  )

  $targets = Get-BackupTargets -TargetResourcesDir $TargetResourcesDir

  $destDir = New-UniqueBackupDirectory -RootDir $ResolvedBackupRoot -ExplicitDir $TargetBackupDir
  $manifestLines = [System.Collections.Generic.List[string]]::new()
  $manifestLines.Add('# Antigravity Orchestrator Backup Manifest')
  $manifestLines.Add("# Created: $([DateTimeOffset]::Now.ToString('o'))")
  $manifestLines.Add('# Format: SHA256 | RELATIVE_PATH | ORIGINAL_PATH | BYTES')

  $copiedCount = 0
  foreach ($item in $targets) {
    $srcPath = $item.Src
    if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
      if ($item.Required) {
        throw "Required backup source file not found: $srcPath"
      }
      Write-Host "[skip] Optional file missing: $srcPath"
      continue
    }

    $dstPath = Join-Path $destDir $item.Rel
    $dstParent = Split-Path -Parent $dstPath
    if (-not (Test-Path -LiteralPath $dstParent)) {
      New-Item -ItemType Directory -Path $dstParent -Force | Out-Null
    }

    $srcHash = Get-Sha256Lower -LiteralPath $srcPath
    [System.IO.File]::Copy($srcPath, $dstPath, $true)
    $dstHash = Get-Sha256Lower -LiteralPath $dstPath
    if ($srcHash -ne $dstHash) {
      throw "SHA-256 verification failed after copying '$srcPath' to '$dstPath'."
    }

    $byteLength = (Get-Item -LiteralPath $dstPath).Length
    $manifestLines.Add("$dstHash | $($item.Rel) | $srcPath | $byteLength")
    $copiedCount++
    Write-Host "[ok] Backed up $($item.Rel) ($byteLength bytes)"
  }

  if ($copiedCount -eq 0) {
    throw 'No files were backed up.'
  }

  $manifestPath = Join-Path $destDir 'MANIFEST.txt'
  [System.IO.File]::WriteAllLines($manifestPath, $manifestLines, [System.Text.UTF8Encoding]::new($false))
  Write-Host "[done] Backup created ($copiedCount files): $destDir"
  return $destDir
}

function Invoke-Apply {
  param(
    [Parameter(Mandatory = $true)][string]$TargetResourcesDir,
    [switch]$WithLanguageServerPatch
  )

  Assert-AntigravityNotRunning -TargetResourcesDir $TargetResourcesDir

  $null = Get-Command node -ErrorAction Stop
  $npmCmd = Get-Command npm -ErrorAction Stop

  Push-Location $RepoRoot
  try {
    Write-Host '[apply] Building TypeScript bundle (npm run build)...'
    & $npmCmd.Source run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed with exit code $LASTEXITCODE"
    }

    $deployScript = Join-Path $RepoRoot 'scripts\deploy.mjs'
    $deployArgs = @($deployScript, '--resources', $TargetResourcesDir)
    if ($WithLanguageServerPatch) {
      $deployArgs += '--patch-language-server'
    }

    Write-Host "[apply] Deploying custom preload to $TargetResourcesDir..."
    & node @deployArgs
    if ($LASTEXITCODE -ne 0) {
      throw "deploy.mjs failed with exit code $LASTEXITCODE"
    }

    Write-Host '[apply] Verifying deployment (--check)...'
    & node $deployScript '--resources' $TargetResourcesDir '--check'
    if ($LASTEXITCODE -ne 0) {
      throw "deploy.mjs --check failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  Write-Host '[done] Apply completed and verified.'
}

function Resolve-RollbackDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [string]$ExplicitDir = ''
  )

  if (-not [string]::IsNullOrWhiteSpace($ExplicitDir)) {
    $resolved = [System.IO.Path]::GetFullPath($ExplicitDir)
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
      throw "Backup directory not found: $resolved"
    }
    return $resolved
  }

  if (-not (Test-Path -LiteralPath $RootDir -PathType Container)) {
    throw "BackupRoot not found: $RootDir"
  }

  $candidates = @(
    Get-ChildItem -LiteralPath $RootDir -Directory |
      Where-Object { $_.Name -match '^orchestrator-\d{8}-\d{6}(?:-\d+)?$' } |
      Sort-Object -Property Name -Descending
  )
  if ($candidates.Count -eq 0) {
    throw "No orchestrator-* backup directories found in $RootDir"
  }
  return $candidates[0].FullName
}

function Resolve-RestoreDestination {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$OriginalPath,
    [Parameter(Mandatory = $true)][string]$TargetResourcesDir
  )

  if ([System.IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "Unsafe relative path in MANIFEST.txt: $RelativePath"
  }

  $normRel = $RelativePath -replace '/', '\'
  if ($normRel.StartsWith('repo\', [System.StringComparison]::OrdinalIgnoreCase)) {
    $subPath = $normRel.Substring(5)
    if ([string]::IsNullOrWhiteSpace($subPath)) {
      throw "Invalid repo relative path in MANIFEST.txt: $RelativePath"
    }
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $subPath))
    $basePrefix = $RepoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($basePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Restore destination escapes RepoRoot: $RelativePath"
    }
    return $resolved
  }
  if ($normRel.StartsWith('user\', [System.StringComparison]::OrdinalIgnoreCase)) {
    if ([string]::IsNullOrWhiteSpace($ResolvedUserProfileDir)) {
      throw "UserProfileDir is required to restore $RelativePath"
    }
    $subPath = $normRel.Substring(5)
    if ([string]::IsNullOrWhiteSpace($subPath)) {
      throw "Invalid user relative path in MANIFEST.txt: $RelativePath"
    }
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $ResolvedUserProfileDir $subPath))
    $basePrefix = $ResolvedUserProfileDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($basePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Restore destination escapes UserProfileDir: $RelativePath"
    }
    return $resolved
  }
  $resourcesRelPrefix = 'local\Programs\antigravity\resources\'
  if ($normRel.StartsWith($resourcesRelPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    $subPath = $normRel.Substring($resourcesRelPrefix.Length)
    if ([string]::IsNullOrWhiteSpace($subPath)) {
      throw "Invalid resources relative path in MANIFEST.txt: $RelativePath"
    }
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $TargetResourcesDir $subPath))
    $basePrefix = $TargetResourcesDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($basePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Restore destination escapes ResourcesDir: $RelativePath"
    }
    return $resolved
  }
  return [System.IO.Path]::GetFullPath($OriginalPath)
}

function Invoke-Rollback {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [string]$ExplicitDir = '',
    [Parameter(Mandatory = $true)][string]$TargetResourcesDir
  )

  $selectedDir = Resolve-RollbackDirectory -RootDir $RootDir -ExplicitDir $ExplicitDir
  $manifestPath = Join-Path $selectedDir 'MANIFEST.txt'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "MANIFEST.txt not found in backup directory: $selectedDir"
  }

  $entries = [System.Collections.Generic.List[hashtable]]::new()
  $lineNumber = 0
  foreach ($rawLine in [System.IO.File]::ReadAllLines($manifestPath)) {
    $lineNumber++
    $trimmed = $rawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) {
      continue
    }
    if ($trimmed -notmatch '^([0-9a-fA-F]{64})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*$') {
      throw "Malformed MANIFEST.txt line ${lineNumber}: $trimmed"
    }

    $expectedSha = $Matches[1].ToLowerInvariant()
    $relPath = ($Matches[2].Trim() -replace '/', '\')
    $origPath = $Matches[3].Trim()
    $expectedBytes = [int64]$Matches[4]

    $destPath = Resolve-RestoreDestination -RelativePath $relPath -OriginalPath $origPath -TargetResourcesDir $TargetResourcesDir
    $backupFile = [System.IO.Path]::GetFullPath((Join-Path $selectedDir $relPath))
    $selectedPrefix = $selectedDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $backupFile.StartsWith($selectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Backup file escapes backup directory: $relPath"
    }
    if (-not (Test-Path -LiteralPath $backupFile -PathType Leaf)) {
      throw "Missing backed-up file listed in manifest: $backupFile"
    }

    $actualBytes = (Get-Item -LiteralPath $backupFile).Length
    if ($actualBytes -ne $expectedBytes) {
      throw "Byte length mismatch for $relPath (expected $expectedBytes, got $actualBytes)"
    }

    $actualSha = Get-Sha256Lower -LiteralPath $backupFile
    if ($actualSha -ne $expectedSha) {
      throw "SHA-256 verification failed for backup file $relPath (expected $expectedSha, got $actualSha)"
    }

    $entries.Add(@{
      Sha256     = $expectedSha
      RelPath    = $relPath
      BackupFile = $backupFile
      DestPath   = $destPath
    })
  }

  if ($entries.Count -eq 0) {
    throw "MANIFEST.txt contains zero entries: $manifestPath"
  }

  $patchStatePath = Join-Path $TargetResourcesDir '.antigravity-model-patch\state.json'
  $resourcesPrefix = $TargetResourcesDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $touchesResources = (Test-Path -LiteralPath $patchStatePath) -or (
    @($entries | Where-Object {
      $_.DestPath.StartsWith($resourcesPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
  )

  if ($touchesResources) {
    Assert-AntigravityNotRunning -TargetResourcesDir $TargetResourcesDir
  }

  $stateRelPath = 'local\Programs\antigravity\resources\.antigravity-model-patch\state.json'
  $appAsarRelPath = 'local\Programs\antigravity\resources\app.asar'
  $hasManifestState = @($entries | Where-Object { $_.RelPath -ieq $stateRelPath }).Count -gt 0
  $appAsarEntry = $entries | Where-Object { $_.RelPath -ieq $appAsarRelPath } | Select-Object -First 1
  $shouldRunDeployRestore = $false

  if (-not $hasManifestState -and (Test-Path -LiteralPath $patchStatePath -PathType Leaf)) {
    try {
      $patchState = Get-Content -LiteralPath $patchStatePath -Raw | ConvertFrom-Json
    } catch {
      throw "Existing patch state is unreadable ($patchStatePath): $($_.Exception.Message)"
    }

    $origArchiveSha = ''
    if ($patchState -and $patchState.PSObject.Properties['original'] -and $patchState.original -and $patchState.original.PSObject.Properties['archive'] -and $patchState.original.archive) {
      $origArchiveSha = ([string]$patchState.original.archive).ToLowerInvariant()
    }
    $patchedArchiveSha = ''
    if ($patchState -and $patchState.PSObject.Properties['patched'] -and $patchState.patched -and $patchState.patched.PSObject.Properties['archive'] -and $patchState.patched.archive) {
      $patchedArchiveSha = ([string]$patchState.patched.archive).ToLowerInvariant()
    }

    if ($null -eq $appAsarEntry) {
      $shouldRunDeployRestore = $true
    } elseif ($origArchiveSha -and ($appAsarEntry.Sha256 -eq $origArchiveSha)) {
      $shouldRunDeployRestore = $true
    } elseif ($patchedArchiveSha -and ($appAsarEntry.Sha256 -eq $patchedArchiveSha)) {
      $shouldRunDeployRestore = $false
      Write-Host '[rollback] Backed-up app.asar matches state.patched.archive; preserving existing state.json and restoring app.asar directly.'
    } else {
      throw "Rollback aborted to prevent state.json desync: '$patchStatePath' exists, manifest omits state.json, and backed-up app.asar ($($appAsarEntry.Sha256)) matches neither state.original.archive ($origArchiveSha) nor state.patched.archive ($patchedArchiveSha). Run 'node scripts/deploy.mjs --resources `"$TargetResourcesDir`" --restore' first or roll back from a backup that includes state.json."
    }
  }

  if ($shouldRunDeployRestore) {
    $null = Get-Command node -ErrorAction Stop
    $deployScript = Join-Path $RepoRoot 'scripts\deploy.mjs'
    if (-not (Test-Path -LiteralPath $deployScript -PathType Leaf)) {
      $deployScript = Join-Path $PSScriptRoot 'deploy.mjs'
    }
    Write-Host '[rollback] Running deploy.mjs --restore for active patch state...'
    & node $deployScript '--resources' $TargetResourcesDir '--restore'
    if ($LASTEXITCODE -ne 0) {
      throw "deploy.mjs --restore failed with exit code $LASTEXITCODE"
    }
  }

  $restoredCount = 0
  $unchangedCount = 0
  foreach ($entry in $entries) {
    $destParent = Split-Path -Parent $entry.DestPath
    if (-not (Test-Path -LiteralPath $destParent)) {
      New-Item -ItemType Directory -Path $destParent -Force | Out-Null
    }

    if ((Test-Path -LiteralPath $entry.DestPath -PathType Leaf) -and ((Get-Sha256Lower -LiteralPath $entry.DestPath) -eq $entry.Sha256)) {
      $unchangedCount++
      Write-Host "[ok] Unchanged $($entry.RelPath)"
      continue
    }

    [System.IO.File]::Copy($entry.BackupFile, $entry.DestPath, $true)
    $restoredSha = Get-Sha256Lower -LiteralPath $entry.DestPath
    if ($restoredSha -ne $entry.Sha256) {
      throw "Post-restore SHA-256 mismatch at $($entry.DestPath)"
    }
    $restoredCount++
    Write-Host "[ok] Restored $($entry.RelPath) -> $($entry.DestPath)"
  }

  Write-Host "[done] Rollback verified from ${selectedDir}: $restoredCount restored, $unchangedCount already matching."
}

if ($Check -or $DryRun) {
  Invoke-Check -TargetResourcesDir $ResolvedResourcesDir -IsDryRun:$DryRun
}
if ($Backup -and -not $DryRun) {
  $null = Invoke-Backup -TargetBackupDir $BackupDir -TargetResourcesDir $ResolvedResourcesDir
}
if ($Apply -and -not $DryRun) {
  Invoke-Apply -TargetResourcesDir $ResolvedResourcesDir -WithLanguageServerPatch:$PatchLanguageServer
}
if ($Rollback) {
  Invoke-Rollback -RootDir $ResolvedBackupRoot -ExplicitDir $BackupDir -TargetResourcesDir $ResolvedResourcesDir
}
