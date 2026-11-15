# CINDERWAKE

A 3D action roguelite for the browser (three.js + TypeScript + Vite). Everything — models, textures, sound, music — is generated in code.

**Start here:** read `docs/HANDOFF.md` (Korean). It holds the architecture map, the current status and the prioritised to-do list. Update its "현재 상태" and "다음 할 일" sections whenever you finish a chunk of work.

## Commands

- `npm run build` — type-check and build to `dist/`
- `npm test` — vitest (world generation + headless simulation runs)
- `npm run sim` — balance bot: `npx tsx tests/simbot.ts <runs> <difficulty> <char|all> <skill>`
- `npx vite preview --port 4173` — serve the build for Playwright screenshots (`?debug&q=low`, then `window.warp(seconds)`)

## Rules of the codebase

- `src/sim/` is pure logic and must never import three.js or touch the DOM. Rendering and audio react to `sim.events`.
- All user-facing text lives in `src/core/i18n.ts` as `[ko, en]` pairs. Add both languages.
- Keep the number of scene lights fixed (see `render/view.ts`); changing it at runtime recompiles every shader.
- Commit and push to `claude/wizardly-franklin-eup7j9` after each working milestone. Do not weaken the Pages environment protection in the deploy workflow.
