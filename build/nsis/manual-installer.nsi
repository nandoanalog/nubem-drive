Unicode True
Name "Nubem Drive"
OutFile "/home/nando/Documents/cloud/release/Nubem-Drive-Setup-0.0.26-x64.exe"
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

  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "MUIVerb" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "Icon" "$INSTDIR\Nubem Drive.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud\command" "" "$\"$INSTDIR\Nubem Drive.exe$\" $\"nubem-cloud-folder:%1$\""

  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "MUIVerb" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "Icon" "$INSTDIR\Nubem Drive.exe"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud\command" "" "$\"$INSTDIR\Nubem Drive.exe$\" $\"nubem-cloud-folder:%1$\""

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "MUIVerb" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "Icon" "$INSTDIR\Nubem Drive.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud\command" "" "$\"$INSTDIR\Nubem Drive.exe$\" $\"nubem-cloud-folder:%V$\""

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "DisplayName" "Nubem Drive"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "DisplayIcon" "$INSTDIR\Nubem Drive.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "DisplayVersion" "0.0.26"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Nubem Drive.lnk"
  Delete "$SMPROGRAMS\Nubem Drive\Nubem Drive.lnk"
  RMDir "$SMPROGRAMS\Nubem Drive"

  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive"

  RMDir /r "$INSTDIR"
SectionEnd
