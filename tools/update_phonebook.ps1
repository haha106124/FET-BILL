param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [Parameter(Mandatory = $true)]
  [string]$Account,
  [string]$SourceLabel = 'Monthly phonebook'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$python = 'C:\Users\0024\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$temporaryDirectory = Join-Path $env:TEMP ('fet-phonebook-' + [Guid]::NewGuid().ToString('N'))
$plainDirectory = Join-Path $temporaryDirectory 'directory.json'
$encryptedDirectory = Join-Path $repo 'data\directory.enc.json'

if (-not (Test-Path -LiteralPath $InputPath)) {
  throw "Phonebook file was not found: $InputPath"
}
if (-not (Test-Path -LiteralPath $python)) {
  throw 'The local helper runtime is not available. Please reopen Codex and try again.'
}

New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
try {
  Write-Host ''
  Write-Host 'Reading the monthly phonebook locally...'
  & $python (Join-Path $PSScriptRoot 'extract_xls.py') $InputPath --output $plainDirectory --source $SourceLabel --summary
  if ($LASTEXITCODE -ne 0) { throw 'The phonebook could not be read.' }

  Write-Host ''
  $securePassword = Read-Host 'Set scanner password (input is hidden)' -AsSecureString
  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try {
    $env:FET_SCANNER_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    & $python (Join-Path $PSScriptRoot 'encrypt_data.py') --account $Account --input $plainDirectory --output $encryptedDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Encrypted directory was not created.' }
  }
  finally {
    Remove-Item Env:FET_SCANNER_PASSWORD -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }

  Set-Location $repo
  & git add -- data/directory.enc.json
  & git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host 'No changes were needed.'
    exit 0
  }
  & git commit -m 'Update encrypted phonebook'
  & git push
  if ($LASTEXITCODE -ne 0) { throw 'The encrypted directory could not be uploaded.' }
  Write-Host ''
  Write-Host 'Done. The original XLS was never uploaded.'
}
finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
