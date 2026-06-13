Unicode True
Name "Nubem Drive"
OutFile "/home/nando/Documents/cloud/release/Nubem-Drive-Setup-0.0.7-x64.exe"
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

  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "" "Cloud"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "Icon" "$INSTDIR\Nubem Drive.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud\command" "" "$\"$INSTDIR\Nubem Drive.exe$\" --cloud-folder $\"%1$\""

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "DisplayName" "Nubem Drive"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "DisplayIcon" "$INSTDIR\Nubem Drive.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive" "DisplayVersion" "0.0.7"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Nubem Drive.lnk"
  Delete "$SMPROGRAMS\Nubem Drive\Nubem Drive.lnk"
  RMDir "$SMPROGRAMS\Nubem Drive"

  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NubemDrive"

  RMDir /r "$INSTDIR"
SectionEnd
