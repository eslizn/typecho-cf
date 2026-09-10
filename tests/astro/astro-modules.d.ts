/**
 * `.astro` imports for the render tests.
 *
 * Astro's generated `.astro/types.d.ts` lives in a dot-directory, which
 * TypeScript's default file inclusion skips, so `tsc --noEmit` would otherwise
 * reject every `import X from '*.astro'` in this project.
 */
declare module '*.astro' {
  const component: any;
  export default component;
}
