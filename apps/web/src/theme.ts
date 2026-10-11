import { useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
const key = 'shlab.appearance';
const listeners = new Set<() => void>();
let preference: ThemePreference = 'system';
let media: MediaQueryList;
let storage: Storage | undefined;

function parse(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

function apply() {
  const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#102632' : '#102b40');
  for (const listener of listeners) listener();
}

export function initializeTheme() {
  media = window.matchMedia('(prefers-color-scheme: dark)');
  try {
    storage = window.localStorage;
    preference = parse(storage.getItem(key));
  } catch {
    preference = parse(document.documentElement.dataset.themePreference);
  }
  media.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (storage && event.storageArea === storage && (event.key === key || event.key === null)) {
      preference = parse(event.newValue);
      apply();
    }
  });
  apply();
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    localStorage.setItem(key, next);
  } catch {
    // Keep the selection for this page when storage is restricted or full.
  }
  apply();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme() {
  // The snapshot includes the resolved system theme so icons follow live OS changes.
  const snapshot = useSyncExternalStore(
    subscribe,
    () => preference + ':' + document.documentElement.dataset.theme
  );
  return {
    preference: snapshot.split(':')[0] as ThemePreference,
    dark: snapshot.endsWith(':dark'),
    setPreference: setThemePreference,
  };
}
