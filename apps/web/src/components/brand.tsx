export function Brand({ administrator = false }: { administrator?: boolean } = {}) {
  return (
    <div class="brand">
      <img
        class="brand-symbol"
        src={administrator ? "/static/admin-brand.svg" : "/static/brand.svg"}
        alt=""
      />
      <img
        class="brand-wordmark"
        src={administrator ? "/static/admin-wordmark.svg" : "/static/wordmark.svg"}
        alt="aBridge"
      />
    </div>
  );
}
