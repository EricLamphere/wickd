// Attributes for metric search boxes: metric names aren't words, so the webview must not
// autocorrect, capitalize, spell-check or offer autofill on them (macOS WKWebView autocorrects
// unless every one of these is off).
export const NO_AUTOCORRECT = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
} as const;
