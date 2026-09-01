// PostCSS config for the Tailwind layer. Tailwind only transforms stylesheets
// that contain @tailwind directives (src/styles/tailwind.css), so existing Sass
// / Bootstrap CSS is unaffected. autoprefixer applies vendor prefixes.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
