/* global localStorage, matchMedia, document */
// Apply the saved appearance before the page paints, without inline scripts.
(() => {
  let preference = 'system';
  try {
    const saved = localStorage.getItem('shlab.appearance');
    if (['light', 'dark', 'system'].includes(saved)) preference = saved;
  } catch {
    // Appearance remains usable when browser storage is unavailable.
  }
  const theme =
    preference === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
})();
