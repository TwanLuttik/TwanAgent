/// <reference types="vite/client" />

declare const __APP_VERSION_LABEL__: string;

declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: object;
}
