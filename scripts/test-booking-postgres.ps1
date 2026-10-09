param([switch]$Browser, [switch]$BrowserOnly, [switch]$ProductionSmoke)
$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$clusterPath = [IO.Path]::GetFullPath((Join-Path $tempRoot ('neotek-booking-test-' + [guid]::NewGuid().ToString('N'))))
if (-not $clusterPath.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test directory' }
$postgresBin = Split-Path -Parent (Get-Command initdb.exe -ErrorAction Stop).Source
$portProbe = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$testPort = $portProbe.LocalEndpoint.Port
$portProbe.Stop()
$oldDatabase = $env:DATABASE_URL
$oldTestDatabase = $env:BOOKING_TEST_DATABASE_URL
$oldTestMarker = $env:BOOKING_TEST_DISPOSABLE
$started = $false
Push-Location $backendRoot
try {
  & (Join-Path $postgresBin 'initdb.exe') -D $clusterPath -U neotek_booking_test --auth=trust --encoding=UTF8 --no-locale
  if ($LASTEXITCODE -ne 0) { throw 'Disposable initdb failed' }
  & (Join-Path $postgresBin 'pg_ctl.exe') -D $clusterPath -l (Join-Path $clusterPath 'server.log') -o "-h 127.0.0.1 -p $testPort" -w start
  if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL start failed' }
  $started = $true
  & (Join-Path $postgresBin 'createdb.exe') -h 127.0.0.1 -p $testPort -U neotek_booking_test neotek_booking_disposable
  if ($LASTEXITCODE -ne 0) { throw 'Disposable database creation failed' }
  $env:DATABASE_URL = "postgresql://neotek_booking_test@127.0.0.1:$testPort/neotek_booking_disposable?schema=public"
  $env:BOOKING_TEST_DATABASE_URL = $env:DATABASE_URL
  $env:BOOKING_TEST_DISPOSABLE = '1'
  & '.\node_modules\.bin\prisma.cmd' migrate deploy
  if ($LASTEXITCODE -ne 0) { throw 'Migration replay failed' }
  & '.\node_modules\.bin\prisma.cmd' migrate deploy
  if ($LASTEXITCODE -ne 0) { throw 'Second migration deploy failed' }
  if ($ProductionSmoke) {
    & node scripts/check-booking-production.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Booking production smoke failed' }
  }
  if (-not $BrowserOnly) {
    & '.\node_modules\.bin\jest.cmd' --runInBand --no-cache --runTestsByPath src/booking/booking-postgres.integration.spec.ts src/booking/booking-http-postgres.integration.spec.ts
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL foundation tests failed' }
  }
  if ($Browser -or $BrowserOnly) {
    & node scripts/check-booking-browser.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Booking browser checks failed' }
  }
} finally {
  $env:DATABASE_URL = $oldDatabase
  $env:BOOKING_TEST_DATABASE_URL = $oldTestDatabase
  $env:BOOKING_TEST_DISPOSABLE = $oldTestMarker
  if ($started) {
    & (Join-Path $postgresBin 'pg_ctl.exe') -D $clusterPath -m immediate -w stop
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop disposable PostgreSQL; directory preserved' }
  }
  Pop-Location
  # Only delete the freshly generated, explicitly verified disposable cluster.
  $resolvedCluster = [IO.Path]::GetFullPath($clusterPath)
  if ($resolvedCluster.StartsWith($tempRoot + '\neotek-booking-test-', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedCluster)) {
    Remove-Item -LiteralPath $resolvedCluster -Recurse -Force
  }
}
