import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pick a workspace",
  description: "Choose which workspace to open.",
};

export default function TeamsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
