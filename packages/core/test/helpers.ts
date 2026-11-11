/** Returns the element at `index`, or throws. Makes assertions on array elements fail with a clear message. */
export const at = <T>(items: readonly T[], index: number): T => {
  if (index < 0 || index >= items.length) {
    throw new Error(`Expected an element at index ${index}, but the array has ${items.length}.`);
  }
  return items[index] as T;
};
