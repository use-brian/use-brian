using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Text.Json.Nodes;
using static Brian.Native.Boundary;
namespace Brian.Native;
internal static class Native {
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int L,T,R,B; public bool Valid=>R>L&&B>T&&R-L<=8192&&B-T<=8192; public JsonObject Json()=>new(){["x"]=L,["y"]=T,["width"]=R-L,["height"]=B-T}; }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X,Y; }
    internal delegate bool EnumProc(nint h,nint l);
    internal delegate nint HookProc(int code,nint w,nint l);
    internal delegate void EventProc(nint hook,uint evt,nint window,int objectId,int childId,uint thread,uint time);
    internal static readonly System.Collections.Concurrent.ConcurrentDictionary<nint,long> Generations=new();
    [DllImport("user32.dll")] internal static extern nint SetWinEventHook(uint min,uint max,nint module,EventProc callback,uint process,uint thread,uint flags);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumProc cb,nint l);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(nint h);
    [DllImport("user32.dll")] internal static extern bool IsWindowEnabled(nint h);
    [DllImport("user32.dll")] internal static extern bool IsIconic(nint h);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(nint h,out Rect r);
    [DllImport("user32.dll")] internal static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(nint h);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint h,out uint p);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern int GetWindowText(nint h,StringBuilder s,int n);
    [DllImport("user32.dll")] internal static extern nint GetAncestor(nint h,uint flags);
    [DllImport("user32.dll")] internal static extern nint WindowFromPoint(Point p);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(nint c);
    [DllImport("user32.dll")] internal static extern bool ClientToScreen(nint h,ref Point p);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(nint h);
    [DllImport("user32.dll")] static extern bool PrintWindow(nint h,nint dc,uint flags);
    internal static Bitmap Capture(nint h) {
        var b=Bounds(h);Require((long)(b.R-b.L)*(b.B-b.T)<=2000000);var bitmap=new Bitmap(b.R-b.L,b.B-b.T);
        try {using var g=Graphics.FromImage(bitmap);g.Clear(Color.Black);var dc=g.GetHdc();try {RequirePrivateChannel();Require(PrintWindow(h,dc,2));}finally{g.ReleaseHdc(dc);}return bitmap;}catch{bitmap.Dispose();throw;}
    }
    [DllImport("user32.dll")] internal static extern nint OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(nint h);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(nint h,int i,StringBuilder s,uint len,out uint need);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(nint p,uint access,out nint t);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(nint t,int type,nint data,int len,out int need);
    [DllImport("advapi32.dll")] static extern nint GetSidSubAuthority(nint sid,uint i);
    [DllImport("advapi32.dll")] static extern nint GetSidSubAuthorityCount(nint sid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(nint h);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern nint GetModuleHandle(string? name);
    [DllImport("user32.dll")] internal static extern nint SetWindowsHookEx(int id,HookProc proc,nint module,uint thread);
    [DllImport("user32.dll")] internal static extern nint CallNextHookEx(nint hook,int code,nint w,nint l);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(nint p,int c,nint b,int size,out int returned);
    // FILE_PIPE_LOCAL_INFORMATION (FilePipeLocalInformation=24), documented in
    // WDK ntifs.h. Unlike PeekNamedPipe/readability, NamedPipeState distinguishes
    // CLOSING from CONNECTED while ReadDataAvailable may still be nonzero.
    [StructLayout(LayoutKind.Sequential)] struct IoStatusBlock { public nint Status; public nuint Information; }
    [StructLayout(LayoutKind.Sequential)] struct PipeLocalInformation {
        public uint Type, Configuration, MaximumInstances, CurrentInstances, InboundQuota,
                    ReadDataAvailable, OutboundQuota, WriteQuotaAvailable, NamedPipeState, End;
    }
    [DllImport("kernel32.dll")] static extern nint GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern uint GetFileType(nint handle);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(nint handle, out IoStatusBlock status,
        out PipeLocalInformation info, uint length, int informationClass);
    static bool PipeConnected(nint handle) {
        if(handle==0||handle==-1||GetFileType(handle)!=3)return false; // FILE_TYPE_PIPE only
        uint size=(uint)Marshal.SizeOf<PipeLocalInformation>();
        return NtQueryInformationFile(handle,out var status,out var pipe,size,24)==0 &&
            status.Status==0 && status.Information==size && pipe.NamedPipeState==3;
    }
    internal static bool PrivateChannelAlive() {
        try {
            // Check output first: never depend on a protocol reader draining input.
            // Only inherited handles are queried; no new pipe, read or write.
            return PipeConnected(GetStdHandle(-11))&&PipeConnected(GetStdHandle(-10));
        } catch { return false; } // Missing/unsupported query is not authority.
    }
    internal static void RequirePrivateChannel() { if(!PrivateChannelAlive())Environment.Exit(70); }
    internal static int Pid(nint h) { GetWindowThreadProcessId(h,out var p);return checked((int)p); }
    internal static int Parent() { nint b=Marshal.AllocHGlobal(6*IntPtr.Size); try { Require(NtQueryInformationProcess(Process.GetCurrentProcess().Handle,0,b,6*IntPtr.Size,out _)==0);return checked((int)Marshal.ReadIntPtr(b,5*IntPtr.Size)); } finally {Marshal.FreeHGlobal(b);} }
    internal static bool Desktop() { nint d=OpenInputDesktop(0,false,1); if(d==0)return false; try {var s=new StringBuilder(256);return GetUserObjectInformation(d,2,s,512,out _)&&s.ToString()=="Default";} finally {CloseDesktop(d);} }
    internal static int Integrity(Process p) { Require(OpenProcessToken(p.Handle,8,out var t)); try {GetTokenInformation(t,25,0,0,out int n); Require(n>0&&n<65536); nint b=Marshal.AllocHGlobal(n);try {Require(GetTokenInformation(t,25,b,n,out _));var sid=Marshal.ReadIntPtr(b);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));Require(count>0);return Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));}finally{Marshal.FreeHGlobal(b);}}finally{CloseHandle(t);} }
    internal static nint Hook(int kind,HookProc proc)=>SetWindowsHookEx(kind,proc,GetModuleHandle(null),0);
    internal static string Title(nint h) {var b=new StringBuilder(256);GetWindowText(h,b,256);return b.ToString();}
    internal static Rect Bounds(nint h) {Require(GetWindowRect(h,out var r)&&r.Valid);return r;}
    // SystemEvents display changes revoke the process; bounds hash also fences every command.
    internal static string Layout()=>Digest(new JsonArray(System.Windows.Forms.Screen.AllScreens.Select(s=>(JsonNode?)new JsonObject{["name"]=s.DeviceName,["x"]=s.Bounds.X,["y"]=s.Bounds.Y,["w"]=s.Bounds.Width,["h"]=s.Bounds.Height}).ToArray()));
    internal static bool Clear(nint h, string actionKind="", int trustedParentPid=0) {
        var r=Bounds(h);bool clear=true,found=false;
        EnumWindows((other,_)=>{
            if(other==h){found=true;return false;}
            if(!IsWindowVisible(other))return true;
            // Unknown geometry or owner cannot establish that an overlay is harmless.
            if(!GetWindowRect(other,out var b)){clear=false;return false;}
            bool intersects=b.R>r.L&&b.L<r.R&&b.B>r.T&&b.T<r.B;
            if(BlocksOverlay(actionKind,true,intersects,Pid(other),trustedParentPid)){clear=false;return false;}
            return true;
        },0);
        return clear&&found;
    }
    // No coordinate emitter: SendInput/finally cannot guarantee owned release after termination.
}
