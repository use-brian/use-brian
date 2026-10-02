using System.Buffers.Binary;
using System.Text;
using System.Text.Json.Nodes;
using Brian.Native;
using static Brian.Native.Boundary;
int count=0;
void Test(string name,Action test){test();count++;Console.WriteLine("PASS "+name);}
void Reject(Action a){bool failed=false;try{a();}catch{failed=true;}if(!failed)throw new Exception("Expected rejection");}
JsonNode Parse(string s)=>JsonNode.Parse(s)!;
var target=Parse("{\"appId\":\"app\",\"processId\":123,\"processInstanceId\":\"p\",\"windowId\":\"w\",\"windowInstanceId\":\"wi\"}");
var identity=Parse("{\"deploymentId\":\"d\",\"userId\":\"u\",\"workspaceId\":\"w\",\"deviceId\":\"dev\",\"sessionId\":\"s\",\"conversationId\":\"c\",\"taskId\":\"t\"}");
JsonObject CommandOf(string kind)=>new(){["protocol"]=Protocol,["identity"]=identity.DeepClone(),["grantId"]="g",["epoch"]=1,["commandId"]="c",["deadlineAt"]=Now+10000,["action"]=new JsonObject{["kind"]=kind,["target"]=target.DeepClone()}};
Test("frame roundtrip",()=>{using var s=new MemoryStream();Write(s,target);s.Position=0;Require(JsonNode.DeepEquals(target,Read(s)));Require(Read(s)==null);});
Test("zero/oversize/truncated frames",()=>{foreach(uint size in new uint[]{0,Max+1,uint.MaxValue,10}){byte[] h=new byte[4];BinaryPrimitives.WriteUInt32BigEndian(h,size);Reject(()=>Read(new MemoryStream(h)));}});
Test("duplicate JSON keys rejected recursively",()=>{byte[] b=Encoding.UTF8.GetBytes("{\"a\":{\"x\":1,\"x\":2}}");byte[] h=new byte[4];BinaryPrimitives.WriteUInt32BigEndian(h,(uint)b.Length);Reject(()=>Read(new MemoryStream(h.Concat(b).ToArray())));});
Test("canonical digest order independent and payload bound",()=>{Require(Digest(Parse("{\"a\":1,\"b\":2}"))==Digest(Parse("{\"b\":2,\"a\":1}")));Require(Digest(Parse("{\"a\":1}"))!=Digest(Parse("{\"a\":2}")));});
Test("observe command and strict keys",()=>{var c=CommandOf("observe");Command(c);c["extra"]=true;Reject(()=>Command(c));});
Test("unknown action denied",()=>Reject(()=>Command(CommandOf("shell"))));
Test("typed text and bounded scroll",()=>{var c=CommandOf("setValue");c["action"]!["observationId"]="o";c["action"]!["ref"]="r";c["action"]!["text"]=new string('x',4096);Command(c);c["action"]!["text"]=new string('x',4097);Reject(()=>Command(c));var s=CommandOf("scroll");s["action"]!["observationId"]="o";s["action"]!["ref"]="r";s["action"]!["deltaY"]=601;Reject(()=>Command(s));s["action"]!["deltaY"]=-600;Command(s);});
Test("key allowlist",()=>{var c=CommandOf("key");c["action"]!["observationId"]="o";c["action"]!["key"]="Ctrl+L";Reject(()=>Command(c));c["action"]!["key"]="Tab";Command(c);});
Test("coordinate numeric boundary",()=>{var c=CommandOf("click");c["action"]!["observationId"]="o";c["action"]!["frameId"]="f";c["action"]!["x"]=-1;c["action"]!["y"]=0;Reject(()=>Command(c));c["action"]!["x"]=1.5;Command(c);});
Test("identity/target exact shape",()=>{Identity(identity);Target(target);var t=target.DeepClone();t["processId"]=0;Reject(()=>Target(t));});
Test("grant lifetime and single-target scope",()=>{var g=new JsonObject{["protocol"]=Protocol,["identity"]=identity.DeepClone(),["grantId"]="g",["epoch"]=1,["expiresAt"]=Now+60000,["targets"]=new JsonArray(target.DeepClone()),["allowControl"]=true,["allowCapture"]=false,["requester"]="Local",["goal"]="Test"};Grant(g);g["expiresAt"]=Now-1;Reject(()=>Grant(g));g["expiresAt"]=Now+1000000;Reject(()=>Grant(g));});
Test("semantic indicator overlay allowed only for exact trusted parent",()=>{foreach(var kind in new[]{"invoke","setValue","select","scroll"}) {Require(!BlocksOverlay(kind,true,true,42,42));Require(BlocksOverlay(kind,true,true,43,42));}});
Test("pixel paths never exempt trusted parent overlays",()=>{foreach(var kind in new[]{"capture","click"})Require(BlocksOverlay(kind,true,true,42,42));});
Test("unsupported actions cannot inherit semantic overlay exception",()=>{foreach(var kind in new[]{"","focus","key","observe","shell"})Require(BlocksOverlay(kind,true,true,42,42));});
Test("missing parent or window identity fails closed",()=>{Require(BlocksOverlay("setValue",true,true,0,0));Require(BlocksOverlay("setValue",true,true,-1,-1));Require(BlocksOverlay("setValue",true,true,0,42));Require(BlocksOverlay("setValue",true,true,42,0));});
Test("target-owned modal and arbitrary application overlays still block",()=>{const int parent=42,target=50,other=60;Require(BlocksOverlay("invoke",true,true,target,parent));Require(BlocksOverlay("invoke",true,true,other,parent));});
Test("invisible and nonintersecting windows do not occlude",()=>{foreach(var kind in new[]{"invoke","capture","click"}) {Require(!BlocksOverlay(kind,false,true,60,42));Require(!BlocksOverlay(kind,true,false,60,42));}});
Test("source: input disabled and private click refused before native dispatch",()=>{
    var broker=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Broker.source"));
    var native=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Native.source"));
    Require(broker.Contains("[\"input\"]=false")&&!broker.Contains("[\"input\"]=true"));
    var execute=broker[broker.IndexOf("internal JsonObject Execute",StringComparison.Ordinal)..];
    const string refusal="if(S(c[\"action\"],\"kind\")==\"click\")return Receipt(id,\"unsupported\");";
    Require(execute.Contains(refusal)&&execute.IndexOf(refusal,StringComparison.Ordinal)<execute.IndexOf("var w=Live",StringComparison.Ordinal));
    Require(!broker.Contains("Native.Click(")&&!native.Contains("extern uint SendInput")&&!native.Contains("void Click("));
    Require(execute.Contains("Native.Capture(w.H)")&&execute.Contains("((InvokePattern)")&&execute.Contains("((ValuePattern)")&&execute.Contains("((SelectionItemPattern)")&&execute.Contains("((ScrollPattern)"));
});
Test("source: no self-input marker bypass; parent approval and hook ABI retained",()=>{
    var program=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Program.source"));
    var native=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Native.source"));
    var hook=program[program.IndexOf("static nint Hook(",StringComparison.Ordinal)..program.IndexOf("static void Work()",StringComparison.Ordinal)];
    Require(!program.Contains("Native.Marker")&&!native.Contains("Marker")&&!hook.Contains(".Extra")&&!hook.Contains("GetCurrentProcess"));
    Require(hook.Contains("if(code>=0&&Broker.Active)")&&hook.Contains("if(!(Broker.Approving&&pid==parent!.Id))Environment.Exit(73);"));
    Require(hook.Contains("Native.WindowFromPoint(e.Point)")&&hook.Contains("Native.GetForegroundWindow()"));
    Require(hook.Split("return").Length==2&&hook.Contains("return Native.CallNextHookEx(0,code,w,l);"));
    Require(program.Contains("[StructLayout(LayoutKind.Sequential)] struct KeyEvent {public uint Key,Scan,Flags,Time;public nuint Extra;}"));
    Require(program.Contains("[StructLayout(LayoutKind.Sequential)] struct MouseEvent {public Native.Point Point;public uint Data,Flags,Time;public nuint Extra;}"));
});
Test("source: private channel uses local connection state, not buffered byte availability",()=>{
    var native=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Native.source"));
    var program=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Program.source"));
    var broker=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Broker.source"));
    Require(native.Contains("NtQueryInformationFile(handle,out var status,out var pipe,size,24)==0"));
    Require(native.Contains("pipe.NamedPipeState==3")&&native.Contains("status.Information==size"));
    Require(native.Contains("catch { return false; }")&&native.Contains("GetFileType(handle)!=3"));
    Require(program.Contains("Native.RequirePrivateChannel();\n            Require(Native.SetProcessDpiAwarenessContext"));
    Require(program.Contains("Native.RequirePrivateChannel();\n            Write(output"));
    Require(native.Contains("RequirePrivateChannel();Require(PrintWindow"));
    Require(broker.Contains("Snapshot Observe(JsonNode c,Window w) {\n        Native.RequirePrivateChannel();"));
    Require(!native.Contains("PeekNamedPipe(")&&!native.Contains("WriteFile("));
    Require(program.Contains("if(!Native.PrivateChannelAlive()||parent.HasExited"));
    Require(program.Contains("IdField(request,\"id\");Native.RequirePrivateChannel();"));
    foreach(var phase in new[]{"api_invoke","api_set_value","api_select","api_scroll"})
        Require(broker.Contains("Native.RequirePrivateChannel();HelperTiming.Invoke(timing,\""+phase+"\",()=>"));
    Require(broker.Contains("Native.RequirePrivateChannel();Require(Native.SetForegroundWindow"));
});
JsonObject RequestOf(string method="execute")=>new(){["id"]="request_1",["method"]=method,["payload"]=new JsonObject{["command"]=CommandOf("observe")}};
Test("private opt-in is strict JSON boolean and optional",()=>{
    var r=RequestOf();Require(!Request(r));r["diagnostics"]=false;Require(!Request(r));r["diagnostics"]=true;Require(Request(r));
    foreach(var bad in new[]{"null","0","1","\"true\"","{}","[]"}){r["diagnostics"]=Parse(bad);Reject(()=>Request(r));}
    r.Remove("diagnostics");r["extra"]=true;Reject(()=>Request(r));
});
Test("private framed malformed opt-in and duplicate opt-in rejected",()=>{
    foreach(var tail in new[]{"\"diagnostics\":null","\"diagnostics\":\"true\"","\"diagnostics\":true,\"diagnostics\":false"}) {
        byte[] bytes=Encoding.UTF8.GetBytes("{\"id\":\"r\",\"method\":\"capabilities\",\"payload\":{},"+tail+"}");
        byte[] header=new byte[4];BinaryPrimitives.WriteUInt32BigEndian(header,(uint)bytes.Length);
        Reject(()=>Request(Read(new MemoryStream(header.Concat(bytes).ToArray()))!));
    }
});
Test("all fixed methods emit request-only timing outside execute",()=>{
    foreach(var method in new[]{"capabilities","listTargets","start","beginApproval","endApproval"}) {
        var r=RequestOf(method);r["diagnostics"]=true;Require(Request(r));
        var dto=HelperTiming.Begin(r,true)!.Finish(true)!;
        Require(S(dto,"method")==method&&dto["spans"]!.AsArray().Count==1&&S(dto["spans"]![0],"phase")=="request");
    }
    Reject(()=>Request(RequestOf("arbitrary_method")));
});
Test("timing disabled and unrepresentable correlation omitted",()=>{
    var r=RequestOf();Require(HelperTiming.Begin(r,false)==null);r["id"]="raw secret label";Require(HelperTiming.Begin(r,true)==null);
});
Test("source clock DTO nesting, UUID lifetime, phases and exact arithmetic",()=>{
    string? instance=null,clock=null;
    foreach(var kind in new[]{"observe","capture","invoke","setValue","select","scroll"}) {
        var r=RequestOf();r["payload"]!["command"]!["action"]!["kind"]=kind;
        var t=HelperTiming.Begin(r,true)!;int effects=0;
        string? phase=kind switch {"invoke"=>"api_invoke","setValue"=>"api_set_value","select"=>"api_select","scroll"=>"api_scroll",_=>null};
        if(phase!=null)HelperTiming.Invoke(t,phase,()=>effects++);
        var dto=t.Finish(true)!;Keys(dto,"version","instanceId","clockId","requestId","method","spans");Require(N(dto,"version")==1);
        Require(Guid.TryParse(S(dto,"instanceId"),out _)&&Guid.TryParse(S(dto,"clockId"),out _));
        instance??=S(dto,"instanceId");clock??=S(dto,"clockId");Require(instance==S(dto,"instanceId")&&clock==S(dto,"clockId")&&instance!=clock);
        var spans=dto["spans"]!.AsArray();Require(spans.Count==(phase==null?1:2)&&effects==(phase==null?0:1));
        Require(S(spans[0],"phase")== (kind=="observe"?"observe_request":kind=="capture"?"capture_request":"request"));
        foreach(var span in spans){Keys(span,"phase","startUs","endUs","durationUs","status");Require(N(span,"endUs")-N(span,"startUs")==N(span,"durationUs")&&N(span,"durationUs") is >=0 and <=900000000);Require(N(span,"startUs")>=N(spans[0],"startUs")&&N(span,"endUs")<=N(spans[0],"endUs"));}
    }
});
Test("failed invocation propagates once; metadata failure never replays work",()=>{
    var r=RequestOf();r["payload"]!["command"]!["action"]!["kind"]="invoke";
    var t=HelperTiming.Begin(r,true)!;int calls=0;
    Reject(()=>HelperTiming.Invoke(t,"api_invoke",()=>{calls++;throw new InvalidOperationException("private sentinel");}));
    var dto=t.Finish(false)!;Require(calls==1&&S(dto["spans"]![1],"status")=="failed"&&!dto.ToJsonString().Contains("sentinel"));
    HelperTiming.Invoke(t,"invalid phase",()=>calls++);Require(calls==2&&t.Finish(true)==null);
    HelperTiming.Invoke(null,"api_invoke",()=>calls++);Require(calls==3);
});
Test("source: negotiation only on response and one guarded output",()=>{
    var program=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Program.source"));
    var broker=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Broker.source"));
    Require(program.Contains("if(S(request,\"method\")==\"capabilities\")response[\"diagnosticsVersion\"]=1;")&&!broker.Contains("diagnosticsVersion"));
    Require(program.Contains("bool diagnostics=Request(request!)")&&program.Split("Write(output,").Length==2);
    Require(program.Contains("var metadata=timing?.Finish(ok);if(metadata!=null)response[\"diagnostics\"]=metadata;"));
});
Console.WriteLine($"{count} portable boundary tests passed; no Windows native gates exercised.");
