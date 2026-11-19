import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "../../../apps/app-web/node_modules/react-router-dom";
import { Plus } from "../../../apps/app-web/node_modules/lucide-react";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { TriggerEditor } from "@/components/workflow/trigger-editor";
import type { WorkflowTrigger } from "@/lib/api/workflow";
import { ChoiceCards, SwitchField } from "@/components/association/ui";
import { AnalyseTab } from "@/components/shopify/analyse-tab";
import { Button as ViewButton } from "../../../packages/views-renderer/src/widgets/Button";
import { CheckboxProperty } from "../../../packages/views-renderer/src/properties/checkbox";
import "./preview.css";

const surface = new URLSearchParams(location.search).get("surface") ?? "renderers";
const names: Record<string, string> = {
  renderers: "Rendered views: action and checkbox primitives",
  association: "Association: form choice cards",
  workflow: "Workflow builder: trigger selection",
  shopify: "Shopify: Analyse choices",
  emoji: "Document icon: emoji picker in dark mode",
  controls: "Shared controls: phone target-size verification",
};

function Reference() {
  return <section className="audit-reference"><h2>Common-system reference (production primitives)</h2>
    <div className="audit-controls"><Button>Save changes</Button><Button variant="outline">Cancel</Button>
      <label className="audit-controls"><Switch defaultChecked aria-label="Reference enabled" /> Enabled</label>
    </div>
  </section>;
}

function Frame({ children }: { children: ReactNode }) {
  return <main className="audit-frame">
    <header><p className="audit-label">ISOLATED REAL-COMPONENT CAPTURE · NOT AN AUTHENTICATED PAGE</p>
      <h1>{names[surface] ?? names.renderers}</h1>
      <p className="audit-note">Unmodified source components and app globals. Synthetic input only; no workspace API or external actions.</p>
    </header>
    {children}
  </main>;
}

function Renderers() {
  const Cell = CheckboxProperty.Cell;
  return <><div className="audit-comparison">
    <section className="audit-panel" data-audit="app-primitives"><h2>Common app primitives</h2>
      <Button data-audit="app-button">Save changes</Button>
      <div className="audit-controls mt-5"><Checkbox defaultChecked aria-label="App checkbox" /><span className="text-sm">Shared checkbox</span></div>
    </section>
    <section className="audit-panel" data-audit="renderer-primitives"><h2>views-renderer primitives</h2>
      <ViewButton text="Save changes" action={{ id: "audit-noop" }} />
      <div className="audit-controls mt-5"><Cell value="true" /><span className="text-sm">Checkbox property cell</span></div>
    </section>
  </div><Reference /></>;
}

function Association() {
  const [value, setValue] = useState("public");
  return <><ChoiceCards label="Fixture: registration visibility" value={value} onChange={setValue}
    options={[{ value: "public", label: "Public registration", hint: "Anyone can register for this event." }, { value: "members", label: "Members only", hint: "Require an active membership." }]} />
    <div className="mt-6"><SwitchField label="Fixture: accept registrations" checked onChange={() => {}} help="Shared switch with neutral action tokens and a reserved phone hit area." /></div><Reference /></>;
}

function Workflow() {
  const [trigger, setTrigger] = useState<WorkflowTrigger>({ kind: "manual" });
  return <><TriggerEditor workflowId="audit-fixture" workspaceId={null} trigger={trigger} webhookSlug={null} webhookSecret={null}
    onChange={setTrigger} onRotateWebhook={() => {}} /><Reference /></>;
}

function Controls() {
  return <><section className="audit-panel"><h2>Unenlarged primitive defaults (caller may enlarge)</h2>
    <div className="audit-controls" data-audit="controls">
      <Button data-audit="default-button">Default action</Button>
      <Button size="icon" aria-label="Add item" data-audit="icon-button"><Plus /></Button>
      <Select defaultValue="first" items={{ first: "First option" }}><SelectTrigger aria-label="Example choice" data-audit="select-trigger"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="first">First option</SelectItem></SelectContent></Select>
      <Checkbox defaultChecked aria-label="Example checkbox" data-audit="checkbox" />
      <Switch defaultChecked aria-label="Example switch" data-audit="switch" />
    </div>
  </section><p className="audit-note">Measurements are stored in manifest.json. The contract is 44px touch targets below 768px; this fixture deliberately adds no larger label/hit-area wrapper.</p></>;
}

function Emoji() {
  return <><p className="audit-note mb-5">The outer popover and emoji-mart both follow the resolved app mode.</p>
    <EmojiPicker trigger={<Button variant="outline">Choose page icon</Button>} onPick={() => {}} /><Reference /></>;
}

function App() {
  return <BrowserRouter><I18nProvider locale="en" dict={en}><Frame>
    {surface === "association" ? <Association /> : surface === "workflow" ? <Workflow /> : surface === "controls" ? <Controls />
      : surface === "shopify" ? <><AnalyseTab workspaceId="audit-fixture" /><Reference /></> : surface === "emoji" ? <Emoji /> : <Renderers />}
  </Frame></I18nProvider></BrowserRouter>;
}

createRoot(document.getElementById("root")!).render(<App />);
