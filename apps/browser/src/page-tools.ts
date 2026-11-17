// Page-local functions are serialized explicitly; no extension globals enter the page.
/** Pure validation runs before focus/scroll or native input, so a known refusal keeps the task tab. */
export function validateInput(this: Node, action: string): string | null {
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
  return null;
}

export function prepareInput(this: HTMLElement | Document | Text, action?: string) {
  const rootKey = this.nodeType === 9 && action === "press";
  const element =
    this.nodeType === 9
      ? (this as Document).body
      : this.nodeType === 3
        ? this.parentElement
        : (this as HTMLElement);
  if (!element) throw new Error("Element detached");
  if (!element.isConnected) throw new Error("Element detached");
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
  const hit = doc.elementFromPoint(x, y);
  if (!hit || (this.nodeType === 3 ? hit !== element : hit !== element && !element.contains(hit)))
    throw new Error("Element is obscured");
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
    if (frame.ownerDocument.elementFromPoint(x, y) !== frame) throw new Error("Frame is obscured");
    current = frame.ownerDocument.defaultView!;
  }
  // Pointer input must keep native mouseDown → focus → mouseUp → click ordering.
  // Pre-focusing a menu/combobox option can blur its trigger and destroy the target.
  // Fill focuses in prepareFill; only element-directed key input needs focus here.
  if (action === "press" && !rootKey) element.focus({ preventScroll: true });
  return { x, y };
}
export function selectValues(this: HTMLSelectElement, values: string[]) {
  if (!this.isConnected || this.matches(":disabled") || this.tagName !== "SELECT")
    throw new Error("Select unavailable");
  if (!this.multiple && values.length !== 1) throw new Error("Single select requires one value");
  for (const value of values)
    if (![...this.options].some((option) => option.value === value && !option.matches(":disabled")))
      throw new Error("Option unavailable");
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
    const tables = root.matches("table") ? [root] : [...root.querySelectorAll("table")];
    return tables.flatMap((table, tableIndex) =>
      [...table.querySelectorAll("tr")].map((row, rowIndex) => ({
        table: tableIndex,
        row: rowIndex,
        cells: [...row.querySelectorAll("th,td")].map((cell) => ({
          text: (cell as HTMLElement).innerText,
          row_span: (cell as HTMLTableCellElement).rowSpan,
          col_span: (cell as HTMLTableCellElement).colSpan,
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
  if (state === "value") return matching.some((node) => (node as HTMLInputElement).value === value);
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
