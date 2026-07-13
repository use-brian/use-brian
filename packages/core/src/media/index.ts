export type { MediaAttachment } from './types.js'
export { transcribeAudio, type TranscribeOptions, type TranscribeResult } from './transcribe.js'
export { transcribeFirstAudio, type PreflightOptions } from './preflight.js'
export {
  transcribeRecording,
  transcribeRecordingChunks,
  uploadAudioToGeminiFiles,
  parseTranscriptLines,
  mergeUtterances,
  stripDegenerateTail,
  stripDegenerateUtterances,
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
