import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme] = useState('light');

  useEffect(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.classList.remove('dark');
    localStorage.setItem('atlas-theme', 'light');
  }, [theme]);

  const value = useMemo(() => ({
    theme: 'light',
    isDark: false,
  }), []);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
