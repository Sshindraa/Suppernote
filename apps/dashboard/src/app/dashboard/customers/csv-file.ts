/**
 * French Excel saves CSV as Windows-1252 unless told otherwise: try UTF-8 strictly (a stray byte
 * such as « é » in Windows-1252 makes it throw), then fall back to Windows-1252.
 */
export function decodeCsvBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
