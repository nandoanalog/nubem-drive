!macro customInstall
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
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-toggle-folder:%1"'

  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "" "Cloud folder"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "MUIVerb" "Cloud folder"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-toggle-folder:%1"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "" "Cloud folder"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "MUIVerb" "Cloud folder"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-toggle-folder:%V"'

  CreateShortCut "$SENDTO\Cloud folder.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--toggle-cloud-folder" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
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
!macroend
