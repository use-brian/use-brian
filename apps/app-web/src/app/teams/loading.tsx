import { Skeleton } from "@/components/skeleton";

export default function TeamsLoading() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6 animate-fade-in">
        <div className="space-y-2 text-center">
          <Skeleton className="h-7 w-32 mx-auto" />
          <Skeleton className="h-3 w-72 mx-auto" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
