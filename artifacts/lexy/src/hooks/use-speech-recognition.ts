import { useState, useEffect, useCallback, useRef } from "react";

interface SpeechRecognitionOptions {
  onResult: (text: string) => void;
}

export function useSpeechRecognition({ onResult }: SpeechRecognitionOptions) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      setIsSupported(true);
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = "en-US";

      recognitionRef.current.onresult = (event: any) => {
        let finalTranscript = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          }
        }
        if (finalTranscript) {
          onResult(finalTranscript.trim() + " ");
        }
      };

      recognitionRef.current.onerror = (event: any) => {
        if (event.error === "no-speech") return;
        setError(`Speech recognition error: ${event.error}`);
        setIsListening(false);
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
      };
    }
  }, [onResult]);

  const startListening = useCallback(() => {
    setError(null);
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (e: any) {
      setError(`Could not start recognition: ${e.message}`);
    }
  }, []);

  const stopListening = useCallback(() => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.stop();
      setIsListening(false);
    } catch (_e) {
      // ignore
    }
  }, []);

  useEffect(() => {
    // stop listening on unmount
    return () => {
      if (recognitionRef.current && isListening) {
        try {
          recognitionRef.current.stop();
        } catch (_error) {
          // The browser may have already ended recognition during unmount.
        }
      }
    };
  }, [isListening]);

  return {
    isSupported,
    isListening,
    startListening,
    stopListening,
    error,
    clearError: () => setError(null),
  };
}
