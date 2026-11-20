/** Minimal UIA3 COM boundary; vtable order and IIDs follow Microsoft's UIAutomationClient.h.
 * Uses the OS proxy factory, including legacy Win32 controls; no external interop DLL is needed.
 */
export const WINDOWS_UIA = String.raw`
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
`;
