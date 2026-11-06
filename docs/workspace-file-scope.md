# Workspace file tool scope

`fileWrite` creates a new text file at an unused workspace path. Its description
must distinguish storage location from the file's read audience: source-derived
files retain canonical private ownership and all sensitivity, Department and
Project restrictions. They are not automatically readable by every workspace
member. The backend revalidates source evidence and admits the inherited scope
in the insert transaction.

Source-free files may be workspace-visible. The model cannot choose private
ownership through this tool's arguments or infer it solely from a Personal chat
label. It must retain verified private source scope when required and report a
refusal instead of using a shared fallback or changing access. Sensitivity is a
clearance label, independent of sharing; requesting `public` does not publish a
private source or remove its restrictions.
