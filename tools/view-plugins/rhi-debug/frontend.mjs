/** Domain operations remain in the existing RHI viewer and RHI Debug packages. */
export default {
 name: 'forgeax.engine.view.rhi-debug',
 inject: ['pageHost', 'panelHost'],
 async apply(ctx) {
  const page = ctx.pageHost;
  const node = document.createElement('section');
  node.dataset.forgeaxDiagnostic = 'rhi-debug';
  node.style.cssText = 'height:100%;min-height:0;overflow:auto';
  const unregister = page.registerType({ typeId: 'rhi-debug', context: 'artifact', title: 'RHI Debug', order: -10,
   closable: true, singleton: true, initial: true, openable: true, layout: 'surface', showPanelRail: false, hideWhenInactive: true });
  const unmount = page.mount('rhi-debug', node);
  let dispose;
  let live = true;
  ctx.effect(() => async () => { live = false; await dispose?.(); unmount(); unregister(); });
  const mounted = await ctx.panelHost.mountPanelInto({ element: node, panel: 'RhiDebug' });
  if (live) dispose = mounted; else await mounted?.();
 },
};
