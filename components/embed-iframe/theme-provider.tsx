const THEME_SCRIPT = `
  (function() {
    var doc = document.documentElement;
    var params = new URLSearchParams(window.location.search);
    var theme = params.get('theme') || 'dark';
    var backgroundColor = params.get('backgroundColor');
    var primaryColor = params.get('primaryColor');
    var accentColor = params.get('accentColor');

    // Apply theme class (light or dark only)
    doc.classList.add(theme === 'light' ? 'light' : 'dark');

    // Always set body/html background to transparent
    doc.style.setProperty('--background', 'transparent');

    // Apply custom embed widget background if provided, otherwise keep theme default
    if (backgroundColor) {
      if (backgroundColor === 'transparent') {
        doc.style.setProperty('--embed-bg', 'transparent');
      } else {
        // Handle hex colors (with or without #)
        var color = backgroundColor.charAt(0) === '#' ? backgroundColor : '#' + backgroundColor;
        doc.style.setProperty('--embed-bg', color);
      }
    }

    // Apply custom primaryColor if provided
    if (primaryColor) {
      var pColor = primaryColor.charAt(0) === '#' ? primaryColor : '#' + primaryColor;
      doc.style.setProperty('--primary', pColor);
      doc.style.setProperty('--primary-hover', pColor);
    }

    // Apply custom accentColor if provided
    if (accentColor) {
      var aColor = accentColor.charAt(0) === '#' ? accentColor : '#' + accentColor;
      doc.style.setProperty('--accent', aColor);
      doc.style.setProperty('--fgAccent', aColor);
    }
  })();
`;

export function ApplyThemeScript() {
  return <script id="theme-script" dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
