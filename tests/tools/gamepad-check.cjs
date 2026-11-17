const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const bad = []; page.on('pageerror', (e) => bad.push(e.message));
  // fake standard gamepad driven from the test
  await page.addInitScript(() => {
    window.__btn = new Array(17).fill(false);
    const pad = { id: 'fake', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], get buttons() { return window.__btn.map((p) => ({ pressed: p, value: p ? 1 : 0 })); } };
    navigator.getGamepads = () => [pad];
  });
  const press = async (i) => { await page.evaluate((i) => { window.__btn[i] = true; }, i); await page.waitForTimeout(700); await page.evaluate((i) => { window.__btn[i] = false; }, i); await page.waitForTimeout(700); };
  await page.goto('http://localhost:4173/?debug=1&q=low');
  await page.waitForTimeout(3000);
  await page.click('[data-act="settings"]'); await page.waitForTimeout(600);
  await page.click('[data-act="padbind"][data-arg="skill"]'); await page.waitForTimeout(600);
  const waiting = await page.evaluate(() => !!app.input.padCapture);
  await press(3); // Y
  const after = await page.evaluate(() => [app.save.data.settings.pad, app.input.pad, !!app.input.padCapture]);
  await page.click('[data-act="padbind"][data-arg="dash"]'); await page.waitForTimeout(600);
  await press(3); // Y again: should swap
  const swapped = await page.evaluate(() => app.save.data.settings.pad);
  await page.evaluate(() => document.querySelector('.scroll').scrollTop = 600);
  await page.screenshot({ path: '/home/user/freefable5.2/shots/pad_settings.png' });
  await page.click('[data-act="pad-reset"]'); await page.waitForTimeout(500);
  await page.click('[data-act="padbind"][data-arg="skill"]'); await page.waitForTimeout(600);
  await press(1); // B for ability
  await page.click('[data-act="settings-back"]'); await page.waitForTimeout(600);
  await page.click('[data-act="play"]'); await page.waitForTimeout(600); await page.click('[data-act="start"]');
  for (let i = 0; i < 40; i++) { if (await page.evaluate(() => app.state === 'playing')) break; await page.waitForTimeout(500); }
  await page.evaluate(() => { app.sim.player.skillCd = 0; });
  await press(1);
  await page.waitForTimeout(1500);
  const cast = await page.evaluate(() => [app.sim.player.skillCd > 1, app.input.device, document.querySelector('.skill small').textContent]);
  console.log(JSON.stringify({ waiting, after, swapped, cast, bad }));
  await browser.close();
})();
