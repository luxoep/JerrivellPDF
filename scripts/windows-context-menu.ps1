# SPDX-License-Identifier: MIT OR Apache-2.0
param(
    [ValidateSet('Register','Unregister')][string]$Action = 'Register',
    [string]$Executable = (Join-Path $PSScriptRoot '../release/jerrivell-app/jerrivell-pdf.exe')
)
$ErrorActionPreference = 'Stop'
$taskExe = [IO.Path]::GetFullPath($Executable)
if ([IO.Path]::GetFileName($taskExe) -ne 'jerrivell-pdf.exe') { throw 'Expected jerrivell-pdf.exe' }
$taskCommand = '"' + $taskExe + '" --open "%1"'
$taskVerb = 'Software\Classes\SystemFileAssociations\.pdf\shell\JerrivellPDF'
$taskApp = 'Software\Classes\Applications\jerrivell-pdf.exe'
$taskProg = 'Software\Classes\JerrivellPDF.Document'
$taskOpenWith = 'Software\Classes\.pdf\OpenWithProgids'
$taskCapabilities = 'Software\JerrivellPDF\Capabilities'
$taskRegistered = 'Software\RegisteredApplications'
$taskRegistry = [Microsoft.Win32.Registry]::CurrentUser
$taskLink = Join-Path ([Environment]::GetFolderPath('SendTo')) 'Jerrivell PDF.lnk'
$taskShell = New-Object -ComObject WScript.Shell
function Get-TaskRegistryValue([string]$Path, [string]$Name) {
    $taskKey = $taskRegistry.OpenSubKey($Path)
    if ($null -eq $taskKey) { return $null }
    try { return $taskKey.GetValue($Name) } finally { $taskKey.Dispose() }
}
function Remove-TaskRegistryValue([string]$Path, [string]$Name) {
    $taskKey = $taskRegistry.OpenSubKey($Path,$true)
    if ($null -ne $taskKey) { try { $taskKey.DeleteValue($Name,$false) } finally { $taskKey.Dispose() } }
}
if ($Action -eq 'Register') {
    if (-not [IO.File]::Exists($taskExe)) { throw "Executable does not exist: $taskExe" }
    $taskValues = @{
        $taskVerb = @{ ''='使用 Jerrivell PDF 打开'; Icon=('"'+$taskExe+'",0'); MultiSelectModel='Single' }
        ($taskVerb+'\command') = @{ ''=$taskCommand }
        $taskApp = @{ FriendlyAppName='Jerrivell PDF' }
        ($taskApp+'\DefaultIcon') = @{ ''=('"'+$taskExe+'",0') }
        ($taskApp+'\SupportedTypes') = @{ '.pdf'='' }
        ($taskApp+'\shell\open\command') = @{ ''=$taskCommand }
        $taskProg = @{ ''='Jerrivell PDF document' }
        ($taskProg+'\DefaultIcon') = @{ ''=('"'+$taskExe+'",0') }
        ($taskProg+'\shell\open\command') = @{ ''=$taskCommand }
        ($taskProg+'\Application') = @{ ApplicationName='Jerrivell PDF'; ApplicationIcon=('"'+$taskExe+'",0') }
        $taskOpenWith = @{ 'JerrivellPDF.Document'='' }
        $taskCapabilities = @{ ApplicationName='Jerrivell PDF'; ApplicationDescription='Local open-source PDF workspace'; ApplicationIcon=('"'+$taskExe+'",0'); JerrivellOwnerPath=$taskExe }
        ($taskCapabilities+'\FileAssociations') = @{ '.pdf'='JerrivellPDF.Document' }
        $taskRegistered = @{ 'Jerrivell PDF'=$taskCapabilities }
    }
    foreach ($taskPath in $taskValues.Keys) {
        $taskKey = $taskRegistry.CreateSubKey($taskPath)
        try { foreach ($taskName in $taskValues[$taskPath].Keys) { $taskKey.SetValue($taskName,$taskValues[$taskPath][$taskName],[Microsoft.Win32.RegistryValueKind]::String) } }
        finally { $taskKey.Dispose() }
    }
    $taskShortcut = $taskShell.CreateShortcut($taskLink)
    $taskShortcut.TargetPath = $taskExe
    $taskShortcut.Arguments = ''
    $taskShortcut.IconLocation = $taskExe + ',0'
    $taskShortcut.Save()
} else {
    if ([IO.File]::Exists($taskLink)) {
        $taskShortcut = $taskShell.CreateShortcut($taskLink)
        if ($taskShortcut.TargetPath -eq $taskExe) { Remove-Item -LiteralPath $taskLink }
    }
    foreach ($taskPath in @($taskVerb,$taskApp)) {
        $taskSuffix = if ($taskPath -eq $taskVerb) { '\command' } else { '\shell\open\command' }
        $taskValue = Get-TaskRegistryValue ($taskPath+$taskSuffix) ''
        if ($taskValue -eq $taskCommand) { $taskRegistry.DeleteSubKeyTree($taskPath,$false) }
        elseif ($null -ne $taskValue) { Write-Warning "Kept registration belonging to another executable: $taskPath" }
    }
    if ((Get-TaskRegistryValue ($taskProg+'\shell\open\command') '') -eq $taskCommand) {
        Remove-TaskRegistryValue $taskOpenWith 'JerrivellPDF.Document'
        $taskRegistry.DeleteSubKeyTree($taskProg,$false)
    }
    if ((Get-TaskRegistryValue $taskCapabilities 'JerrivellOwnerPath') -eq $taskExe) {
        if ((Get-TaskRegistryValue $taskRegistered 'Jerrivell PDF') -eq $taskCapabilities) {
            Remove-TaskRegistryValue $taskRegistered 'Jerrivell PDF'
        }
        $taskRegistry.DeleteSubKeyTree($taskCapabilities,$false)
    }
}
if (-not ('JerrivellShellAssociationNotify' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JerrivellShellAssociationNotify {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
}
[JerrivellShellAssociationNotify]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)
Write-Output "$Action completed for current user: $taskExe"
