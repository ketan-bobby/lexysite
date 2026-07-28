/**
 * Public entry point for the React (client) side of the OpenAI AI integration.
 * Re-exports the voice audio utilities and hooks (recorder, playback, stream).
 */
export { decodePCM16ToFloat32, createAudioPlaybackContext } from "./audio/audio-utils";
export { useVoiceRecorder, type RecordingState } from "./audio/useVoiceRecorder";
export { useAudioPlayback, type PlaybackState } from "./audio/useAudioPlayback";
export { useVoiceStream } from "./audio/useVoiceStream";
