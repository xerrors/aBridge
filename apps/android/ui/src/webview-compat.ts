// Tamagui uses Object.hasOwn, which Android System WebView 87 lacks.
if (!Object.hasOwn) {
  Object.defineProperty(Object, "hasOwn", {
    configurable: true,
    writable: true,
    value: function hasOwn(object: object, key: PropertyKey): boolean {
      return Object.prototype.hasOwnProperty.call(object, key);
    },
  });
}
