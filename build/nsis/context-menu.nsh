!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "MUIVerb" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-cloud-folder:%1"'

  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "MUIVerb" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Folder\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-cloud-folder:%1"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "MUIVerb" "Add to cloud"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "nubem-cloud-folder:%V"'

  CreateShortCut "$SENDTO\Add to cloud.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--cloud-folder" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\NubemDriveCloud"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NubemDriveCloud"
  Delete "$SENDTO\Add to cloud.lnk"
!macroend
