
DECLARE publication public.native_conversation_publications;completion public.native_turn_completions;
BEGIN
 IF cancelled THEN RETURN 'stopped_by_user';END IF;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_publication_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
 IF t IS NULL OR a IS NULL THEN RETURN 'stalled_reclaimed';END IF;
 SELECT * INTO publication FROM public.native_conversation_publications p
  WHERE p.workspace_id=w AND p.session_id=s AND p.turn_token=t
   AND p.slot='buffered_transcript';
 -- The shared-web buffered receipt (8272) keeps its exact terminal rule.
 IF FOUND THEN
  IF publication.command_format=1 THEN RETURN 'stalled_reclaimed';END IF;
  IF publication.command_format<>2 THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
  IF publication.completed_at IS NULL OR publication.outputs IS NULL OR jsonb_typeof(publication.outputs) IS DISTINCT FROM 'array'
   OR jsonb_array_length(publication.outputs)<>publication.expected_output_count
  THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
  IF publication.assistant_id<>a OR publication.stopped OR publication.terminal_descriptor IS NULL THEN RETURN 'stalled_reclaimed';END IF;
  IF publication.outputs IS NULL OR publication.terminal_outputs IS NULL
   OR jsonb_typeof(publication.terminal_outputs) IS DISTINCT FROM 'array'
   OR jsonb_array_length(publication.terminal_outputs)=0
   OR jsonb_array_length(publication.terminal_outputs)<>jsonb_array_length(publication.terminal_descriptor->'members')
  THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
  -- The authenticated independent completion owner validates descriptor/member
  -- shape, exact roots/native references and the entire actual output closure
  -- before this immutable row can commit. Current access does not alter that fact.
  RETURN 'publication_recovered';
 END IF;
 -- Every other lane and edition: the per-turn completion header (8277), written
 -- in the same transaction as the reply. Its absence is never a commit.
 SELECT * INTO completion FROM public.native_turn_completions c WHERE c.session_id=s AND c.turn_token=t;
 IF NOT FOUND THEN RETURN 'stalled_reclaimed';END IF;
 IF completion.workspace_id IS DISTINCT FROM w OR jsonb_typeof(completion.outputs) IS DISTINCT FROM 'array'
  OR jsonb_array_length(completion.outputs)=0
 THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
 IF completion.assistant_id<>a OR completion.stopped OR NOT completion.published_reply THEN RETURN 'stalled_reclaimed';END IF;
 RETURN 'publication_recovered';
END 
