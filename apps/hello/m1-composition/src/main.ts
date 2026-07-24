import { createApp } from '@forgeax/engine-app';
import { FixedUpdate, Update, defineComponent, ok } from '@forgeax/engine-ecs';
import { INPUT_MAP_KEY, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { runPlugins } from '@forgeax/engine-plugin';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { ChildOf, Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, Transform } from '@forgeax/engine-runtime';
import { addOnEnter, addOnExit, defineState, despawnOnExit, getState, setNextState } from '@forgeax/engine-state';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const Mode = defineState('M1LiveCompositionMode', ['menu', 'play']);
const Marker = defineComponent('M1LiveCompositionMarker', { value: 'u32' });

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const status = document.querySelector<HTMLDivElement>('#status');
if (!canvas || !status) throw new Error('m1-composition: missing browser host elements');

const appResult = await createApp(
  canvas,
  {
    time: { fixedDeltaSeconds: 0.05, maxStepsPerUpdate: 2, maxDeltaSeconds: 0.2 },
    plugins: [
      {
        name: 'm1-live-composition',
        build(world) {
          world.insertResource('m1LivePluginBuilt', { value: true });
          return ok(undefined);
        },
      },
    ],
  },
  forgeaxBundlerAdapter(),
);

if (!appResult.ok) {
  const code = 'code' in appResult.error ? appResult.error.code : 'environment-error';
  status.textContent = `createApp failed: ${code}`;
  throw new Error(`createApp failed: ${code}`);
}

const app = appResult.value;
const { world } = app;
const liveState = { value: 'boot' };
const liveFrames = { value: 0 };
const liveFixedTicks = { value: 0 };
const liveErrors = { value: 0, codes: [] as string[] };
const livePosition = { x: 0, y: 0, z: 0 };
world.insertResource('m1LivePhase', liveState);
world.insertResource('m1LiveFrames', liveFrames);
world.insertResource('m1LiveFixedTicks', liveFixedTicks);
world.insertResource('m1LiveErrors', liveErrors);
world.insertResource('m1LivePosition', livePosition);
world.insertResource(INPUT_MAP_KEY, [
  { action: 'jump', bindings: [{ type: 'key', key: 'Space' }] },
]);
world.insertResource('m1LiveInput', { jump: false, justPressed: false });

const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0.1, 0.7, 0.95, 1]));
const root = world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [material] } },
).unwrap();
const child = world.spawn({ component: Marker, data: { value: 7 } }).unwrap();
world.addChild(root, child, ChildOf, { parent: root }).unwrap();
world.insertResource('m1LiveRoot', root);

world.spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data: { fov: 60, aspect: 16 / 9 } }).unwrap();
world.spawn({ component: DirectionalLight, data: { direction: [-0.4, -0.7, -1], color: [1, 1, 1], intensity: 1.2 } }).unwrap();

addOnEnter(Mode, 'play', (target) => {
  const entity = target.spawn({ component: Marker, data: { value: 1 } }).unwrap();
  despawnOnExit(target, entity, Mode, 'play');
});
addOnExit(Mode, 'play', () => {
  liveState.value = 'menu';
});

world.addSystem(Update, {
  name: 'm1-live-observe',
  after: ['transitionStates'],
  before: [FixedUpdate],
  queries: [],
  fn(world) {
    liveFrames.value += 1;
    const current = getState(world, Mode);
    if (current.ok) liveState.value = current.value;
    const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    const jump = snapshot.action('jump');
    const liveInput = world.getResource<{ jump: boolean; justPressed: boolean }>('m1LiveInput');
    liveInput.jump = jump.isPressed();
    liveInput.justPressed = jump.justPressed();
    const position = world.getResource<{ x: number; y: number; z: number }>('m1LivePosition');
    world.set(root, Transform, { pos: [position.x, position.y, position.z] }).unwrap();
    status.textContent = `phase=${liveState.value} frames=${liveFrames.value} fixed=${liveFixedTicks.value}`;
  },
}).unwrap();
world.addSystem(FixedUpdate, {
  name: 'm1-live-fixed',
  queries: [],
  fn() {
    liveFixedTicks.value += 1;
  },
}).unwrap();

app.onError((error) => {
  liveErrors.value += 1;
  liveErrors.codes.push(error.code);
});

const pluginProbe = await runPlugins(world, [], []);
if (!pluginProbe.ok) throw new Error(`plugin probe failed: ${pluginProbe.error.code}`);
const transition = setNextState(world, Mode, 'play');
if (!transition.ok) throw new Error(`initial state transition failed: ${transition.error.code}`);
app.start().unwrap();
