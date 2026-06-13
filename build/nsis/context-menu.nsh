!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "" "Cloud"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NubemDriveCloud\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cloud-folder "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NubemDriveCloud"
!macroend
