!macro customInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\*\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\*\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveRemoveCloud"
  Delete "$SENDTO\Add to cloud.lnk"
  Delete "$SENDTO\Remove from cloud.lnk"
  Delete "$SENDTO\Cloud folder.lnk"
  Delete "$SENDTO\Add or remove from Nubem.lnk"
  Delete "$SENDTO\Add to Nubem.lnk"

  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "" "Add to Nubem"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "MUIVerb" "Add to Nubem"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud\command" "" `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$p='%1'; $$d=Join-Path $$env:APPDATA 'nubem-drive\commands'; New-Item -ItemType Directory -Force -Path $$d | Out-Null; @{ type='cloud-folder'; paths=@($$p); createdAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $$d (([guid]::NewGuid().ToString()) + '.json')) -Encoding UTF8; if (-not (Get-Process 'Nubem Drive' -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$INSTDIR\${APP_EXECUTABLE_FILENAME}' }"`

  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "" "Add to Nubem"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "MUIVerb" "Add to Nubem"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud\command" "" `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$p='%1'; $$d=Join-Path $$env:APPDATA 'nubem-drive\commands'; New-Item -ItemType Directory -Force -Path $$d | Out-Null; @{ type='cloud-folder'; paths=@($$p); createdAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $$d (([guid]::NewGuid().ToString()) + '.json')) -Encoding UTF8; if (-not (Get-Process 'Nubem Drive' -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$INSTDIR\${APP_EXECUTABLE_FILENAME}' }"`

  WriteRegStr HKCU "Software\Classes\*\shell\NubemDriveCloud" "" "Add to Nubem"
  WriteRegStr HKCU "Software\Classes\*\shell\NubemDriveCloud" "MUIVerb" "Add to Nubem"
  WriteRegStr HKCU "Software\Classes\*\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\*\shell\NubemDriveCloud\command" "" `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$p='%1'; $$d=Join-Path $$env:APPDATA 'nubem-drive\commands'; New-Item -ItemType Directory -Force -Path $$d | Out-Null; @{ type='cloud-folder'; paths=@($$p); createdAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $$d (([guid]::NewGuid().ToString()) + '.json')) -Encoding UTF8; if (-not (Get-Process 'Nubem Drive' -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$INSTDIR\${APP_EXECUTABLE_FILENAME}' }"`

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "" "Add to Nubem"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "MUIVerb" "Add to Nubem"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud\command" "" `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$p='%V'; $$d=Join-Path $$env:APPDATA 'nubem-drive\commands'; New-Item -ItemType Directory -Force -Path $$d | Out-Null; @{ type='cloud-folder'; paths=@($$p); createdAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $$d (([guid]::NewGuid().ToString()) + '.json')) -Encoding UTF8; if (-not (Get-Process 'Nubem Drive' -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$INSTDIR\${APP_EXECUTABLE_FILENAME}' }"`

  CreateShortCut "$SENDTO\Add to Nubem.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--cloud-folder" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\*\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\*\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveRemoveCloud"
  Delete "$SENDTO\Add to cloud.lnk"
  Delete "$SENDTO\Remove from cloud.lnk"
  Delete "$SENDTO\Cloud folder.lnk"
  Delete "$SENDTO\Add or remove from Nubem.lnk"
  Delete "$SENDTO\Add to Nubem.lnk"
!macroend
