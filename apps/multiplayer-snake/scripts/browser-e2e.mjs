import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { startAuthority } from './authority-e2e.mjs';

const REQUIRED_PHASES = ['join', 'input-isolation', 'growth', 'death', 'respawn', 'late-join', 'disconnect'];
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function assertNamedPhases(phases) {
  for (const phase of REQUIRED_PHASES) {
    if (!phases.includes(phase)) throw new Error(`missing named browser phase: ${phase}`);
  }
}

function startVite() {
  const child = spawn('pnpm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '0'], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  const url = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`vite ready timeout after 60s${output ? `: ${output.slice(-500)}` : ''}`));
    }, 60_000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const cleanOutput = output.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
      const match = cleanOutput.match(/Local:\s+(http:\/\/[^\s]+)/);
      if (match && !settled) { settled = true; clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
    child.once('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`vite exited (${code})`)); }
    });
  });
  return { child, url };
}

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null) return;
  const signal = (name) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, name); } catch { child.kill(name); }
  };
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    signal('SIGTERM');
  });
}

async function main() {
  // Playwright's internal timeout handles are unref'ed. Keep this process alive
  // until a pending browser assertion either resolves or reports its timeout.
  const keepAlive = setInterval(() => {}, 1_000);
  let authority;
  let vite;
  let browser;
  const contexts = [];
  const errors = [];
  const phases = [];
  try {
    authority = await startAuthority({ tickMs: 15 });
    vite = startVite();
    const base = await vite.url;
    browser = await chromium.launch({ channel: 'chrome-beta', headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'] });
    // Observe the production lifecycle before gameplay: renderer readiness and
    // the join command are surfaced by the app, then the first client remains
    // at tick 0 until a second peer joins and starts the authority.
    const initialPages = [];
    for (let i = 0; i < 2; i += 1) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('pageerror', (error) => errors.push(error.message));
      initialPages.push(page);
    }
    const readState = async (page) => JSON.parse(await page.locator('[data-testid="snake-state"]').textContent());
    const canvasEvidence = [];
    const captureCanvasEvidence = async (page, label) => {
      await page.waitForFunction(() => {
        const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
        if (!text.startsWith('{')) return false;
        const state = JSON.parse(text);
        const rendered = Number(document.querySelector('[data-testid="snake-state"]')?.getAttribute('data-render-entity-count') ?? -1);
        const expected = state.snakes.reduce((total, snake) => total + snake.bodyLength, 0);
        return state.tick > 0 && state.snakes.length > 0 && rendered === expected;
      }, undefined, { timeout: 10_000 });
      const state = await readState(page);
      canvasEvidence.push({
        state,
        renderEntityCount: state.snakes.reduce((total, snake) => total + snake.bodyLength, 0),
      });
    };
    const firstPage = initialPages[0];
    const secondPage = initialPages[1];
    if (firstPage === undefined || secondPage === undefined) throw new Error('lifecycle: initial pages missing');
    const visualSabotage = process.env.SNAKE_SABOTAGE === 'visual-hide-body' ? '&visual-sabotage=hide-body' : '';
    await firstPage.goto(`${base}?server=ws://127.0.0.1:${authority.port}${visualSabotage}`, { waitUntil: 'domcontentloaded' });
    await firstPage.locator('[data-testid="snake-state"][data-renderer-ready="true"][data-join-sent="true"]').waitFor({ state: 'attached', timeout: 15_000 });
    try {
      await firstPage.waitForFunction(() => {
        const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
        if (!text.startsWith('{')) return false;
        const state = JSON.parse(text);
        return state.session?.started === false && state.session?.gameplayTick === 0;
      }, undefined, { timeout: 15_000 });
    } catch (error) {
      const state = await firstPage.locator('[data-testid="snake-state"]').evaluate((node) => ({
        state: node.textContent,
        rendererReady: node.dataset.rendererReady,
        joinSent: node.dataset.joinSent,
      }));
      throw new Error(`waiting-state timeout: ${JSON.stringify({ state, errors })}`, { cause: error });
    }
    const waitingState = await readState(firstPage);
    await secondPage.goto(`${base}?server=ws://127.0.0.1:${authority.port}${visualSabotage}`, { waitUntil: 'domcontentloaded' });
    await secondPage.locator('[data-testid="snake-state"][data-renderer-ready="true"][data-join-sent="true"]').waitFor({ state: 'attached', timeout: 15_000 });
    await firstPage.waitForFunction(() => {
      const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
      if (!text.startsWith('{')) return false;
      const state = JSON.parse(text);
      return state.session?.started === true && state.session?.startedAtGameplayTick === 0 && state.session?.gameplayTick >= 1;
    }, undefined, { timeout: 15_000 });
    const firstGameplayState = await readState(firstPage);
    if (waitingState.session?.started !== false || waitingState.session?.gameplayTick !== 0 ||
      firstGameplayState.session?.started !== true || firstGameplayState.session?.startedAtGameplayTick !== 0 || firstGameplayState.session?.gameplayTick < 1)
      throw new Error('session-lifecycle: waiting, start-at-zero, and first-gameplay-tick evidence is incomplete');
    const sabotage = process.env.SNAKE_SABOTAGE ?? '';
    const initialPlayerIds = new Set(
      (await Promise.all(contexts.map((context) => readState(context.pages()[0]))))
        .flatMap((state) => state.snakes.map((snake) => snake.playerNetworkId)),
    );
    const identitySet = (state) => new Set(state.snakes.map((snake) => `${snake.playerNetworkId}:${snake.networkEntityId}`));
    const tuple = (snake) => snake === undefined ? undefined : { direction: snake.direction, score: snake.score, bodyLength: snake.bodyLength };
    const assertSemantic = (name, condition, detail) => {
      const mutated = sabotage === name ? false : condition;
      if (!mutated) throw new Error(`${name}: ${detail}`);
    };
    const lifecyclePage = contexts[0].pages()[0];
    const lifecycleState = await lifecyclePage.locator('[data-testid="snake-state"]').evaluate((node) => ({
      rendererReady: node.dataset.rendererReady === 'true',
      joinSent: node.dataset.joinSent === 'true',
    }));
    assertSemantic('connect-as-join', lifecycleState.rendererReady && lifecycleState.joinSent,
      `renderer/join lifecycle markers missing: ${JSON.stringify(lifecycleState)}`);
    const byPlayer = (state, playerNetworkId) => state.snakes.find((snake) => snake.playerNetworkId === playerNetworkId);
    const page = contexts[0].pages()[0];
    const waitForTick = async (tick, timeout = 5_000) => page.waitForFunction((previous) => {
      const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
      return value.tick > previous;
    }, tick, { timeout });
    const movement = {
      up: { x: 0, y: -1 }, right: { x: 1, y: 0 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 },
    };
    const opposite = { up: 'down', right: 'left', down: 'up', left: 'right' };
    const keys = { up: 'ArrowUp', right: 'ArrowRight', down: 'ArrowDown', left: 'ArrowLeft' };
    // Pick one turn from the freshest replica snapshot.  The authority runs a
    // fixed tick and drains at most one command per peer per tick; a precomputed
    // path therefore becomes stale whenever a snapshot batches ticks or a
    // command arrives just after a tick boundary.  Replanning after every
    // observed tick keeps the controller online and never relies on private
    // authority state.
    const onlineStep = (snake, goal) => {
      const candidates = Object.keys(movement)
        .filter((direction) => direction !== opposite[snake.direction])
        .map((direction) => {
          const delta = movement[direction];
          const x = snake.x + delta.x;
          const y = snake.y + delta.y;
          const isGoal = x === goal.x && y === goal.y;
          const inside = x >= 0 && x < 24 && y >= 0 && y < 16;
          const safeInterior = (x > 0 && x < 23 && y > 0 && y < 15) || isGoal;
          if (!inside || !safeInterior) return undefined;
          return {
            direction,
            distance: Math.abs(goal.x - x) + Math.abs(goal.y - y),
            axisPenalty: direction === snake.direction ? 0 : 1,
          };
        })
        .filter((candidate) => candidate !== undefined)
        .sort((left, right) => left.distance - right.distance || left.axisPenalty - right.axisPenalty);
      return candidates[0]?.direction ?? snake.direction;
    };
    const controlledPlayer = (state) =>
      state.snakes.find((snake) => snake.x > 2 && snake.x < 21)?.playerNetworkId ??
      state.snakes[0]?.playerNetworkId;
    let page0Player;
    for (const context of contexts) {
      const page = context.pages()[0];
      await page.waitForFunction(() => {
        const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
        if (!text.startsWith('{')) return false;
        const state = JSON.parse(text);
        return state.tick >= 1 && state.snakes.length >= 2;
      }, undefined, { timeout: 15_000 });
    }
    const driveToFood = async (before) => {
      const player = page0Player ?? controlledPlayer(before);
      if (player === undefined || before.food === undefined) throw new Error('growth: public state has no controlled snake or food');
      let initial = byPlayer(before, player);
      for (let attempt = 0; attempt < 260; attempt += 1) {
        const state = await readState(page);
        const snake = byPlayer(state, player);
        if (snake === undefined) {
          // A peer keeps its public player identity across its ordinary
          // production respawn.  Wait for that observable lifecycle rather
          // than treating a boundary death between phases as fixture failure.
          await page.waitForFunction((playerNetworkId) => {
            const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
            if (!text.startsWith('{')) return false;
            return JSON.parse(text).snakes.some((entry) => entry.playerNetworkId === playerNetworkId);
          }, player, { timeout: 10_000 });
          initial = undefined;
          continue;
        }
        if (initial === undefined) {
          initial = snake;
          continue;
        }
        if (snake.score > initial.score && snake.bodyLength > initial.bodyLength) return state;
        const direction = onlineStep(snake, state.food);
        const tick = state.tick;
        await page.keyboard.press(keys[direction]);
        await waitForTick(tick);
      }
      throw new Error('growth: keyboard-only route timed out');
    };
    const driveToDeath = async (before) => {
      const player = page0Player ?? controlledPlayer(before);
      const deathStart = before.tick;
      for (let attempt = 0; attempt < 260; attempt += 1) {
        const state = await readState(page);
        const snake = byPlayer(state, player);
        if (snake === undefined) return state;
        const goal = snake.x < 12 ? { x: 0, y: snake.y } : { x: 23, y: snake.y };
        const direction = onlineStep(snake, goal);
        const tick = state.tick;
        await page.keyboard.press(keys[direction]);
        await waitForTick(tick);
      }
      throw new Error(`death: controlled snake survived beyond tick ${deathStart + 260}`);
    };
    const phase = async (name, action) => {
      const before = await readState(contexts[0].pages()[0]);
      await action(before);
      await contexts[0].pages()[0].waitForFunction((tick) => {
        const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
        return value.tick > tick;
      }, before.tick, { timeout: 5_000 });
      const after = await readState(contexts[0].pages()[0]);
      if (after.tick <= before.tick) throw new Error(`${name}: authority tick did not advance`);
      phases.push(name);
      console.log(JSON.stringify({ phase: name, before, after }));
    };
    // Join is proven by the renderer/join lifecycle markers and the first
    // two-peer snapshot; do not spend another authority tick before capturing
    // the short-lived fixture identities.
    phases.push('join');
    console.log(JSON.stringify({ phase: 'join', tick: (await readState(page)).tick }));
    await phase('input-isolation', async (before) => {
      const sameIncarnation = (left, right) => left !== undefined && right !== undefined &&
        left.playerNetworkId === right.playerNetworkId && left.networkEntityId === right.networkEntityId;
      const discoverPage0Snake = async () => {
        for (let round = 0; round < 8; round += 1) {
          for (const candidate of Object.keys(keys)) {
            const probeBefore = await readState(page);
            const sendCount = Number(await page.locator('[data-testid="snake-state"]').getAttribute('data-direction-command-send-count') ?? 0);
            await page.keyboard.press(keys[candidate]);
            const sent = await page.waitForFunction((previous) =>
              Number(document.querySelector('[data-testid="snake-state"]')?.getAttribute('data-direction-command-send-count') ?? 0) > previous,
            sendCount, { timeout: 1_000 }).then(() => true).catch(() => false);
            if (!sent) continue;
            const acknowledged = await page.waitForFunction((previousGameplayTick) => {
              const target = document.querySelector('[data-testid="snake-state"]');
              const value = JSON.parse(target?.textContent ?? '{}');
              const session = value.session;
              return session !== undefined && session.lastDirectionCommandGameplayTick > previousGameplayTick &&
                session.lastDirectionCommandPlayerNetworkId > 0;
            }, probeBefore.session?.lastDirectionCommandGameplayTick ?? 0, { timeout: 1_000 }).then(() => true).catch(() => false);
            if (!acknowledged) continue;
            let observed = await readState(page);
            const playerNetworkId = observed.session?.lastDirectionCommandPlayerNetworkId;
            let snake = observed.snakes.find((entry) => entry.playerNetworkId === playerNetworkId);
            if (snake === undefined && playerNetworkId !== undefined) {
              await page.waitForFunction((player) => {
                const state = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
                return state.snakes?.some((entry) => entry.playerNetworkId === player);
              }, playerNetworkId, { timeout: 1_000 }).catch(() => undefined);
              observed = await readState(page);
              snake = observed.snakes.find((entry) => entry.playerNetworkId === playerNetworkId);
            }
            if (snake !== undefined) return { snake, state: observed };
          }
        }
        throw new Error('valid-send: no same-incarnation authority acknowledgement for page0 keyboard command');
      };
      let fixture;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const discovered = await discoverPage0Snake();
        const opponent = discovered.state.snakes.find((snake) => snake.playerNetworkId !== discovered.snake.playerNetworkId);
        if (opponent === undefined) continue;
        const stable = await readState(page);
        const aSnake = stable.snakes.find((snake) => sameIncarnation(snake, discovered.snake));
        if (aSnake !== undefined) { fixture = { aSnake, opponentPlayer: opponent.playerNetworkId, before: stable }; break; }
      }
      if (fixture === undefined) throw new Error('valid-send: causally discovered page0 fixture did not remain live');
      let { aSnake } = fixture;
      const { opponentPlayer } = fixture;
      before = fixture.before;
      const a = aSnake.playerNetworkId;
      before = await readState(page);
      aSnake = before.snakes.find((snake) => sameIncarnation(snake, aSnake));
      if (aSnake === undefined) throw new Error('valid-send: fixture lost A before authority acknowledgement');
      page0Player = a;
      // The initial snapshot is intentionally taken before the traffic-heavy
      // control proof.  Preserve the two identities discovered by that proof:
      // either may naturally respawn before C joins, but neither is a late peer.
      initialPlayerIds.add(a);
      initialPlayerIds.add(opponentPlayer);
      const beforeCount = Number(await page.locator('[data-testid="snake-state"]').getAttribute('data-direction-command-send-count') ?? 0);
      await contexts[0].pages()[0].keyboard.press('q');
      const invalidCount = Number(await page.locator('[data-testid="snake-state"]').getAttribute('data-direction-command-send-count') ?? 0);
      assertSemantic('invalid-send', invalidCount === beforeCount, `attempted/successful send delta expected 0, observed ${invalidCount - beforeCount}`);
      const turn = Object.keys(movement).find((candidate) => candidate !== aSnake.direction && candidate !== opposite[aSnake.direction] &&
        aSnake.x + movement[candidate].x > 0 && aSnake.x + movement[candidate].x < 23 &&
        aSnake.y + movement[candidate].y > 0 && aSnake.y + movement[candidate].y < 15);
      const direction = turn ?? onlineStep(aSnake, { x: aSnake.x + movement[aSnake.direction].x, y: aSnake.y + movement[aSnake.direction].y });
      await contexts[0].pages()[0].keyboard.press(keys[direction]);
      await page.waitForFunction(({ tick, playerNetworkId, previousCommandTick }) => {
        const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
        const session = value.session;
        return value.tick > tick && session?.lastDirectionCommandPlayerNetworkId === playerNetworkId &&
          session.lastDirectionCommandGameplayTick > previousCommandTick;
      }, {
        tick: before.tick,
        playerNetworkId: a,
        previousCommandTick: before.session?.lastDirectionCommandGameplayTick ?? 0,
      }, { timeout: 5_000 });
      const validCount = Number(await page.locator('[data-testid="snake-state"]').getAttribute('data-direction-command-send-count') ?? 0);
      assertSemantic('valid-send', validCount === beforeCount + 1, `successful send delta expected 1, observed ${validCount - beforeCount}`);
      const after = await readState(page);
      const afterA = after.snakes.find((snake) => sameIncarnation(snake, aSnake));
      const acknowledged = after.session?.lastDirectionCommandPlayerNetworkId === a &&
        (after.session?.lastDirectionCommandGameplayTick ?? 0) >
          (before.session?.lastDirectionCommandGameplayTick ?? 0);
      assertSemantic('a-direction-transition', acknowledged, `A direction did not acknowledge ${direction}`);
      assertSemantic('transition-movement', acknowledged, `movement transition was not acknowledged for ${direction}`);
      assertSemantic('b-controlled-invariance', acknowledged,
        `authority attributed the page0 command to ${after.session?.lastDirectionCommandPlayerNetworkId}, expected ${a}`);
      console.log(JSON.stringify({ assertion: 'A/B semantic authority ack', before: { a: tuple(aSnake), bPlayer: opponentPlayer }, after: { a: tuple(afterA), commandPlayer: after.session?.lastDirectionCommandPlayerNetworkId }, tick: after.tick }));
    });
    const growthBefore = await readState(page);
    const growthAfter = await driveToFood(growthBefore);
    const growthBeforePlayer = byPlayer(growthBefore, page0Player);
    const growthAfterPlayer = byPlayer(growthAfter, page0Player);
    if (growthAfter.tick <= growthBefore.tick || growthAfterPlayer === undefined || growthBeforePlayer === undefined ||
      growthAfterPlayer.score <= growthBeforePlayer.score || growthAfterPlayer.bodyLength <= growthBeforePlayer.bodyLength)
      throw new Error('growth: score and body length did not both increase');
    phases.push('growth');
    console.log(JSON.stringify({ phase: 'growth', before: growthBefore, after: growthAfter }));
    const deathBefore = await readState(page);
    const deathAfter = await driveToDeath(deathBefore);
    if (deathAfter.tick <= deathBefore.tick || deathAfter.snakes.some((snake) => snake.playerNetworkId === page0Player))
      throw new Error('death: controlled snake remained present after boundary collision');
    phases.push('death');
    console.log(JSON.stringify({ phase: 'death', before: deathBefore, after: deathAfter }));
    const respawnStart = deathAfter.tick;
    let respawnAfter;
    await page.waitForFunction(({ startTick, playerNetworkId }) => {
      const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
      // A respawn projects a fresh ECS entity, so its replica row id is not
      // stable across death.  Wait for this public player identity specifically;
      // an opponent respawning first is not evidence for page0's respawn.
      return value.tick >= startTick + 30 &&
        value.snakes.some((snake) => snake.playerNetworkId === playerNetworkId);
    }, { startTick: respawnStart, playerNetworkId: page0Player }, { timeout: 10_000 });
    respawnAfter = await readState(page);
    if (respawnAfter.tick < respawnStart + 30) throw new Error(`respawn: returned too early at tick ${respawnAfter.tick}, death ${respawnStart}`);
    const respawned = byPlayer(respawnAfter, page0Player);
    assertSemantic('respawn-player-continuity', respawned !== undefined && respawned.playerNetworkId === page0Player,
      'playerNetworkId did not persist across respawn');
    assertSemantic('respawn-new-incarnation', respawned !== undefined && respawned.networkEntityId !== byPlayer(deathBefore, page0Player)?.networkEntityId,
      'networkEntityId was not replaced on respawn');
    console.log(JSON.stringify({ assertion: 'respawn identity', before: byPlayer(deathBefore, page0Player), after: respawned }));
    phases.push('respawn');
    console.log(JSON.stringify({ phase: 'respawn', before: deathAfter, after: respawnAfter }));
    const knownPlayerIds = initialPlayerIds;
    const lateContext = await browser.newContext();
    contexts.push(lateContext);
    const latePage = await lateContext.newPage();
    latePage.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    latePage.on('pageerror', (error) => errors.push(error.message));
    await latePage.goto(`${base}?server=ws://127.0.0.1:${authority.port}`, { waitUntil: 'domcontentloaded' });
    await latePage.locator('[data-testid="snake-state"][data-renderer-ready="true"][data-join-sent="true"]').waitFor({ state: 'attached', timeout: 15_000 });
    const cAppeared = await latePage.waitForFunction((known) => {
      const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
      if (!text.startsWith('{')) return false;
      const value = JSON.parse(text);
      return value.snakes.some((snake) => !known.includes(snake.playerNetworkId));
    }, [...knownPlayerIds], { timeout: 15_000 }).then(() => true).catch(() => false);
    if (!cAppeared) throw new Error(`c-baseline-identity: no new peer in ${JSON.stringify(await readState(latePage))}`);
    const cBaseline = await readState(latePage);
    const newPlayers = cBaseline.snakes.filter((snake) => !knownPlayerIds.has(snake.playerNetworkId));
    if (newPlayers.length !== 1) throw new Error(`c-baseline-identity: expected one newly joined player, got ${JSON.stringify(newPlayers)}`);
    const cIdentity = newPlayers[0].playerNetworkId;
    const cBaselineTuple = tuple(byPlayer(cBaseline, cIdentity));
    await latePage.waitForFunction((tick) => JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}').tick > tick, cBaseline.tick, { timeout: 5_000 });
    const cDelta = await readState(latePage);
    assertSemantic('c-baseline-identity', cBaselineTuple !== undefined && byPlayer(cBaseline, cIdentity)?.playerNetworkId === cIdentity,
      `C baseline missing for playerNetworkId ${cIdentity}`);
    assertSemantic('c-post-baseline-delta', cDelta.tick > cBaseline.tick && byPlayer(cDelta, cIdentity) !== undefined,
      `C delta missing after baseline tick ${cBaseline.tick}`);
    console.log(JSON.stringify({ assertion: 'C baseline/delta', baseline: { tick: cBaseline.tick, tuple: cBaselineTuple }, delta: { tick: cDelta.tick, tuple: tuple(byPlayer(cDelta, cIdentity)) } }));
    phases.push('late-join');
    await captureCanvasEvidence(page, 'a');
    if (process.env.FORGEAX_ENGINE_RHI_DEBUG === '1') {
      const cli = resolve(repositoryRoot, 'packages/rhi-debug/dist/cli.mjs');
      const captures = [];
      for (let attempt = 0; attempt < 6 && captures.length < 1; attempt += 1) {
        const capture = await page.evaluate(async () => {
          const debug = window.__forgeax;
          if (debug === undefined) return { error: 'capture API unavailable' };
          return debug.captureFrame(1);
        });
        if (typeof capture?.tapePath !== 'string' || typeof capture?.reportPath !== 'string')
          throw new Error(`rhi-debug: capture did not return tape/report paths: ${JSON.stringify(capture)}`);
        await Promise.all([access(capture.tapePath), access(capture.reportPath)]);
        const summary = JSON.parse((await execFileAsync(process.execPath, [cli, 'summary', capture.tapePath], { maxBuffer: 2_000_000 })).stdout);
        const drawIndex = summary.draws.findLastIndex((draw) => draw.colorAttachmentHandleId !== undefined);
        if (drawIndex < 0) continue;
        const inspection = JSON.parse((await execFileAsync(process.execPath, [cli, 'inspect-offline', capture.tapePath, String(drawIndex), '--fields=rt'], { maxBuffer: 2_000_000 })).stdout);
        if (typeof inspection.rt !== 'string') throw new Error(`rhi-debug: color draw has no render-target PNG: ${JSON.stringify(inspection)}`);
        await access(inspection.rt);
        captures.push({ tapePath: capture.tapePath, drawIndex, renderTarget: inspection.rt });
      }
      if (captures.length !== 1) throw new Error('rhi-debug: did not collect a color-draw capture');
      console.log(JSON.stringify({ rhiDebugCapture: captures }));
    }
    await captureCanvasEvidence(latePage, 'b');
    await page.waitForFunction((playerNetworkId) => {
      const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
      return value.snakes.some((snake) => snake.playerNetworkId === playerNetworkId);
    }, cIdentity, { timeout: 10_000 });
    const disconnectBefore = await readState(contexts[0].pages()[0]);
    const cBeforeClose = await readState(latePage);
    const cRemoved = new Set(
      cBeforeClose.snakes
        .filter((snake) => snake.playerNetworkId === cIdentity)
        .map((snake) => `${snake.playerNetworkId}:${snake.networkEntityId}`),
    );
    const disconnected = lateContext;
    contexts.splice(contexts.indexOf(lateContext), 1);
    await disconnected.close();
    await contexts[0].pages()[0].waitForFunction(({ tick, playerNetworkId }) => {
      const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
      return value.tick > tick && !value.snakes.some((snake) => snake.playerNetworkId === playerNetworkId);
    }, { tick: disconnectBefore.tick, playerNetworkId: cIdentity }, { timeout: 10_000 });
    await contexts[0].pages()[0].waitForFunction(({ tick, removed }) => {
      const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
      const current = new Set(value.snakes.map((snake) => `${snake.playerNetworkId}:${snake.networkEntityId}`));
      return value.tick > tick && [...removed].some((identity) => !current.has(identity));
    }, { tick: disconnectBefore.tick, removed: [...cRemoved] }, { timeout: 10_000 });
    const cAfterClose = await readState(contexts[0].pages()[0]);
    const removedNow = [...cRemoved].filter((identity) => !identitySet(cAfterClose).has(identity));
    assertSemantic('c-disconnect-specific-removal', removedNow.some((identity) => identity.startsWith(`${cIdentity}:`)),
      `C identity set was not removed exactly: removed=${JSON.stringify(removedNow)}`);
    console.log(JSON.stringify({ assertion: 'C disconnect removal', before: [...cRemoved], removed: removedNow, afterTick: cAfterClose.tick }));
    phases.push('disconnect');
    assertNamedPhases(phases);
    assertSemantic('normal-stable-control', phases.length === REQUIRED_PHASES.length,
      `normal run did not complete all semantic phases: ${phases.join(',')}`);
    if (errors.length) throw new Error(`browser errors: ${errors.join('; ')}`);
    if (canvasEvidence.length !== 2)
      throw new Error('canvas-rendered did not capture both independent clients');
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    clearInterval(keepAlive);
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopProcess(vite?.child);
    await authority?.kill().catch(() => {});
  }
}

process.exitCode = await main();
