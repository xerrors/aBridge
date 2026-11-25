/** Android 11 can retain WebView 87; keep runtime APIs used by shared contracts available. */
if (!Object.hasOwn) {
  Object.defineProperty(Object, "hasOwn", {
    configurable: true,
    writable: true,
    value: (object: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(object, key),
  });
}
if (!String.prototype.isWellFormed) {
  Object.defineProperty(String.prototype, "isWellFormed", {
    configurable: true,
    writable: true,
    value: function (this: string): boolean {
      for (let index = 0; index < this.length; index++) {
        const unit = this.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = this.charCodeAt(++index);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
      }
      return true;
    },
  });
}
/** getRandomValues works on the private HTTP origins supported by the native controller. */
export function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
