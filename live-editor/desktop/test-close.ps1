param([string]$Executable = (Join-Path $PSScriptRoot 'build-slim\录播机.exe'))
$ErrorActionPreference = 'Stop'
$closeScreenshotPath = $env:CAIBO_TEST_CLOSE_SCREENSHOT
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\dev-env.ps1')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$closeAssembly = [Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$closeType = $closeAssembly.GetType('LiveRecorderDesktop.CloseChoiceDialog', $true)
$closeFlags = [Reflection.BindingFlags]'NonPublic,Instance'
function New-CloseDialog { $closeType.GetConstructor($closeFlags,$null,[type[]]@(),$null).Invoke(@()) }
function Assert-Close([bool]$Condition,[string]$Message) { if (!$Condition) { throw $Message } }
function Click-CloseAction($Dialog,[string]$Action) {
    # Raise the actual button handler without displaying a test window.
    [Windows.Forms.Button].GetMethod('OnClick',$closeFlags).Invoke($Dialog.Controls[$Action],@([EventArgs]::Empty)) | Out-Null
}
    foreach ($closeRemember in @($false,$true)) {
        foreach ($closeAction in @('exit','background')) {
            $closeDialog=New-CloseDialog
            try {
                Assert-Close (!$closeDialog.Controls['remember'].Checked) '不再提示应默认未勾选。'
                $closeDialog.Controls['remember'].Checked=$closeRemember
                Click-CloseAction $closeDialog $closeAction
                Assert-Close ($closeDialog.DialogResult -eq [Windows.Forms.DialogResult]::OK) '未确认所选关闭动作。'
                Assert-Close ($closeType.GetProperty('SelectedAction',$closeFlags).GetValue($closeDialog) -eq $closeAction) '所选动作与按钮不一致。'
                Assert-Close ($closeType.GetProperty('RememberSelection',$closeFlags).GetValue($closeDialog) -eq $closeRemember) '不再提示勾选结果丢失。'
            } finally { $closeDialog.Dispose() }
        }
    }
$closeDialog=New-CloseDialog
try {
    $closeDialog.Controls['remember'].Checked=$true
    $closeArguments=[object[]]@([Windows.Forms.Message]::new(),[Windows.Forms.Keys]::Escape)
    Assert-Close ($closeType.GetMethod('ProcessCmdKey',$closeFlags).Invoke($closeDialog,$closeArguments)) 'Escape 未取消。'
    Assert-Close ($closeDialog.DialogResult -eq [Windows.Forms.DialogResult]::Cancel) '取消被误认为确认。'
    Assert-Close ($closeType.GetProperty('SelectedAction',$closeFlags).GetValue($closeDialog) -eq '') '取消不应选择或记住动作。'
} finally { $closeDialog.Dispose() }
$closeDialog=New-CloseDialog
try {
    if ($closeScreenshotPath) {
        $null=$closeDialog.Handle
        foreach ($closeControl in $closeDialog.Controls) { $null=$closeControl.Handle }
        $closeBitmap=[Drawing.Bitmap]::new($closeDialog.Width,$closeDialog.Height)
        try { $closeDialog.DrawToBitmap($closeBitmap,[Drawing.Rectangle]::new(0,0,$closeDialog.Width,$closeDialog.Height)); $closeBitmap.Save([IO.Path]::GetFullPath($closeScreenshotPath),[Drawing.Imaging.ImageFormat]::Png) } finally { $closeBitmap.Dispose() }
    }
    $closeDialog.Close()
    Assert-Close ($closeDialog.DialogResult -ne [Windows.Forms.DialogResult]::OK) '关闭弹窗被误认为确认。'
    Assert-Close ($closeType.GetProperty('SelectedAction',$closeFlags).GetValue($closeDialog) -eq '') '关闭弹窗不应选择动作。'
} finally { $closeDialog.Dispose() }
$confirmType=$closeAssembly.GetType('LiveRecorderDesktop.ExitConfirmationDialog',$true)
function New-ExitConfirmation { $confirmType.GetConstructor($closeFlags,$null,[type[]]@(),$null).Invoke(@()) }
foreach ($confirmAction in @('cancel','confirm')) {
    $confirmDialog=New-ExitConfirmation
    try {
        Assert-Close ($confirmDialog.AcceptButton -eq $confirmDialog.Controls['cancel']) '回车应默认取消。'
        Assert-Close ($confirmDialog.CancelButton -eq $confirmDialog.Controls['cancel']) 'Escape 应取消。'
        $confirmLabel=$confirmDialog.Controls | Where-Object { $_ -is [Windows.Forms.Label] }
        Assert-Close ($confirmLabel.Text -eq '当前有任务正在进行中，退出可能会导致中断，是否继续') '任务退出确认文案不符。'
        foreach ($confirmControl in $confirmDialog.Controls) { Assert-Close ($confirmDialog.ClientRectangle.Contains($confirmControl.Bounds)) '确认控件超出窗口。' }
        $confirmDialog.CreateControl()
        [Windows.Forms.Button].GetMethod('OnClick',$closeFlags).Invoke($confirmDialog.Controls[$confirmAction],@([EventArgs]::Empty)) | Out-Null
        # Button DialogResult is applied by WinForms when shown. Test its native
        # decision directly without displaying or manipulating a user's window.
        $expected=if($confirmAction -eq 'confirm'){[Windows.Forms.DialogResult]::OK}else{[Windows.Forms.DialogResult]::Cancel}
        Assert-Close ($confirmDialog.Controls[$confirmAction].DialogResult -eq $expected) '确认/取消按钮结果不符。'
    } finally { $confirmDialog.Dispose() }
}
$confirmDialog=New-ExitConfirmation
try { $confirmDialog.Close(); Assert-Close ($confirmDialog.DialogResult -ne [Windows.Forms.DialogResult]::OK) '关闭确认弹窗应取消退出。' } finally { $confirmDialog.Dispose() }
'关闭选择与任务确认测试通过：退出/后台、不再提示、确认/取消、默认取消、窗口关闭取消。'
