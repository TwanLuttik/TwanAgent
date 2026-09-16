/** xterm `onBinary` payload: each JS char is one byte (0–255). */
export function binaryStringToBytes(data: string): number[] {
  const bytes = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
  return bytes;
}

export function attachXtermInput(
  term: {
    onData: (fn: (data: string) => void) => unknown;
    onBinary: (fn: (data: string) => void) => unknown;
  },
  writeText: (data: string) => void,
  writeBytes: (data: number[]) => void,
): void {
  term.onData(writeText);
  term.onBinary((data) => writeBytes(binaryStringToBytes(data)));
}
