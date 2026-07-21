import type { TocItem } from "../../source/toc.js";

export function listTocSerialIds(items: readonly TocItem[]): number[] {
  const serialIds: number[] = [];

  for (const item of items) {
    if (item.serialId !== undefined) {
      serialIds.push(item.serialId);
    }

    serialIds.push(...listTocSerialIds(item.children));
  }

  return serialIds;
}
