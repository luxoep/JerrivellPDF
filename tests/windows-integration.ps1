# SPDX-License-Identifier: MIT OR Apache-2.0
# Exercise the real per-user registry and owned/unowned uninstall paths.
# Defaults are inspected but never changed. Finally restore the real candidate.
param([string]$Executable = (Join-Path $PSScriptRoot '../release/jerrivell-app/jerrivell-pdf.exe'))
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskExe = [IO.Path]::GetFullPath($Executable)
$taskScript = Join-Path $taskRoot 'scripts/windows-context-menu.ps1'
$taskRegistry = [Microsoft.Win32.Registry]::CurrentUser
$taskProg = 'Software\Classes\JerrivellPDF.Document'
$taskOpenWith = 'Software\Classes\.pdf\OpenWithProgids'
$taskCapabilities = 'Software\JerrivellPDF\Capabilities'
$taskRegistered = 'Software\RegisteredApplications'
$taskCommand = '"' + $taskExe + '" --open "%1"'
if (-not [IO.File]::Exists($taskExe)) { throw 'Build/install Jerrivell before this registry integration check.' }
function Read-TestValue([string]$Path,[string]$Name) {
    $taskKey = $taskRegistry.OpenSubKey($Path)
    if ($null -eq $taskKey) { return $null }
    try { return $taskKey.GetValue($Name) } finally { $taskKey.Dispose() }
}
function Read-TestSnapshot([string]$Path,[string]$Exclude = '') {
    $taskKey = $taskRegistry.OpenSubKey($Path)
    $taskValues = [ordered]@{}
    if ($null -ne $taskKey) {
        try {
            foreach ($taskName in ($taskKey.GetValueNames() | Sort-Object)) {
                if ($Exclude -ne '' -and $taskName -eq $Exclude) { continue }
                $taskValues[$taskName] = @{type=$taskKey.GetValueKind($taskName).ToString(); value=$taskKey.GetValue($taskName)}
            }
        } finally { $taskKey.Dispose() }
    }
    return ($taskValues | ConvertTo-Json -Compress -Depth 6)
}
function Assert-Test([bool]$Value,[string]$Message) { if (-not $Value) { throw $Message } }
$taskDefaultPath = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice'
$taskDefaultBefore = Read-TestSnapshot $taskDefaultPath
$taskExtensionBefore = Read-TestSnapshot 'Software\Classes\.pdf'
$taskOtherCandidates = Read-TestSnapshot $taskOpenWith 'JerrivellPDF.Document'
try {
    & $taskScript -Action Register -Executable $taskExe
    Assert-Test ((Read-TestValue ($taskProg+'\shell\open\command') '') -eq $taskCommand) 'ProgID command/quoting mismatch'
    Assert-Test ((Read-TestValue $taskOpenWith 'JerrivellPDF.Document') -ceq '') 'PDF OpenWith candidate missing'
    Assert-Test ((Read-TestValue $taskRegistered 'Jerrivell PDF') -eq $taskCapabilities) 'RegisteredApplications candidate missing'
    Assert-Test ((Read-TestValue ($taskCapabilities+'\FileAssociations') '.pdf') -eq 'JerrivellPDF.Document') 'PDF capability mismatch'
    Assert-Test ((Read-TestValue $taskCapabilities 'JerrivellOwnerPath') -eq $taskExe) 'Capabilities owner mismatch'
    # Simulate an older installation's uninstall command without inventing a
    # second executable or changing the current registration's owner.
    $taskOtherExe = Join-Path $taskRoot 'test-results/unowned older install/jerrivell-pdf.exe'
    & $taskScript -Action Unregister -Executable $taskOtherExe
    Assert-Test ((Read-TestValue ($taskProg+'\shell\open\command') '') -eq $taskCommand) 'Older installation removed the current ProgID'
    Assert-Test ((Read-TestValue $taskOpenWith 'JerrivellPDF.Document') -ceq '') 'Older installation removed current OpenWith candidate'
    Assert-Test ((Read-TestValue $taskCapabilities 'JerrivellOwnerPath') -eq $taskExe) 'Older installation removed current capabilities'
    Assert-Test ((Read-TestValue $taskRegistered 'Jerrivell PDF') -eq $taskCapabilities) 'Older installation removed current app registration'
    & $taskScript -Action Unregister -Executable $taskExe
    Assert-Test ($null -eq (Read-TestValue ($taskProg+'\shell\open\command') '')) 'Owned ProgID not removed'
    Assert-Test ($null -eq (Read-TestValue $taskOpenWith 'JerrivellPDF.Document')) 'Owned OpenWith value not removed'
    Assert-Test ($null -eq (Read-TestValue $taskRegistered 'Jerrivell PDF')) 'Owned app registration not removed'
    Assert-Test ($null -eq (Read-TestValue $taskCapabilities 'JerrivellOwnerPath')) 'Owned capabilities not removed'
} finally {
    & $taskScript -Action Register -Executable $taskExe
}
Assert-Test ((Read-TestSnapshot $taskDefaultPath) -ceq $taskDefaultBefore) 'UserChoice changed'
Assert-Test ((Read-TestSnapshot 'Software\Classes\.pdf') -ceq $taskExtensionBefore) 'PDF extension values changed'
Assert-Test ((Read-TestSnapshot $taskOpenWith 'JerrivellPDF.Document') -ceq $taskOtherCandidates) 'Other OpenWith candidates changed'
if (-not ('JerrivellAssociationQueryTest' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class JerrivellAssociationQueryTest {
    [DllImport("shlwapi.dll", CharSet=CharSet.Unicode)]
    public static extern int AssocQueryString(uint flags, uint kind, string assoc, string extra, StringBuilder output, ref uint length);
}
'@
}
$taskOutput = New-Object Text.StringBuilder 32768
$taskLength = [uint32]32768
$taskQueryResult = [JerrivellAssociationQueryTest]::AssocQueryString(0,2,'JerrivellPDF.Document','open',$taskOutput,[ref]$taskLength)
Assert-Test ($taskQueryResult -eq 0) ('Windows association query failed: '+$taskQueryResult)
Assert-Test ($taskOutput.ToString() -eq $taskExe) 'Windows association resolver selected a different executable'
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
$taskResults = Join-Path $taskRoot ('test-results/'+$taskVersion)
New-Item -ItemType Directory -Force -Path $taskResults | Out-Null
$taskReport = [ordered]@{status='PASS';executable=$taskExe;progId='JerrivellPDF.Document';candidateRegistered=$true;windowsAssociationResolver=$taskOutput.ToString();defaultUserChoiceUnchanged=$true;extensionValuesUnchanged=$true;otherCandidatesUnchanged=$true;olderUninstallPreservesCurrentOwner=$true;ownedUninstallCleanup=$true;finalRegistrationRestored=$true;defaultSettingsNotOpened=$true;scope='Real HKCU candidates/capabilities and uninstall ownership; Windows menu appearance and user choosing a default need UI verification'}
$taskReport | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskResults 'windows-integration.json') -Encoding UTF8
$taskReport | ConvertTo-Json -Depth 5
