using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Windows.Automation;
using System.Drawing;
using System.Drawing.Imaging;
using static Brian.Native.Boundary;
namespace Brian.Native;
internal sealed class Broker {
    sealed record Window(nint H, int Pid, long Start, string Path, JsonObject Target, AutomationElement Root, string Runtime, long Generation);
    sealed record Snapshot(JsonObject Observation, Dictionary<string,AutomationElement> Refs, string Signature, long Tick);
    readonly Dictionary<string,Window> windows=[];
    readonly Dictionary<string,(string Digest,JsonObject Receipt)> journal=[];
    JsonNode? grant; string lease=""; Snapshot? snapshot; JsonNode? approval,approved; string approvalSignature="";
    long expiry; Mutex? mutex;
    internal volatile bool Active, Approving;
    internal nint ActiveWindow;
    // Set once from the actual direct pipe-parent process, never from wire data.
    internal int TrustedParentPid;
    internal long WatchdogExpiry;
    static long Tick=>Environment.TickCount64;
    static string Fixture=>System.IO.Path.GetFullPath(System.IO.Path.Combine(AppContext.BaseDirectory,"Brian.NativeFixture.exe"));
    static string? Cohort(Process p) { var path=p.MainModule?.FileName; if(path==null)return null;
        if(path.Equals(Fixture,StringComparison.OrdinalIgnoreCase))return "com.usebrian.NativeComputerFixture";
        // Deliberately excludes packaged/Store Notepad until separately validated.
        if(path.Equals(System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","notepad.exe"),StringComparison.OrdinalIgnoreCase)) return "com.microsoft.Notepad";
        return null;
    }
    internal JsonObject Capabilities()=>new(){["protocol"]=Protocol,["platform"]="win32",["axRead"]=true,["semanticActions"]=true,["windowCapture"]=true,["input"]=false,["accessibilityPermission"]="granted",["capturePermission"]="granted",["limitations"]=new JsonArray("Experimental: Windows acceptance/signing pending; interactive medium-integrity Default desktop only.","System32 Notepad document ValuePattern only; adjacent trusted fixture UIA patterns. Store Notepad excluded.","Coordinate input disabled: no surviving release owner. Capture only isolated fixture canvas; keys/focus unsupported. All effects require exact local approval.","One target; bounded complete fresh UIA tree required for effects; input takeover terminates session.")};
    internal JsonArray List() {
        Require(grant==null); windows.Clear(); Native.Generations.Clear(); var result=new JsonArray();
        Native.EnumWindows((h,unused)=>{if(result.Count>=128)return false;try {
            if(!Native.IsWindowVisible(h)||Native.IsIconic(h))return true;
            using var p=Process.GetProcessById(Native.Pid(h)); var app=Cohort(p);if(app==null||Native.Integrity(p)!=0x2000)return true;
            _=Native.Bounds(h);Native.Generations.TryAdd(h,0);long generation=Native.Generations[h];var root=AutomationElement.FromHandle(h);if(root.Current.ControlType!=ControlType.Window||(app=="com.microsoft.Notepad"&&root.Current.ClassName!="Notepad"))return true;
            var t=new JsonObject{["appId"]=app,["processId"]=p.Id,["processInstanceId"]=Id(),["windowId"]=Id(),["windowInstanceId"]=Id()};
            windows.Add(S(t,"windowInstanceId"),new(h,p.Id,p.StartTime.ToUniversalTime().Ticks,p.MainModule!.FileName!,t,root,string.Join(",",root.GetRuntimeId()),generation));var discovered=(JsonObject)t.DeepClone();
            try { discovered["displayName"]=DiscoveryName(root.Current.Name); } catch { /* optional local metadata */ }
            result.Add(discovered);
        }catch{/* inaccessible target is not advertised */}return true;},0);return result;
    }
    // UTF-16 wire bound without splitting a surrogate pair. Local discovery only.
    static string DiscoveryName(string s) { int end=Math.Min(s.Length,256);if(end<s.Length&&end>0&&char.IsHighSurrogate(s[end-1])&&char.IsLowSurrogate(s[end]))end--;return s[..end]; }
    Window Live(JsonNode target,bool foreground=true) {
        Require(Native.Desktop());Require(windows.TryGetValue(S(target,"windowInstanceId"),out var w));Require(JsonNode.DeepEquals(w!.Target,target));
        using var p=Process.GetProcessById(w.Pid); Require(!p.HasExited&&p.StartTime.ToUniversalTime().Ticks==w.Start&&p.MainModule!.FileName==w.Path&&Cohort(p)==S(target,"appId")&&Native.Integrity(p)==0x2000);
        Require(Native.Generations.TryGetValue(w.H,out var generation)&&generation==w.Generation&&string.Join(",",AutomationElement.FromHandle(w.H).GetRuntimeId())==w.Runtime);
        Require(Native.Pid(w.H)==w.Pid&&w.Pid!=TrustedParentPid&&Native.IsWindowVisible(w.H)&&Native.IsWindowEnabled(w.H)&&!Native.IsIconic(w.H)&&Automation.Compare(w.Root,AutomationElement.FromHandle(w.H)));
        Require(!foreground||Native.GetForegroundWindow()==w.H); _=Native.Bounds(w.H);return w;
    }
    internal bool Start(JsonNode payload) {
        Keys(payload,"grant","leaseId");IdField(payload,"leaseId");var g=payload["grant"]!;Grant(g);Require(grant==null);
        var w=Live(g["targets"]![0]!,false);mutex=new Mutex(false,"Local\\Brian.NativeComputer.Windows.Attended");Require(mutex.WaitOne(0));
        // Restore only as part of explicit local grant, never as a model action.
        Native.RequirePrivateChannel();Require(Native.SetForegroundWindow(w.H));Thread.Sleep(80);_=Live(w.Target);
        Native.RequirePrivateChannel();grant=g.DeepClone();lease=S(payload,"leaseId");expiry=Tick+N(g,"expiresAt")-Now;WatchdogExpiry=expiry;ActiveWindow=w.H;Active=true;return true;
    }
    void Authorized(JsonNode c,string l) {
        Native.RequirePrivateChannel();
        Command(c);Require(grant!=null&&l==lease&&Now<N(grant,"expiresAt")&&Tick<expiry&&Now<N(c,"deadlineAt"));
        Require(JsonNode.DeepEquals(c["identity"],grant!["identity"])&&S(c,"grantId")==S(grant,"grantId")&&N(c,"epoch")==N(grant,"epoch")&&JsonNode.DeepEquals(c["action"]!["target"],grant["targets"]![0]));
        string k=S(c["action"],"kind");Require(k=="observe"||(k=="capture"?B(grant,"allowCapture"):B(grant,"allowControl")));Require(k!="click"||B(grant,"allowCapture"));
    }
    static readonly HashSet<ControlType> Safe=[ControlType.Window,ControlType.Pane,ControlType.Group,ControlType.Button,ControlType.Edit,ControlType.Text,ControlType.CheckBox,ControlType.RadioButton,ControlType.List,ControlType.ListItem,ControlType.ComboBox,ControlType.ScrollBar,ControlType.Document,ControlType.MenuBar,ControlType.Menu,ControlType.MenuItem,ControlType.ToolBar,ControlType.StatusBar,ControlType.TitleBar];
    static string Clip(string s)=>s.Length<=4096?s:s[..4096];
    Snapshot Observe(JsonNode c,Window w) {
        Native.RequirePrivateChannel();
        var begin=Tick;var nodes=new JsonArray();var refs=new Dictionary<string,AutomationElement>();var signature=new JsonArray();bool complete=true;int bytes=0;
        var queue=new Queue<(AutomationElement E,string? Parent,int Depth)>();queue.Enqueue((w.Root,null,0));var visited=new HashSet<string>();
        while(queue.Count>0) {
            Native.RequirePrivateChannel();
            if(nodes.Count>=500||Tick-begin>300||bytes>400000){complete=false;break;}
            var (e,parent,depth)=queue.Dequeue();var runtime=string.Join(",",e.GetRuntimeId());if(!visited.Add(runtime))continue;
            var a=e.Current;bool sensitive=a.IsPassword||!Safe.Contains(a.ControlType);var actions=new JsonArray();
            bool fixture=S(w.Target,"appId")=="com.usebrian.NativeComputerFixture";
            if(!sensitive&&a.IsEnabled&&!a.IsOffscreen) {
                if(fixture&&e.TryGetCurrentPattern(InvokePattern.Pattern,out _))actions.Add("invoke");
                if((fixture||(a.ControlType==ControlType.Edit&&a.ClassName=="Edit"&&Automation.Compare(TreeWalker.ControlViewWalker.GetParent(e),w.Root)))&&e.TryGetCurrentPattern(ValuePattern.Pattern,out var v)&&!((ValuePattern)v).Current.IsReadOnly)actions.Add("setValue");
                if(fixture&&e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out _))actions.Add("select");
                if(fixture&&e.TryGetCurrentPattern(ScrollPattern.Pattern,out _))actions.Add("scroll");
            }
            var id=Id();var n=new JsonObject{["ref"]=id,["role"]=a.ControlType.ProgrammaticName,["name"]=sensitive?"":Clip(a.Name),["enabled"]=a.IsEnabled,["focused"]=a.HasKeyboardFocus,["selected"]=!sensitive&&e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out var sp)&&((SelectionItemPattern)sp).Current.IsSelected,["sensitive"]=sensitive,["actions"]=actions};
            if(parent!=null)n["parentRef"]=parent;
            var b=a.BoundingRectangle;if(!b.IsEmpty&&b.Width>0&&b.Height>0&&b.Width<=32768&&b.Height<=32768)n["bounds"]=new JsonObject{["x"]=b.X,["y"]=b.Y,["width"]=b.Width,["height"]=b.Height};
            if(!sensitive&&e.TryGetCurrentPattern(ValuePattern.Pattern,out var value)) {var text=((ValuePattern)value).Current.Value;if(text.Length>4096)complete=false;n["value"]=Clip(text);}
            if(!sensitive&&a.Name.Length>4096)complete=false;
            // Recheck after property/pattern reads; a changed secure classification discards the whole observation.
            Require(sensitive==(a.IsPassword||!Safe.Contains(a.ControlType)));
            var sig=(JsonObject)n.DeepClone();sig.Remove("ref");sig.Remove("parentRef");sig.Remove("focused");sig["runtime"]=runtime;sig["parent"]=parent==null?"":string.Join(",",refs[parent].GetRuntimeId());signature.Add(sig);
            bytes+=n.ToJsonString().Length*3;nodes.Add(n);refs[id]=e;
            if(sensitive){complete=false;continue;}
            var child=TreeWalker.ControlViewWalker.GetFirstChild(e);int count=0;
            while(child!=null) {if(depth>=16||queue.Count>=500||++count>500||Tick-begin>300){complete=false;break;}queue.Enqueue((child,id,depth+1));child=TreeWalker.ControlViewWalker.GetNextSibling(child);}
        }
        var o=new JsonObject{["identity"]=c["identity"]!.DeepClone(),["epoch"]=N(c,"epoch"),["id"]=Id(),["capturedAt"]=Now,["monotonicMs"]=Tick,["target"]=w.Target.DeepClone(),["foreground"]=Native.GetForegroundWindow()==w.H,["bounds"]=Native.Bounds(w.H).Json(),["displayLayoutVersion"]=Native.Layout(),["completeness"]=complete?"complete":"partial",["nodes"]=nodes};
        signature.Add(o["bounds"]!.DeepClone());signature.Add(o["displayLayoutVersion"]!.DeepClone());signature.Add(Native.GetDpiForWindow(w.H));Native.RequirePrivateChannel();return new(o,refs,Digest(signature),Tick);
    }
    Snapshot Fresh(JsonNode c,Window w,bool age=true) {
        var s=snapshot;Require(s!=null&&S(c["action"],"observationId")==S(s!.Observation,"id")&&(!age||Tick-s.Tick<=5000));
        Require(S(s!.Observation,"completeness")=="complete");var current=Observe(c,w);Require(S(current.Observation,"completeness")=="complete"&&current.Signature==s.Signature);return s;
    }
    internal bool Begin(JsonNode p) {
        Keys(p,"command","leaseId");var c=p["command"]!;Authorized(c,S(p,"leaseId"));Require(!Approving&&approved==null&&approval==null&&!journal.ContainsKey(S(c,"commandId")));
        var w=Live(c["action"]!["target"]!);Require(EffectClear(c,w));var s=Fresh(c,w);Require(S(c["action"],"kind") is not ("observe" or "capture" or "key" or "focus"));
        if(S(c["action"],"kind")=="click")VerifyPixels(w,s);
        approval=c.DeepClone();approvalSignature=s.Signature;Approving=true;return true;
    }
    internal bool End(JsonNode p) {
        Keys(p,"command","leaseId","approved");bool consent=B(p,"approved");var c=p["command"]!;Authorized(c,S(p,"leaseId"));Require(Approving&&JsonNode.DeepEquals(c,approval));
        var w=Live(c["action"]!["target"]!,false);Native.RequirePrivateChannel();Require(Native.SetForegroundWindow(w.H));Thread.Sleep(80);_=Live(w.Target);
        Require(EffectClear(c,w));var s=Fresh(c,w,false);Require(s.Signature==approvalSignature);if(S(c["action"],"kind")=="click")VerifyPixels(w,s);Approving=false;approval=null;
        // Approval can take longer than 5s; exact tree/geometry revalidation renews only this proposal.
        Native.RequirePrivateChannel();snapshot=s with {Tick=Tick};if(consent)approved=c.DeepClone();return true;
    }
    bool EffectClear(JsonNode c,Window w)=>Native.Clear(w.H,S(c["action"],"kind"),TrustedParentPid);
    bool Canvas(Window w)=>S(w.Target,"appId")=="com.usebrian.NativeComputerFixture"&&Native.Title(w.H)=="Brian Safe Canvas";
    internal JsonObject Execute(JsonNode p,HelperTiming? timing=null) {
        Keys(p,"command","leaseId");var c=p["command"]!;Command(c);string id=S(c,"commandId"),digest=Digest(c);Authorized(c,S(p,"leaseId"));
        // Refuse private wire clicks independently of advertised capability and approval.
        if(S(c["action"],"kind")=="click")return Receipt(id,"unsupported");
        if(journal.TryGetValue(id,out var old))return old.Digest==digest?(JsonObject)old.Receipt.DeepClone():Receipt(id,"denied");
        Require(journal.Count<512);var r=Receipt(id,"denied");journal[id]=(digest,r);bool dispatched=false;
        try {
            var a=c["action"]!;string k=S(a,"kind");var w=Live(a["target"]!);
            if(k=="observe") {snapshot=Observe(c,w);r=Receipt(id,"ok","executed");r["observation"]=snapshot.Observation.DeepClone();}
            else {
                var s=Fresh(c,w);
                if(k=="capture") {
                    Require(Canvas(w)&&Native.Clear(w.H)&&Tick-lastCapture>=1000);lastCapture=Tick;var b=Native.Bounds(w.H);Require((long)(b.R-b.L)*(b.B-b.T)<=2000000);
                    using var image=Native.Capture(w.H);
                    Require(Native.Clear(w.H));_=Fresh(c,Live(w.Target));using var ms=new MemoryStream();image.Save(ms,ImageFormat.Png);string data=Convert.ToBase64String(ms.ToArray());Require(data.Length<=3*1024*1024);
                    var frame=new JsonObject{["id"]=Id(),["mimeType"]="image/png",["data"]=data,["width"]=image.Width,["height"]=image.Height,["bounds"]=b.Json(),["displayLayoutVersion"]=Native.Layout()};
                    s.Observation["frame"]=frame;r=Receipt(id,"ok","executed");r["observation"]=s.Observation.DeepClone();
                } else {
                    if(!JsonNode.DeepEquals(c,approved)){r=Receipt(id,"approval_required");journal[id]=(digest,(JsonObject)r.DeepClone());return r;}
                    approved=null;Require(k is not ("key" or "focus"));Require(EffectClear(c,w));
                    AutomationElement? e=null;
                    if(k!="click") {Require(s.Refs.TryGetValue(S(a,"ref"),out e));var node=s.Observation["nodes"]!.AsArray().First(n=>S(n,"ref")==S(a,"ref"))!;Require(node["actions"]!.AsArray().Any(n=>n!.GetValue<string>()==k)&&!e!.Current.IsPassword&&!e.Current.IsOffscreen&&e.Current.IsEnabled);}
                    // Last gate immediately before dispatch; receipt is unknown before crossing into OS/provider.
                    Authorized(c,S(p,"leaseId"));_=Live(w.Target);_=Fresh(c,w);Require(EffectClear(c,w));Authorized(c,S(p,"leaseId"));journal[id]=(digest,Receipt(id,"helper_error","execution_unknown"));
                    {
                        dispatched=true;
                        switch(k) {case "invoke":var invoke=((InvokePattern)e!.GetCurrentPattern(InvokePattern.Pattern));Native.RequirePrivateChannel();HelperTiming.Invoke(timing,"api_invoke",()=>invoke.Invoke());break;
                        case "setValue":var value=((ValuePattern)e!.GetCurrentPattern(ValuePattern.Pattern));var text=S(a,"text");Native.RequirePrivateChannel();HelperTiming.Invoke(timing,"api_set_value",()=>value.SetValue(text));break;
                        case "select":var selection=((SelectionItemPattern)e!.GetCurrentPattern(SelectionItemPattern.Pattern));Native.RequirePrivateChannel();HelperTiming.Invoke(timing,"api_select",()=>selection.Select());break;
                        case "scroll":var delta=N(a,"deltaY");Require(delta!=0);var scroll=((ScrollPattern)e!.GetCurrentPattern(ScrollPattern.Pattern));var amount=delta>0?ScrollAmount.SmallIncrement:ScrollAmount.SmallDecrement;Native.RequirePrivateChannel();HelperTiming.Invoke(timing,"api_scroll",()=>scroll.Scroll(ScrollAmount.NoAmount,amount));break;
                        default:throw new InvalidDataException();}
                    }
                    snapshot=null;r=Receipt(id,"ok","executed");snapshot=Observe(c,Live(w.Target));r["observation"]=snapshot.Observation.DeepClone();
                }
            }
        }catch {r=Receipt(id,dispatched?"helper_error":"stale_observation",dispatched?"execution_unknown":"not_executed");}
        finally {if(dispatched)approved=null;}
        journal[id]=(digest,Receipt(id,S(r,"code"),S(r,"outcome")));return r;
    }
    void VerifyPixels(Window w,Snapshot s) {
        Require(Canvas(w)&&Native.Clear(w.H));var f=s.Observation["frame"];Require(f!=null);
        using var image=Native.Capture(w.H);using var ms=new MemoryStream();image.Save(ms,ImageFormat.Png);
        Require(Convert.ToBase64String(ms.ToArray())==S(f,"data")&&Native.Clear(w.H));
    }
    long lastCapture=long.MinValue/2;
}
