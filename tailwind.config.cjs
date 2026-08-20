/* eslint-disable @typescript-eslint/no-require-imports */
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  corePlugins: {
    // Keep the existing SCSS application stable while new UI code adopts Tailwind incrementally.
    preflight: false
  },
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--tm-background) / <alpha-value>)',
        canvas: 'hsl(var(--tm-canvas) / <alpha-value>)',
        foreground: 'hsl(var(--tm-foreground) / <alpha-value>)',
        surface: 'hsl(var(--tm-surface) / <alpha-value>)',
        'surface-muted': 'hsl(var(--tm-surface-muted) / <alpha-value>)',
        'surface-elevated': 'hsl(var(--tm-surface-elevated) / <alpha-value>)',
        border: 'hsl(var(--tm-border) / <alpha-value>)',
        'border-subtle': 'hsl(var(--tm-border-subtle) / <alpha-value>)',
        primary: 'hsl(var(--tm-primary) / <alpha-value>)',
        'primary-hover': 'hsl(var(--tm-primary-hover) / <alpha-value>)',
        'primary-foreground': 'hsl(var(--tm-primary-foreground) / <alpha-value>)',
        secondary: 'hsl(var(--tm-secondary) / <alpha-value>)',
        'secondary-foreground': 'hsl(var(--tm-secondary-foreground) / <alpha-value>)',
        muted: 'hsl(var(--tm-muted) / <alpha-value>)',
        'muted-foreground': 'hsl(var(--tm-muted-foreground) / <alpha-value>)',
        'subtle-foreground': 'hsl(var(--tm-subtle-foreground) / <alpha-value>)',
        accent: 'hsl(var(--tm-accent) / <alpha-value>)',
        'accent-foreground': 'hsl(var(--tm-accent-foreground) / <alpha-value>)',
        success: 'hsl(var(--tm-success) / <alpha-value>)',
        warning: 'hsl(var(--tm-warning) / <alpha-value>)',
        destructive: 'hsl(var(--tm-destructive) / <alpha-value>)',
        'destructive-foreground': 'hsl(var(--tm-destructive-foreground) / <alpha-value>)',
        'disabled-surface': 'hsl(var(--tm-disabled-surface) / <alpha-value>)',
        'disabled-foreground': 'hsl(var(--tm-disabled-foreground) / <alpha-value>)',
        'disabled-border': 'hsl(var(--tm-disabled-border) / <alpha-value>)',
        ring: 'hsl(var(--tm-focus-ring) / <alpha-value>)'
      },
      height: {
        'control-compact': 'var(--tm-control-height-compact)',
        'control-standard': 'var(--tm-control-height-standard)',
        'control-form': 'var(--tm-control-height-form)'
      },
      borderRadius: {
        sm: 'var(--tm-radius-sm)',
        md: 'var(--tm-radius-md)',
        lg: 'var(--tm-radius-lg)',
        xl: 'var(--tm-radius-xl)'
      },
      boxShadow: {
        surface: 'var(--tm-shadow-surface)',
        floating: 'var(--tm-shadow-floating)',
        popover: 'var(--tm-shadow-popover)',
        dialog: 'var(--tm-shadow-dialog)'
      },
      transitionDuration: {
        fast: 'var(--tm-motion-fast)',
        normal: 'var(--tm-motion-normal)',
        slow: 'var(--tm-motion-slow)'
      },
      transitionTimingFunction: {
        'tm-standard': 'var(--tm-ease-standard)',
        'tm-emphasized': 'var(--tm-ease-emphasized)'
      },
      zIndex: {
        base: 'var(--tm-z-base)',
        dropdown: 'var(--tm-z-dropdown)',
        popover: 'var(--tm-z-popover)',
        toast: 'var(--tm-z-toast)',
        modal: 'var(--tm-z-modal)'
      }
    }
  },
  plugins: [require('tailwindcss-animate')]
}
