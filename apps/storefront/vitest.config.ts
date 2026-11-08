// Vitest through Astro's Vite config so component tests can render .astro files
// (experimental_AstroContainer). Loading the Astro config loads the catalogue, which requires
// HB_SNAPSHOT (unset fails the build, lead ruling); tests run on the fixture explicitly, as the
// ruling allows for dev and tests. Owner: shell.
import { getViteConfig } from 'astro/config';

process.env['HB_SNAPSHOT'] ??= 'fixture';

export default getViteConfig({ test: { include: ['test/**/*.test.ts', 'src/**/*.test.ts'] } });
