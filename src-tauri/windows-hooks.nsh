; SPDX-License-Identifier: MIT OR Apache-2.0
; Per-user static PDF verb; do not change the user's default PDF association.
LangString JerrivellOpenLabel 2052 "使用 Jerrivell PDF 打开"
LangString JerrivellOpenLabel 1033 "Open with Jerrivell PDF"
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\JerrivellPDF" "" "$(JerrivellOpenLabel)"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\JerrivellPDF" "Icon" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\JerrivellPDF" "MultiSelectModel" "Single"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\JerrivellPDF\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "Jerrivell PDF"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open $\"%1$\"'
  ; Register an explicit PDF ProgID as a candidate, never set the .pdf default.
  WriteRegStr HKCU "Software\Classes\JerrivellPDF.Document" "" "Jerrivell PDF document"
  WriteRegStr HKCU "Software\Classes\JerrivellPDF.Document\DefaultIcon" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr HKCU "Software\Classes\JerrivellPDF.Document\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\JerrivellPDF.Document\Application" "ApplicationName" "Jerrivell PDF"
  WriteRegStr HKCU "Software\Classes\JerrivellPDF.Document\Application" "ApplicationIcon" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "JerrivellPDF.Document" ""
  WriteRegStr HKCU "Software\JerrivellPDF\Capabilities" "ApplicationName" "Jerrivell PDF"
  WriteRegStr HKCU "Software\JerrivellPDF\Capabilities" "ApplicationDescription" "Local open-source PDF workspace"
  WriteRegStr HKCU "Software\JerrivellPDF\Capabilities" "ApplicationIcon" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr HKCU "Software\JerrivellPDF\Capabilities" "JerrivellOwnerPath" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\JerrivellPDF\Capabilities\FileAssociations" ".pdf" "JerrivellPDF.Document"
  WriteRegStr HKCU "Software\RegisteredApplications" "Jerrivell PDF" "Software\JerrivellPDF\Capabilities"
  ; Send To is a compatible path on systems that suppress static shell verbs.
  CreateShortCut "$SENDTO\Jerrivell PDF.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro IsShortcutTarget "$SENDTO\Jerrivell PDF.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    Delete "$SENDTO\Jerrivell PDF.lnk"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\JerrivellPDF\command" ""
  ${If} $0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open $\"%1$\"'
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\JerrivellPDF"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" ""
  ${If} $0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open $\"%1$\"'
    DeleteRegKey HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\JerrivellPDF.Document\shell\open\command" ""
  ${If} $0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open $\"%1$\"'
    DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "JerrivellPDF.Document"
    DeleteRegKey HKCU "Software\Classes\JerrivellPDF.Document"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\JerrivellPDF\Capabilities" "JerrivellOwnerPath"
  ${If} $0 == "$INSTDIR\${MAINBINARYNAME}.exe"
    ReadRegStr $0 HKCU "Software\RegisteredApplications" "Jerrivell PDF"
    ${If} $0 == "Software\JerrivellPDF\Capabilities"
      DeleteRegValue HKCU "Software\RegisteredApplications" "Jerrivell PDF"
    ${EndIf}
    DeleteRegKey HKCU "Software\JerrivellPDF\Capabilities"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
