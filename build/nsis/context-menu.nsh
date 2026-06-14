!macro customInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveRemoveCloud"
  Delete "$SENDTO\Add to cloud.lnk"
  Delete "$SENDTO\Remove from cloud.lnk"
  Delete "$SENDTO\Cloud folder.lnk"
  Delete "$SENDTO\Add or remove from Nubem.lnk"

  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "" "Add or remove from Nubem"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "MUIVerb" "Add or remove from Nubem"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-toggle-folder:%1"'

  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "" "Add or remove from Nubem"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "MUIVerb" "Add or remove from Nubem"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-toggle-folder:%1"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "" "Add or remove from Nubem"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "MUIVerb" "Add or remove from Nubem"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-toggle-folder:%V"'

  CreateShortCut "$SENDTO\Add or remove from Nubem.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--toggle-cloud-folder" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveRemoveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveRemoveCloud"
  Delete "$SENDTO\Add to cloud.lnk"
  Delete "$SENDTO\Remove from cloud.lnk"
  Delete "$SENDTO\Cloud folder.lnk"
  Delete "$SENDTO\Add or remove from Nubem.lnk"
!macroend
