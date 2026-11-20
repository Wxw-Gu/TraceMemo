!include "LogicLib.nsh"
!include "getProcessInfo.nsh"

Var tmSelfPid

!ifndef BUILD_UNINSTALLER
  Var tmTempRedirected
  Var tmOrigTemp
  Var tmOrigTmp
  Var tmAltTempDir
  Var tmOldInstDir
  Var tmOldDrive
  Var tmTempDrive
!endif

!macro TM_FIND_PROCESS _FILE _ERR
  !ifdef INSTALL_MODE_PER_ALL_USERS
    ${nsProcess::FindProcess} "${_FILE}" ${_ERR}
  !else
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${_FILE}" /FO csv | "$SYSDIR\find.exe" /I "${_FILE}"`
    Pop ${_ERR}
  !endif
!macroend

!macro TM_TASKKILL_SOFT _FILE _PID
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `taskkill /im "${_FILE}" /fi "PID ne ${_PID}"`
  !else
    nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /im "${_FILE}" /fi "PID ne ${_PID}" /fi "USERNAME eq %USERNAME%"`
  !endif
  Pop $R9
!macroend

!macro TM_TASKKILL_FORCE_TREE _FILE _PID
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `taskkill /f /t /im "${_FILE}" /fi "PID ne ${_PID}"`
  !else
    nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /t /im "${_FILE}" /fi "PID ne ${_PID}" /fi "USERNAME eq %USERNAME%"`
  !endif
  Pop $R9
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; 旧版卸载器在 --updated 模式下会把文件 Rename 到 %TEMP% 下的 $PLUGINSDIR\old-install。
    ; 若旧版装在非系统盘，把子进程继承的 TEMP/TMP 暂指同盘符可写目录，避免跨卷 Rename 必败。
    Function tmPrepareCrossDriveUpdateTemp
      Push $0
      Push $1

      StrCpy $tmTempRedirected "0"
      StrCpy $tmAltTempDir ""
      StrCpy $tmOldInstDir ""

      ReadRegStr $tmOldInstDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${if} $tmOldInstDir == ""
        ReadRegStr $tmOldInstDir HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${endIf}
      ${if} $tmOldInstDir == ""
        StrCpy $tmOldInstDir "$INSTDIR"
      ${endIf}

      StrCpy $tmOldDrive $tmOldInstDir 2
      StrCpy $tmTempDrive $TEMP 2
      ${if} $tmOldDrive == ""
      ${orIf} $tmTempDrive == ""
      ${orIf} $tmOldDrive == $tmTempDrive
        Goto tm_temp_done
      ${endIf}

      StrCpy $0 $tmOldInstDir 1 -1
      ${if} $0 == "\"
        StrCpy $tmOldInstDir $tmOldInstDir -1
      ${endIf}

      StrCpy $tmAltTempDir "$tmOldInstDir._tm_upd_tmp"
      CreateDirectory "$tmAltTempDir"
      ClearErrors
      FileOpen $1 "$tmAltTempDir\.probe" w
      ${if} ${Errors}
        StrCpy $tmAltTempDir "$tmOldDrive\.tracememo_upd_tmp"
        CreateDirectory "$tmAltTempDir"
        ClearErrors
        FileOpen $1 "$tmAltTempDir\.probe" w
        ${if} ${Errors}
          StrCpy $tmAltTempDir ""
          Goto tm_temp_done
        ${endIf}
      ${endIf}
      FileClose $1
      Delete "$tmAltTempDir\.probe"

      ReadEnvStr $tmOrigTemp "TEMP"
      ReadEnvStr $tmOrigTmp "TMP"
      System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$tmAltTempDir") i.r0'
      System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$tmAltTempDir") i.r0'
      StrCpy $tmTempRedirected "1"

      tm_temp_done:
      Pop $1
      Pop $0
    FunctionEnd

    Function tmRestoreCrossDriveUpdateTemp
      Push $0
      ${if} $tmTempRedirected == "1"
        ${if} $tmOrigTemp != ""
          System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$tmOrigTemp") i.r0'
        ${endIf}
        ${if} $tmOrigTmp != ""
          System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$tmOrigTmp") i.r0'
        ${endIf}
        ${if} $tmAltTempDir != ""
          RMDir /r "$tmAltTempDir"
        ${endIf}
        StrCpy $tmTempRedirected "0"
      ${endIf}
      Pop $0
    FunctionEnd
  !else
    Var /GLOBAL tmOldBackupRoot

    Function un.tmAtomicMoveToBackup
      Exch $R0
      Push $R1
      Push $R2
      Push $R3

      StrCpy $R3 "$INSTDIR$R0\*.*"
      FindFirst $R1 $R2 $R3

      tm_move_loop:
        StrCmp $R2 "" tm_move_break
        StrCmp $R2 "." tm_move_continue
        StrCmp $R2 ".." tm_move_continue

        IfFileExists "$INSTDIR$R0\$R2\*.*" tm_move_is_dir tm_move_is_file

        tm_move_is_dir:
          CreateDirectory "$tmOldBackupRoot$R0\$R2"
          Push "$R0\$R2"
          Call un.tmAtomicMoveToBackup
          Pop $R3
          ${if} $R3 != 0
            Goto tm_move_done
          ${endIf}
          Goto tm_move_continue

        tm_move_is_file:
          ClearErrors
          Rename "$INSTDIR$R0\$R2" "$tmOldBackupRoot$R0\$R2"
          StrCmp "$R0\$R2" "\${UNINSTALL_FILENAME}" 0 +2
          ClearErrors
          StrCmp "$R0\$R2" "${UNINSTALL_FILENAME}" 0 +2
          ClearErrors

          IfErrors 0 +3
          StrCpy $R3 "$INSTDIR$R0\$R2"
          Goto tm_move_done

        tm_move_continue:
          FindNext $R1 $R2
          Goto tm_move_loop

      tm_move_break:
        StrCpy $R3 0

      tm_move_done:
        FindClose $R1
        StrCpy $R0 $R3
        Pop $R3
        Pop $R2
        Pop $R1
        Exch $R0
    FunctionEnd

    Function un.tmRestoreFromBackup
      Exch $R0
      Push $R1
      Push $R2
      Push $R3

      StrCpy $R3 "$tmOldBackupRoot$R0\*.*"
      FindFirst $R1 $R2 $R3

      tm_restore_loop:
        StrCmp $R2 "" tm_restore_break
        StrCmp $R2 "." tm_restore_continue
        StrCmp $R2 ".." tm_restore_continue

        IfFileExists "$tmOldBackupRoot$R0\$R2\*.*" tm_restore_is_dir tm_restore_is_file

        tm_restore_is_dir:
          CreateDirectory "$INSTDIR$R0\$R2"
          Push "$R0\$R2"
          Call un.tmRestoreFromBackup
          Pop $R3
          Goto tm_restore_continue

        tm_restore_is_file:
          Rename "$tmOldBackupRoot$R0\$R2" "$INSTDIR$R0\$R2"

        tm_restore_continue:
          FindNext $R1 $R2
          Goto tm_restore_loop

      tm_restore_break:
        StrCpy $R0 0
        FindClose $R1
        Pop $R3
        Pop $R2
        Pop $R1
        Exch $R0
    FunctionEnd
  !endif
!macroend

!macro customCheckAppRunning
  ${GetProcessInfo} 0 $tmSelfPid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${if} ${isUpdated}
      Sleep 500
    ${endIf}

    !insertmacro TM_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      ${if} ${isUpdated}
        Sleep 1000
        !insertmacro TM_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 != 0
          Goto tm_app_not_running
        ${endIf}
        Goto tm_do_stop_process
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK tm_do_stop_process
      Quit

      tm_do_stop_process:
      DetailPrint `Closing running "${PRODUCT_NAME}"...`
      !insertmacro TM_TASKKILL_SOFT "${APP_EXECUTABLE_FILENAME}" $tmSelfPid
      Sleep 500

      StrCpy $R1 0

      tm_stop_loop:
        IntOp $R1 $R1 + 1

        !insertmacro TM_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          Sleep 1000
          !insertmacro TM_TASKKILL_FORCE_TREE "${APP_EXECUTABLE_FILENAME}" $tmSelfPid
          Sleep 500
          !insertmacro TM_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
          ${if} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 1500
          ${else}
            Goto tm_app_not_running
          ${endIf}
        ${else}
          Goto tm_app_not_running
        ${endIf}

        ${if} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY tm_stop_loop
          Quit
        ${else}
          Goto tm_stop_loop
        ${endIf}

      tm_app_not_running:
    ${endIf}
  ${endIf}

  !ifndef BUILD_UNINSTALLER
    Call tmPrepareCrossDriveUpdateTemp
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customInstall
    Call tmRestoreCrossDriveUpdateTemp
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  ; 同盘符沿用原生 $PLUGINSDIR\old-install，跨盘符改用同卷旁路目录避免 Rename 必败。
  !macro customRemoveFiles
    ${if} ${isUpdated}
      StrCpy $0 $INSTDIR 2
      StrCpy $1 $PLUGINSDIR 2
      ${if} $0 == $1
        CreateDirectory "$PLUGINSDIR\old-install"
        Push ""
        Call un.atomicRMDir
        Pop $R0
        ${if} $R0 != 0
          DetailPrint "File is busy, aborting: $R0"
          Push ""
          Call un.restoreFiles
          Pop $R0
          Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
        ${endIf}
      ${else}
        StrCpy $2 $INSTDIR
        StrCpy $3 $2 1 -1
        ${if} $3 == "\"
          StrCpy $2 $2 -1
        ${endIf}
        StrCpy $tmOldBackupRoot "$2._tm_old"
        RMDir /r "$tmOldBackupRoot"
        CreateDirectory "$tmOldBackupRoot"

        ClearErrors
        FileOpen $4 "$tmOldBackupRoot\.probe" w
        ${ifNot} ${Errors}
          FileClose $4
          Delete "$tmOldBackupRoot\.probe"
          Push ""
          Call un.tmAtomicMoveToBackup
          Pop $R0
          ${if} $R0 != 0
            DetailPrint "File is busy, aborting: $R0"
            Push ""
            Call un.tmRestoreFromBackup
            Pop $R0
            RMDir /r "$tmOldBackupRoot"
            Abort `Can't rename "$INSTDIR" to "$tmOldBackupRoot".`
          ${endIf}
          RMDir /r "$tmOldBackupRoot"
        ${else}
          ; 父目录不可写时检测主程序是否被锁，未锁再清理安装目录。
          ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
            ClearErrors
            Rename "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}.tm_bak"
            ${if} ${Errors}
              Abort `File is busy: "$INSTDIR\${APP_EXECUTABLE_FILENAME}".`
            ${endIf}
            Rename "$INSTDIR\${APP_EXECUTABLE_FILENAME}.tm_bak" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
          ${endIf}
        ${endIf}
      ${endIf}
    ${endIf}

    RMDir /r $INSTDIR
  !macroend
!endif
