// The child of test/server/machines-local.test.ts: loads the machines sampler on a throwaway data folder (the
// environment gives it), runs what argv says and prints one JSON line. Its own process, because the sampler opens
// the database of whatever folder the environment names.
const { sampleMachines, machineHealth, setLocalReader } = await import("../src/server/machines.ts");
const mode = process.argv[2];
const timed = async () => { const t = performance.now(); await sampleMachines(); return Math.round(performance.now() - t); };
const sample = () => machineHealth()[0].sample;
if (mode === "reader") {
  setLocalReader(() => ({ stats: { cores: "8", load1: "1.25", cpu_busy: "12.5", mem_used: "50.0", swap_used_gb: "1.00", disk_free_gb: "100.0" }, tempGb: 3.21 }));
  const ms = await timed();
  console.log(JSON.stringify({ ms, sample: sample() }));
} else if (mode === "no-reading") {
  // A monitor with no fresh tick and no temp reading: the script and the walk, as on a machine without a monitor.
  setLocalReader(() => ({ stats: null, tempGb: undefined }));
  const ms = await timed();
  console.log(JSON.stringify({ ms, sample: sample() }));
}
process.exit(0);
