/** Start an independent MenuView scenario without removing unrelated session data. */
export function clearTestCartSession(storage: Storage): void {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith("scanym:cart:v1:")) storage.removeItem(key);
  }
}
