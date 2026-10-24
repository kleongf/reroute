import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { StateSnapshot } from '../src/domain/types.ts';

const snapshot = JSON.parse(
  readFileSync(new URL('fixtures/snapshot.json', import.meta.url), 'utf8'),
) as StateSnapshot;

test('map panel renders a snapshot without duplicating layers', async ({ page }) => {
  await page.goto('/');
  await page.addStyleTag({ url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css' });
  await page.addStyleTag({ url: '/map.css' });
  await page.addScriptTag({ url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js' });

  // Inline module script: keeps DOM code out of the Node-typed test file.
  await page.addScriptTag({
    type: 'module',
    content: `
      import { initMap } from '/map.js';
      const frame = document.createElement('div');
      frame.style.cssText = 'width:800px;height:500px;display:flex';
      const host = document.createElement('div');
      host.id = 'map-under-test';
      host.style.flex = '1';
      frame.append(host);
      document.body.prepend(frame);
      const map = initMap(host);
      const snapshot = ${JSON.stringify(snapshot)};
      map.render(snapshot);
      map.render(snapshot); // re-render must replace layers, not stack them
      host.dataset.ready = 'true';
    `,
  });
  await expect(page.locator('#map-under-test[data-ready=true]')).toHaveCount(1);

  const root = page.locator('#map-under-test');
  const markers = root.locator('.leaflet-marker-icon');
  await expect(markers).toHaveCount(snapshot.drivers.length + snapshot.jobs.length * 2);
  await expect(root.locator('[data-kind=driver]')).toHaveCount(snapshot.drivers.length);
  await expect(root.locator('.map-line--assigned')).toHaveCount(3);
  await expect(root.locator('.map-line--pending')).toHaveCount(1);
  await expect(root.locator('.map-traffic')).toHaveCount(1);
  await expect(root.getByText('awaiting acceptance')).toBeVisible();
  await expect(root.getByText('simulated positions')).toBeVisible();
  await expect(root.getByText('Blair')).toBeVisible();

  await page.screenshot({ path: 'artifacts/screenshots/map.png' });

  const expand = root.getByTestId('map-expand');
  await expand.click();
  await expect(root).toHaveClass(/map-root--expanded/);
  await page.screenshot({ path: 'artifacts/screenshots/map-expanded.png' });
  await expand.click();
  await expect(root).not.toHaveClass(/map-root--expanded/);
});
