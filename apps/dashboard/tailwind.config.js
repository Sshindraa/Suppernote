const { fontFamily } = require('tailwindcss/defaultTheme');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        // Couleur produit plus claire que --primary : nav active, focus,
        // états interactifs secondaires. --primary reste réservé aux CTA.
        brand: {
          DEFAULT: 'hsl(var(--brand))',
          foreground: 'hsl(var(--brand-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        'onboarding-complete': 'hsl(var(--onboarding-complete))',
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        'accent-cyan': 'hsl(var(--accent-cyan))',
        'accent-violet': 'hsl(var(--accent-violet))',
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Surface de panneau imbriqué (ex: mini-carte dans une carte) + liseré
        // spéculaire pour l'effet verre.
        glass2: 'hsl(var(--glass-2))',
        'glass-stroke': 'hsl(var(--glass-stroke))',
        'floor-status': {
          free: 'hsl(var(--floor-status-free))',
          reserved: 'hsl(var(--floor-status-reserved))',
          upcoming: 'hsl(var(--floor-status-upcoming))',
          late: 'hsl(var(--floor-status-late))',
          occupied: 'hsl(var(--floor-status-occupied))',
        },
        'floor-table': {
          surface: 'hsl(var(--floor-table-surface))',
          chair: 'hsl(var(--floor-table-chair))',
          idle: 'hsl(var(--floor-table-idle))',
          held: 'hsl(var(--floor-table-held))',
          lit: 'hsl(var(--floor-table-lit))',
          'lit-text': 'hsl(var(--floor-table-lit-text))',
          'lit-chair': 'hsl(var(--floor-table-lit-chair))',
          accent: 'hsl(var(--floor-table-accent))',
          text: 'hsl(var(--floor-table-text))',
          muted: 'hsl(var(--floor-table-muted))',
        },
        // Métal champagne (#8E877B) — séparateurs, badges passifs, icônes secondaires.
        metal: 'hsl(var(--metal))',
        'pricing-accent': 'hsl(var(--pricing-accent))',
        'pricing-accent-glow': 'hsl(var(--pricing-accent-glow))',
        // Texte faible (#7E7A74) — métadonnées, labels secondaires (contraste borderline).
        faint: {
          DEFAULT: 'hsl(var(--faint-foreground))',
          foreground: 'hsl(var(--faint-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', ...fontFamily.sans],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
