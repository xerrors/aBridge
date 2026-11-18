/** Bounded, read-only discovery of visible pointer affordances absent from semantic AX controls. */
export function capturePointerTargets() {
  const targets: HTMLElement[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let scanned = 0,
    truncated = false;
  while (walker.nextNode()) {
    if (++scanned > 4000) {
      truncated = true;
      break;
    }
    const el = walker.currentNode as HTMLElement;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "CANVAS", "OBJECT", "EMBED"].includes(el.tagName)) continue;
    if (el.closest("button,a,input,select,textarea,[role='button'],[role='link']")) continue;
    const style = getComputedStyle(el);
    if (
      style.cursor !== "pointer" ||
      style.visibility !== "visible" ||
      style.display === "none" ||
      Number(style.opacity) === 0
    )
      continue;
    let transparent = false;
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (Number(getComputedStyle(ancestor).opacity) === 0) {
        transparent = true;
        break;
      }
    }
    if (transparent) continue;
    // Visible text already has AX text references; this fallback supplies unnamed visual affordances.
    if ((el.innerText || "").trim()) continue;
    if (
      [...el.children].some(
        (child) => getComputedStyle(child).cursor === "pointer" && child.getClientRects().length,
      )
    )
      continue;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left),
      y = Math.max(0, r.top);
    const width = Math.min(innerWidth, r.right) - x,
      height = Math.min(innerHeight, r.bottom) - y;
    if (width < 2 || height < 2) continue;
    const hit = document.elementFromPoint(x + width / 2, y + height / 2);
    if (!hit || (hit !== el && !el.contains(hit))) continue;
    if (targets.length >= 16) {
      truncated = true;
      break;
    }
    targets.push(el);
  }
  return { targets, truncated };
}
/** Metadata is read from the same element handle later bound to the action reference. */
export function pointerTargetDetails(this: HTMLElement) {
  if (!this.isConnected) return null;
  const style = getComputedStyle(this);
  if (style.cursor !== "pointer" || style.visibility !== "visible" || style.display === "none") return null;
  for (let ancestor: HTMLElement | null = this; ancestor; ancestor = ancestor.parentElement)
    if (Number(getComputedStyle(ancestor).opacity) === 0) return null;
  const r = this.getBoundingClientRect();
  const x = Math.max(0, r.left),
    y = Math.max(0, r.top),
    width = Math.min(innerWidth, r.right) - x,
    height = Math.min(innerHeight, r.bottom) - y;
  if (width < 2 || height < 2) return null;
  const hit = document.elementFromPoint(x + width / 2, y + height / 2);
  if (!hit || (hit !== this && !this.contains(hit))) return null;
  return {
    name: (
      this.getAttribute("aria-label") ||
      this.getAttribute("title") ||
      this.getAttribute("alt") ||
      "Unlabelled clickable target"
    ).slice(0, 240),
    bounds: { x, y, width, height },
  };
}
/** Scroll offsets directly: background compositor wheel acknowledgement does not prove movement. */
export function scrollElement(this: Node, deltaX: number, deltaY: number) {
  const doc = this.nodeType === 9 ? (this as Document) : this.ownerDocument!;
  const win = doc.defaultView!;
  let candidate =
    this.nodeType === 9 ? doc.scrollingElement : this.nodeType === 3 ? this.parentElement : (this as Element);
  let target: Element | null = null;
  while (candidate && candidate !== doc.scrollingElement) {
    const style = win.getComputedStyle(candidate);
    const vertical =
      deltaY !== 0 &&
      /^(auto|scroll|overlay)$/.test(style.overflowY) &&
      candidate.scrollHeight > candidate.clientHeight;
    const horizontal =
      deltaX !== 0 &&
      /^(auto|scroll|overlay)$/.test(style.overflowX) &&
      candidate.scrollWidth > candidate.clientWidth;
    if (vertical || horizontal) {
      target = candidate;
      break;
    }
    candidate = candidate.parentElement;
  }
  target ||= doc.scrollingElement || doc.documentElement;
  const before = { x: target.scrollLeft, y: target.scrollTop };
  target.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
  const after = { x: target.scrollLeft, y: target.scrollTop };
  return {
    target: target === doc.scrollingElement ? "page" : "element",
    before,
    after,
    delta: { x: after.x - before.x, y: after.y - before.y },
  };
}
// Page-local functions are serialized explicitly; no extension globals enter the page.
/** The same screen point must hit the target inside its root and each host from outside. */
export function hitsInputTarget(element: Element, x: number, y: number, exact: boolean): boolean {
  const doc = element.ownerDocument;
  let expected = element;
  for (;;) {
    const root = (expected.getRootNode?.() ?? doc) as Document | ShadowRoot;
    const hit = root.elementFromPoint(x, y);
    if (!hit || (hit !== expected && (exact || !expected.contains(hit)))) return false;
    if (root === doc) return true;
    const host = (root as ShadowRoot).host;
    if (!host || host.ownerDocument !== doc) return false;
    expected = host;
    exact = true;
  }
}
/** Pure validation runs before focus/scroll or native input, so a known refusal keeps the task tab. */
export function validateInput(this: Node, action: string, hitTest = hitsInputTarget): string | null {
  if (this.nodeType === 9)
    return action === "press" || action === "scroll" ? null : "页面根节点只支持按键或滚动，请选择具体元素";
  if (this.nodeType === 3 && (action === "fill" || action === "select"))
    return "文本引用只用于定位文字，请选择可编辑输入框或下拉控件";
  const node = this.nodeType === 3 ? this.parentElement : this;
  if (!node || node.nodeType !== 1) return "目标不是可操作元素，请重新观察";
  const element = node as HTMLElement;
  if (action === "fill") {
    const input = element as HTMLInputElement;
    if (input.readOnly) return "目标为只读字段，不能 fill；请点击控件并使用页面提供的选择界面";
    if (input.disabled || element.closest("[inert]")) return "目标已禁用，不能 fill";
    if (
      !element.isContentEditable &&
      (!["INPUT", "TEXTAREA"].includes(element.tagName) ||
        ["file", "checkbox", "radio", "button", "submit", "reset", "hidden"].includes(input.type))
    )
      return "目标不是可编辑文本字段；请重新观察并选择文本输入框";
  }
  if (!element.isConnected) return "目标已离开页面，请重新观察";
  let rect = element.getBoundingClientRect();
  const doc = element.ownerDocument,
    win = doc.defaultView!;
  if (this.nodeType === 3) {
    const range = doc.createRange();
    range.selectNodeContents(this);
    rect = range.getBoundingClientRect();
  }
  if (rect.width <= 0 || rect.height <= 0) return "目标不可见，请重新观察";
  if (action === "scroll") return null; // DOM offsets do not require a pointer hit on the descendant.
  const x = rect.x + rect.width / 2,
    y = rect.y + rect.height / 2;
  // Only reject current in-viewport occlusion here: no scroll/focus/input has happened.
  if (x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight) {
    if (!hitTest(element, x, y, this.nodeType === 3)) {
      // A point can be inside the page viewport but outside a nested scrollport.
      // Let native preparation reveal that original target, then perform its final hit test.
      const canReveal = ["click", "fill", "hover", "press"].includes(action);
      for (let parent = canReveal ? element.parentElement : null; parent; parent = parent.parentElement) {
        const style = win.getComputedStyle(parent);
        const clipsX = /^(auto|scroll|hidden|overlay)$/.test(style.overflowX);
        const clipsY = /^(auto|scroll|hidden|overlay)$/.test(style.overflowY);
        if (!clipsX && !clipsY) continue;
        if (style.transform && style.transform !== "none") return null;
        const p = parent.getBoundingClientRect();
        const left = p.left + (parent.clientLeft || 0),
          top = p.top + (parent.clientTop || 0);
        if (
          (clipsX && (x < left || x >= left + parent.clientWidth)) ||
          (clipsY && (y < top || y >= top + parent.clientHeight))
        )
          return null;
      }
      return "目标被覆盖，未执行输入；请先处理覆盖层并重新观察";
    }
  }
  return null;
}

export function prepareInput(
  this: HTMLElement | Document | Text,
  action?: string,
  hitTest = hitsInputTarget,
) {
  const rootKey = this.nodeType === 9 && action === "press";
  const element =
    this.nodeType === 9
      ? (this as Document).body
      : this.nodeType === 3
        ? this.parentElement
        : (this as HTMLElement);
  if (!element) throw new Error("Element detached");
  if (!element.isConnected) throw new Error("Element detached");
  if (rootKey) return { x: 0, y: 0 };
  element.scrollIntoView({ block: "center", inline: "center" });
  const doc = element.ownerDocument;
  const win = doc.defaultView!;
  let rect = element.getBoundingClientRect();
  if (this.nodeType === 3) {
    const range = doc.createRange();
    range.selectNodeContents(this);
    rect = range.getBoundingClientRect();
  }
  const style = win.getComputedStyle(element);
  if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none")
    throw new Error("Element is not visible");
  if (element.matches(":disabled") || element.closest("[inert]")) throw new Error("Element is disabled");
  let x = Math.max(0, Math.min(win.innerWidth - 1, rect.x + rect.width / 2));
  let y = Math.max(0, Math.min(win.innerHeight - 1, rect.y + rect.height / 2));
  if (!hitTest(element, x, y, this.nodeType === 3)) throw new Error("Element is obscured");
  let current = win;
  while (current !== current.top) {
    const frame = current.frameElement as HTMLElement | null;
    if (!frame) throw new Error("Unsupported cross-origin frame");
    for (let ancestor: HTMLElement | null = frame; ancestor; ancestor = ancestor.parentElement) {
      const parentStyle = frame.ownerDocument.defaultView!.getComputedStyle(ancestor);
      if (
        parentStyle.transform !== "none" ||
        parentStyle.perspective !== "none" ||
        !["1", "normal", ""].includes(parentStyle.zoom)
      )
        throw new Error("Transformed frames are unsupported");
    }
    frame.scrollIntoView({ block: "center", inline: "center" });
    const bounds = frame.getBoundingClientRect();
    x += bounds.left + frame.clientLeft;
    y += bounds.top + frame.clientTop;
    if (!hitTest(frame, x, y, true)) throw new Error("Frame is obscured");
    current = frame.ownerDocument.defaultView!;
  }
  // Pointer input must keep native mouseDown → focus → mouseUp → click ordering.
  // Pre-focusing a menu/combobox option can blur its trigger and destroy the target.
  // Fill focuses in prepareFill; only element-directed key input needs focus here.
  if (action === "press" && !rootKey) element.focus({ preventScroll: true });
  return { x, y };
}
/** Read-only validation is shared by preflight and the final page-local write. */
export function validateSelect(this: Node, values: string[]): string | null {
  if (this.nodeType !== 1 || (this as Element).tagName !== "SELECT")
    return "select 只支持原生 SELECT；自定义下拉框请点击可见控件与选项";
  const element = this as HTMLSelectElement;
  if (!element.isConnected) return "下拉控件已离开页面，请重新观察";
  if (element.matches(":disabled") || element.closest("[inert]")) return "下拉控件已禁用";
  if (!element.multiple && values.length !== 1) return "单选控件必须提供一个选项值";
  for (const value of values)
    if (![...element.options].some((option) => option.value === value && !option.matches(":disabled")))
      return "选项不存在或已禁用，请重新观察并选择有效选项值";
  return null;
}
export function selectValues(this: HTMLSelectElement, values: string[]) {
  const refusal = validateSelect.call(this, values);
  if (refusal) return refusal;
  for (const option of this.options) option.selected = values.includes(option.value);
  const win = this.ownerDocument.defaultView!;
  this.dispatchEvent(new win.Event("input", { bubbles: true }));
  this.dispatchEvent(new win.Event("change", { bubbles: true }));
  return [...this.selectedOptions].map((option) => option.value);
}
export function captureContent(selector: string | undefined, format: string) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) throw new Error("Read target missing");
  if (format === "table") {
    const tables = root instanceof HTMLTableElement ? [root] : [...root.querySelectorAll("table")];
    return tables.flatMap((table, tableIndex) =>
      [...table.rows].map((row, rowIndex) => ({
        table: tableIndex,
        row: rowIndex,
        cells: [...row.cells].map((cell) => ({
          text: cell.innerText,
          row_span: cell.rowSpan,
          col_span: cell.colSpan,
        })),
      })),
    );
  }
  return (root as HTMLElement).innerText.slice(0, 1000001);
}
export function checkCondition(
  selector: string | undefined,
  text: string | undefined,
  state: string,
  value?: string,
  verify = false,
) {
  const nodes = selector ? [...document.querySelectorAll(selector)] : [document.body];
  const matching = nodes.filter(
    (node) =>
      node &&
      (text === undefined ||
        (
          (state === "visible" || state === "hidden" ? (node as HTMLElement).innerText : node.textContent) ||
          ""
        ).includes(text)),
  );
  // Negative conditions apply to every match. A positive verification must identify one target.
  if (matching.length > 1 && (state === "value" || (verify && (state === "visible" || state === "attached"))))
    return matching.length;
  if (state === "value") return matching.length === 1 && (matching[0] as HTMLInputElement).value === value;
  const visible = matching.some((node) => {
    const style = getComputedStyle(node);
    return node.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
  });
  return state === "attached"
    ? matching.length > 0
    : state === "detached"
      ? !matching.length
      : state === "hidden"
        ? !visible
        : visible;
}

export function prepareFill(this: HTMLElement) {
  const win = this.ownerDocument.defaultView!;
  if (!this.isConnected) throw new Error("Element detached");
  this.focus({ preventScroll: true });
  if (this instanceof win.HTMLInputElement || this instanceof win.HTMLTextAreaElement) {
    if (
      this.disabled ||
      this.readOnly ||
      (this instanceof win.HTMLInputElement &&
        ["file", "checkbox", "radio", "button", "submit", "reset", "hidden"].includes(this.type))
    )
      throw new Error("Field unavailable");
    this.select();
    return { select_all: this instanceof win.HTMLInputElement && ["number", "email"].includes(this.type) };
  } else if (this.isContentEditable) {
    const selection = win.getSelection();
    const range = this.ownerDocument.createRange();
    range.selectNodeContents(this);
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else throw new Error("Element is not editable");
  return { select_all: false };
}

/** Serialized into the target document for bounded, read-only ambiguity diagnostics. */
export function describeLocatorMatches(selector: string) {
  const matches = document.querySelectorAll(selector);
  const label = (el: Element) =>
    el.localName +
    (el.id ? "#" + el.id.slice(0, 48) : "") +
    Array.from(el.classList)
      .slice(0, 2)
      .map((name) => "." + name.slice(0, 32))
      .join("");
  const candidates = Array.from({ length: Math.min(matches.length, 4) }, (_, i) => {
    const el = matches[i];
    const container =
      el.parentElement?.closest('[id],[data-testid],article,li,tr,[role="row"],[role="listitem"]') ||
      el.parentElement;
    return {
      element: label(el),
      visible: el.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
      container: container ? label(container) : null,
    };
  });
  return { count: matches.length, candidates };
}

/** Runs on a resolved container. Follow the composed tree without leaving its document. */
export function composedMembership(this: Element, ...candidates: Node[]): boolean[] {
  if (!this.isConnected) throw new Error("Locator container detached");
  return candidates.map((candidate) => {
    if (candidate.ownerDocument !== this.ownerDocument || !candidate.isConnected) return false;
    let node: Node | null = candidate;
    for (let depth = 0; node; depth++) {
      if (node === this) return true;
      if (depth >= 4096) throw new Error("Locator ancestry exceeds limit");
      const slot: HTMLSlotElement | null = (node as Element | Text).assignedSlot;
      node = slot ?? node.parentNode ?? (node.nodeType === 11 ? (node as ShadowRoot).host : null);
    }
    return false;
  });
}
