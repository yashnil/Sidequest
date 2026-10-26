import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * THE INTERACTIVE MAPS, END TO END.
 *
 * The main suite runs with no vector basemap (`SIDEQUEST_MAP_PROVIDER=`), so it
 * drives the SVG figure that also stands in without WebGL. This configuration
 * turns the real map provider on and runs `e2e/maps/**`, where every tile,
 * glyph and elevation request is answered by `e2e/maps/support/tiles.ts`: the
 * production MapLibre code renders, the network never leaves the machine.
 *
 * Chromium needs a software GL to draw headless; SwiftShader is asked for
 * explicitly so a machine without a usable GPU still runs WebGL.
 */
const webServer = base.webServer as { command: string } & Record<string, unknown>;
const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export default defineConfig({
  ...base,
  testMatch: /maps\/.*\.spec\.ts$/,
  projects: (base.projects ?? [])
    .filter((project) => project.name === 'desktop' || project.name === 'mobile')
    .map((project) => ({ ...project, testIgnore: [], use: { ...project.use, launchOptions: { args: GL_ARGS } } })),
  webServer: { ...webServer, command: webServer.command.replace('SIDEQUEST_MAP_PROVIDER= ', 'SIDEQUEST_MAP_PROVIDER=openfreemap ') },
});
