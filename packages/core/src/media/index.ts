export type { MediaAttachment } from './types.js'
export { transcribeAudio, type TranscribeOptions, type TranscribeResult } from './transcribe.js'
export { transcribeFirstAudio, type PreflightOptions } from './preflight.js'
export {
  transcribeRecording,
  uploadAudioToGeminiFiles,
  parseTranscriptLines,
  mergeUtterances,
  stripDegenerateTail,
  stripDegenerateUtterances,
  type TranscribedUtterance,
  type RecordingTranscriptionResult,
  type TranscribeRecordingOptions,
} from './transcribe-recording.js'
