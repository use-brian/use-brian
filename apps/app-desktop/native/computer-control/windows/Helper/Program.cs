using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Windows.Forms;
using static Brian.Native.Boundary;
namespace Brian.Native;
internal static class Program {
    static readonly Broker Broker=new();
    static Native.HookProc? keyboard,mouse;
    static Native.EventProc? windowEvents;
    static long busyUntil;
    static Process? parent;
    [StructLayout(LayoutKind.Sequential)] struct KeyEvent {public uint Key,Scan,Flags,Time;public nuint Extra;}
    [StructLayout(LayoutKind.Sequential)] struct MouseEvent {public Native.Point Point;public uint Data,Flags,Time;public nuint Extra;}
    [STAThread] static void Main() {
        try {
            Require(OperatingSystem.IsWindowsVersionAtLeast(10,0,17763)&&RuntimeInformation.OSArchitecture==Architecture.X64&&RuntimeInformation.ProcessArchitecture==Architecture.X64);
            Require(Environment.UserInteractive&&!SystemInformation.TerminalServerSession&&Console.IsInputRedirected&&Console.IsOutputRedirected);
            Native.RequirePrivateChannel();
            Require(Native.SetProcessDpiAwarenessContext(-4));Require(Native.Desktop());Require(Native.Integrity(Process.GetCurrentProcess())==0x2000);
            parent=Process.GetProcessById(Native.Parent());Broker.TrustedParentPid=parent.Id;
            keyboard=(code,w,l)=>Hook(false,code,w,l);mouse=(code,w,l)=>Hook(true,code,w,l);
            Require(Native.Hook(13,keyboard)!=0&&Native.Hook(14,mouse)!=0);
            windowEvents=WindowEvent;
            Require(Native.SetWinEventHook(0x8001,0x8001,0,windowEvents,0,0,0)!=0);
            Require(Native.SetWinEventHook(0x800B,0x800B,0,windowEvents,0,0,0)!=0);
            Require(Native.SetWinEventHook(3,3,0,windowEvents,0,0,0)!=0);
            Microsoft.Win32.SystemEvents.SessionSwitch+=(_,_)=>Environment.Exit(71);
            Microsoft.Win32.SystemEvents.PowerModeChanged+=(_,_)=>Environment.Exit(71);
            Microsoft.Win32.SystemEvents.DisplaySettingsChanging+=(_,_)=>Environment.Exit(71);
            var watchdog=new Thread(()=> {while(true){Thread.Sleep(50);try {if(!Native.PrivateChannelAlive()||parent.HasExited||!Native.Desktop()||(Broker.Active&&Environment.TickCount64>=Broker.WatchdogExpiry)||(Interlocked.Read(ref busyUntil)!=0&&Environment.TickCount64>=Interlocked.Read(ref busyUntil)))Environment.Exit(70);}catch{Environment.Exit(70);}}}){IsBackground=true};watchdog.Start();
            // UIA never runs on the hook/message-pump thread. A blocked provider dies at 3s.
            var worker=new Thread(Work){IsBackground=true};worker.SetApartmentState(ApartmentState.MTA);worker.Start();Application.Run();
        }catch {Environment.Exit(72);}
    }
    static void WindowEvent(nint hook,uint evt,nint window,int objectId,int childId,uint thread,uint time) {
        if(evt==0x8001&&objectId==0&&childId==0&&Native.Generations.TryGetValue(window,out var generation))Native.Generations.TryUpdate(window,generation+1,generation);
        if(!Broker.Active)return;
        if((evt==0x8001||evt==0x800B)&&window==Broker.ActiveWindow&&objectId==0&&childId==0)Environment.Exit(71);
        if(evt==3&&window!=Broker.ActiveWindow&&!(Broker.Approving&&Native.Pid(window)==parent!.Id))Environment.Exit(73);
    }
    static nint Hook(bool isMouse,int code,nint w,nint l) {
        if(code>=0&&Broker.Active) {
            // No marker exemption: semantic actions/capture do not inject input.
            int pid;
            if(isMouse){var e=Marshal.PtrToStructure<MouseEvent>(l);pid=Native.Pid(Native.GetAncestor(Native.WindowFromPoint(e.Point),2));}
            else{pid=Native.Pid(Native.GetForegroundWindow());}
            if(!(Broker.Approving&&pid==parent!.Id))Environment.Exit(73);
        }
        return Native.CallNextHookEx(0,code,w,l);
    }
    static void Work() {
        using var input=Console.OpenStandardInput();using var output=Console.OpenStandardOutput();
        try {while(true) {
            var request=Read(input);if(request==null)Environment.Exit(0);bool diagnostics=Request(request!);IdField(request,"id");Native.RequirePrivateChannel();
            var timing=HelperTiming.Begin(request!,diagnostics);
            long deadline=Environment.TickCount64+3000;
            if(request!["payload"]?["command"] is JsonNode c)deadline=Math.Min(deadline,Environment.TickCount64+Math.Max(0,N(c,"deadlineAt")-Now));
            Interlocked.Exchange(ref busyUntil,deadline);
            JsonNode? result=null;bool ok=true;
            try {var p=request!["payload"]!;result=S(request,"method") switch {
                "capabilities"=>Empty(p,()=>Broker.Capabilities()),"listTargets"=>Empty(p,()=>Broker.List()),
                "start"=>JsonValue.Create(Broker.Start(p)),"beginApproval"=>JsonValue.Create(Broker.Begin(p)),"endApproval"=>JsonValue.Create(Broker.End(p)),"execute"=>Broker.Execute(p,timing),_=>throw new InvalidDataException()};
            }catch {ok=false;}
            var response=new JsonObject{["id"]=S(request,"id"),["ok"]=ok,["result"]=result};
            if(S(request,"method")=="capabilities")response["diagnosticsVersion"]=1;
            var metadata=timing?.Finish(ok);if(metadata!=null)response["diagnostics"]=metadata;
            Native.RequirePrivateChannel();
            Write(output,response);Interlocked.Exchange(ref busyUntil,0);
            if(!ok)Environment.Exit(72);
            if(result is JsonObject o&&o["outcome"]?.GetValue<string>()=="execution_unknown")Environment.Exit(70);
        }}catch{Environment.Exit(72);}
    }
    static JsonNode Empty(JsonNode p,Func<JsonNode> f){Keys(p);return f();}
}
