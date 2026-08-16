# Optiline WASI SDK bootstrap (PROJECT_SPECIFICATION.md §6.4).
# Verifies or downloads the pinned WASI SDK 33.0 for x86-64 Windows.
# It never selects an unpinned "latest" toolchain.
$ErrorActionPreference = 'Stop'

$SdkRoot   = 'C:\repos\optiline\tools\wasi-sdk-33.0-x86_64-windows'
$VersionFile = Join-Path $PSScriptRoot '..\cmake\wasi-sdk-version.txt'
$ExpectedSha256 = 'df14ca2a2127c2d6b6be07e6f5549b3af9c1b3c0112430c200a4749970c59f06'
$ExpectedClang = '22.1.0'
$ExpectedVersion = '33.0'
$ArchiveUrl = 'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-x86_64-windows.tar.gz'

function Test-Sdk {
    $clang = Join-Path $SdkRoot 'bin\clang.exe'
    if (-not (Test-Path $clang)) { return $false }

    $versionPath = Join-Path $SdkRoot 'VERSION'
    if (-not (Test-Path $versionPath)) {
        throw "WASI SDK VERSION file missing at $versionPath"
    }
    $versionText = Get-Content $versionPath -Raw
    if ($versionText -notmatch [regex]::Escape($ExpectedVersion)) {
        throw "WASI SDK VERSION mismatch: expected $ExpectedVersion, file says: $versionText"
    }

    $clangOut = & $clang --version 2>&1 | Out-String
    if ($clangOut -notmatch [regex]::Escape($ExpectedClang)) {
        throw "clang --version mismatch: expected $ExpectedClang, got: $clangOut"
    }

    Write-Host "WASI SDK $ExpectedVersion verified at $SdkRoot (clang $ExpectedClang)."
    return $true
}

if (Test-Sdk) { exit 0 }

Write-Host "Pinned WASI SDK not found. Downloading the official pinned archive..."
$archive = Join-Path $env:TEMP 'wasi-sdk-33.0-x86_64-windows.tar.gz'
if (-not (Test-Path $archive)) {
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $archive
} else {
    Write-Host "Reusing the existing downloaded archive at $archive."
}

if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
    $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLowerInvariant()
} else {
    $hashLine = certutil.exe -hashfile $archive SHA256 |
        Where-Object { $_ -match '^[0-9a-fA-F ]{64,}$' } |
        Select-Object -First 1
    if (-not $hashLine) { throw 'No SHA-256 implementation is available.' }
    $actual = ($hashLine -replace ' ', '').ToLowerInvariant()
}
if ($actual -ne $ExpectedSha256) {
    Remove-Item $archive -Force
    throw "Archive SHA-256 mismatch: expected $ExpectedSha256, got $actual. Refusing to install."
}

$toolsDir = Split-Path $SdkRoot -Parent
tar -xzf $archive -C $toolsDir
Remove-Item $archive -Force

if (-not (Test-Sdk)) {
    throw "SDK extraction finished but verification failed."
}
