/**
 * Isolate known long integration files without losing, duplicating or silently
 * ignoring coverage. Each batch keeps the existing bounded process budget.
 */
export function planAssistedTestBatches(files, dedicated, { maxFilesPerBatch = Infinity } = {}) {
  if (
    maxFilesPerBatch !== Infinity &&
    (!Number.isSafeInteger(maxFilesPerBatch) || maxFilesPerBatch < 1)
  )
    throw new Error("Batch size must be a positive integer");
  if (!files.length || new Set(files).size !== files.length)
    throw new Error("Assisted test manifest must be nonempty and contain no duplicates");
  const reserved = new Set(["other"]);
  const isolated = new Set();
  for (const entry of dedicated) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.name) || reserved.has(entry.name))
      throw new Error("Dedicated test batch names must be unique");
    if (!files.includes(entry.file) || isolated.has(entry.file))
      throw new Error("Dedicated test file must occur exactly once in the manifest");
    reserved.add(entry.name);
    isolated.add(entry.file);
  }
  const other = files.filter((file) => !isolated.has(file));
  const otherBatches = [];
  for (let start = 0; start < other.length; start += maxFilesPerBatch) {
    const name = other.length <= maxFilesPerBatch ? "other" : `other-${otherBatches.length + 1}`;
    if (dedicated.some((entry) => entry.name === name))
      throw new Error("Dedicated test batch conflicts with a generated batch name");
    otherBatches.push({ name, files: other.slice(start, start + maxFilesPerBatch) });
  }
  return [
    ...otherBatches,
    ...dedicated.map((entry) => ({ name: entry.name, files: [entry.file] })),
  ];
}
