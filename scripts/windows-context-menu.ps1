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
$taskRegistry = [Microsoft.Win32.Registry]::CurrentUser
$taskLink = Join-Path ([Environment]::GetFolderPath('SendTo')) 'Jerrivell PDF.lnk'
$taskShell = New-Object -ComObject WScript.Shell
if ($Action -eq 'Register') {
    if (-not [IO.File]::Exists($taskExe)) { throw "Executable does not exist: $taskExe" }
    $taskValues = @{
        $taskVerb = @{ ''='使用 Jerrivell PDF 打开'; Icon=('"'+$taskExe+'",0'); MultiSelectModel='Single' }
        ($taskVerb+'\command') = @{ ''=$taskCommand }
        $taskApp = @{ FriendlyAppName='Jerrivell PDF' }
        ($taskApp+'\SupportedTypes') = @{ '.pdf'='' }
        ($taskApp+'\shell\open\command') = @{ ''=$taskCommand }
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
        $taskKey = $taskRegistry.OpenSubKey($taskPath+$taskSuffix)
        $taskValue = if ($null -ne $taskKey) { try { $taskKey.GetValue('') } finally { $taskKey.Dispose() } } else { $null }
        if ($taskValue -eq $taskCommand) { $taskRegistry.DeleteSubKeyTree($taskPath,$false) }
        elseif ($null -ne $taskValue) { Write-Warning "Kept registration belonging to another executable: $taskPath" }
    }
}
Write-Output "$Action completed for current user: $taskExe"
