/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    fontSize: {
      xs: ['0.6875rem', { lineHeight: '1rem' }],       // 11px
      sm: ['0.8125rem', { lineHeight: '1.25rem' }],     // 13px
      base: ['0.875rem', { lineHeight: '1.375rem' }],   // 14px
      lg: ['1rem', { lineHeight: '1.5rem' }],            // 16px
      xl: ['1.125rem', { lineHeight: '1.75rem' }],       // 18px
      '2xl': ['1.375rem', { lineHeight: '1.875rem' }],   // 22px
      '3xl': ['1.75rem', { lineHeight: '2.125rem' }],    // 28px
      '4xl': ['2.125rem', { lineHeight: '2.5rem' }],     // 34px
      '5xl': ['2.75rem', { lineHeight: '1' }],            // 44px
      '6xl': ['3.5rem', { lineHeight: '1' }],             // 56px
    },
    extend: {
      colors: {
        primary: {
          DEFAULT: 'var(--primary-color)',
          rgb: 'rgb(var(--primary-rgb))'
        },
        secondary: {
          DEFAULT: 'var(--secondary-color)',
          rgb: 'rgb(var(--secondary-rgb))'
        },
        accent: {
          DEFAULT: 'var(--accent-color)',
          rgb: 'rgb(var(--accent-rgb))'
        },
        surface: 'var(--surface-color)',
        'glass-strong': 'var(--glass-strong-color)',
        glass: 'var(--glass-color)'
      },
      backgroundColor: {
        'theme-surface': 'var(--surface-color)',
        'theme-glass': 'var(--glass-strong-color)'
      },
      borderColor: {
        'theme-border': 'var(--border-color)'
      }
    }
  },
  plugins: []
}
