import { Moon, Sun } from 'lucide-react';
import { useTheme, type ThemePreference } from '../theme';

export function ThemeControl() {
  const { preference, dark, setPreference } = useTheme();
  const Icon = dark ? Moon : Sun;
  return (
    <label className="theme-control" title="Aparência da plataforma">
      <Icon size={16} aria-hidden="true" />
      <span className="sr-only">Aparência da plataforma</span>
      <select value={preference} onChange={(event) => setPreference(event.target.value as ThemePreference)}>
        <option value="light">Claro</option>
        <option value="dark">Escuro</option>
        <option value="system">Sistema</option>
      </select>
    </label>
  );
}
