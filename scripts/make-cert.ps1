# Creates a self-signed HTTPS certificate (PFX) for LAN use, so phones can open the app over https://
# (browsers only allow the camera on secure origins).
#
#   powershell -ExecutionPolicy Bypass -File scripts\make-cert.ps1 -Ip 192.168.1.20
#
# Then start the server with:
#   $env:SSL_PFX = "data\server.pfx"; $env:SSL_PASSPHRASE = "warehouse"; node server/index.js
#
# NOTE: a self-signed certificate shows a one-time browser warning on each phone. For a warning-free setup
# with "install app" support, put the app behind a real domain + certificate (see README).
param(
  [Parameter(Mandatory = $true)][string]$Ip,
  [string]$Password = 'warehouse',
  [string]$Out = (Join-Path (Split-Path -Parent $PSScriptRoot) 'data\server.pfx')
)

$ErrorActionPreference = 'Stop'
$san = "2.5.29.17={text}DNS=localhost&DNS=$($env:COMPUTERNAME)&IPAddress=$Ip&IPAddress=127.0.0.1"
$cert = New-SelfSignedCertificate -Subject 'CN=warehouse' -TextExtension @($san) `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(5) `
  -CertStoreLocation 'Cert:\CurrentUser\My'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
$sec = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $Out -Password $sec | Out-Null
Remove-Item -Path ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force
Write-Host "Certificate written to $Out (password: $Password)"
