using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Security.Cryptography;

namespace Brian.Native;
public static class Boundary {
    public const int Max = 4 * 1024 * 1024;
    public const string Protocol = "native-computer-v1";
    public static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public static string Id() => Guid.NewGuid().ToString();
    // Only non-pixel semantic effects can see through the trusted parent's indicator.
    // No title-based trust, target-process exemption, or pixel-path exception.
    public static bool BlocksOverlay(string actionKind, bool visible, bool intersects, int windowPid, int trustedParentPid) {
        bool semantic = actionKind is "invoke" or "setValue" or "select" or "scroll";
        bool trustedOverlay = semantic && trustedParentPid > 0 && windowPid == trustedParentPid;
        return visible && intersects && !trustedOverlay;
    }
    public static string S(JsonNode? n, string k) => n?[k]?.GetValue<string>() ?? throw new InvalidDataException();
    public static long N(JsonNode? n, string k) => JsonSerializer.Deserialize<long>(n?[k]?.ToJsonString() ?? throw new InvalidDataException());
    public static double D(JsonNode? n, string k) => JsonSerializer.Deserialize<double>(n?[k]?.ToJsonString() ?? throw new InvalidDataException());
    public static bool B(JsonNode? n, string k) => n?[k]?.GetValue<bool>() ?? throw new InvalidDataException();
    public static void Require(bool b) { if (!b) throw new InvalidDataException("Rejected boundary"); }
    public static void Keys(JsonNode? n, params string[] keys) => Require(n is JsonObject o && o.Count == keys.Length && keys.All(o.ContainsKey));
    public static void IdField(JsonNode? n, string k, int max = 256) { var s = S(n,k); Require(s.Length > 0 && s.Length <= max); }
    // Private envelope opt-in only; no coercion, null, payload or public capability extension.
    public static bool Request(JsonNode n) {
        bool has=n is JsonObject o && o.ContainsKey("diagnostics");
        Keys(n,has ? ["id","method","payload","diagnostics"] : ["id","method","payload"]);
        IdField(n,"id");
        Require(S(n,"method") is "capabilities" or "listTargets" or "start" or "beginApproval" or "endApproval" or "execute");
        return has && B(n,"diagnostics");
    }
    public static void Identity(JsonNode? n) { string[] keys = ["deploymentId","userId","workspaceId","deviceId","sessionId","conversationId","taskId"]; Keys(n,keys); foreach(var k in keys) IdField(n,k); }
    public static void Target(JsonNode? n) { Keys(n,"appId","processId","processInstanceId","windowId","windowInstanceId"); foreach(var k in new[]{"appId","processInstanceId","windowId","windowInstanceId"}) IdField(n,k); Require(N(n,"processId") > 0 && N(n,"processId") <= int.MaxValue); }
    public static void Grant(JsonNode n) {
        Keys(n,"protocol","identity","grantId","epoch","expiresAt","targets","allowControl","allowCapture","requester","goal");
        Require(S(n,"protocol")==Protocol); Identity(n["identity"]); IdField(n,"grantId"); IdField(n,"requester",200); IdField(n,"goal",2000);
        Require(N(n,"epoch")>0 && N(n,"expiresAt")>Now && N(n,"expiresAt")<=Now+900000); _=B(n,"allowControl"); _=B(n,"allowCapture");
        Require(n["targets"] is JsonArray a && a.Count==1); Target(n["targets"]![0]);
    }
    public static void Command(JsonNode n) {
        Keys(n,"protocol","identity","grantId","epoch","commandId","deadlineAt","action"); Require(S(n,"protocol")==Protocol);
        Identity(n["identity"]); IdField(n,"grantId"); IdField(n,"commandId"); Require(N(n,"epoch")>=0 && N(n,"deadlineAt")>=0);
        var a=n["action"]!; Target(a["target"]); var kind=S(a,"kind");
        string[] extra=kind switch { "observe"=>[], "capture" or "focus"=>["observationId"], "invoke" or "select"=>["observationId","ref"], "setValue"=>["observationId","ref","text"], "scroll"=>["observationId","ref","deltaY"], "click"=>["observationId","frameId","x","y"], "key"=>["observationId","key"], _=>throw new InvalidDataException() };
        Keys(a, new[]{"kind","target"}.Concat(extra).ToArray()); foreach(var k in extra.Where(k=>k is "observationId" or "ref" or "frameId")) IdField(a,k);
        if(kind=="setValue") Require(S(a,"text").Length<=4096);
        if(kind=="scroll") Require(N(a,"deltaY") is >=-600 and <=600);
        if(kind=="click") foreach(var k in new[]{"x","y"}) { double v=D(a,k); Require(double.IsFinite(v)&&v>=0); }
        if(kind=="key") Require(new[]{"Tab","Shift+Tab","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Escape","Enter"}.Contains(S(a,"key")));
    }
    public static string Digest(JsonNode n) => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Canonical(n))));
    static string Canonical(JsonNode? n) => n switch { JsonObject o => "{"+string.Join(",",o.OrderBy(p=>p.Key,StringComparer.Ordinal).Select(p=>JsonSerializer.Serialize(p.Key)+":"+Canonical(p.Value)))+"}", JsonArray a=>"["+string.Join(",",a.Select(Canonical))+"]", _=>n?.ToJsonString()??"null" };
    public static JsonNode? Read(Stream stream) {
        byte[] h=new byte[4]; int first=stream.ReadByte(); if(first<0)return null; h[0]=(byte)first; stream.ReadExactly(h.AsSpan(1));
        int size=checked((int)BinaryPrimitives.ReadUInt32BigEndian(h)); Require(size>0&&size<=Max); byte[] b=new byte[size]; stream.ReadExactly(b);
        using var doc=JsonDocument.Parse(b,new JsonDocumentOptions{MaxDepth=40}); Unique(doc.RootElement);
        return JsonNode.Parse(b)!;
    }
    static void Unique(JsonElement e) { if(e.ValueKind==JsonValueKind.Object) { var seen=new HashSet<string>(); foreach(var p in e.EnumerateObject()){Require(seen.Add(p.Name));Unique(p.Value);} } else if(e.ValueKind==JsonValueKind.Array) foreach(var v in e.EnumerateArray()) Unique(v); }
    public static void Write(Stream stream, JsonNode n) { byte[] b=JsonSerializer.SerializeToUtf8Bytes(n); Require(b.Length>0&&b.Length<=Max); byte[] h=new byte[4]; BinaryPrimitives.WriteUInt32BigEndian(h,(uint)b.Length); stream.Write(h); stream.Write(b); stream.Flush(); }
    public static JsonObject Receipt(string id,string code,string outcome="not_executed") => new(){["commandId"]=id,["code"]=code,["outcome"]=outcome};
}
