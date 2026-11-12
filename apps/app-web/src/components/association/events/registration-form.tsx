"use client";

/** Edit the canonical website registration metadata, with a non-submitting visitor preview. [COMP:app-web/association] */
import { useEffect, useRef, useState } from "react";
import { Eye, Plus } from "lucide-react";
import { z } from "zod";
import { useT } from "@/lib/i18n/client";
import { listAssociationPage, saveAssociationEvent, type AssociationEvent } from "@/lib/api/association";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AssociationChoice, AssociationField, useAssociationAction } from "../operator-controls";
import { InlineNotice, SwitchField } from "../ui";

const attendeeFields = ["phone", "organisation", "job_title"] as const;
const types = ["text", "textarea", "select"] as const;
// Matches the website's registration contract. Unknown metadata stays intact.
const questionSchema = z.object({
  key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  label: z.string().min(1).max(500),
  type: z.enum(types),
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(5000).default(500),
  options: z.array(z.string().min(1).max(300)).min(2).max(50).optional(),
});
const questionnaireSchema = z.object({ version: z.string(), questions: z.array(questionSchema).max(20) });
type Question = z.infer<typeof questionSchema>;
type QuestionDraft = Omit<Question, "options"> & { optionLines: string };

export function readEventRegistration(metadata: Record<string, unknown>) {
  const questionnaire = questionnaireSchema.safeParse(metadata.questionnaire);
  const shown = Array.isArray(metadata.attendeeFields) ? metadata.attendeeFields : [];
  const required = Array.isArray(metadata.requiredAttendeeFields) ? metadata.requiredAttendeeFields : [];
  const fields = Object.fromEntries(attendeeFields.map(field => [field, shown.includes(field) ? field === "phone" || required.includes(field) ? "required" : "optional" : "hidden"]));
  const questions = (questionnaire.data?.questions ?? []).map(({ options, ...question }) => ({ ...question, optionLines: options?.join("\n") ?? "" }));
  return { fields, questions, invalid: metadata.questionnaire != null && !questionnaire.success };
}

function normalizedQuestion({ optionLines, ...question }: QuestionDraft) {
  return {
    ...question,
    label: question.label.trim(),
    ...(question.type === "select" ? { options: optionLines.split("\n").map(value => value.trim()).filter(Boolean) } : {}),
  };
}

function validQuestion(question: ReturnType<typeof normalizedQuestion>) {
  return questionSchema.safeParse(question).success &&
    (!question.options || new Set(question.options).size === question.options.length);
}

export type EventRegistrationDraft = ReturnType<typeof readEventRegistration>;

export function invalidRegistrationQuestion(draft: EventRegistrationDraft) {
  return draft.questions.map(normalizedQuestion).find(question => !validQuestion(question))?.key ?? "";
}

export function eventRegistrationMetadata(metadata: Record<string, unknown>, draft: EventRegistrationDraft, baseline: EventRegistrationDraft) {
  const next = {
    ...metadata,
    attendeeFields: attendeeFields.filter(field => draft.fields[field] !== "hidden"),
    requiredAttendeeFields: attendeeFields.filter(field => draft.fields[field] === "required"),
  } as Record<string, unknown>;
  if (JSON.stringify(draft.questions) !== JSON.stringify(baseline.questions)) {
    if (draft.questions.length) next.questionnaire = { version: `form-${crypto.randomUUID()}`, questions: draft.questions.map(normalizedQuestion) };
    else delete next.questionnaire;
  }
  return next;
}

export function EventRegistrationForm({ workspaceId, event, disabled, onDirtyChange, onSaved }: {
  workspaceId: string; event: AssociationEvent; disabled: boolean; onDirtyChange: (dirty: boolean) => void; onSaved: () => void;
}) {
  const t = useT().associationPage, s = t.staff;
  const [baseline, setBaseline] = useState(() => readEventRegistration(event.metadata));
  const [draft, setDraft] = useState(baseline);
  const [error, setError] = useState("");
  const [invalidQuestion, setInvalidQuestion] = useState("");
  const action = useAssociationAction(workspaceId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  async function save() {
    if (disabled || !dirty || action.pending) return;
    const invalid = invalidRegistrationQuestion(draft);
    setInvalidQuestion(invalid);
    if (invalid) return;
    setError("");
    await action.run(s.saveForm, async () => {
      const page = await listAssociationPage(workspaceId, "events", { id: event.id });
      const latest = page.items.find(row => row.id === event.id);
      if (!latest || JSON.stringify(readEventRegistration(latest.metadata)) !== JSON.stringify(baseline) ||
        latest.metadata.registrationKind === "none" || latest.metadata.registrationKind === "external") {
        setError(s.formChanged);
        throw new Error("stale_registration_form");
      }
      const { id: _id, ...body } = latest;
      const response = await saveAssociationEvent(workspaceId, { ...body, metadata: eventRegistrationMetadata(body.metadata, draft, baseline) });
      const next = readEventRegistration(response.record.metadata);
      setBaseline(next); setDraft(next); onSaved();
    }, false);
  }

  if (baseline.invalid) return <InlineNotice tone="warning">{s.formChanged}</InlineNotice>;
  return <section className="space-y-4" data-event-registration-editor>
    <EventRegistrationFields title={event.title} draft={draft} setDraft={setDraft} invalidQuestion={invalidQuestion} disabled={disabled || action.pending} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {action.outcome === "failed" && !error && action.feedback}
    {action.outcome === "saved" && !dirty && <InlineNotice tone="success">{t.ux.saved}</InlineNotice>}
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" className="min-h-11 md:min-h-9" disabled={!dirty || disabled || action.pending} onClick={() => void save()}>{s.saveForm}</Button>
      {event.status !== "draft" && <p className="text-sm text-muted-foreground">{s.formLive}</p>}
    </div>
  </section>;
}

export function EventRegistrationFields({ title, draft, setDraft, invalidQuestion, disabled, embedded = false }: {
  title: string;
  draft: EventRegistrationDraft;
  setDraft: React.Dispatch<React.SetStateAction<EventRegistrationDraft>>;
  invalidQuestion: string;
  disabled: boolean;
  embedded?: boolean;
}) {
  const t = useT().associationPage, s = t.staff;
  const [preview, setPreview] = useState(false);
  const [focusQuestion, setFocusQuestion] = useState("");
  const editor = useRef<HTMLElement>(null);
  useEffect(() => {
    if (invalidQuestion) { setPreview(false); setFocusQuestion(invalidQuestion); }
  }, [invalidQuestion]);
  useEffect(() => {
    if (focusQuestion && !preview) {
      editor.current?.querySelector<HTMLInputElement>(`[data-question="${focusQuestion}"] input`)?.focus();
      setFocusQuestion("");
    }
  }, [focusQuestion, preview]);
  const labels = { phone: s.phone, organisation: s.organisation, job_title: s.jobTitle };
  const displayLabels = { hidden: s.hidden, optional: s.optional, required: s.required };
  const questionLabels = { text: s.shortAnswer, textarea: s.longAnswer, select: s.choice };
  function editQuestion(key: string, changes: Partial<QuestionDraft>) {
    setDraft(current => ({ ...current, questions: current.questions.map(question => question.key === key ? { ...question, ...changes } : question) }));
  }

  return <section ref={editor} className="space-y-4">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold">{s.registrationForm}</h3><p className="mt-1 text-sm text-muted-foreground">{embedded ? s.registrationHelp : t.eventSetup.standardForm}</p></div>
      <Button type="button" variant="outline" className="min-h-11 md:min-h-9" aria-pressed={preview} onClick={() => setPreview(value => !value)}>
        <Eye aria-hidden className="size-4" />{preview ? s.backToEditor : t.eventSetup.previewForm}
      </Button>
    </header>
    {preview ? <div className="max-w-xl space-y-4 rounded-xl border border-border bg-background p-5" data-registration-preview>
      <p className="text-sm text-muted-foreground">{s.previewOnly}</p>
      <h3 className="text-lg font-semibold">{title || s.registrationForm}</h3>
      <div className="grid gap-3 sm:grid-cols-2"><PreviewText label={s.firstName} required detached={embedded} /><PreviewText label={s.lastName} required detached={embedded} /></div>
      <PreviewText label={s.email} type="email" required detached={embedded} />
      {attendeeFields.filter(field => draft.fields[field] !== "hidden").map(field => <PreviewText key={field} label={labels[field]} type={field === "phone" ? "tel" : "text"} required={draft.fields[field] === "required"} detached={embedded} />)}
      {draft.questions.map(question => <PreviewQuestion key={question.key} question={question} detached={embedded} />)}
    </div> : <fieldset disabled={disabled} className="min-w-0 space-y-4">
      <div className="grid gap-4 rounded-lg bg-muted/30 p-4 sm:grid-cols-3">
        {attendeeFields.map(field => <AssociationChoice key={field} label={labels[field]} value={draft.fields[field] ?? "hidden"}
          values={field === "phone" ? ["hidden", "required"] : ["hidden", "optional", "required"]}
          labels={displayLabels} onChange={value => setDraft(current => ({ ...current, fields: { ...current.fields, [field]: value } }))} />)}
      </div>
      {draft.questions.map((question, index) => <div key={question.key} data-question={question.key} className="grid min-w-0 gap-4 rounded-lg bg-muted/30 p-4 sm:grid-cols-2">
        <AssociationField label={s.question} value={question.label} onChange={label => editQuestion(question.key, { label })} maxLength={500} aria-invalid={!!invalidQuestion && !question.label.trim()} />
        <AssociationChoice label={s.answerType} value={question.type} values={types} labels={questionLabels}
          onChange={value => editQuestion(question.key, { type: value as Question["type"] })} />
        {question.type === "select" && <AssociationField label={s.choices} multiline value={question.optionLines} onChange={optionLines => editQuestion(question.key, { optionLines })} />}
        <SwitchField label={s.required} checked={question.required} onChange={required => editQuestion(question.key, { required })} />
        {!!invalidQuestion && !validQuestion(normalizedQuestion(question)) && <p className="text-sm text-destructive sm:col-span-2">{s.invalidQuestions}</p>}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="button" variant="outline" className="min-h-11 md:min-h-9" disabled={index === 0} onClick={() => setDraft(current => {
            const questions = [...current.questions]; [questions[index - 1], questions[index]] = [questions[index]!, questions[index - 1]!];
            return { ...current, questions };
          })}>{s.moveUp}</Button>
          <Button type="button" variant="ghost" className="min-h-11 md:min-h-9" onClick={() => setDraft(current => ({ ...current, questions: current.questions.filter(item => item.key !== question.key) }))}>{t.publishing.remove}</Button>
        </div>
      </div>)}
      <Button type="button" variant="outline" className="min-h-11 md:min-h-9" disabled={draft.questions.length >= 20} onClick={() => {
        const key = `question-${crypto.randomUUID()}`;
        setDraft(current => ({
          ...current, questions: [...current.questions, { key, label: "", type: "text", required: false, maxLength: 500, optionLines: "" }],
        }));
        setFocusQuestion(key);
      }}><Plus aria-hidden className="size-4" />{s.addQuestion}</Button>
    </fieldset>}
  </section>;
}

function PreviewText({ label, type = "text", required, detached }: { label: string; type?: "text" | "email" | "tel"; required?: boolean; detached?: boolean }) {
  const [value, setValue] = useState("");
  return <AssociationField label={label} type={type} value={value} onChange={setValue} required={required && !detached} aria-required={required} form={detached ? "event-form-preview" : undefined} />;
}

function PreviewQuestion({ question, detached }: { question: QuestionDraft; detached?: boolean }) {
  const s = useT().associationPage.staff;
  const label = question.label.trim() || s.question;
  const [value, setValue] = useState("");
  const choices = [...new Set(question.optionLines.split("\n").map(option => option.trim()).filter(Boolean))];
  return question.type === "select" ? <div className="space-y-1 text-sm">
    <span>{label}{question.required ? " *" : ""}</span>
    <Select items={choices.map(choice => ({ value: choice, label: choice }))} value={value} onValueChange={next => setValue(next ?? "")}>
      <SelectTrigger aria-label={label} aria-required={question.required} className="min-h-11 md:min-h-9 w-full text-base"><SelectValue placeholder={s.choice} /></SelectTrigger>
      <SelectContent>{choices.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
    </Select>
  </div> : question.type === "textarea"
    ? <AssociationField label={label} value={value} onChange={setValue} multiline required={question.required && !detached} maxLength={question.maxLength} />
    : <AssociationField label={label} value={value} onChange={setValue} maxLength={question.maxLength} required={question.required && !detached} form={detached ? "event-form-preview" : undefined} />;
}
