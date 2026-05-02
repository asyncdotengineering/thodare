export interface ContractTestOptions {
  skip?: string[];
  only?: string[];
}

export function packPredicate(
  packId: string,
  options?: ContractTestOptions,
): boolean {
  if (options?.only !== undefined && options.only.length > 0) {
    return options.only.some((id) => id === packId || packId.startsWith(`${id}/`));
  }
  if (options?.skip !== undefined) {
    const hit = options.skip.some((id) => id === packId || packId.startsWith(`${id}/`));
    if (hit) return false;
  }
  return true;
}
