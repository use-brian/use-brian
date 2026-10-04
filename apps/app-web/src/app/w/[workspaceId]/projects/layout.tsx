"use client";

import type { ReactNode } from "react";
import { ProjectsTopbar } from "@/components/projects/projects-navigation";

export default function ProjectsLayout({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col">
    <ProjectsTopbar />
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </div>;
}
