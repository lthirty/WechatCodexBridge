import path from "node:path";

export function assertAllowedPath(config, rawPath) {
  const resolved = path.resolve(rawPath);
  const allowed = config.allowedRoots.some((root) => {
    const allowedRoot = path.resolve(root);
    return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`);
  });
  if (!allowed) {
    throw new Error(`path is outside allowedRoots: ${resolved}`);
  }
  return resolved;
}
