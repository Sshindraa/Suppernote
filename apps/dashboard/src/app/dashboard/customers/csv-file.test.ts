import { describe, expect, it } from 'vitest';
import { decodeCsvBytes } from '@suppernote/shared';

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('decodeCsvBytes', () => {
  it('lit l’UTF-8 tel quel', () => {
    expect(decodeCsvBytes(encode('Renée;0612345678\n'))).toBe('Renée;0612345678\n');
  });

  it('retombe sur le Windows-1252 quand l’UTF-8 est invalide (« é » = 0xE9)', () => {
    const bytes = new Uint8Array([0x52, 0x65, 0x6e, 0xe9, 0x65, 0x3b, 0x30, 0x36]).buffer;
    expect(decodeCsvBytes(bytes)).toBe('Renée;06');
  });
});
