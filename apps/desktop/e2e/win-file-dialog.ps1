# Drives the real Windows "Open" dialog for native-dialog.spec.ts (test-only).
# Finds the dialog by title with UI Automation, then either types -File into the
# File name box and presses Open, or presses Cancel. Synthetic export paths only.
# The footer controls are classic Win32 controls (some Windows builds expose them
# to UI Automation without Value/Invoke patterns), so they are driven with
# WM_SETTEXT and BM_CLICK on their window handles.
param(
  [Parameter(Mandatory)] [string] $Title,
  [string] $File,
  [switch] $Cancel,
  [int] $TimeoutSec = 20
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace UgcTest -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern System.IntPtr SendMessage(System.IntPtr hWnd, uint msg, System.IntPtr wParam, string lParam);
'@
$A = [System.Windows.Automation.AutomationElement]
$P = [System.Windows.Automation.PropertyCondition]
$Scope = [System.Windows.Automation.TreeScope]
$WM_SETTEXT = 0x000C
$BM_CLICK = 0x00F5

function Find-Within($parent, $property1, $value1, $property2, $value2) {
  [System.Windows.Automation.Condition[]] $both = (New-Object $P($property1, $value1)), (New-Object $P($property2, $value2))
  $condition = New-Object System.Windows.Automation.AndCondition(, $both)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $found = $parent.FindFirst($Scope::Descendants, $condition)
    if ($found -and $found.Current.NativeWindowHandle -ne 0) { return $found }
    Start-Sleep -Milliseconds 200
  }
  throw "dialog control not found"
}

# Standard common-dialog control IDs: 1148 File name edit, 1 Open, 2 Cancel.
$dialog = Find-Within $A::RootElement $A::NameProperty $Title $A::ClassNameProperty '#32770'
if (-not $Cancel) {
  $edit = Find-Within $dialog $A::AutomationIdProperty '1148' $A::ClassNameProperty 'Edit'
  [void][UgcTest.Win32]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, $WM_SETTEXT, [IntPtr]::Zero, $File)
}
$button = Find-Within $dialog $A::AutomationIdProperty $(if ($Cancel) { '2' } else { '1' }) $A::ClassNameProperty 'Button'
[void][UgcTest.Win32]::SendMessage([IntPtr]$button.Current.NativeWindowHandle, $BM_CLICK, [IntPtr]::Zero, $null)
'ok'
