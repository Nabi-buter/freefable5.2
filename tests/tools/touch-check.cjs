const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const [name, vp] of [['portrait', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }]]) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: vp });
    const page = await ctx.newPage();
    const bad = [];
    page.on('pageerror', (e) => bad.push(e.message));
    await page.goto('http://localhost:4173/?debug=1&q=low');
    await page.waitForTimeout(3000);
    await page.tap('[data-act="settings"]'); await page.waitForTimeout(800);
    const s1 = await page.evaluate(() => app.ui.screen);
    await page.tap('[data-act="set"][data-arg="reduceFlash:true"]'); await page.waitForTimeout(500);
    const s2 = await page.evaluate(() => app.save.data.settings.reduceFlash);
    await page.tap('[data-act="settings-back"]'); await page.waitForTimeout(800);
    await page.tap('[data-act="play"]'); await page.waitForTimeout(800);
    const s3 = await page.evaluate(() => app.ui.screen);
    await page.screenshot({ path: `/home/user/freefable5.2/shots/tap_${name}_setup.png` });
    await page.tap('[data-act="start"]');
    for (let i = 0; i < 40; i++) { if (await page.evaluate(() => app.state === 'playing')) break; await page.waitForTimeout(500); }
    const s4 = await page.evaluate(() => [app.state, app.input.device]);
    // drag on the playfield moves the bearer, tap the ability button
    const x0 = await page.evaluate(() => app.sim.player.x);
    const cdp = await ctx.newCDPSession(page);
    const pt = { x: vp.width * 0.25, y: vp.height * 0.7 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pt.x + 60, y: pt.y, id: 1 }] });
    await page.waitForTimeout(4000);
    const mv = await page.evaluate(() => [app.input.stick.active, app.input.moveX.toFixed(2)]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const x1 = await page.evaluate(() => app.sim.player.x);
    await page.evaluate(() => { app.sim.player.skillCd = 0; });
    await page.tap('.skillbtn'); await page.waitForTimeout(2500);
    const sk = await page.evaluate(() => app.sim.player.skillCd > 1);
    await page.tap('.hudbtn'); await page.waitForTimeout(2000);
    const s5 = await page.evaluate(() => [app.state, app.ui.modal]);
    await page.screenshot({ path: `/home/user/freefable5.2/shots/tap_${name}_pause.png` });
    console.log(name, JSON.stringify({ settings: s1, toggled: s2, setup: s3, run: s4, stick: mv, moved: (x1 - x0).toFixed(2), skill: sk, pause: s5, errors: bad }));
    await ctx.close();
  }
  await browser.close();
})();
