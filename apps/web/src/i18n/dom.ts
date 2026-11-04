/**
 * Translates rendered text in place. React keeps rendering the Portuguese source; this layer
 * rewrites text nodes and accessible attributes (aria-label, title, placeholder...) after each
 * commit through a MutationObserver, and can restore the originals when the language changes.
 */
// Subtrees left untouched, and elements whose text is code or user data (attributes still translate).
const SKIP_SUBTREE = 'script,style,.xterm,[data-no-translate],[contenteditable="true"]';
const SKIP_TEXT = SKIP_SUBTREE + ',code,kbd,samp,textarea,.tcp-payload';
export const TRANSLATED_ATTRIBUTES = [
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
];
interface Entry {
  source: string;
  translated: string;
}
export class DomTranslator {
  private observers = new Map<Node, MutationObserver>();
  private texts = new WeakMap<Text, Entry>();
  private attributes = new WeakMap<Element, Map<string, Entry>>();

  constructor(private readonly translate: (text: string) => string) {}

  /** Translates the subtree now and keeps translating it as it changes. */
  observe(root: Node) {
    if (this.observers.has(root)) return;
    const view = (root.ownerDocument ?? (root as Document)).defaultView ?? window;
    const observer = new view.MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') this.text(record.target as Text);
        else if (record.type === 'attributes')
          this.attribute(record.target as Element, record.attributeName!);
        else record.addedNodes.forEach((node) => this.subtree(node));
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATED_ATTRIBUTES,
    });
    this.observers.set(root, observer);
    this.subtree(root);
  }

  /** Stops observing a root and puts back the source text where it is still displayed. */
  unobserve(root: Node) {
    const observer = this.observers.get(root);
    if (!observer) return;
    observer.disconnect();
    this.observers.delete(root);
    this.restore(root);
  }

  disconnect() {
    for (const root of [...this.observers.keys()]) this.unobserve(root);
  }

  private skipped(element: Element | null, selector = SKIP_SUBTREE) {
    return !element || !!element.closest(selector);
  }

  private subtree(root: Node) {
    if (root.nodeType === Node.TEXT_NODE) return this.text(root as Text);
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (this.skipped(root as Element)) return;
      this.elementAttributes(root as Element);
    }
    const doc = root.ownerDocument ?? (root as Document);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(SKIP_SUBTREE)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (node.nodeType === Node.TEXT_NODE) this.text(node as Text);
      else this.elementAttributes(node as Element);
  }

  private elementAttributes(element: Element) {
    for (const name of TRANSLATED_ATTRIBUTES) if (element.hasAttribute(name)) this.attribute(element, name);
  }

  private text(node: Text) {
    const value = node.data;
    const known = this.texts.get(node);
    if (known?.translated === value || !/\p{L}/u.test(value)) return;
    if (this.skipped(node.parentElement, SKIP_TEXT)) return;
    // Preformatted blocks are translated line by line.
    const translated = node.parentElement!.closest('pre')
      ? value
          .split('\n')
          .map((line) => this.translate(line))
          .join('\n')
      : this.translate(value);
    if (translated === value) {
      this.texts.delete(node);
      return;
    }
    this.texts.set(node, { source: value, translated });
    node.data = translated;
  }

  private attribute(element: Element, name: string) {
    const value = element.getAttribute(name);
    if (value === null || !/\p{L}/u.test(value) || this.skipped(element)) return;
    const entries = this.attributes.get(element) ?? new Map<string, Entry>();
    if (entries.get(name)?.translated === value) return;
    const translated = this.translate(value);
    if (translated === value) return;
    entries.set(name, { source: value, translated });
    this.attributes.set(element, entries);
    element.setAttribute(name, translated);
  }

  private restore(root: Node) {
    const doc = root.ownerDocument ?? (root as Document);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    const restoreElement = (element: Element) => {
      for (const [name, entry] of this.attributes.get(element) ?? [])
        if (element.getAttribute(name) === entry.translated) element.setAttribute(name, entry.source);
      this.attributes.delete(element);
    };
    if (root.nodeType === Node.ELEMENT_NODE) restoreElement(root as Element);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (node.nodeType === Node.TEXT_NODE) {
        const entry = this.texts.get(node as Text);
        if (entry && (node as Text).data === entry.translated) (node as Text).data = entry.source;
        this.texts.delete(node as Text);
      } else restoreElement(node as Element);
  }
}
