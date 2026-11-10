import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeSpeechModel,
  speechDownloadIdle,
  speechDownloadProgress,
  speechDownloadStart,
  speechModel,
  type SpeechDownload,
  type SpeechModelInfo,
} from "../lib/speech";
import * as api from "../lib/tauri";

/** Speech model choice, the download list, and dictation. Settings reads this. */
export function useSpeech(setFlash: (flash: { kind: "err"; text: string }) => void) {
  const [speechModelId, setSpeechModelId] = useState(speechModel(null).id);
  const [speechRows, setSpeechRows] = useState<SpeechModelInfo[]>([]);
  const [download, setDownload] = useState<SpeechDownload>(speechDownloadIdle);
  const downloadGen = useRef(0);

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
        setDownload((current) =>
          speechDownloadProgress(current, {
            id: event.id,
            received: event.received,
            total: event.total,
            done: event.done,
          }),
        );
        if (event.done) refreshSpeech();
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
      const modelId = normalizeSpeechModel(id);
      const generation = downloadGen.current + 1;
      downloadGen.current = generation;
      setDownload(speechDownloadStart(modelId, speechModel(modelId).bytes));
      void api
        .speechDownload(modelId)
        .then((row) => {
          setSpeechRows((prev) => prev.map((item) => (item.id === row.id ? row : item)));
        })
        .catch((e) => setFlash({ kind: "err", text: String(e) }))
        .finally(() => {
          if (downloadGen.current !== generation) return;
          setDownload(speechDownloadIdle());
          refreshSpeech();
        });
    },
    [refreshSpeech, setFlash],
  );

  const dictate = useCallback(async (bytesBase64: string, filename: string) => {
    return api.transcribe(bytesBase64, filename);
  }, []);

  const speech = useMemo(() => {
    if (download.phase !== "downloading") {
      return { speechDownloading: false, speechProgress: null as { id: string; received: number; total: number } | null };
    }
    return {
      speechDownloading: true,
      speechProgress: { id: download.id, received: download.received, total: download.total },
    };
  }, [download]);

  return {
    speechModelId,
    speechRows,
    speechProgress: speech.speechProgress,
    speechDownloading: speech.speechDownloading,
    refreshSpeech,
    pickSpeechModel,
    downloadSpeech,
    dictate,
  };
}
