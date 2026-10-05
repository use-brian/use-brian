/** Every workspace can be deleted by its owner. Spec: workspaces.md. */
export function canDeleteWorkspace(role: string): boolean {
  return role === "owner";
}
