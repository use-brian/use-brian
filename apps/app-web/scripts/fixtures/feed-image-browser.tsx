// [COMP:app-web/feed-generation-placeholder] Browser regression for modal focus and scroll.
import { useState } from 'react';
import { CompositionEditor, type FeedEditorSelection } from '@/components/feed/composition-editor';
import type { FeedGenerationControls } from '@/components/feed/generation-placeholder';
import { importLegacyFeed } from '@use-brian/doc-model';
import type { FeedPlaceholderAttrs } from '@use-brian/shared';

const composition = importLegacyFeed({ text: Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. A fictional orchard grows apples and pears.`).join('\n\n'), postFormat: 'post', threadSegments: [], media: [] });
const segment = composition.segments[0]!;
const slot: FeedPlaceholderAttrs = { id: crypto.randomUUID(), kind: 'image', brief: 'A fictional orchard.', briefRevision: 0, references: [] };
segment.content.splice(18, 0, { type: 'generationPlaceholder', attrs: slot });
const commands: unknown[] = [];
const controls: FeedGenerationControls = {
  workspaceId: 'fictional-workspace', assistantId: 'fictional-writer', sessionId: 'fictional-draft', revision: 1,
  offline: false, pending: false, readOnly: false, article: false,
  onCommand: async command => { commands.push(command); return true; }, onRefresh: () => {},
  snapshot: { copy: null, threads: [], suggestions: ['First option', 'Second option'].map(alt => ({
    id: crypto.randomUUID(), sourceRunId: crypto.randomUUID(), sourceRevision: 1,
    edits: [{ kind: 'replaceBlock', segmentId: segment.id, blockId: slot.id, preimage: { type: 'generationPlaceholder', attrs: slot }, replacement: [{ type: 'image', attrs: { id: slot.id, fileId: crypto.randomUUID(), mimeType: 'image/png', alt, placement: 'attachment' } }] }],
    rationale: alt, status: 'proposed', threadId: null, parentId: null, authorUserId: 'fixture', authorKind: 'assistant',
  })) },
};
// Another background counter must not force modal masking into the editor.
const secondSlot = { ...slot, id: crypto.randomUUID() };
segment.content.splice(30, 0, { type: 'generationPlaceholder', attrs: secondSlot });
controls.snapshot!.suggestions.push(...controls.snapshot!.suggestions.map(candidate => ({ ...candidate, id: crypto.randomUUID(), edits: candidate.edits.map(edit => edit.kind === 'replaceBlock' ? { ...edit, blockId: secondSlot.id, preimage: { type: 'generationPlaceholder' as const, attrs: secondSlot } } : edit) })));
Object.assign(window, { feedImageFixture: { commands } });
export function FeedImageFixture() {
  const [, setSelection] = useState<FeedEditorSelection | null>(null);
  return <main data-image-scroll className="h-dvh overflow-y-auto p-4"><CompositionEditor composition={composition} generation={controls} threads={[]}
    onEdit={edits => commands.push(edits)} onSelection={next => setSelection(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)}
    onOpenThread={() => {}} onAction={() => {}} /></main>;
}
