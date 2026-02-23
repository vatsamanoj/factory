/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#f4f6f9',
        panel: '#ffffff',
        surface: '#f8fafc',
        ink: '#0f172a',
        accent: '#0f6bff',
        warning: '#b45309',
        danger: '#dc2626',
        muted: '#475467',
        border: '#d9e0ea'
      },
      boxShadow: {
        card: '0 14px 34px rgba(15, 23, 42, 0.1)',
        soft: '0 2px 8px rgba(15, 23, 42, 0.08)'
      }
    }
  },
  plugins: []
};
