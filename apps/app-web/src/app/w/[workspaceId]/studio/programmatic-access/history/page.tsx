"use client";
import {useWorkspaces} from "@/contexts/workspace-context";
import {HistoryReader} from "@/components/engineering-history/history-reader";
export default function EngineeringHistoryPage(){const {activeId}=useWorkspaces();return activeId?<HistoryReader key={activeId} workspaceId={activeId}/>:null}
