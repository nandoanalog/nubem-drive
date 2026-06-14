Unicode True
Name "Nubem Drive"
OutFile "/home/nando/Documents/cloud/release/Nubem-Drive-Setup-0.0.30-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\Nubem Drive"
RequestExecutionLevel user

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "/home/nando/Documents/cloud/release/win-unpacked/*"

  CreateDirectory "$SMPROGRAMS\Nubem Drive"
  CreateShortcut "$SMPROGRAMS\Nubem Drive\Nubem Drive.lnk" "$INSTDIR\Nubem Drive.exe"
  CreateShortcut "$DESKTOP\Nubem Drive.lnk" "$INSTDIR\Nubem Drive.exe"

  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveRemoveCloud"
  Delete "$SENDTO\Add to cloud.lnk"
  Delete "$SENDTO\Remove from cloud.lnk"

  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "" "Cloud folder"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "MUIVerb" "Cloud folder"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "Icon" "$INSTDIR\Nubem Drive.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud\command" "" "$\"$INSTDIR\Nubem Drive.exe$\" $\"nubem-toggle-folder:%1$\""

  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "" "Cloud folder"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "MUIVerb" "Cloud folder"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "Icon" "$INSTDIR\Nubem Drive.exe"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud\command" "" "$\"$INSTDIR\Nubem Drive.exe$\" $\"nubem-toggle-folder:%1$\""

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "" "Cloud folder"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "MUIVerb" "Cloud folder"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "Icon" "$INSTDIR\Nubem Drive.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud\command" "" "$\"$INSTDIR\Nubem Drive.exe$\" $\"nubem-toggle-folder:%V$\""

  CreateShortCut "$SENDTO\Cloud folder.lnk" "$INSTDIR\Nubem Drive.exe" "--toggle-cloud-folder" "$INSTDIR\Nubem Drive.exe" 0

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "DisplayName" "Nubem Drive"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "DisplayIcon" "$INSTDIR\Nubem Drive.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "DisplayVersion" "0.0.30"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Nubem Drive.lnk"
  Delete "$SMPROGRAMS\Nubem Drive\Nubem Drive.lnk"
  RMDir "$SMPROGRAMS\Nubem Drive"

  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveRemoveCloud"
  Delete "$SENDTO\Add to cloud.lnk"
  Delete "$SENDTO\Remove from cloud.lnk"
  Delete "$SENDTO\Cloud folder.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive"

  RMDir /r "$INSTDIR"
SectionEnd
