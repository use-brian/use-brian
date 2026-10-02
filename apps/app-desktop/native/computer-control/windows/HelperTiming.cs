using System.Diagnostics;
using System.Text.Json.Nodes;
using static Brian.Native.Boundary;
namespace Brian.Native;

// Private source intervals, never delivery/mutation/drain evidence. Metadata failure
// drops the DTO; it must never suppress, catch/retry, or replay the actual operation.
internal sealed class HelperTiming {
    static class Domain {
        internal static readonly string Instance=Guid.NewGuid().ToString(), Clock=Guid.NewGuid().ToString();
        internal static readonly long Origin=Stopwatch.GetTimestamp();
    }
    readonly string id,method,phase;
    readonly long start;
    JsonObject? api;
    bool invalid;
    static long Us() {
        long origin=Domain.Origin;long ticks=checked(Stopwatch.GetTimestamp()-origin);
        Require(ticks>=0);
        long us=checked((long)((Int128)ticks*1_000_000/Stopwatch.Frequency));
        Require(us<=9_007_199_254_740_991);return us;
    }
    HelperTiming(JsonNode request) {
        id=S(request,"id");method=S(request,"method");
        Require(id.All(c=>char.IsAsciiLetterOrDigit(c)||c is '_' or '-'));
        phase=method=="execute" ? request["payload"]?["command"]?["action"]?["kind"]?.GetValue<string>() switch {
            "observe"=>"observe_request","capture"=>"capture_request",_=>"request"
        } : "request";
        start=Us();
    }
    internal static HelperTiming? Begin(JsonNode request,bool enabled) {
        if(!enabled)return null;
        try{return new(request);}catch{return null;}
    }
    static JsonObject Span(string phase,long start,long end,bool returned) {
        Require(end>=start&&end-start<=900_000_000);
        return new(){["phase"]=phase,["startUs"]=start,["endUs"]=end,["durationUs"]=end-start,["status"]=returned?"returned":"failed"};
    }
    internal static void Invoke(HelperTiming? timing,string phase,Action action) {
        long? begin=null;
        if(timing!=null)try {
            Require(timing.api==null&&timing.method=="execute"&&timing.phase=="request"&&phase is "api_set_value" or "api_invoke" or "api_select" or "api_scroll");
            begin=Us();
        }catch{timing.invalid=true;}
        bool returned=false;
        try{action();returned=true;}
        finally {
            if(timing!=null&&begin.HasValue)try{timing.api=Span(phase,begin.Value,Us(),returned);}catch{timing.invalid=true;}
        }
    }
    internal JsonObject? Finish(bool returned) {
        try {
            if(invalid)return null;
            var spans=new JsonArray(Span(phase,start,Us(),returned));if(api!=null)spans.Add(api.DeepClone());
            return new(){["version"]=1,["instanceId"]=Domain.Instance,["clockId"]=Domain.Clock,["requestId"]=id,["method"]=method,["spans"]=spans};
        }catch{return null;}
    }
}
