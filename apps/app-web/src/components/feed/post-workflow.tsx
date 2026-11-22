"use client";

/** Visible editorial stages and canonical actions. [COMP:app-web/feed-post-workflow] */
import { Check, ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n/client';
import { StatusLabel } from './feed-status';
import type { PostQueueStatus } from '@/lib/feed-posts';

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
  return <div role="group" aria-label={te.workflow} className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-feed-post-workflow>
    <span aria-current="step" className="me-auto pe-1"><StatusLabel status={props.status} label={t.feedPage.posts.status[props.status]} /></span>
    <div className="flex max-w-full flex-wrap items-center gap-1">
      {props.onReview ? <Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-9 whitespace-normal"
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
