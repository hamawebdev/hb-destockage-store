// Vitest through Astro's Vite config so component tests can render .astro files
// (experimental_AstroContainer). Owner: shell.
import { getViteConfig } from 'astro/config';

export default getViteConfig({ test: { include: ['test/**/*.test.ts', 'src/**/*.test.ts'] } });
