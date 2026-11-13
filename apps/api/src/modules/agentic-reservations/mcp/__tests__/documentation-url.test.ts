import { describe, expect, it } from 'vitest';
import { mcpDocumentationUrl } from '../oauth';

describe('mcpDocumentationUrl', () => {
  it('pointe vers le site public de l’environnement', () => {
    expect(mcpDocumentationUrl('https://api.suppernote.com', {})).toBe(
      'https://suppernote.com/assistants-ia',
    );
    expect(mcpDocumentationUrl('https://api-staging.suppernote.com', {})).toBe(
      'https://staging.suppernote.com/assistants-ia',
    );
  });

  it('respecte une adresse configurée', () => {
    expect(
      mcpDocumentationUrl('https://api.suppernote.com', {
        MCP_DOCUMENTATION_URL: 'https://docs.example.test/suppernote',
      }),
    ).toBe('https://docs.example.test/suppernote');
  });
});
