import { useCallback, useEffect, useState } from "react";
import { normalizeSpeechModel, speechModel, type SpeechModelInfo } from "../lib/speech";
import * as api from "../lib/tauri";

/** Speech model choice, the download list, and dictation. Settings reads this. */
export function useSpeech(setFlash: (flash: { kind: "err"; text: string }) => void) {
  const [speechModelId, setSpeechModelId] = useState(speechModel(null).id);
  const [speechRows, setSpeechRows] = useState<SpeechModelInfo[]>([]);
  const [speechProgress, setSpeechProgress] = useState<{ id: string; received: number; total: number } | null>(null);
  const [speechDownloading, setSpeechDownloading] = useState(false);

  const refreshSpeech = useCallback(() => {
    void api
      .speechModels()
      .then((rows) => setSpeechRows(rows))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshSpeech();
    let gone = false;
    void api
      .getAppSetting("speech.model")
      .then((saved) => {
        if (!gone) setSpeechModelId(normalizeSpeechModel(saved));
      })
      .catch(() => undefined);
    let unlisten: (() => void) | undefined;
    void api
      .onSpeechDownload((event) => {
        setSpeechProgress({ id: event.id, received: event.received, total: event.total });
        if (event.done) {
          setSpeechDownloading(false);
          setSpeechProgress(null);
          refreshSpeech();
        }
      })
      .then((fn) => {
        if (gone) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [refreshSpeech]);

  const pickSpeechModel = useCallback(
    (id: string) => {
      const next = normalizeSpeechModel(id);
      setSpeechModelId(next);
      void api.setAppSetting("speech.model", next).catch((e) => setFlash({ kind: "err", text: String(e) }));
    },
    [setFlash],
  );

  const downloadSpeech = useCallback(
    (id: string) => {
      setSpeechDownloading(true);
      setSpeechProgress({ id: normalizeSpeechModel(id), received: 0, total: speechModel(id).bytes });
      void api
        .speechDownload(normalizeSpeechModel(id))
        .then((row) => {
          setSpeechRows((prev) => prev.map((item) => (item.id === row.id ? row : item)));
        })
        .catch((e) => setFlash({ kind: "err", text: String(e) }))
        .finally(() => {
          setSpeechDownloading(false);
          setSpeechProgress(null);
          refreshSpeech();
        });
    },
    [refreshSpeech, setFlash],
  );

  const dictate = useCallback(async (bytesBase64: string, filename: string) => {
    return api.transcribe(bytesBase64, filename);
  }, []);

  return {
    speechModelId,
    speechRows,
    speechProgress,
    speechDownloading,
    refreshSpeech,
    pickSpeechModel,
    downloadSpeech,
    dictate,
  };
}
