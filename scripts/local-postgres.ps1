param([ValidateSet('start','stop','status')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskDirectory = [IO.Path]::GetFullPath((Join-Path $taskWorkspace '.data/test-postgres'))
if (-not $taskDirectory.StartsWith($taskWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cluster outside workspace' }
$taskBin = Join-Path $taskWorkspace '.data/tools/pgsql/bin'
$taskCluster = Join-Path $taskDirectory 'cluster'
$taskStatePath = Join-Path $taskDirectory 'connection.json'
New-Item -ItemType Directory -Force -Path $taskDirectory | Out-Null
if ($Action -eq 'stop') {
  & (Join-Path $taskBin 'pg_ctl.exe') -D $taskCluster -m fast -w stop
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop the isolated cluster' }
  exit
}
if ($Action -eq 'status') { & (Join-Path $taskBin 'pg_ctl.exe') -D $taskCluster status; exit }
if (-not (Test-Path -LiteralPath $taskStatePath)) {
  $taskRandom = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($taskRandom)
  $taskPassword = [Convert]::ToBase64String($taskRandom)
  @{ port = 55438; user = 'shlab'; password = $taskPassword; database = 'shlab_test' } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $taskStatePath
}
$taskState = Get-Content -Raw -Encoding UTF8 -LiteralPath $taskStatePath | ConvertFrom-Json
if ($taskState.database -notmatch '^[a-zA-Z0-9_]+$') { throw 'Invalid isolated database name' }
if (-not (Test-Path -LiteralPath (Join-Path $taskCluster 'PG_VERSION'))) {
  $taskPasswordFile = Join-Path $taskDirectory 'initial-password.txt'
  [IO.File]::WriteAllText($taskPasswordFile, $taskState.password, [Text.UTF8Encoding]::new($false))
  try {
    & (Join-Path $taskBin 'initdb.exe') -D $taskCluster -U $taskState.user -A scram-sha-256 --pwfile $taskPasswordFile -E UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
  } finally { Remove-Item -LiteralPath $taskPasswordFile -ErrorAction SilentlyContinue }
}
& (Join-Path $taskBin 'pg_ctl.exe') -D $taskCluster status *> $null
if ($LASTEXITCODE -ne 0) {
  $taskArguments = @('-D', ('"'+$taskCluster+'"'), '-l', ('"'+(Join-Path $taskDirectory 'server.log')+'"'), '-o', ('"-h 127.0.0.1 -p '+$taskState.port+' -c max_connections=40"'), '-w', 'start')
  $taskProcess = Start-Process -FilePath (Join-Path $taskBin 'pg_ctl.exe') -ArgumentList $taskArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskDirectory 'start.log') -RedirectStandardError (Join-Path $taskDirectory 'start-error.log')
  if (-not $taskProcess.WaitForExit(60000)) { throw 'pg_ctl exceeded its startup deadline' }
  # Windows PowerShell may lose the launcher ExitCode after WaitForExit.
  # Verify the actual server rather than treating a null ExitCode as failure.
  & (Join-Path $taskBin 'pg_ctl.exe') -D $taskCluster status *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start the isolated cluster; inspect .data/test-postgres/start-error.log' }
}
$env:PGPASSWORD = $taskState.password
try {
  & (Join-Path $taskBin 'psql.exe') -h 127.0.0.1 -p $taskState.port -U $taskState.user -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$($taskState.database)'" | Set-Variable -Name taskExists
  if ($LASTEXITCODE -ne 0) { throw 'Could not connect to the isolated cluster' }
  if (-not $taskExists) {
    & (Join-Path $taskBin 'createdb.exe') -h 127.0.0.1 -p $taskState.port -U $taskState.user $taskState.database
    if ($LASTEXITCODE -ne 0) { throw 'Could not create test database' }
  }
} finally {
  Remove-Item Env:PGPASSWORD
}
Write-Output 'PostgreSQL ready on 127.0.0.1:55438. Test credentials stay in ignored .data/test-postgres/connection.json.'
