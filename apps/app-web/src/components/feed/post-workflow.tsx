"use client";

/** Visible editorial stages and canonical actions. [COMP:app-web/feed-post-workflow] */
import { Check, ChevronRight, ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import type { PostQueueStatus } from '@/lib/feed-posts';

const stages = ['drafting', 'review', 'ready', 'posted'] as const;

export function FeedPostWorkflow(props: {
  status: PostQueueStatus;
  hasEdits: boolean;
  actionDisabled: boolean;
  reviewOpen: boolean;
  onReview?: (anchor: HTMLButtonElement) => void;
  onCommit: () => void;
  onApprove: () => void;
  approveLabel?: string;
  onPosted: () => void;
}) {
  const t = useT();
  const te = t.feedPage.postEditor;
  const committing = props.status === 'drafting' || (props.status === 'review' && props.hasEdits);
  return <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3" data-feed-post-workflow>
    <ol aria-label={te.workflow} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-2 text-xs">
      {stages.map((stage, index) => <li key={stage} aria-current={props.status === stage ? 'step' : undefined}
        className={cn('inline-flex items-center gap-1.5 text-muted-foreground', props.status === stage && 'font-semibold text-foreground')}>
        {index > 0 ? <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden /> : null}
        <span className={cn('rounded-md px-1.5 py-1', props.status === stage && 'bg-muted')}>{t.feedPage.posts.status[stage]}</span>
      </li>)}
    </ol>
    <div className="flex max-w-full flex-wrap items-center gap-2">
      {props.onReview ? <Button type="button" variant="outline" size="sm" className="min-h-11 md:min-h-9 whitespace-normal"
        aria-expanded={props.reviewOpen} onClick={event => props.onReview?.(event.currentTarget)}>
        <ClipboardCheck className="size-4 shrink-0" aria-hidden />{t.feedCollaboration.review}
      </Button> : null}
      {props.status !== 'posted' ? <Button type="button" size="sm" disabled={props.actionDisabled}
        className="min-h-11 md:min-h-9 whitespace-normal bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90"
        onClick={committing ? props.onCommit : props.status === 'review' ? props.onApprove : props.onPosted}>
        {props.status === 'review' && !props.hasEdits ? <Check className="size-4 shrink-0" aria-hidden /> : null}
        {props.status === 'drafting' ? te.submitForApproval : committing ? te.saveChanges : props.status === 'review' ? props.approveLabel ?? te.approve : te.markPosted}
      </Button> : null}
    </div>
  </div>;
}
