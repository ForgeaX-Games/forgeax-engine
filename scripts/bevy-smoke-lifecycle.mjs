// Standard Dawn smokes hand their lifetime to bevy-demo.mjs. Keep the child
// alive after a successful module evaluation so the parent can flush stdout
// and reap the native WebGPU process with SIGKILL.
const nativeExit = process.exit.bind(process);
const keepAlive = setInterval(() => {
  if (process.exitCode !== undefined && process.exitCode !== 0) {
    clearInterval(keepAlive);
    nativeExit(process.exitCode);
  }
}, 10);

process.exit = (code = 0) => {
  if (code === 0) {
    process.exitCode = 0;
    return;
  }
  nativeExit(code);
};
