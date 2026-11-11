import { describe, expect, it } from 'vitest';
import { buildWidgetPreviewUrl } from './widget-preview-url';

describe('buildWidgetPreviewUrl', () => {
  it('targets the canonical dashboard widget on the current origin', () => {
    expect(buildWidgetPreviewUrl('chez-suppernote-demo', '#0f172a', '#f97316')).toBe(
      '/widget/chez-suppernote-demo?embedded=1&primary=0f172a&accent=f97316',
    );
  });

  it('encodes the slug and custom colors safely', () => {
    expect(buildWidgetPreviewUrl('chez suppernote', '#112233', '#aabbcc')).toBe(
      '/widget/chez%20suppernote?embedded=1&primary=112233&accent=aabbcc',
    );
  });
});
