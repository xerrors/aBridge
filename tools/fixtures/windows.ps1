param([Parameter(Mandatory=$true)][string]$Receipt,[string]$Control,[long]$HostWindowId=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type 'using System;using System.Runtime.InteropServices;public static class FixtureNative{[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);}'
Add-Type 'using System;using System.Runtime.InteropServices;public static class FixtureFrame{[StructLayout(LayoutKind.Sequential)]public struct Rect{public int Left,Top,Right,Bottom;}[DllImport("dwmapi.dll")]public static extern int DwmGetWindowAttribute(IntPtr h,int attr,out Rect r,int size);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out Rect r);}'
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System -TypeDefinition @'
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public sealed class FixturePopup : Form {
 public bool PassThrough;
 protected override bool ShowWithoutActivation {get{return true;}}
 protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000080;if(PassThrough)p.ExStyle|=0x20;return p;}}
 protected override void WndProc(ref Message message){if(PassThrough&&message.Msg==0x84){message.Result=new IntPtr(-1);return;}base.WndProc(ref message);}
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child,IntPtr parent);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll",EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h,int index,IntPtr value);
}
'@
[void][FixtureNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
[Windows.Forms.Application]::EnableVisualStyles()
[Windows.Forms.Application]::SetUnhandledExceptionMode([Windows.Forms.UnhandledExceptionMode]::CatchException)
[Windows.Forms.Application]::add_ThreadException({
 param($sender,$eventArgs)
 $failure=@{phase='ui-thread';command=$script:lastFixtureCommand;error=$eventArgs.Exception.ToString()}
 $suffix=if($HostWindowId){'.hosted-error'}else{'.fixture-error'}
 if($Control){[IO.File]::WriteAllText($Control+$suffix,($failure | ConvertTo-Json -Depth 4))}
 [Console]::Error.WriteLine($failure.error)
 [Environment]::Exit(1)
})
if($HostWindowId){
 $hosted=New-Object FixturePopup;$hosted.TopLevel=$false;$hosted.Text='aBridge Fixture Hosted Content';$hosted.FormBorderStyle='None';$hosted.ShowInTaskbar=$false
 $hosted.Size=New-Object Drawing.Size(300,65)
 $hostedEdit=New-Object Windows.Forms.TextBox;$hostedEdit.AccessibleName='Fixture hosted text';$hostedEdit.Location=New-Object Drawing.Point(5,5);$hostedEdit.Size=New-Object Drawing.Size(150,25)
 $hostedButton=New-Object Windows.Forms.Button;$hostedButton.AccessibleName='Fixture hosted button';$hostedButton.Text='Hosted record';$hostedButton.Location=New-Object Drawing.Point(160,5);$hostedButton.Size=New-Object Drawing.Size(130,30)
 function Write-HostedState {
  $foreground=[FixturePopup]::GetForegroundWindow()
  @{text=$hostedEdit.Text;top_level=$hosted.TopLevel;foreground=$foreground.ToInt64();foreground_root=[FixturePopup]::GetAncestor($foreground,2).ToInt64()} | ConvertTo-Json | Set-Content -LiteralPath ($Control+'.hosted-state') -Encoding UTF8
 }
 $hostedEdit.Add_TextChanged({Write-HostedState})
 $script:hostedCount=0
 $hostedButton.Add_Click({$script:hostedCount++;@{count=$script:hostedCount;text=$hostedEdit.Text} | ConvertTo-Json | Set-Content -LiteralPath ($Control+'.hosted-effect') -Encoding UTF8})
 $hosted.Controls.AddRange(@($hostedEdit,$hostedButton))
 # Create a genuine child HWND before attaching or showing it; the WinForms
 # TopLevel state and native WS_CHILD style must agree throughout its lifetime.
 [void][FixturePopup]::SetParent($hosted.Handle,[IntPtr]$HostWindowId)
 [void][FixtureNative]::SetWindowPos($hosted.Handle,[IntPtr]::Zero,280,195,300,65,0x14)
 $hosted.Add_Shown({
  Write-HostedState
  @{pid=$PID;window_id=$hosted.Handle.ToInt64();root_window_id=[FixturePopup]::GetAncestor($hosted.Handle,2).ToInt64()} | ConvertTo-Json | Set-Content -LiteralPath ($Control+'.hosted-ready') -Encoding UTF8
 })
 [Windows.Forms.Application]::Run($hosted)
 return
}
$form=New-Object Windows.Forms.Form
$form.Text='aBridge Windows Fixture'
$form.Size=New-Object Drawing.Size(620,440)
$form.StartPosition='CenterScreen'
$form.TopMost=$true
$form.AutoScaleMode='None'
$edit=New-Object Windows.Forms.TextBox
$edit.AccessibleName='Fixture text'
$edit.Location=New-Object Drawing.Point(30,30)
$edit.Size=New-Object Drawing.Size(400,30)
$button=New-Object Windows.Forms.Button
$button.Text='Record fixture'
$button.AccessibleName='Record fixture'
$button.Location=New-Object Drawing.Point(30,90)
$button.Size=New-Object Drawing.Size(180,40)
$check=New-Object Windows.Forms.CheckBox
$check.Text='Fixture toggle'
$check.AccessibleName='Fixture toggle'
$check.Location=New-Object Drawing.Point(30,160)
$check.Size=New-Object Drawing.Size(200,30)
$password=New-Object Windows.Forms.TextBox
$password.AccessibleName='Fixture password'
$password.UseSystemPasswordChar=$true
$password.Text='fixture-secret-must-not-leak'
$password.Location=New-Object Drawing.Point(30,220)
$password.Size=New-Object Drawing.Size(200,30)
$pointer=New-Object Windows.Forms.Panel
$pointer.AccessibleName='Fixture pointer'
$pointer.AccessibleRole='StaticText'
$pointer.BackColor=[Drawing.Color]::LightBlue
$pointer.Location=New-Object Drawing.Point(300,100)
$pointer.Size=New-Object Drawing.Size(200,160)
$script:events=@{Left=0;Right=0;Middle=0;wheel=0;keys=0}
$pointer.Add_MouseDown({param($s,$e);$script:events[$e.Button.ToString()]++;if($Control -and (([FixtureNative]::GetAsyncKeyState(17) -band 0x8000) -ne 0)){[IO.File]::WriteAllText($Control+'.drag-started','started')}})
$script:wheelPoint=$null
$edit.Add_MouseWheel({param($s,$e);$script:events.wheel+=$e.Delta;$p=[Windows.Forms.Cursor]::Position;$script:wheelPoint=@{x=$p.X;y=$p.Y}})
$edit.Add_KeyDown({$script:events.keys++})
$script:popupOutsideCount=0
$edit.Add_MouseDown({if($Control -and $script:popup){$script:popupOutsideCount++;[IO.File]::WriteAllText($Control+'.popup-outside',[string]$script:popupOutsideCount)}})
$script:count=0
$button.Add_Click({
 $script:count++
 @{count=$script:count;text=$edit.Text;checked=$check.Checked;events=$script:events;wheel_point=$script:wheelPoint} | ConvertTo-Json | Set-Content -LiteralPath $Receipt -Encoding UTF8
})
$form.Controls.AddRange(@($edit,$button,$check,$password,$pointer))
# A deep but bounded native control tree, independent from application-specific UI.
$readonly=New-Object Windows.Forms.TextBox
$readonly.AccessibleName='Fixture readonly';$readonly.ReadOnly=$true;$readonly.Text='unchanged readonly'
$readonly.Location=New-Object Drawing.Point(30,250);$readonly.Size=New-Object Drawing.Size(230,22)
$form.Controls.Add($readonly)
$deepRoot=New-Object Windows.Forms.Panel
$deepRoot.AccessibleName='Fixture structural container';$deepRoot.Location=New-Object Drawing.Point(30,290);$deepRoot.Size=New-Object Drawing.Size(520,75)
$form.Controls.Add($deepRoot)
$deepParent=$deepRoot
for($level=1;$level -le 18;$level++){
 $nested=New-Object Windows.Forms.Panel;$nested.AccessibleName='Fixture structural level '+$level;$nested.Dock='Fill'
 $deepParent.Controls.Add($nested);$deepParent=$nested
}
$deepEdit=New-Object Windows.Forms.TextBox
$deepEdit.AccessibleName='Fixture deep text';$deepEdit.Location=New-Object Drawing.Point(5,5);$deepEdit.Size=New-Object Drawing.Size(280,25)
$deepButton=New-Object Windows.Forms.Button
$deepButton.Text='Deep record';$deepButton.AccessibleName='Fixture deep button';$deepButton.Location=New-Object Drawing.Point(300,5);$deepButton.Size=New-Object Drawing.Size(140,30)
$script:deepCount=0
$deepButton.Add_Click({$script:deepCount++;@{count=$script:deepCount;text=$deepEdit.Text} | ConvertTo-Json | Set-Content -LiteralPath ($Control+'.deep') -Encoding UTF8})
$deepParent.Controls.AddRange(@($deepEdit,$deepButton))
$timer=New-Object Windows.Forms.Timer
$timer.Interval=50
$script:commandReadRetryTimer=$null
$timer.Add_Tick({
 if($Control -and [IO.File]::Exists($Control)){
  try {$command=[IO.File]::ReadAllText($Control);[IO.File]::Delete($Control)}
  catch {
   $failure=$_.Exception.GetBaseException()
   # Publication/inspection can briefly retain a Windows handle. No command has
   # run yet: defer only sharing/lock violations for at most one second.
   if($failure -is [IO.IOException] -and ($failure.HResult -band 0xFFFF) -in @(32,33)){
    if($null -eq $script:commandReadRetryTimer){$script:commandReadRetryTimer=[Diagnostics.Stopwatch]::StartNew()}
    if($script:commandReadRetryTimer.ElapsedMilliseconds -lt 1000){return}
   }
   throw
  }
  $script:commandReadRetryTimer=$null
  $script:lastFixtureCommand=$command
  switch($command){
   'foreign-foreground' {$script:foreign=New-Object Windows.Forms.Form;$script:foreign.Text='aBridge Fixture Other Target';$script:foreign.Size=New-Object Drawing.Size(220,160);$script:foreign.StartPosition='Manual';$script:foreign.Location=$form.Location;$script:foreign.TopMost=$true;$script:foreign.Show();$script:foreign.Activate()}
   'restore-foreground' {if($script:foreign){$script:foreign.Close();$script:foreign=$null};$form.Activate()}
   'minimize' {$form.WindowState='Minimized'}
   'restore' {$form.WindowState='Normal';$form.Activate()}
   'maximize' {$form.WindowState='Maximized';$form.Activate()}
   'workarea-edge' {
    $screen=[Windows.Forms.Screen]::FromHandle($form.Handle);$work=$screen.WorkingArea;$monitor=$screen.Bounds
    $edge=$null
    if($work.Left -gt $monitor.Left){$edge='left'}
    elseif($work.Top -gt $monitor.Top){$edge='top'}
    elseif($work.Right -lt $monitor.Right){$edge='right'}
    elseif($work.Bottom -lt $monitor.Bottom){$edge='bottom'}
    $result=@{edge=$edge}
    if($edge){
     $script:edgeOriginalBounds=$form.Bounds;$script:edgeOriginalBorder=$form.FormBorderStyle
     $form.WindowState='Normal';$form.FormBorderStyle='None'
     $width=[Math]::Min(620,$work.Width);$height=[Math]::Min(440,$work.Height)
     $x=$work.Left+[int](($work.Width-$width)/2);$y=$work.Top+[int](($work.Height-$height)/2)
     switch($edge){
      'left' {$x=$work.Left-1;$width++}
      'top' {$y=$work.Top-1;$height++}
      'right' {$x=$work.Right-$width;$width++}
      'bottom' {$y=$work.Bottom-$height;$height++}
     }
     $form.SetBounds($x,$y,$width,$height);$form.Activate()
     $result.bounds=@{x=[Math]::Max($x,$work.Left);y=[Math]::Max($y,$work.Top);width=$width-([int]($edge -in @('left','right')));height=$height-([int]($edge -in @('top','bottom')))}
    }
    $result | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath ($Control+'.workarea') -Encoding UTF8
   }
   'workarea-restore' {if($script:edgeOriginalBounds){$form.FormBorderStyle=$script:edgeOriginalBorder;$form.Bounds=$script:edgeOriginalBounds;$form.Activate()}}
   'frame' {$outer=New-Object FixtureFrame+Rect;$visible=New-Object FixtureFrame+Rect;[void][FixtureFrame]::GetWindowRect($form.Handle,[ref]$outer);$hr=[FixtureFrame]::DwmGetWindowAttribute($form.Handle,9,[ref]$visible,16);@{outer=$outer;visible=$visible;hr=$hr} | ConvertTo-Json | Set-Content -LiteralPath ($Control+'.frame') -Encoding UTF8}
   'border-cover' {$visible=New-Object FixtureFrame+Rect;if([FixtureFrame]::DwmGetWindowAttribute($form.Handle,9,[ref]$visible,16) -ne 0){throw 'fixture_frame_unavailable'};$script:cover=New-Object Windows.Forms.Form;$script:cover.Text='aBridge Fixture Border Neighbour';$script:cover.FormBorderStyle='None';$script:cover.Size=New-Object Drawing.Size(160,24);$script:cover.Location=New-Object Drawing.Point(($visible.Left+30),$visible.Bottom);$script:cover.StartPosition='Manual';$script:cover.TopMost=$true;$script:cover.Show();$form.Activate();[void][FixtureNative]::SetWindowPos($script:cover.Handle,[IntPtr](-1),0,0,0,0,0x13)}
   'move' {$form.Left+=20}
   'disable' {$button.Enabled=$false}
   'geometry' {$p=$pointer.RectangleToScreen($pointer.ClientRectangle);$e=$edit.RectangleToScreen($edit.ClientRectangle);@{pointer=@{x=$p.X;y=$p.Y;width=$p.Width;height=$p.Height};edit=@{x=$e.X;y=$e.Y;width=$e.Width;height=$e.Height}} | ConvertTo-Json | Set-Content -LiteralPath ($Control+'.geometry') -Encoding UTF8}
   'state' {$foreground=[FixturePopup]::GetForegroundWindow();@{text=$edit.Text;count=$script:count;edit_focused=$edit.Focused;button_focused=$button.Focused;active_control=if($form.ActiveControl){$form.ActiveControl.AccessibleName}else{$null};foreground=$foreground.ToInt64();foreground_root=[FixturePopup]::GetAncestor($foreground,2).ToInt64();events=$script:events} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath ($Control+'.state') -Encoding UTF8}
   'key-state' {$held=@();foreach($k in @(1,2,4,16,17,18,91)){if(([FixtureNative]::GetAsyncKeyState($k) -band 0x8000) -ne 0){$held+= $k}};ConvertTo-Json -InputObject @($held) | Set-Content -LiteralPath ($Control+'.keys') -Encoding UTF8}
   'cover' {$script:cover=New-Object Windows.Forms.Form;$script:cover.Text='aBridge Fixture Occluder';$script:cover.Size=New-Object Drawing.Size(200,200);$script:cover.Location=$form.Location;$script:cover.StartPosition='Manual';$script:cover.TopMost=$true;$script:cover.Show();$form.Activate();[void][FixtureNative]::SetWindowPos($script:cover.Handle,[IntPtr](-1),0,0,0,0,0x13)}
   {$_ -in @('owned-passive','owned-layered-passive','owned-interactive','foreign-passive')} {
    $focusBefore=[FixturePopup]::GetForegroundWindow().ToInt64()
    if($script:popup){$script:popup.Close()}
    $focusAfterClose=[FixturePopup]::GetForegroundWindow().ToInt64()
    $form.Activate()
    $script:popup=New-Object FixturePopup
    $script:popup.PassThrough=$command -ne 'owned-interactive'
    $script:popup.Text='aBridge Fixture Popup';$script:popup.FormBorderStyle='None';$script:popup.ShowInTaskbar=$false
    $script:popup.StartPosition='Manual';$script:popup.Size=New-Object Drawing.Size(200,48)
    $script:popup.Location=$form.PointToScreen((New-Object Drawing.Point(40,130)))
    $script:popup.BackColor=[Drawing.Color]::LightGoldenrodYellow;$script:popup.TopMost=$true
    if($command -eq 'owned-layered-passive'){$script:popup.Opacity=0.95}
    if($command -eq 'owned-interactive'){
     $popupButton=New-Object Windows.Forms.Button;$popupButton.Text='Popup action';$popupButton.Dock='Fill'
     $popupButton.Add_Click({[IO.File]::WriteAllText($Control+'.popup-dispatched','unexpected input')})
     $script:popup.Controls.Add($popupButton)
    }
    if($command -eq 'foreign-passive'){$script:popup.Show()}else{$script:popup.Show($form)}
    $focusAfterShow=[FixturePopup]::GetForegroundWindow().ToInt64()
    # Establish focus explicitly after the WinForms popup lifecycle, as in the
    # existing cover fixture: owner keeps focus, popup keeps its topmost Z order.
    $form.Activate()
    [void][FixtureNative]::SetWindowPos($script:popup.Handle,[IntPtr](-1),0,0,0,0,0x13)
    $p=$script:popup.Bounds
    @{command=$command;window_id=$script:popup.Handle.ToInt64();owner=[FixturePopup]::GetWindow($script:popup.Handle,4).ToInt64();focus_before=$focusBefore;focus_after_close=$focusAfterClose;focus_after_show=$focusAfterShow;foreground=[FixturePopup]::GetForegroundWindow().ToInt64();extended_style=[FixturePopup]::GetWindowLongPtr($script:popup.Handle,-20).ToInt64();bounds=@{x=$p.X;y=$p.Y;width=$p.Width;height=$p.Height}} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath ($Control+'.popup') -Encoding UTF8
   }
   'popup-close' {if($script:popup){$script:popup.Close();$script:popup=$null};$form.Activate()}
   'hosted-reparent' {
    $hostedInfo=[IO.File]::ReadAllText($Control+'.hosted-ready') | ConvertFrom-Json
    $work=[Windows.Forms.Screen]::FromHandle($form.Handle).WorkingArea
    $script:otherHost=New-Object FixturePopup;$script:otherHost.Text='aBridge Fixture Other Host';$script:otherHost.Size=New-Object Drawing.Size(340,120)
    $script:otherHost.StartPosition='Manual';$script:otherHost.Location=New-Object Drawing.Point(($work.Right-350),($work.Top+30));$script:otherHost.TopMost=$true;$script:otherHost.Show()
    [void][FixturePopup]::SetParent([IntPtr]$hostedInfo.window_id,$script:otherHost.Handle)
    [void][FixtureNative]::SetWindowPos([IntPtr]$hostedInfo.window_id,[IntPtr]::Zero,5,5,300,65,0x54)
    $form.Activate();[void][FixtureNative]::SetWindowPos($script:otherHost.Handle,[IntPtr](-1),0,0,0,0,0x13)
   }
   'hosted-close' {if($script:otherHost){$script:otherHost.Close();$script:otherHost=$null};$form.Activate()}
   'same-process-reparent' {
    $work=[Windows.Forms.Screen]::FromHandle($form.Handle).WorkingArea
    $script:otherHost=New-Object FixturePopup;$script:otherHost.Text='aBridge Fixture Other Host';$script:otherHost.Size=New-Object Drawing.Size(340,120)
    $script:otherHost.StartPosition='Manual';$script:otherHost.Location=New-Object Drawing.Point(($work.Right-350),($work.Top+30));$script:otherHost.TopMost=$true
    $script:otherHost.Controls.Add($deepButton);$deepButton.Location=New-Object Drawing.Point(10,10);$script:otherHost.Show()
    $form.Activate();[void][FixtureNative]::SetWindowPos($script:otherHost.Handle,[IntPtr](-1),0,0,0,0,0x13)
   }
   'same-process-restore' {$deepParent.Controls.Add($deepButton);$deepButton.Location=New-Object Drawing.Point(300,5);if($script:otherHost){$script:otherHost.Close();$script:otherHost=$null};$form.Activate()}
   'uncover' {if($script:cover){$script:cover.Close()};$form.Activate()}
  }
  # Publish acknowledgement only after all command effects and receipt writes finish.
  [IO.File]::WriteAllText($Control+'.done.pending',$command)
  [IO.File]::Move($Control+'.done.pending',$Control+'.done')
 }
})
$timer.Start()
$form.Add_Shown({[void][FixtureNative]::ShowWindow($form.Handle,5)})
[Windows.Forms.Application]::Run($form)
$timer.Dispose()
