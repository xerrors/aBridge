
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing,System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[ComImport,Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IABAutomation {
 void CompareElements(IABElement a,IABElement b,out bool same);
 void CompareRuntimeIds(IntPtr a,IntPtr b,out bool same);
 IABElement GetRootElement();
 IABElement ElementFromHandle(IntPtr h);
 void ElementFromPoint(); void GetFocusedElement(); void GetRootElementBuildCache();
 void ElementFromHandleBuildCache(); void ElementFromPointBuildCache(); void GetFocusedElementBuildCache();
 void CreateTreeWalker();
 IABWalker GetControlViewWalker();
}
[ComImport,Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IABElement {
 void SetFocus(); void GetRuntimeId(); void FindFirst(); void FindAll();
 void FindFirstBuildCache(); void FindAllBuildCache(); void BuildUpdatedCache();
 [return:MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int id);
 void GetCurrentPropertyValueEx(); void GetCachedPropertyValue(); void GetCachedPropertyValueEx();
 void GetCurrentPatternAs(); void GetCachedPatternAs();
 [return:MarshalAs(UnmanagedType.IUnknown)] object GetCurrentPattern(int id);
}
[ComImport,Guid("4042c624-389c-4afc-a630-9df854a541fc"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IABWalker {
 IABElement GetParentElement(IABElement e);
 IABElement GetFirstChildElement(IABElement e);
 IABElement GetLastChildElement(IABElement e);
 IABElement GetNextSiblingElement(IABElement e);
}
[ComImport,Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IABInvoke {void Invoke();}
[ComImport,Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IABValue {void SetValue([MarshalAs(UnmanagedType.BStr)] string value); [return:MarshalAs(UnmanagedType.BStr)] string GetValue();}
[ComImport,Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IABToggle {void Toggle();}
[ComImport,Guid("a8efa66a-0fda-421a-9194-38021f3578ea"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IABSelection {void Select();}
public sealed class ABUiaBounds {
 public double X,Y,Width,Height;
 public bool IsEmpty {get{return Width<=0||Height<=0;}}
}
public sealed class ABUiaInfo {
 public string Name,ControlType;
 public bool IsPassword,IsEnabled,IsOffscreen;
 public int ProcessId;
 public ABUiaBounds BoundingRectangle;
}
public sealed class ABUia {
 static readonly IABAutomation api=(IABAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e")));
 static readonly IABWalker walker=api.GetControlViewWalker();
 public static bool Ready(){return api!=null&&walker!=null;}
 readonly IABElement element;
 ABUia(IABElement e){element=e;}
 static ABUia Wrap(IABElement e){return e==null?null:new ABUia(e);}
 public static ABUia FromHandle(IntPtr h){return Wrap(api.ElementFromHandle(h));}
 public long NativeWindowHandle {get{return unchecked((uint)Convert.ToInt32(Property(30020)));}}
 public void Focus(){element.SetFocus();}
 public ABUia Parent(){return Wrap(walker.GetParentElement(element));}
 public bool Same(ABUia other){if(other==null)return false;bool same;api.CompareElements(element,other.element,out same);return same;}
 public ABUia FirstChild(){return Wrap(walker.GetFirstChildElement(element));}
 public ABUia NextSibling(){return Wrap(walker.GetNextSiblingElement(element));}
 object Property(int id){return element.GetCurrentPropertyValue(id);}
 public ABUiaInfo Current {get{
  var r=Property(30001) as double[];var bounds=new ABUiaBounds();
  if(r!=null&&r.Length==4){bounds.X=r[0];bounds.Y=r[1];bounds.Width=r[2];bounds.Height=r[3];}
  int kind=Convert.ToInt32(Property(30003));
  string[] names={"Button","Calendar","CheckBox","ComboBox","Edit","Hyperlink","Image","ListItem","List","Menu","MenuBar","MenuItem","ProgressBar","RadioButton","ScrollBar","Slider","Spinner","StatusBar","Tab","TabItem","Text","ToolBar","ToolTip","Tree","TreeItem","Custom","Group","Thumb","DataGrid","DataItem","Document","SplitButton","Window","Pane","Header","HeaderItem","Table","TitleBar","Separator","SemanticZoom","AppBar"};
  return new ABUiaInfo{Name=Property(30005) as string,ControlType=kind>=50000&&kind<50000+names.Length?names[kind-50000]:"Custom",IsPassword=Convert.ToBoolean(Property(30019)),IsEnabled=Convert.ToBoolean(Property(30010)),IsOffscreen=Convert.ToBoolean(Property(30022)),ProcessId=Convert.ToInt32(Property(30002)),BoundingRectangle=bounds};
 }}
 object Pattern(int id){try{return element.GetCurrentPattern(id);}catch(COMException){return null;}}
 public bool HasPattern(int id){return Pattern(id)!=null;}
 public bool IsValueReadOnly(){try{var value=Property(30046);return !(value is bool)||(bool)value;}catch(COMException){return true;}}
 public string Value(){var p=Pattern(10002) as IABValue;return p==null?null:p.GetValue();}
 public void SetValue(string value){var p=Pattern(10002) as IABValue;if(p==null||IsValueReadOnly())throw new Exception("unsupported_element_action");p.SetValue(value);}
 public void Click(){
  var invoke=Pattern(10000) as IABInvoke;if(invoke!=null){invoke.Invoke();return;}
  var toggle=Pattern(10015) as IABToggle;if(toggle!=null){toggle.Toggle();return;}
  var select=Pattern(10010) as IABSelection;if(select!=null){select.Select();return;}
  throw new Exception("unsupported_element_action");
 }
}

public static class ABWin {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; public Point(int x,int y){X=x;Y=y;} }
 [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct Key { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Key key; }
 [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Union u; }
 delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h,int attr,out int value,int size);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h,int attr,out Rect value,int size);
 [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h,out uint key,out byte alpha,out uint flags);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h,uint command);
 public static long Owner(long hwnd){return GetWindow(new IntPtr(hwnd),4).ToInt64();}
 public static string Style(long hwnd,bool extended){return "0x"+GetWindowLongPtr(new IntPtr(hwnd),extended?-20:-16).ToInt64().ToString("X");}
 public static bool PassiveOwnedOverlay(long hwnd,long target){
   // Only screenshot occlusion uses this exception. The visible overlay remains
   // in the image and Guard-Point still rejects every pixel under its bounds.
   if(hwnd==target||GetForegroundWindow().ToInt64()!=target||Owner(hwnd)!=target||Pid(hwnd)!=Pid(target))return false;
   long style=GetWindowLongPtr(new IntPtr(hwnd),-20).ToInt64();
   return (style&0x080000A0)==0x080000A0; // NOACTIVATE | TOOLWINDOW | TRANSPARENT
 }
 public static bool Cloaked(long hwnd){int cloaked;return DwmGetWindowAttribute(new IntPtr(hwnd),14,out cloaked,4)==0&&cloaked!=0;}
 public static bool Transparent(long hwnd){uint key,flags;byte alpha;return GetLayeredWindowAttributes(new IntPtr(hwnd),out key,out alpha,out flags)&&(flags&2)!=0&&alpha==0;}
 public static bool NonInteractiveOverlay(long hwnd){long style=GetWindowLongPtr(new IntPtr(hwnd),-20).ToInt64();uint key,flags;byte alpha;return (style&0x8080020)==0x8080020&&GetLayeredWindowAttributes(new IntPtr(hwnd),out key,out alpha,out flags)&&((flags&1)!=0||alpha==0);}
 public static bool OwnIndicator(long hwnd){int pid;long style=GetWindowLongPtr(new IntPtr(hwnd),-20).ToInt64();return int.TryParse(Environment.GetEnvironmentVariable("ABRIDGE_INDICATOR_PID"),out pid)&&pid>0&&Pid(hwnd)==pid&&(style&0x8080020)==0x8080020;}
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor,Work; public uint Flags; }
 [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Rect r,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr h,ref MonitorInfo info);
 public static Rect CaptureBounds(Rect r){
   var monitor=MonitorFromRect(ref r,0);var info=new MonitorInfo{Size=Marshal.SizeOf(typeof(MonitorInfo))};
   // Crop only a frame wholly on one monitor. Pixels reserved for system app bars
   // are excluded from both the image and input geometry, never ignored as occluders.
   if(monitor!=IntPtr.Zero&&GetMonitorInfo(monitor,ref info)&&r.Left>=info.Monitor.Left&&r.Top>=info.Monitor.Top&&r.Right<=info.Monitor.Right&&r.Bottom<=info.Monitor.Bottom){
     var clipped=new Rect{Left=Math.Max(r.Left,info.Work.Left),Top=Math.Max(r.Top,info.Work.Top),Right=Math.Min(r.Right,info.Work.Right),Bottom=Math.Min(r.Bottom,info.Work.Bottom)};
     if(clipped.Right>clipped.Left&&clipped.Bottom>clipped.Top)return clipped;
   }
   return r;
 }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll",SetLastError=true)] static extern bool AttachThreadInput(uint a,uint b,bool attach);
 [DllImport("user32.dll",SetLastError=true)] static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] static extern bool PeekMessage(out Message m,IntPtr h,uint min,uint max,uint flags);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 public static Dictionary<string,object> LastActivation {get;private set;}
 public static bool Activate(long hwnd,int stamp){
   var h=new IntPtr(hwnd);var before=GetForegroundWindow();
   var diagnostic=new Dictionary<string,object>{{"target_window_id",hwnd},{"foreground_before",before.ToInt64()}};LastActivation=diagnostic;
   if(before==h&&!IsIconic(h)){diagnostic["already_focused"]=true;return true;}
   // Explicitly create the caller's message queue before attaching input queues.
   Message message;PeekMessage(out message,IntPtr.Zero,0,0,0);
   uint p;var current=GetCurrentThreadId();var front=GetWindowThreadProcessId(before,out p);var target=GetWindowThreadProcessId(h,out p);
   diagnostic["caller_thread"]=current;diagnostic["foreground_thread"]=front;diagnostic["target_thread"]=target;
   bool frontAttached=false,targetAttached=false;
   try{
     if(front!=0&&front!=current){frontAttached=AttachThreadInput(current,front,true);diagnostic["foreground_attached"]=frontAttached;if(!frontAttached)diagnostic["foreground_attach_error"]=Marshal.GetLastWin32Error();}
     if(target!=0&&target!=current&&target!=front){targetAttached=AttachThreadInput(current,target,true);diagnostic["target_attached"]=targetAttached;if(!targetAttached)diagnostic["target_attach_error"]=Marshal.GetLastWin32Error();}
     if(HumanInput!=stamp){diagnostic["user_takeover"]=true;return false;}
     if(IsIconic(h)){diagnostic["restore_requested"]=true;ShowWindow(h,9);}
     diagnostic["brought_to_top"]=BringWindowToTop(h);
     if(HumanInput!=stamp){diagnostic["user_takeover"]=true;return false;}
     diagnostic["foreground_requested"]=SetForegroundWindow(h);
   }
   finally{
     // Never wait for an external provider while its input queue is attached.
     if(targetAttached)diagnostic["target_detached"]=AttachThreadInput(current,target,false);
     if(frontAttached)diagnostic["foreground_detached"]=AttachThreadInput(current,front,false);
     diagnostic["foreground_after_detach"]=GetForegroundWindow().ToInt64();
   }
   return ConfirmActivation(hwnd,stamp);
 }
 public static bool ConfirmActivation(long hwnd,int stamp){
   var h=new IntPtr(hwnd);var diagnostic=LastActivation;int stable=0;
   for(int i=0;i<25;i++){
     if(HumanInput!=stamp){diagnostic["user_takeover"]=true;return false;}
     var foreground=GetForegroundWindow();diagnostic["foreground_final"]=foreground.ToInt64();
     stable=foreground==h&&!IsIconic(h)?stable+1:0;
     if(stable>=3){diagnostic["confirmed"]=true;return true;}
     Thread.Sleep(20);
   }
   diagnostic["confirmed"]=false;return false;
 }
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] static extern uint SendInput(uint n,Input[] a,int cb);
 [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f,bool inherit,uint access);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr h,ref uint length,StringBuilder id);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int cls,out int value,int size,out int returned);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static bool Elevated(int pid){using(var p=System.Diagnostics.Process.GetProcessById(pid)){IntPtr t;if(!OpenProcessToken(p.Handle,8,out t))throw new Exception("permission_denied");try{int v,n;if(!GetTokenInformation(t,20,out v,4,out n))throw new Exception("permission_denied");return v!=0;}finally{CloseHandle(t);}}}
 delegate IntPtr Hook(int n,IntPtr w,IntPtr l);
 [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr hwnd;public uint message;public UIntPtr w;public IntPtr l;public uint time;public Point point;public uint priv; }
 [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id,Hook proc,IntPtr module,uint thread);
 [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h,int n,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern bool GetMessage(out Message m,IntPtr h,uint min,uint max);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
 static Hook keyboard,mouse;
 static int humanInput;
 static bool watching;
 public static int HumanInput { get {return Volatile.Read(ref humanInput);} }
 public static bool Watch(){if(watching)return true;var ready=new ManualResetEvent(false);var thread=new Thread(()=>{
   keyboard=(n,w,l)=>{if(n>=0&&(Marshal.ReadInt32(l,8)&0x10)==0)Interlocked.Increment(ref humanInput);return CallNextHookEx(IntPtr.Zero,n,w,l);};
   mouse=(n,w,l)=>{if(n>=0&&(Marshal.ReadInt32(l,12)&1)==0)Interlocked.Increment(ref humanInput);return CallNextHookEx(IntPtr.Zero,n,w,l);};
   var k=SetWindowsHookEx(13,keyboard,GetModuleHandle(null),0);var m=SetWindowsHookEx(14,mouse,GetModuleHandle(null),0);watching=k!=IntPtr.Zero&&m!=IntPtr.Zero;ready.Set();if(!watching)return;
   Message msg;while(GetMessage(out msg,IntPtr.Zero,0,0)){}
 });thread.IsBackground=true;thread.Start();ready.WaitOne(3000);return watching;}
 public static string AppId(int pid){try{using(var p=System.Diagnostics.Process.GetProcessById(pid)){uint n=0;GetApplicationUserModelId(p.Handle,ref n,null);if(n==0||n>4096)return null;var b=new StringBuilder((int)n);return GetApplicationUserModelId(p.Handle,ref n,b)==0?b.ToString():null;}}catch{return null;}}
 public static bool Ready(){var h=OpenInputDesktop(0,false,0x0100);if(h==IntPtr.Zero)return false;CloseDesktop(h);return true;}
 public static long Pid(long h){uint p;GetWindowThreadProcessId(new IntPtr(h),out p);return p;}
 public static long[] Windows(){var a=new List<long>();EnumWindows((h,p)=>{if(IsWindowVisible(h)&&!Cloaked(h.ToInt64())&&!Transparent(h.ToInt64())&&!NonInteractiveOverlay(h.ToInt64())&&!OwnIndicator(h.ToInt64()))a.Add(h.ToInt64());return true;},IntPtr.Zero);return a.ToArray();}
 public static string Title(long h){var b=new StringBuilder(1024);GetWindowText(new IntPtr(h),b,b.Capacity);return b.ToString();}
 public static Rect Bounds(long h){
   var hwnd=new IntPtr(h);Rect outer,visible;
   if(!GetWindowRect(hwnd,out outer))throw new Exception("window_not_found");
   // GetWindowRect includes invisible resize borders. Use physical visible bounds
   // consistently for capture, occlusion, observation geometry and input mapping.
   // The helper is per-monitor DPI aware; DWM coordinates are already physical.
   if(DwmGetWindowAttribute(hwnd,9,out visible,Marshal.SizeOf(typeof(Rect)))==0&&visible.Right>visible.Left&&visible.Bottom>visible.Top)return visible;
   return outer; // Conservative fallback: never invent an inset or ignore an occluder.
 }
 static void Send(Input i){if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(Input)))!=1)throw new Exception("input_not_confirmed");}
 public static void K(ushort vk,bool up){Send(new Input{type=1,u=new Union{key=new Key{vk=vk,flags=up?2u:0u}}});}
 public static void Text(string s){foreach(char c in s){Send(new Input{type=1,u=new Union{key=new Key{scan=c,flags=4}}});Send(new Input{type=1,u=new Union{key=new Key{scan=c,flags=6}}});}}
 public static void M(uint flags,int data){Send(new Input{type=0,u=new Union{mouse=new Mouse{flags=flags,data=unchecked((uint)data)}}});}
 public static void Move(int x,int y){int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);if(x<left||y<top||x>=left+width||y>=top+height)throw new Exception("invalid_coordinates");Send(new Input{type=0,u=new Union{mouse=new Mouse{x=(int)(((long)(x-left)*65536+32768)/width),y=(int)(((long)(y-top)*65536+32768)/height),flags=0xC001}}});}
}
'@
[void][ABWin]::SetThreadDpiAwarenessContext([IntPtr](-4))
$watching=[ABWin]::Watch()
$ownElevated=[ABWin]::Elevated($PID)
$protected = @($PID) + @($env:ABRIDGE_PROTECTED_PIDS -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
$captures = @{}
$catalog = @{}
$launchPaths = @{}
$installedApps = $null
$mutating = $false
function Refuse($code) { throw $code }
function Bounded-Text($text) { if($null -eq $text){return $null};$s=[string]$text;if($s.Length -gt 1024){return $s.Substring(0,1024)};return $s }
function Check-Cancel {
 if([IO.File]::Exists($env:ABRIDGE_CANCEL_FILE) -and [IO.File]::ReadAllText($env:ABRIDGE_CANCEL_FILE) -eq [string]$req.id){throw 'cancelled'}
 if($mutating -and [ABWin]::HumanInput -ne $script:inputStamp){throw 'user_takeover'}
 if($mutating -and [ABWin]::GetForegroundWindow().ToInt64() -ne $script:inputForeground){throw 'focus_changed'}
}
function Check-Activation([int]$stamp) {
 # Activation intentionally changes foreground, but never resets the original
 # human-input baseline or ignores cancellation while selecting that window.
 if([IO.File]::Exists($env:ABRIDGE_CANCEL_FILE) -and [IO.File]::ReadAllText($env:ABRIDGE_CANCEL_FILE) -eq [string]$req.id){throw 'cancelled'}
 if([ABWin]::HumanInput -ne $stamp){throw 'user_takeover'}
}
function Guard-Process([long]$processId) {
 if($processId -le 0){Refuse 'target_changed'}
 if($protected -contains $processId){Refuse 'protected_target'}
 if(-not $ownElevated -and [ABWin]::Elevated($processId)){Refuse 'permission_denied'}
}
function Guard-Window([long]$h,[long]$expected=0) {
 if (-not [ABWin]::Ready()) { Refuse 'desktop_unavailable' }
 if (-not [ABWin]::IsWindow([IntPtr]$h)) { Refuse 'window_not_found' }
 $p = [ABWin]::Pid($h)
 if ($expected -and $p -ne $expected) { Refuse 'window_identity_changed' }
 Guard-Process $p
}
function App-Id($path) {
 $sha=[System.Security.Cryptography.SHA256]::Create()
 try { 'win.' + ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($path.ToLowerInvariant())))).Replace('-','').ToLowerInvariant() }
 finally { $sha.Dispose() }
}
function Get-Apps {
 if($null -eq $script:installedApps){
  $script:installedApps=@(try {Get-StartApps} catch {})
  # Resolve only plain executable shortcuts. Argument-bearing shortcuts cannot be
  # correlated to a running process by executable identity alone.
  try {
   $shell=New-Object -ComObject Shell.Application
   foreach($item in $shell.Namespace('shell:AppsFolder').Items()){
    $path=[string]$item.ExtendedProperty('System.Link.TargetParsingPath')
    $shortcutArgs=[string]$item.ExtendedProperty('System.Link.Arguments')
    if($path -and -not $shortcutArgs -and [IO.Path]::GetExtension($path) -eq '.exe' -and [IO.File]::Exists($path)){$launchPaths[[string]$item.ExtendedProperty('System.AppUserModel.ID')]=$path}
   }
  } catch {}
 }
 $rows=New-Object System.Collections.Generic.List[object]
 $seen=@{}
 $fg=[ABWin]::Pid([ABWin]::GetForegroundWindow().ToInt64())
 $windowByPid=@{}
 foreach($hwnd in [ABWin]::Windows()){$owner=[ABWin]::Pid($hwnd);if(-not $windowByPid.ContainsKey($owner) -and [ABWin]::Title($hwnd)){$windowByPid[$owner]=$hwnd}}
 foreach($p in Get-Process) {
  try {
   $main=$windowByPid[[long]$p.Id]
   if(-not $p.Path -or -not $main) { continue }
   $aumid=[ABWin]::AppId($p.Id);$identity=$p.Path;if($aumid){$identity='aumid:'+$aumid}
   $baseId=App-Id $identity;$id=$baseId+'.p'+$p.Id
   if($script:pendingLaunch -eq $baseId -and -not $seen[$baseId]){$id=$baseId}
   elseif($script:pendingPath -eq $p.Path -and ($script:pendingPids -notcontains $p.Id -or $fg -eq $p.Id) -and -not $seen[$script:pendingLaunch]){$id=$script:pendingLaunch}
   $catalog[$id]=@{path=$p.Path;pid=$p.Id;handle=$main}; $seen[$baseId]=$true
   $seen[$id]=$true
   $rows.Add(@{pid=$p.Id;name=$p.ProcessName;window_title=[ABWin]::Title($main);bundle_id=$id;running=$true;active=($p.Id -eq $fg)})
  } catch {}
 }
 # Start menu discovery is read-only. Only discovered identifiers can be launched.
 foreach($app in $script:installedApps) {
  $id=App-Id ('aumid:'+ $app.AppID)
  if(-not $seen[$id]) { $catalog[$id]=@{aumid=$app.AppID;launchPath=$launchPaths[$app.AppID]}; $rows.Add(@{pid=0;name=$app.Name;bundle_id=$id;running=$false;active=$false}) }
 }
 return ,$rows.ToArray()
}
function Get-Windows($filterPid) {
 $rows=New-Object System.Collections.Generic.List[object]
 $z=100000
 foreach($h in [ABWin]::Windows()) {
  $z--; $p=[ABWin]::Pid($h)
  if($filterPid -and $p -ne $filterPid) {continue}
  $title=[ABWin]::Title($h); if(-not $title){continue}
  $r=[ABWin]::CaptureBounds([ABWin]::Bounds($h)); $name=''
  try {$name=(Get-Process -Id $p).ProcessName} catch {}
  $rows.Add(@{pid=$p;window_id=$h;app_name=$name;title=$title;bounds=@{x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top};is_on_screen=(-not [ABWin]::IsIconic([IntPtr]$h));is_focused=([ABWin]::GetForegroundWindow().ToInt64() -eq $h);layer=0;z_index=$z})
 }
 return ,$rows.ToArray()
}
function Bounds-Target($target) {
 if($target.desktop) {
  $r=[Windows.Forms.SystemInformation]::VirtualScreen
  return @{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}
 }
 Guard-Window $target.window_id $target.pid
 if([ABWin]::IsIconic([IntPtr]$target.window_id)) { Refuse 'window_minimized' }
 $r=[ABWin]::CaptureBounds([ABWin]::Bounds($target.window_id))
 return @{x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top}
}
function Guard-Visible($target,$bounds) {
 if($target.desktop){return}
 foreach($h in [ABWin]::Windows()) {
  if($h -eq $target.window_id){return}
  if([ABWin]::IsIconic([IntPtr]$h)){continue}
  $r=[ABWin]::Bounds($h)
  if($r.Right -gt $bounds.x -and $r.Bottom -gt $bounds.y -and $r.Left -lt $bounds.x+$bounds.width -and $r.Top -lt $bounds.y+$bounds.height){
   if([ABWin]::PassiveOwnedOverlay($h,$target.window_id)){continue}
   # Bounded local support evidence in the helper's private directory. Never log
   # titles, UI text, input, paths or credentials, and never change the refusal.
   try {
    if($env:ABRIDGE_OCCLUSION_DIAGNOSTIC){
     $diagnostic=@{at=[DateTime]::UtcNow.ToString('o');request_id=$req.id;target_window_id=$target.window_id;target_pid=$target.pid;target_bounds=$bounds;target_owner=[ABWin]::Owner($target.window_id);target_style=[ABWin]::Style($target.window_id,$false);target_extended_style=[ABWin]::Style($target.window_id,$true);foreground_window_id=[ABWin]::GetForegroundWindow().ToInt64();occluder_window_id=$h;occluder_pid=[ABWin]::Pid($h);occluder_owner=[ABWin]::Owner($h);occluder_root_owner=[ABWin]::GetAncestor([IntPtr]$h,3).ToInt64();occluder_style=[ABWin]::Style($h,$false);occluder_extended_style=[ABWin]::Style($h,$true);occluder_bounds=@{x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top}}
     [IO.File]::WriteAllText($env:ABRIDGE_OCCLUSION_DIAGNOSTIC,($diagnostic | ConvertTo-Json -Depth 4 -Compress),(New-Object Text.UTF8Encoding($false)))
    }
   } catch {}
   Refuse 'target_occluded'
  }
 }
 Refuse 'window_not_visible'
}
function Capture-Size($bounds) {
 # Explicit doubles avoid PowerShell 5 selecting Math.Min's integer overload.
 $scale=[Math]::Min(1.0,1920.0/[Math]::Max([double]$bounds.width,[double]$bounds.height))
 return @{width=[Math]::Max(1,[int]($bounds.width*$scale));height=[Math]::Max(1,[int]($bounds.height*$scale))}
}
function Observe($a) {
 $observationTimer=[Diagnostics.Stopwatch]::StartNew();$uiaTimer=$null;$captureTimer=$null
 $visited=0;$collected=0;$budgetExhausted=$false
 try {
 $initialForeground=[ABWin]::GetForegroundWindow().ToInt64()
 $b=Bounds-Target $a.target
 if($b.width -le 0 -or $b.height -le 0) {Refuse 'window_not_visible'}
 if($a.screenshot -and -not $a.target.desktop -and $initialForeground -ne $a.target.window_id){Refuse 'focus_changed'}
 Check-Cancel
 $size=Capture-Size $b;$w=$size.width;$h=$size.height
 $refs=@{}; $nodes=New-Object System.Collections.Generic.List[object]
 $buckets=@(for($i=0;$i -lt 10;$i++){,(New-Object System.Collections.Generic.List[object])})
 $collected=0;$visited=0;$truncated=$false
 if(-not $a.target.desktop) {
  $accessibilityStatus='available'
  $q=New-Object System.Collections.Queue
  # Cooperative traversal budget: one blocking provider call may overrun it.
  # Keep all completed nodes and leave time for the separately guarded image.
  $uiaTimer=[Diagnostics.Stopwatch]::StartNew()
  try {
   $root=[ABUia]::FromHandle([IntPtr]$a.target.window_id)
   if($null -ne $root){$q.Enqueue(@($root,0))}else{$accessibilityStatus='unavailable'}
  } catch {if($_.Exception.Message -in @('cancelled','user_takeover','focus_changed')){throw};$accessibilityStatus='unavailable'}
  while($q.Count -and $visited -lt 1500) {
   Check-Cancel
   if($uiaTimer.ElapsedMilliseconds -ge 3000){$budgetExhausted=$true;break}
   $item=$q.Dequeue(); $el=$item[0]; $depth=$item[1];$visited++
   try {
    $c=$el.Current
    $role=$c.ControlType; if($c.IsPassword){$role='password'}
    $actions=@(); $value=$null;$semanticClick=$false
    if(-not $c.IsPassword) {
     if($el.HasPattern(10002)) {
      $value=$el.Value()
      if($c.IsEnabled -and -not $c.IsOffscreen -and -not $el.IsValueReadOnly()){$actions+='type'}
     }
     if($c.IsEnabled -and -not $c.IsOffscreen){
      $semanticClick=$el.HasPattern(10000) -or $el.HasPattern(10015) -or $el.HasPattern(10010)
      if($semanticClick){$actions+='click'}
     }
    }
    $node=@{role=$role;label=(Bounded-Text ([string]$c.Name));enabled=$c.IsEnabled;depth=$depth;actions=$actions}
    if($null -ne $value){$node.value=Bounded-Text $value}
    $r=$c.BoundingRectangle
    $left=[Math]::Max($b.x,$r.X);$top=[Math]::Max($b.y,$r.Y)
    $right=[Math]::Min($b.x+$b.width,$r.X+$r.Width);$bottom=[Math]::Min($b.y+$b.height,$r.Y+$r.Height)
    $visible=-not $c.IsOffscreen -and $right -gt $left -and $bottom -gt $top
    if($visible){
     # Use the rounded output dimensions, exactly as Point-For does in reverse.
     $px=[int][Math]::Floor(($left-$b.x)*$w/$b.width);$py=[int][Math]::Floor(($top-$b.y)*$h/$b.height)
     $pr=[int][Math]::Ceiling(($right-$b.x)*$w/$b.width);$pb=[int][Math]::Ceiling(($bottom-$b.y)*$h/$b.height)
     $node.bounds=@{x=$px;y=$py;width=($pr-$px);height=($pb-$py)}
    }
    $priority=6
    if($visible -and $c.IsEnabled){
     if($actions -contains 'type'){$priority=0}
     elseif($semanticClick -and $role -in @('Button','SplitButton')){$priority=1}
     elseif($semanticClick){$priority=2}
     elseif($actions.Count){$priority=3}
     elseif(-not [string]::IsNullOrWhiteSpace([string]$c.Name) -and $role -notin @('Window','Pane','Group')){$priority=4}
    } elseif(-not $visible){$priority=9}
    $candidate=@{node=$node;element=$el}
    if($collected -lt 500){$buckets[$priority].Add($candidate);$collected++}
    else {
     $truncated=$true
     # Keep a bounded pool while allowing deep controls to displace shallow wrappers.
     for($i=9;$i -gt $priority;$i--){if($buckets[$i].Count){$buckets[$i].RemoveAt($buckets[$i].Count-1);$buckets[$priority].Add($candidate);break}}
    }
    if($uiaTimer.ElapsedMilliseconds -ge 3000){$budgetExhausted=$true;break}
    $child=$el.FirstChild()
    if($depth -ge 32){if($child){$truncated=$true}}
    else {
     while($child) {
      Check-Cancel
      if($uiaTimer.ElapsedMilliseconds -ge 3000){$budgetExhausted=$true;break}
      if($q.Count -ge 1500){$truncated=$true;break}
      $q.Enqueue(@($child,($depth+1)));$child=$child.NextSibling()
     }
    }
   } catch {if($_.Exception.Message -in @('cancelled','user_takeover','focus_changed')){throw};$accessibilityStatus='partial'}
  }
  $uiaTimer.Stop()
  if($q.Count){$truncated=$true}
  if($budgetExhausted){$truncated=$true;$accessibilityStatus='partial'}
 }
 foreach($bucket in $buckets){foreach($candidate in $bucket){
  $node=$candidate.node;$token=[Guid]::NewGuid().ToString('N');$node.token=$token
  if($node.actions.Count){$refs[$token]=$candidate.element};$nodes.Add($node)
 }}
 $id=[Guid]::NewGuid().ToString('N')
 $result=@{elements=@($nodes.ToArray());element_actions='explicit';capture_id=$id;truncated=$truncated;frame_valid=$true;is_focused=($a.target.desktop -or $initialForeground -eq $a.target.window_id)}
 if(-not $a.target.desktop) {$result.accessibility_status=$accessibilityStatus;$result.window_title=[ABWin]::Title($a.target.window_id);$result.app_name=(Get-Process -Id $a.target.pid).ProcessName}
 if($budgetExhausted){$result.accessibility_limit='time_budget'}
 Check-Cancel
 if($a.screenshot) {
  $captureTimer=[Diagnostics.Stopwatch]::StartNew()
  if(-not $a.target.desktop -and [ABWin]::GetForegroundWindow().ToInt64() -ne $a.target.window_id){Refuse 'focus_changed'}
  Guard-Visible $a.target $b
  $bmp=New-Object Drawing.Bitmap($b.width,$b.height);$g=[Drawing.Graphics]::FromImage($bmp)
  try {
   $g.CopyFromScreen($b.x,$b.y,0,0,$bmp.Size)
   $small=New-Object Drawing.Bitmap($w,$h);$sg=[Drawing.Graphics]::FromImage($small);$ms=New-Object IO.MemoryStream
   try {$sg.DrawImage($bmp,0,0,$w,$h);$small.Save($ms,[Drawing.Imaging.ImageFormat]::Png);$mime='image/png';if($ms.Length -gt 4194304){$ms.SetLength(0);$small.Save($ms,[Drawing.Imaging.ImageFormat]::Jpeg);$mime='image/jpeg'};if($ms.Length -gt 4194304){Refuse 'image_too_large'};$result.image_base64=[Convert]::ToBase64String($ms.ToArray());$result.mime_type=$mime;$result.width=$w;$result.height=$h}
   finally {$sg.Dispose();$small.Dispose();$ms.Dispose()}
  } finally {$g.Dispose();$bmp.Dispose()}
  $captureTimer.Stop()
 }
 $finalBounds=Bounds-Target $a.target
 foreach($k in @('x','y','width','height')){if($b[$k] -ne $finalBounds[$k]){Refuse 'window_changed'}}
 if($a.screenshot -and $initialForeground -ne [ABWin]::GetForegroundWindow().ToInt64()){Refuse 'focus_changed'}
 if($result.image_base64){Guard-Visible $a.target $b}
 $result.is_focused=$a.target.desktop -or [ABWin]::GetForegroundWindow().ToInt64() -eq $a.target.window_id
 $captures[$a.session]=@{id=$id;target=$a.target;bounds=$b;width=$w;height=$h;refs=$refs;at=[DateTime]::UtcNow;foreground=[ABWin]::GetForegroundWindow().ToInt64();pixels=!!$result.image_base64;inputStamp=[ABWin]::HumanInput}
 return $result
 } finally {
  # One overwritten local diagnostic, with timings/counts only. No UI content.
  try {
   if($env:ABRIDGE_OCCLUSION_DIAGNOSTIC){
    $diagnostic=@{uia_elapsed_ms=if($uiaTimer){$uiaTimer.ElapsedMilliseconds}else{0};visited=$visited;collected=$collected;capture_elapsed_ms=if($captureTimer){$captureTimer.ElapsedMilliseconds}else{0};total_ms=$observationTimer.ElapsedMilliseconds;budget_exhausted=$budgetExhausted}
    [IO.File]::WriteAllText((Join-Path ([IO.Path]::GetDirectoryName($env:ABRIDGE_OCCLUSION_DIAGNOSTIC)) 'last-observation.json'),($diagnostic | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
   }
  }catch{}
 }
}
function Key-Code($key) {
 switch($key.ToLowerInvariant()) {
  'ctrl' {return 17} 'control' {return 17} 'shift' {return 16} 'alt' {return 18} 'option' {return 18}
  'win' {return 91} 'meta' {return 91} 'cmd' {return 91} 'command' {return 91}
  'enter' {return 13} 'return' {return 13} 'tab' {return 9} 'escape' {return 27} 'esc' {return 27}
  'backspace' {return 8} 'delete' {return 46} 'space' {return 32} 'left' {return 37} 'up' {return 38} 'right' {return 39} 'down' {return 40}
  'home' {return 36} 'end' {return 35} 'pageup' {return 33} 'pagedown' {return 34}
 }
 if($key -match '^[a-zA-Z0-9]$'){return [int][char]$key.ToUpperInvariant()}
 if($key -match '^f([1-9]|1[0-9]|2[0-4])$'){return 111+[int]$Matches[1]}
 Refuse 'unsupported_key'
}
function Point-For($c,$x,$y) {
 if(-not $c.pixels){Refuse 'screenshot_required'}
 if($x -lt 0 -or $y -lt 0 -or $x -ge $c.width -or $y -ge $c.height){Refuse 'invalid_coordinates'}
 return @([int]($c.bounds.x+$x*$c.bounds.width/$c.width),[int]($c.bounds.y+$y*$c.bounds.height/$c.height))
}
function Guard-Point($a,$p) {
 $h=[ABWin]::WindowFromPoint((New-Object ABWin+Point($p[0],$p[1]))).ToInt64()
 Guard-Window $h
 if(-not $a.target.desktop) {
  # Mouse-transparent windows can hide pixels while WindowFromPoint reports the
  # underlying target. Never dispatch through their visible bounding rectangle.
  foreach($front in [ABWin]::Windows()) {
   if($front -eq $a.target.window_id){break}
   if([ABWin]::IsIconic([IntPtr]$front)){continue}
   $r=[ABWin]::Bounds($front)
   if($p[0] -ge $r.Left -and $p[0] -lt $r.Right -and $p[1] -ge $r.Top -and $p[1] -lt $r.Bottom){Refuse 'target_occluded'}
  }
  if([ABWin]::GetAncestor([IntPtr]$h,2).ToInt64() -ne $a.target.window_id){Refuse 'target_occluded'}
 }
}
function Act($a) {
 $c=$captures[$a.session]
 if(-not $c -or $a.capture_id -ne $c.id -or ([DateTime]::UtcNow-$c.at).TotalSeconds -gt 120){Refuse 'stale_capture'}
 if([ABWin]::HumanInput -ne $c.inputStamp){$captures.Remove($a.session);Refuse 'user_takeover'}
 if(($a.target | ConvertTo-Json -Compress) -ne ($c.target | ConvertTo-Json -Compress)){Refuse 'target_changed'}
 $b=Bounds-Target $a.target
 foreach($k in @('x','y','width','height')){if($b[$k] -ne $c.bounds[$k]){Refuse 'stale_capture'}}
 $fg=[ABWin]::GetForegroundWindow().ToInt64(); Guard-Window $fg
 if($fg -ne $c.foreground -or (-not $a.target.desktop -and $fg -ne $a.target.window_id)){Refuse 'focus_changed'}
 $el=$null
 if($a.native_ref){
  $el=$c.refs[$a.native_ref];if(-not $el){Refuse 'stale_element'}
  try {$current=$el.Current;if(-not $current.IsEnabled -or $current.IsPassword -or $current.IsOffscreen){Refuse 'element_unavailable'}}catch{Refuse 'stale_element'}
  Guard-Process $current.ProcessId
  try {$root=[ABUia]::FromHandle([IntPtr]$a.target.window_id)}catch{Refuse 'stale_element'}
  $ancestor=$el;$belongs=$false
  # UIA providers may live in a different process from their host window. Verify
  # the current parent chain for every reference, including same-process controls.
  for($depth=0;$ancestor -and $depth -lt 64;$depth++){
   Check-Cancel
   try {if($ancestor.Same($root)){$belongs=$true;break};$ancestor=$ancestor.Parent()}catch{Refuse 'stale_element'}
  }
  if(-not $belongs){Refuse 'target_changed'}
 }
 $mods=@($a.modifiers | Where-Object {$null -ne $_} | ForEach-Object {Key-Code $_});$keyCode=0
 if($a.action -eq 'key'){$keyCode=Key-Code $a.key}
 $p=$null;$to=$null
 # A UIA reference promises a semantic operation, never an implicit physical
 # click at provider bounds. Other gestures require a fresh screenshot and
 # explicit coordinates so the normal pixel guards can validate that intent.
 if($el){
  if($a.action -eq 'type'){
   if(-not $el.HasPattern(10002) -or $el.IsValueReadOnly() -or $mods.Count){Refuse 'unsupported_element_action'}
  }elseif($a.action -eq 'click'){
   if($mods.Count -or ($a.button -and $a.button -ne 'left') -or (-not $el.HasPattern(10000) -and -not $el.HasPattern(10015) -and -not $el.HasPattern(10010))){Refuse 'unsupported_element_action'}
  }else{Refuse 'unsupported_element_action'}
 }
 if($a.action -in @('click','double_click','move','drag','scroll') -and -not $el -and -not $p){$p=Point-For $c $a.x $a.y;Guard-Point $a $p}
 if($a.action -eq 'drag'){$to=Point-For $c $a.to_x $a.to_y;Guard-Point $a $to}
 $captures.Remove($a.session)
 Check-Cancel
 if(-not $watching){Refuse 'takeover_monitor_unavailable'}
 $script:inputStamp=[ABWin]::HumanInput
 $script:inputForeground=$fg
 $script:mutating=$true
 $pressed=New-Object System.Collections.Generic.List[int]
 try {
  foreach($m in $mods){[ABWin]::K($m,$false);$pressed.Add($m);Check-Cancel}
  if($el) {
   if($a.action -eq 'type'){$el.SetValue($a.text)}
   elseif($a.action -eq 'click' -and -not $mods.Count -and $a.button -ne 'right' -and $a.button -ne 'middle') {
    $el.Click()
   } else {throw 'unsupported_element_action'}
  } else {
   if($p){[ABWin]::Move($p[0],$p[1]);Check-Cancel;Guard-Point $a $p}
   switch($a.action){
    'type' {foreach($ch in $a.text.ToCharArray()){Check-Cancel;[ABWin]::Text([string]$ch)}}
    'key' {[ABWin]::K($keyCode,$false);try{}finally{[ABWin]::K($keyCode,$true)}}
    'move' {}
    'scroll' {$d=$a.delta_x;if($a.delta_y){$d=$a.delta_y};$ticks=[Math]::Max(1,[Math]::Min(50,[Math]::Round([Math]::Abs($d)/40,[MidpointRounding]::AwayFromZero)));$wheel=[int]([Math]::Sign($d)*$ticks*120);if($a.delta_y){[ABWin]::M(0x0800,-$wheel)}else{[ABWin]::M(0x1000,$wheel)}}
    {$_ -in @('click','double_click','drag')} {
     $down=2;$up=4;if($a.button -eq 'right'){$down=8;$up=16};if($a.button -eq 'middle'){$down=32;$up=64}
     $count=1;if($a.action -eq 'double_click'){$count=2}
     for($i=0;$i -lt $count;$i++){
      [ABWin]::M($down,0)
      try {if($to){for($j=1;$j -le 20;$j++){Check-Cancel;$step=@([int]($p[0]+($to[0]-$p[0])*$j/20),[int]($p[1]+($to[1]-$p[1])*$j/20));Guard-Point $a $step;[ABWin]::Move($step[0],$step[1]);Start-Sleep -Milliseconds 10}}}
      finally{[ABWin]::M($up,0)}
     }
    }
    default {throw 'unsupported_action'}
   }
  }
 } finally {for($i=$pressed.Count-1;$i -ge 0;$i--){[ABWin]::K($pressed[$i],$true)}}
 Check-Cancel
 return @{status='executed';delivery='windows';verified=$false}
}
while($null -ne ($line=[Console]::ReadLine())) {
 $req=$null;$mutating=$false
 try {
  $req=$line | ConvertFrom-Json; $a=$req.args
  $data=switch($req.op) {
   'diagnostics' {$ready=[ABWin]::Ready();$uiaReady=$false;try{$uiaReady=[ABUia]::Ready()}catch{};@{driver=@{ready=$ready;loaded=$true;name='windows-uia3';accessibility_ready=$uiaReady;takeover_monitor=$watching};permissions=@{checked=$true;screen=$ready;input=($ready -and $watching)}}}
   'apps' {Get-Apps}
   'windows' {Get-Windows $a.pid}
   'observe' {Observe $a}
   'act' {Act $a}
   'release' {$captures.Remove($a.session);@{released=$true}}
   'open' {
    $app=$catalog[$a.bundle_id];if(-not $app){Refuse 'app_not_found'}
    if($app.handle){
     Guard-Window $app.handle $app.pid;Check-Cancel;$activationStamp=[ABWin]::HumanInput;$mutating=$true
     try {
      $activated=[ABWin]::Activate($app.handle,$activationStamp);Check-Activation $activationStamp
      if(-not $activated){
       # The foreground queue may legitimately deny AttachThreadInput. Ask only
       # this exact root's UIA provider to focus it; never click or search children.
       Guard-Window $app.handle $app.pid
       $focusRoot=$null;$focusInfo=$null;$focusHandle=0
       try {$focusRoot=[ABUia]::FromHandle([IntPtr]$app.handle);if($focusRoot){$focusInfo=$focusRoot.Current;$focusHandle=$focusRoot.NativeWindowHandle}}
       catch {[ABWin]::LastActivation['uia_lookup_error']=$_.Exception.GetBaseException().HResult}
       Check-Activation $activationStamp
       if($focusRoot -and $focusInfo -and $focusHandle -eq $app.handle){
        Guard-Window $app.handle $app.pid;Guard-Process $focusInfo.ProcessId;Check-Activation $activationStamp
        [ABWin]::LastActivation['uia_focus_requested']=$true
        try {$focusRoot.Focus();[ABWin]::LastActivation['uia_focus_returned']=$true}
        catch {[ABWin]::LastActivation['uia_focus_error']=$_.Exception.GetBaseException().HResult}
        Check-Activation $activationStamp;Guard-Window $app.handle $app.pid
        # A provider HRESULT is not proof of foreground ownership. Even after an
        # error, only read the actual outcome; do not repeat the focus request.
        $activated=[ABWin]::ConfirmActivation($app.handle,$activationStamp)
       }
      }
      Check-Activation $activationStamp
      if(-not $activated){throw 'focus_unavailable'}
     }
     finally {
      try {if($env:ABRIDGE_OCCLUSION_DIAGNOSTIC){$diagnostic=[ABWin]::LastActivation;$diagnostic['at']=[DateTime]::UtcNow.ToString('o');$diagnostic['request_id']=$req.id;[IO.File]::WriteAllText((Join-Path ([IO.Path]::GetDirectoryName($env:ABRIDGE_OCCLUSION_DIAGNOSTIC)) 'last-activation.json'),($diagnostic | ConvertTo-Json -Depth 4 -Compress),(New-Object Text.UTF8Encoding($false)))}}catch{}
     }
    }
    elseif($app.aumid){$script:pendingLaunch=$a.bundle_id;$script:pendingPath=$app.launchPath;$script:pendingPids=@(Get-Process | ForEach-Object {$_.Id});$mutating=$true;[void][Diagnostics.Process]::Start((Join-Path $env:SystemRoot 'explorer.exe'),'shell:AppsFolder\'+$app.aumid)}
    else{$mutating=$true;[void][Diagnostics.Process]::Start($app.path)}
    @{launch_requested=$true}
   }
   default {Refuse 'unsupported_operation'}
  }
  [Console]::WriteLine((@{id=$req.id;ok=$true;data=$data} | ConvertTo-Json -Depth 20 -Compress))
 } catch {
  $code=$_.Exception.Message
  if($code -notmatch '^[a-z_]+$'){$code='native_error'}
  $outcome='refused';if($mutating){$outcome='outcome_unknown'}
  [Console]::WriteLine((@{id=$req.id;ok=$false;error=$code;outcome=$outcome} | ConvertTo-Json -Compress))
 }
}
