export type { MediaAttachment } from './types.js'
// The transcript wire format lives in @use-brian/shared, not here: app-web must
// be able to PARSE what the server WROTE (to make [H:MM:SS] citations
// clickable), and app-web deliberately does not depend on core — core is the
// server engine. `shared` is the client-safe surface both sides can hold.
// Re-exported so server consumers keep importing it from core.
export {
  formatStamp,
  parseStamp,
  scanStamps,
  formatTranscriptLine,
  formatTranscript,
  STAMP_RE,
  UNKNOWN_SPEAKER,
  type StampMatch,
  type TranscriptLineSource,
} from '@use-brian/shared'
// Citations are the same story: the writer resolves them, the browser reads them.
export {
  buildCitationIndex,
  extractCitations,
  type CitationIndex,
  type CitationSegment,
  type FieldCitation,
} from '@use-brian/shared'
export { transcribeAudio, type TranscribeOptions, type TranscribeResult } from './transcribe.js'
export { transcribeFirstAudio, describeTranscriptionFailure, type PreflightOptions } from './preflight.js'
export {
  transcribeRecording,
  transcribeRecordingChunks,
  uploadAudioToGeminiFiles,
  parseTranscriptLines,
  mergeUtterances,
  stripDegenerateTail,
  stripDegenerateUtterances,
  hasTranscriptHole,
  type TranscribedUtterance,
  type RecordingAudioChunk,
  type RecordingTranscriptionResult,
  type TranscribeRecordingOptions,
} from './transcribe-recording.js'
export {
  coverageTruncated,
  withTranscriberFallback,
  geminiTranscriber,
  GEMINI_CHUNKED_MIN_DURATION_MS,
  type RecordingTranscriber,
  type RecordingTranscribeRequest,
} from './recording-transcriber.js'
export {
  scribeTranscriber,
  groupScribeWords,
  SCRIBE_USD_PER_AUDIO_HOUR,
  SCRIBE_KEYTERMS_USD_PER_AUDIO_HOUR,
  type ScribeTranscriberOptions,
  type ScribeWord,
} from './scribe.js'
export {
  qwenFiletransTranscriber,
  QWEN_FILETRANS_USD_PER_AUDIO_HOUR,
  type QwenFiletransOptions,
} from './qwen-filetrans.js'
export {
  convertChineseScript,
  containsHan,
  type ChineseScript,
} from './chinese-script.js'
export {
  transcriptionPrefsSchema,
  parseTranscriptionPrefs,
  type WorkspaceTranscriptionPrefs,
} from './transcription-prefs.js'
