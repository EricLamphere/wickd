import { describe, expect, it } from 'vitest';
import { widgetLinkHref } from './widgetLinks';

describe('widgetLinkHref', () => {
  it('keeps web and mail links', () => {
    expect(widgetLinkHref('https://docs.getdbt.com/x')).toBe('https://docs.getdbt.com/x');
    expect(widgetLinkHref('mailto:a@b.co')).toBe('mailto:a@b.co');
  });
  it('treats a bare domain as https', () => {
    expect(widgetLinkHref('example.com')).toBe('https://example.com');
    expect(widgetLinkHref('www.example.com/page?q=1')).toBe('https://www.example.com/page?q=1');
  });
  it('has nowhere to go for placeholders, paths and other schemes', () => {
    expect(widgetLinkHref('url')).toBeNull();
    expect(widgetLinkHref('docs/page.md')).toBeNull();
    expect(widgetLinkHref('javascript:alert(1)')).toBeNull();
    expect(widgetLinkHref(undefined)).toBeNull();
  });
});
