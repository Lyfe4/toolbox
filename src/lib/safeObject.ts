/**
 * Adds an own, enumerable property to an object.
 *
 * Plain assignment (`target[key] = value`) is unsafe when the key comes from
 * parsed input: `target['__proto__'] = x` REPLACES the object's prototype
 * instead of creating a property, so the key silently vanishes from the data
 * and the object gains a prototype an attacker chose. defineProperty always
 * creates a real own property, whatever the key is called.
 */
export function setOwnProperty<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
