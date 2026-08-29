-- 480_transcript_segment_kind.sql  (OPEN table -> use-brian/packages/api/migrations/)
--
-- Video frame analysis: keyframe descriptions of a video recording ride
-- transcript_segments as kind='visual' rows (speaker 'Screen'), interleaved
-- chronologically with the packed speech segments, so searchRecording, range
-- reads, the synthesis prompt, and [H:MM:SS] citations inherit them with zero
-- new readers. 'speech' is every pre-existing row's meaning, hence the DEFAULT.
--
-- See docs/architecture/media/transcription.md -> "Video frame analysis".

BEGIN;

ALTER TABLE transcript_segments
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'speech';

ALTER TABLE transcript_segments
  ADD CONSTRAINT transcript_segments_kind_check CHECK (kind IN ('speech','visual'));

COMMIT;
