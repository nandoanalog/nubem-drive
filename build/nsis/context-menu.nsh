!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "MUIVerb" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-cloud-folder:%1"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveRemoveCloud" "" "Remove from cloud"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveRemoveCloud" "MUIVerb" "Remove from cloud"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveRemoveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveRemoveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-remove-folder:%1"'

  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "MUIVerb" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-cloud-folder:%1"'
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveRemoveCloud" "" "Remove from cloud"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveRemoveCloud" "MUIVerb" "Remove from cloud"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveRemoveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveRemoveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-remove-folder:%1"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "MUIVerb" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-cloud-folder:%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveRemoveCloud" "" "Remove from cloud"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveRemoveCloud" "MUIVerb" "Remove from cloud"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveRemoveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveRemoveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-remove-folder:%V"'

  CreateShortCut "$SENDTO\Add to cloud.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--cloud-folder" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SENDTO\Remove from cloud.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--remove-cloud-folder" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
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
!macroend
