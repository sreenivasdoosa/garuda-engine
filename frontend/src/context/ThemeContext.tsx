import { createContext, useContext, useEffect, type ReactNode } from 'react';

/**
 * One brand.
 *
 * The engine this was copied from shipped four enterprise brands and two
 * broker white-labels, chosen by hostname at boot. Garuda is one product an
 * operator runs for themselves, so there is nothing to choose: the config is
 * a constant and the provider only applies it.
 *
 * Theming stays possible for anyone who wants it -- the CSS variables under
 * `data-theme` are untouched -- but it is a stylesheet, not a build matrix.
 */

interface BrandConfig {
  name: string;
  displayName: string;
  productName: string;
  tagline: string;
  logo: string;
  logoSmall: string;
  favicon: string;
  primaryColor: string;
}

export const BRAND = 'garuda-engine';

const brandConfig: BrandConfig = {
  name: BRAND,
  displayName: 'Garuda Engine',
  productName: 'Garuda Engine',
  tagline: 'Algorithmic trading engine',
  logo: '/logo.svg',
  logoSmall: '/logo-small.svg',
  favicon: '/favicon.svg',
  primaryColor: '#2dce89',
};

interface ThemeContextType {
  brand: string;
  brandConfig: BrandConfig;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', BRAND);
    document.title = brandConfig.displayName;

    const existingFavicon = document.querySelector('link[rel="icon"]');
    if (existingFavicon) {
      existingFavicon.setAttribute('href', brandConfig.favicon);
    } else {
      const favicon = document.createElement('link');
      favicon.rel = 'icon';
      favicon.href = brandConfig.favicon;
      document.head.appendChild(favicon);
    }

    let metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(metaThemeColor);
    }
    const computed = getComputedStyle(document.documentElement);
    metaThemeColor.setAttribute(
      'content',
      computed.getPropertyValue('--brand-primary').trim() || brandConfig.primaryColor,
    );
  }, []);

  return (
    <ThemeContext.Provider value={{ brand: BRAND, brandConfig }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export { brandConfig };
export type { BrandConfig };
