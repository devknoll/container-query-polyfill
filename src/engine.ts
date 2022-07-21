/**
 * Copyright 2022 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  ContainerType,
  evaluateContainerCondition,
  QueryContext,
  TreeContext,
  WritingAxis,
} from './evaluate.js';
import {
  CUSTOM_PROPERTY_NAME,
  CUSTOM_PROPERTY_TYPE,
  CUSTOM_UNIT_VARIABLE_CQB,
  CUSTOM_UNIT_VARIABLE_CQH,
  CUSTOM_UNIT_VARIABLE_CQI,
  CUSTOM_UNIT_VARIABLE_CQW,
  DATA_ATTRIBUTE_NAME,
  PER_RUN_UID,
} from './constants.js';
import {ContainerQueryDescriptor, transpileStyleSheet} from './transform.js';

interface PhysicalSize {
  width: number;
  height: number;
}

interface QueryContainerState {
  /**
   * True if the query container's condition evaluates to true.
   */
  condition: boolean | null;

  /**
   * True if the query container's rules should be applied.
   *
   * Note: this is subtly different from `condition`, as it
   * takes into account any parent containers and conditions too.
   */
  container: boolean;
}

interface LayoutState {
  conditions: Record<string, QueryContainerState>;
  treeContext: TreeContext;
}

type QueryDescriptorArray = Iterable<ContainerQueryDescriptor>;

const ELEMENT_TO_DESCRIPTORS_MAP: Map<Element, QueryDescriptorArray> =
  new Map();

const CONTROLLER_SYMBOL: unique symbol = Symbol('CQ_CONTROLLER');
const INSTANCE_SYMBOL: unique symbol = Symbol('CQ_INSTANCE');
const QUERY_CONTAINER_ELEMENTS: Set<GenericElementInstance> = new Set();
const SUPPORTS_SMALL_VIEWPORT_UNITS = CSS.supports('width: 1svh');
const SUPPORTS_WRITING_MODE = CSS.supports('writing-mode: auto');

const documentElement = document.documentElement;
const rootEl = document.createElement(`cq-polyfill-${PER_RUN_UID}`);
const rootStyles = window.getComputedStyle(rootEl);

const rootStyleEl = document.createElement('style');
rootStyleEl.innerHTML = `* { ${CUSTOM_PROPERTY_TYPE}: ${ContainerType.Normal}; ${CUSTOM_PROPERTY_NAME}: none; }`;
document.head.prepend(rootStyleEl);

(window as any).CQ_SYMBOL = INSTANCE_SYMBOL;

rootEl.style.cssText =
  'position: fixed; top: 0; left: 0; right: 0; bottom: 0; visibility: hidden; font-size: 1rem; transition: font-size 1e-8ms;';
documentElement.appendChild(rootEl);

interface ViewportChangeContext {
  viewportChanged(size: PhysicalSize): void;
}

interface StyleSheetContext {
  register(source: string, url?: URL): StyleSheetInstance;
}

interface ChildNodeContext {
  // ...
}

interface StyleSheetInstance {
  source: string;
  dispose(): void;
}

class NodeController<T extends Node, C> {
  node: T;
  context: C;

  constructor(node: T, context: C) {
    this.node = node;
    this.context = context;
  }

  connected() {
    // ...
  }

  disconnected() {
    // ...
  }

  resized() {
    // ...
  }

  parentResized() {
    // ...
  }

  mutated() {
    // ...
  }
}

class ChildNodeController<T extends Node, C> extends NodeController<
  T,
  C & ChildNodeContext
> {
  // ...
}

class LinkElementController extends ChildNodeController<
  HTMLLinkElement,
  StyleSheetContext
> {
  #isConnected = false;
  #styleSheet: StyleSheetInstance | null = null;

  connected(): void {
    this.#isConnected = true;
    const node = this.node;
    if (node.rel === 'stylesheet') {
      const srcUrl = new URL(node.href, document.baseURI);
      if (srcUrl.origin === location.origin) {
        fetch(srcUrl.toString())
          .then(r => r.text())
          .then(src => {
            if (this.#isConnected) {
              this.#styleSheet = this.context.register(src, srcUrl);
              const blob = new Blob([this.#styleSheet.source], {
                type: 'text/css',
              });
              node.href = URL.createObjectURL(blob);
            }
          });
      }
    }
  }

  disconnected(): void {
    this.#isConnected = false;
    if (this.#styleSheet) {
      this.#styleSheet.dispose();
      this.#styleSheet = null;
    }
  }
}

class StyleElementController extends ChildNodeController<
  HTMLStyleElement,
  StyleSheetContext
> {
  #styleSheet: StyleSheetInstance | null = null;

  connected(): void {
    const node = this.node;
    this.#styleSheet = this.context.register(node.innerHTML);
    node.innerHTML = this.#styleSheet.source;
  }

  disconnected(): void {
    if (this.#styleSheet) {
      this.#styleSheet.dispose();
      this.#styleSheet = null;
    }
  }
}

class GlobalStyleElementController extends NodeController<
  HTMLStyleElement,
  unknown
> {
  connected(): void {
    this.node.innerHTML = `* { ${CUSTOM_PROPERTY_TYPE}: ${ContainerType.Normal}; ${CUSTOM_PROPERTY_NAME}: none; }`;
  }
}

class DummyElementController extends ChildNodeController<
  HTMLElement,
  ViewportChangeContext
> {
  connected(): void {
    this.node.style.cssText =
      'position: fixed; top: 0; left: 0; right: 0; bottom: 0; visibility: hidden; font-size: 1rem; transition: font-size 1e-8ms;';
  }

  resized(): void {
    const node = this.node;
    this.context.viewportChanged({
      width: node.clientWidth,
      height: node.clientHeight,
    });
  }
}

class HtmlElementController
  extends NodeController<HTMLElement, unknown>
  implements ViewportChangeContext
{
  viewportChanged(size: PhysicalSize): void {
    // ...
  }
}

interface LocalContainerParams {
  type: ContainerType;
  names: Set<string>;
  width?: number;
  height?: number;
  inlineSize?: number;
  blockSize?: number;
  fontSize: number;
}

interface ElementLayoutData {
  writingAxis: WritingAxis;
  localParams: LocalContainerParams | null;
}

class ElementLayoutManager {
  #styles: CSSStyleDeclaration;
  #cachedLayoutData: ElementLayoutData | null;

  constructor(element: Element) {
    this.#styles = window.getComputedStyle(element);
    this.#cachedLayoutData = null;
  }

  invalidate(): void {
    this.#cachedLayoutData = null;
  }

  #computeSizeFeatures(type: ContainerType, writingAxis: WritingAxis) {
    type Axis = {value?: number};
    const styles = this.#styles;
    const horizontalAxis: Axis = {
      value: computeDimension(styles.getPropertyValue('width')),
    };
    const verticalAxis: Axis = {
      value: computeDimension(styles.getPropertyValue('height')),
    };

    let inlineAxis = horizontalAxis;
    let blockAxis = verticalAxis;

    if (writingAxis === WritingAxis.Vertical) {
      const tmp = inlineAxis;
      inlineAxis = blockAxis;
      blockAxis = tmp;
    }

    if (type !== ContainerType.Size) {
      blockAxis.value = undefined;
    }

    return {
      width: horizontalAxis.value,
      height: verticalAxis.value,
      inlineSize: inlineAxis.value,
      blockSize: blockAxis.value,
    };
  }

  get(): ElementLayoutData {
    let layoutData = this.#cachedLayoutData;

    if (!layoutData) {
      const styles = this.#styles;
      const writingAxis = computeWritingAxis(
        styles.getPropertyValue('writing-mode')
      );
      const containerType = computeContainerType(
        styles.getPropertyValue(CUSTOM_PROPERTY_TYPE)
      );

      let localParams: LocalContainerParams | null = null;
      if (containerType !== ContainerType.Normal) {
        const isValidContainer = computeValidContainer(
          styles.getPropertyValue('display')
        );

        if (isValidContainer) {
          localParams = {
            type: containerType,
            names: computeContainerNames(
              styles.getPropertyValue(CUSTOM_PROPERTY_NAME)
            ),
            fontSize: computeDimension(styles.getPropertyValue('font-size')),
            ...this.#computeSizeFeatures(containerType, writingAxis),
          };
        }
      }

      this.#cachedLayoutData = layoutData = {
        writingAxis,
        localParams,
      };
    }
    return layoutData;
  }
}

function initializePolyfill() {
  interface Instance {
    depth: number;
    layoutManager: ElementLayoutManager | null;

    connect(): void;
    disconnect(): void;
    resize(): void;
    parentResize(): void;
    mutate(): void;
  }

  function getInstance(node: Node): Instance | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controller = (node as any)[INSTANCE_SYMBOL];
    return controller ? controller : null;
  }

  const documentElement = document.documentElement;
  if (getInstance(documentElement)) {
    return;
  }

  const dummyElement = document.createElement(`cq-polyfill-${PER_RUN_UID}`);
  const globalStyleElement = document.createElement('style');
  const mutationObserver = new MutationObserver(mutations => {
    for (const entry of mutations) {
      for (const node of entry.removedNodes) {
        const instance = getInstance(node);
        instance?.disconnect();
      }

      if (
        entry.type === 'attributes' &&
        entry.attributeName &&
        (entry.attributeName === DATA_ATTRIBUTE_NAME ||
          (entry instanceof Element &&
            entry.getAttribute(entry.attributeName) === entry.oldValue))
      ) {
        continue;
      }

      // Note: We'll recurse into any added nodes during the mutation.
      const instance = getOrCreateInstance(entry.target);
      instance.mutate();
    }
  });
  mutationObserver.observe(documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
  });

  const resizeObserver = new ResizeObserver(entries => {
    entries
      .map(entry => getOrCreateInstance(entry.target))
      .sort((a, b) => a.depth - b.depth)
      .forEach(instance => instance.resize());
  });

  const rootController = new HtmlElementController(documentElement, {});
  const allQueryDescriptors: Set<QueryDescriptorArray> = new Set();
  const styleSheetRegistry: StyleSheetContext = {
    register(source, url) {
      const [transpiledSource, queryDescriptors] = transpileStyleSheet(
        source,
        url ? url.toString() : undefined
      );
      allQueryDescriptors.add(queryDescriptors);

      return {
        source: transpiledSource,
        dispose() {
          allQueryDescriptors.delete(queryDescriptors);
        },
      };
    },
  };

  function getOrCreateInstance(node: Node): Instance {
    let instance = getInstance(node);
    if (!instance) {
      let innerController: NodeController<Node, unknown>;
      let depth = 0;

      if (node === documentElement) {
        innerController = rootController;
      } else {
        const parentNode = node.parentNode;
        const parentController = parentNode ? getInstance(parentNode) : null;

        if (!parentController) {
          throw new Error('Expected node to have parent');
        }

        depth = parentController.depth + 1;
        if (node === dummyElement) {
          innerController = new DummyElementController(
            dummyElement,
            rootController
          );
        } else if (node === globalStyleElement) {
          innerController = new GlobalStyleElementController(
            globalStyleElement,
            {}
          );
        } else if (node instanceof HTMLLinkElement) {
          innerController = new LinkElementController(node, styleSheetRegistry);
        } else if (node instanceof HTMLStyleElement) {
          innerController = new StyleElementController(
            node,
            styleSheetRegistry
          );
        } else {
          innerController = new NodeController(node, {});
        }
      }

      instance = {
        depth,
        layoutManager:
          node instanceof Element ? new ElementLayoutManager(node) : null,

        connect() {
          if (node instanceof Element) {
            resizeObserver.observe(node);
          }
          for (const child of node.childNodes) {
            const instance = getOrCreateInstance(child);
            instance.connect();
          }
          innerController.connected();
        },

        disconnect() {
          if (node instanceof Element) {
            resizeObserver.unobserve(node);
          }
          for (const child of node.childNodes) {
            const instance = getInstance(child);
            instance?.disconnect();
          }
          innerController.disconnected();
        },

        resize() {
          instance?.layoutManager?.invalidate();
          innerController.resized();
          for (const child of node.childNodes) {
            const instance = getOrCreateInstance(child);
            instance.parentResize();
          }
        },

        parentResize() {
          innerController.parentResized();
        },

        mutate() {
          instance?.layoutManager?.invalidate();
          for (const child of node.childNodes) {
            getOrCreateInstance(child);
          }
          innerController.mutated();
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any)[INSTANCE_SYMBOL] = instance;
      instance.connect();
    }
    return instance;
  }

  getOrCreateInstance(documentElement);
  documentElement.appendChild(dummyElement);
}

initializePolyfill();

// abstract class ElementInstance<T extends Node> {
//   node: T;
//   depth: number;
//   parent: ElementInstance<Node> | null;
//   layoutState: LayoutState | null;

//   constructor(node: T, parent: ElementInstance<Node> | null) {
//     this.node = node;
//     this.parent = parent;
//     this.depth = (parent ? parent.depth : 0) + 1;
//     this.layoutState = null;
//   }

//   connect(): void {
//     // eslint-disable-next-line @typescript-eslint/no-explicit-any
//     (this.node as any)[INSTANCE_SYMBOL] = this;

//     for (const childNode of this.node.childNodes) {
//       // Ensure our children are created and connected first.
//       ElementInstance.getOrCreate(childNode);
//     }

//     this.connected();
//   }

//   computeLayoutState(): LayoutState {
//     throw new Error();
//   }

//   getLayoutState(): LayoutState {
//     if (!this.layoutState) {
//       this.layoutState = this.computeLayoutState();
//     }
//     return this.layoutState;
//   }

//   resize(entry: ResizeObserverEntry): void {
//     this.layoutState = null;
//     this.getLayoutState();

//     this.resized();
//     for (const childNode of this.node.childNodes) {
//       const instance = ElementInstance.getOrCreate(childNode);
//       if (instance) {
//         instance.parentResized();
//       }
//     }
//   }

//   disconnect(): void {
//     for (const childNode of this.node.childNodes) {
//       const instance = ElementInstance.get(childNode);
//       if (instance) {
//         instance.disconnect();
//       }
//     }

//     this.disconnected();
//     // eslint-disable-next-line @typescript-eslint/no-explicit-any
//     delete (this.node as any)[INSTANCE_SYMBOL];
//   }

//   mutate(): void {
//     for (const childNode of this.node.childNodes) {
//       // Ensure any new children are created and connected first.
//       ElementInstance.getOrCreate(childNode);
//     }
//     this.mutated();
//   }

//   connected(): void {
//     // ...
//   }

//   disconnected(): void {
//     // ...
//   }

//   resized(): void {
//     // ...
//   }

//   parentResized(): void {
//     // ...
//   }

//   mutated(): void {
//     // ...
//   }

//   scheduleUpdate(): void {
//     // ...
//   }

//   static get(node: Node): ElementInstance<Node> | null {
//     // eslint-disable-next-line @typescript-eslint/no-explicit-any
//     return (node as any)[INSTANCE_SYMBOL] || null;
//   }

//   static getOrCreate(node: Node): ElementInstance<Node> | null {
//     let instance = ElementInstance.get(node);
//     if (!instance) {
//       const parentNode = node.parentNode;
//       const parentInstance = parentNode
//         ? ElementInstance.getOrCreate(parentNode)
//         : null;

//       if (node === rootEl) {
//         instance = new RootElementInstance(rootEl, parentInstance);
//       } else if (node instanceof HTMLHeadElement) {
//         instance = new HeadElementInstance(node, parentInstance);
//       } else if (node instanceof HTMLLinkElement) {
//         instance = new LinkElementInstance(node, parentInstance);
//       } else if (node instanceof HTMLStyleElement) {
//         instance = new StyleElementInstance(node, parentInstance);
//       } else if (node instanceof HTMLElement || node instanceof SVGElement) {
//         instance = new GenericElementInstance(node, parentInstance);
//       }
//       if (instance) {
//         instance.connect();
//       }
//     }
//     return instance ? instance : null;
//   }
// }

// abstract class ResizableElementInstance<
//   T extends Element
// > extends ElementInstance<T> {
//   styles: CSSStyleDeclaration;

//   constructor(node: T, parent: ElementInstance<Node> | null) {
//     super(node, parent);
//     this.styles = window.getComputedStyle(node);
//   }

//   connected(): void {
//     RO.observe(this.node);
//   }

//   disconnected(): void {
//     RO.unobserve(this.node);
//   }

//   scheduleUpdate(): void {
//     RO.unobserve(this.node);
//     RO.observe(this.node);
//   }
// }

// class RootElementInstance extends ResizableElementInstance<Element> {
//   resized() {
//     // return documentInstance ? documentInstance.resize(entry) : null;
//     // documentElement.style.setProperty(
//     //   CUSTOM_UNIT_VARIABLE_CQW,
//     //   SUPPORTS_SMALL_VIEWPORT_UNITS
//     //     ? '1svw'
//     //     : entry.contentRect.width / 100 + 'px'
//     // );
//     // documentElement.style.setProperty(
//     //   CUSTOM_UNIT_VARIABLE_CQH,
//     //   SUPPORTS_SMALL_VIEWPORT_UNITS
//     //     ? '1svh'
//     //     : entry.contentRect.height / 100 + 'px'
//     // );
//     // return this.parentLayoutContext;
//   }
// }

// class HeadElementInstance extends ElementInstance<HTMLHeadElement> {}

// class LinkElementInstance extends ElementInstance<HTMLLinkElement> {
//   isConnected = false;

//   connected(): void {
//     this.isConnected = true;

//     const node = this.node;
//     if (node.rel === 'stylesheet') {
//       const srcUrl = new URL(node.href, document.baseURI);
//       if (srcUrl.origin === location.origin) {
//         fetch(srcUrl.toString())
//           .then(r => r.text())
//           .then(src => {
//             const res = transpileStyleSheet(src, srcUrl.toString());
//             const blob = new Blob([res[0]], {type: 'text/css'});

//             const img = new Image();
//             img.onload = img.onerror = () => {
//               if (this.isConnected) {
//                 ELEMENT_TO_DESCRIPTORS_MAP.set(node, res[1]);
//               }
//               if (documentInstance) {
//                 documentInstance.scheduleUpdate();
//               }
//             };
//             img.src = node.href = URL.createObjectURL(blob);
//           });
//       }
//     }
//   }

//   disconnected(): void {
//     this.isConnected = false;
//     ELEMENT_TO_DESCRIPTORS_MAP.delete(this.node);
//   }
// }

// class StyleElementInstance extends ElementInstance<HTMLStyleElement> {
//   connected(): void {
//     const node = this.node;
//     const originalSrc = node.innerHTML;
//     if (node !== rootStyleEl && originalSrc.length > 0) {
//       const res = transpileStyleSheet(originalSrc);
//       node.innerHTML = res[0];
//       ELEMENT_TO_DESCRIPTORS_MAP.set(node, res[1]);
//       if (documentInstance) {
//         documentInstance.scheduleUpdate();
//       }
//     }
//   }

//   disconnected(): void {
//     ELEMENT_TO_DESCRIPTORS_MAP.delete(this.node);
//   }
// }

// class GenericElementInstance extends ResizableElementInstance<
//   HTMLElement | SVGElement
// > {
//   styles: CSSStyleDeclaration;

//   constructor(
//     el: HTMLElement | SVGElement,
//     parent: ElementInstance<Node> | null
//   ) {
//     super(el, parent);
//     this.styles = window.getComputedStyle(el);
//   }

//   connected(): void {
//     super.connected();
//     this.updateContainerAttribute();
//     this.scheduleUpdate();
//   }

//   resized() {
//     // if (!this.parentLayoutContext) {
//     //   return null;
//     // }
//     // const layoutState = computeLayoutState(
//     //   this.styles,
//     //   this.parentLayoutContext,
//     //   entry
//     // );
//     // const layoutContext = layoutState.context;
//     // const style = this.node.style;
//     // const queryContext = layoutContext.queryContext;
//     // if (queryContext) {
//     //   QUERY_CONTAINER_ELEMENTS.add(this);
//     //   const sizeFeatures = queryContext.sizeFeatures;
//     //   if (sizeFeatures.width != null) {
//     //     style.setProperty(
//     //       CUSTOM_UNIT_VARIABLE_CQW,
//     //       sizeFeatures.width / 100 + 'px'
//     //     );
//     //   }
//     //   if (sizeFeatures.height != null) {
//     //     style.setProperty(
//     //       CUSTOM_UNIT_VARIABLE_CQH,
//     //       sizeFeatures.height / 100 + 'px'
//     //     );
//     //   }
//     // } else {
//     //   QUERY_CONTAINER_ELEMENTS.delete(this);
//     //   style.removeProperty(CUSTOM_UNIT_VARIABLE_CQW);
//     //   style.removeProperty(CUSTOM_UNIT_VARIABLE_CQH);
//     // }
//     // const writingAxis = queryContext.writingAxis;
//     // if (
//     //   writingAxis !== layoutState.parentQueryContext.writingAxis ||
//     //   queryContext
//     // ) {
//     //   style.setProperty(
//     //     CUSTOM_UNIT_VARIABLE_CQI,
//     //     `var(${
//     //       writingAxis === WritingAxis.Horizontal
//     //         ? CUSTOM_UNIT_VARIABLE_CQW
//     //         : CUSTOM_UNIT_VARIABLE_CQH
//     //     })`
//     //   );
//     //   style.setProperty(
//     //     CUSTOM_UNIT_VARIABLE_CQB,
//     //     `var(${
//     //       writingAxis === WritingAxis.Vertical
//     //         ? CUSTOM_UNIT_VARIABLE_CQW
//     //         : CUSTOM_UNIT_VARIABLE_CQH
//     //     })`
//     //   );
//     // } else {
//     //   style.removeProperty(CUSTOM_UNIT_VARIABLE_CQI);
//     //   style.removeProperty(CUSTOM_UNIT_VARIABLE_CQB);
//     // }
//     // return layoutContext;
//   }

//   parentResized(): void {
//     this.updateContainerAttribute();
//     this.scheduleUpdate();
//   }

//   mutated(): void {
//     this.scheduleUpdate();
//   }

//   disconnected(): void {
//     super.disconnected();
//     this.node.removeAttribute(DATA_ATTRIBUTE_NAME);
//     QUERY_CONTAINER_ELEMENTS.delete(this);
//   }

//   updateContainerAttribute() {
//     const attributes: string[] = [];
//     const node = this.node;

//     // const parentContext = this.parentLayoutContext;
//     // if (parentContext) {
//     //   for (const queryDescriptors of getQueryDescriptors()) {
//     //     for (const queryDescriptor of queryDescriptors) {
//     //       const result = parentContext.conditions[queryDescriptor.uid];
//     //       if (
//     //         queryDescriptor.selector != null &&
//     //         result != null &&
//     //         result.condition &&
//     //         node.matches(queryDescriptor.selector)
//     //       ) {
//     //         attributes.push(queryDescriptor.uid);
//     //       }
//     //     }
//     //   }
//     // }

//     if (attributes.length > 0) {
//       node.setAttribute(DATA_ATTRIBUTE_NAME, attributes.join(' '));
//     } else {
//       node.removeAttribute(DATA_ATTRIBUTE_NAME);
//     }
//   }
// }

// abstract class NodeController<T extends Node> {
//   node: T;

//   constructor(node: T) {
//     this.node = node;
//   }

//   connected(): void {
//     // ...
//   }

//   disconnected(): void {
//     // ...
//   }

//   resized(): void {
//     // ...
//   }

//   mutated(): void {
//     // ...
//   }

//   abstract computeLayoutState(): LayoutState;
// }

// interface LayoutStateProvider {
//   getLayoutState(): LayoutState;
// }

// class ChildNodeController<T extends Node> extends NodeController<T> {
//   provider: LayoutStateProvider;

//   constructor(node: T, provider: LayoutStateProvider) {
//     super(node);
//     this.provider = provider;
//   }

//   computeLayoutState(): LayoutState {
//     return this.provider.getLayoutState();
//   }
// }

// interface InternalElementController extends LayoutStateProvider {
//   depth: number;

//   connect(): void;
//   disconnect(): void;
//   resize(): void;
//   mutate(): void;
// }

// class DocumentElementInstance {
//   #dummyElement: HTMLElement;
//   #mutationObserver: MutationObserver;
//   #resizeObserver: ResizeObserver;

//   constructor() {
//     this.#mutationObserver = new MutationObserver(
//       this.#mutationObserverCallback
//     );
//     this.#mutationObserver.observe(documentElement, {
//       childList: true,
//       subtree: true,
//       attributes: true,
//       attributeOldValue: true,
//     });

//     this.#resizeObserver = new ResizeObserver(this.#resizeObserverCallback);
//     this.#dummyElement = document.createElement(`cq-polyfill-${PER_RUN_UID}`);
//     document.appendChild(this.#dummyElement);
//   }

//   #mutationObserverCallback(mutations: MutationRecord[]) {
//     for (const entry of mutations) {
//       if (
//         entry.type === 'attributes' &&
//         (entry.attributeName === DATA_ATTRIBUTE_NAME ||
//           (entry.target instanceof Element &&
//             entry.attributeName &&
//             entry.target.getAttribute(entry.attributeName) === entry.oldValue))
//       ) {
//         continue;
//       }

//       for (const node of entry.removedNodes) {
//         // We'll recurse into the children during disconnect.
//         const controller = this.#getController(node);
//         controller?.disconnect();
//       }

//       // We'll recurse into children during mutation.
//       const controller = this.#getOrCreateController(entry.target);
//       controller.mutate();
//     }
//   }

//   #resizeObserverCallback(entries: ResizeObserverEntry[]) {
//     entries
//       .map(entry => [this.#getOrCreateController(entry.target), entry] as const)
//       .sort((a, b) => a[0].depth - b[0].depth)
//       .forEach(entry => entry[0].resize());
//   }

//   #getController(node: Node): InternalElementController | null {
//     // eslint-disable-next-line @typescript-eslint/no-explicit-any
//     const controller = (node as any)[INSTANCE_SYMBOL];
//     return controller ? controller : null;
//   }

//   #getOrCreateController(node: Node): InternalElementController {
//     let controller = this.#getController(node);
//     if (!controller) {
//       let innerController: NodeController<Node>;
//       let parentDepth = 0;

//       if (node === document.documentElement) {
//         innerController = new HtmlElementController(node);
//       } else {
//         const parentNode = node.parentNode;
//         const parent = parentNode
//           ? this.#getOrCreateController(parentNode)
//           : null;

//         if (!parent) {
//           throw new Error('Expected a parent node');
//         }

//         parentDepth = parent.depth;
//         const layoutStateProvider: LayoutStateProvider = {
//           getLayoutState: parent.getLayoutState,
//         };
//         if (node === this.#dummyElement) {
//           innerController = new DummyElementController(
//             this.#dummyElement,
//             layoutStateProvider
//           );
//         } else if (node instanceof HTMLLinkElement) {
//           innerController = new LinkElementController(
//             node,
//             layoutStateProvider,
//             {} as any
//           );
//         } else if (node instanceof HTMLStyleElement) {
//           innerController = new StyleElementController(
//             node,
//             layoutStateProvider,
//             {} as any
//           );
//         } else {
//           innerController = new ChildNodeController(node, layoutStateProvider);
//         }
//       }

//       // eslint-disable-next-line @typescript-eslint/no-this-alias
//       const self = this;
//       let cachedLayoutState: LayoutState | null = null;

//       controller = {
//         depth: parentDepth + 1,

//         connect() {
//           if (node instanceof Element) {
//             self.#resizeObserver.observe(node);
//           }
//           innerController.connected();
//         },

//         disconnect() {
//           if (node instanceof Element) {
//             self.#resizeObserver.unobserve(node);
//           }
//           innerController.disconnected();
//         },

//         resize() {
//           cachedLayoutState = innerController.computeLayoutState();
//           innerController.resized();
//         },

//         mutate() {
//           innerController.mutated();
//         },

//         getLayoutState() {
//           if (!cachedLayoutState) {
//             cachedLayoutState = innerController.computeLayoutState();
//           }
//           return cachedLayoutState;
//         },
//       };
//     }
//     return controller;
//   }
// }

// class HtmlElementController extends NodeController<HTMLElement> {
//   computeLayoutState(): LayoutState {
//     throw new Error();
//   }
// }

// class DummyElementController extends ChildNodeController<HTMLElement> {
//   constructor(node: HTMLElement, parent: LayoutStateProvider) {
//     super(node, parent);
//   }

//   resized(): void {
//     // ...
//   }
// }

// interface StyleSheetInstance {
//   source: string;
//   dispose(): void;
// }

// interface StyleController {
//   register(source: string, url?: URL): StyleSheetInstance;
// }

// abstract class ControllerWithStyleController<
//   T extends Node
// > extends ChildNodeController<T> {
//   controller: StyleController;

//   constructor(
//     node: T,
//     parent: LayoutContextProvider,
//     controller: StyleController
//   ) {
//     super(node, parent);
//     this.controller = controller;
//   }
// }

// class StyleElementController extends ControllerWithStyleController<HTMLStyleElement> {
//   #styleSheet: StyleSheetInstance | null = null;

//   connected(): void {
//     const node = this.node;
//     this.#styleSheet = this.controller.register(node.innerHTML);
//     node.innerHTML = this.#styleSheet.source;
//   }

//   disconnected(): void {
//     if (this.#styleSheet) {
//       this.#styleSheet.dispose();
//       this.#styleSheet = null;
//     }
//   }
// }

// class LinkElementController extends ControllerWithStyleController<HTMLLinkElement> {
//   #isConnected = false;
//   #styleSheet: StyleSheetInstance | null = null;

//   connected(): void {
//     this.#isConnected = true;
//     const node = this.node;
//     if (node.rel === 'stylesheet') {
//       const srcUrl = new URL(node.href, document.baseURI);
//       if (srcUrl.origin === location.origin) {
//         fetch(srcUrl.toString())
//           .then(r => r.text())
//           .then(src => {
//             if (this.#isConnected) {
//               this.#styleSheet = this.controller.register(src, srcUrl);
//               const blob = new Blob([this.#styleSheet.source], {
//                 type: 'text/css',
//               });
//               node.href = URL.createObjectURL(blob);
//             }
//           });
//       }
//     }
//   }

//   disconnected(): void {
//     this.#isConnected = false;

//     if (this.#styleSheet) {
//       this.#styleSheet.dispose();
//       this.#styleSheet = null;
//     }
//   }
// }

let cachedQueryDescriptors: Iterable<QueryDescriptorArray> | null = null;
function getQueryDescriptors() {
  if (!cachedQueryDescriptors) {
    const allQueryDescriptors = [];
    for (const styleSheet of document.styleSheets) {
      const ownerNode = styleSheet.ownerNode;
      if (ownerNode instanceof Element) {
        const queryDescriptors = ELEMENT_TO_DESCRIPTORS_MAP.get(ownerNode);
        if (queryDescriptors) {
          allQueryDescriptors.push(queryDescriptors);
        }
      }
    }
    cachedQueryDescriptors = allQueryDescriptors;
  }
  return cachedQueryDescriptors;
}

const RO = new ResizeObserver(entries => {
  entries
    .map(entry => {
      const instance = ElementInstance.get(entry.target);
      return instance ? ([instance, entry] as const) : null;
    })
    .filter(Boolean)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    .sort((a, b) => a![0].depth - b![0].depth)
    .forEach(instance => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      instance![0].resize(instance![1]);
    });
});

const MO = new MutationObserver(entries => {
  cachedQueryDescriptors = null;

  for (const entry of entries) {
    if (
      entry.type === 'attributes' &&
      (entry.attributeName === DATA_ATTRIBUTE_NAME ||
        (entry.target instanceof Element &&
          entry.attributeName &&
          entry.target.getAttribute(entry.attributeName) === entry.oldValue))
    ) {
      continue;
    }

    for (const node of entry.removedNodes) {
      // Note: We'll recurse into the children as part of disposal,
      // if it's necessary.
      const instance = ElementInstance.get(node);
      if (instance) {
        instance.disconnect();
      }
    }

    // Note: We'll recurse into the children (including any new
    // children) as part of the mutation, if it's necessary.
    const instance = ElementInstance.getOrCreate(entry.target);
    if (instance) {
      instance.mutate();
    }
  }
});
MO.observe(documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeOldValue: true,
});

const documentInstance = ElementInstance.getOrCreate(documentElement);
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
documentInstance!.mutate();

function hasAllQueryNames(names: Set<string>, query: ContainerQueryDescriptor) {
  for (const name of query.names) {
    if (!names.has(name)) {
      return false;
    }
  }
  return true;
}

function computeDimension(dimension: string) {
  return parseFloat(dimension);
}

function computeContainerType(containerType: string) {
  return containerType.length === 0
    ? ContainerType.Normal
    : (parseInt(containerType) as ContainerType);
}

function computeInvalidContainer(displayType: string) {
  const lowerDisplayType = displayType.toLowerCase();
  return (
    lowerDisplayType === 'none' ||
    lowerDisplayType === 'contents' ||
    lowerDisplayType.startsWith('table') ||
    lowerDisplayType.startsWith('ruby')
  );
}

function computeValidContainer(displayType: string) {
  const lowerDisplayType = displayType.toLowerCase();
  return !(
    lowerDisplayType === 'none' ||
    lowerDisplayType === 'contents' ||
    lowerDisplayType.startsWith('table') ||
    lowerDisplayType.startsWith('ruby')
  );
}

function computeContainerNames(containerNames: string) {
  return new Set(containerNames.length === 0 ? [] : containerNames.split(' '));
}

function computeWritingAxis(writingMode: string) {
  switch (writingMode) {
    case 'vertical-lr':
    case 'vertical-rl':
    case 'sideways-rl':
    case 'sideways-lr':
    case 'tb':
    case 'tb-lr':
    case 'tb-rl':
      return WritingAxis.Vertical;

    default:
      return WritingAxis.Horizontal;
  }
}

function computePhysicalSize(
  entry: ResizeObserverEntry,
  styles: CSSStyleDeclaration
): PhysicalSize {
  if (entry.target instanceof SVGElement) {
    return {
      width: computeDimension(
        styles.getPropertyValue(SUPPORTS_WRITING_MODE ? 'inline-size' : 'width')
      ),
      height: computeDimension(
        styles.getPropertyValue(SUPPORTS_WRITING_MODE ? 'block-size' : 'height')
      ),
    };
  }
  const contentRect = entry.contentRect;
  return {width: contentRect.width, height: contentRect.height};
}

function computeSizeFeatures(
  physicalSize: PhysicalSize,
  containerType: ContainerType,
  writingAxis: WritingAxis
) {
  type Axis = {value?: number};
  const horizontalAxis: Axis = {value: physicalSize.width};
  const verticalAxis: Axis = {value: physicalSize.height};

  let inlineAxis = horizontalAxis;
  let blockAxis = verticalAxis;

  if (writingAxis === WritingAxis.Vertical) {
    const tmp = inlineAxis;
    inlineAxis = blockAxis;
    blockAxis = tmp;
  }

  if (containerType !== ContainerType.Size) {
    blockAxis.value = undefined;
  }

  return {
    width: horizontalAxis.value,
    height: verticalAxis.value,
    inlineSize: inlineAxis.value,
    blockSize: blockAxis.value,
  };
}

function computeLayoutState(
  styles: CSSStyleDeclaration,
  context: LayoutContext,
  entry: ResizeObserverEntry
) {
  const writingAxis = computeWritingAxis(
    styles.getPropertyValue('writing-mode')
  );
  const containerType = computeContainerType(
    styles.getPropertyValue(CUSTOM_PROPERTY_TYPE)
  );
  const parentConditions = context.conditions;
  const parentQueryContext = context.queryContext;

  let conditions = parentConditions;
  let queryContext = {
    ...parentQueryContext,
    writingAxis,
  };
  if (containerType !== ContainerType.Normal) {
    const isInvalidContainer = computeInvalidContainer(
      styles.getPropertyValue('display')
    );
    if (!isInvalidContainer) {
      const sizeFeatures = computeSizeFeatures(
        computePhysicalSize(entry, styles),
        containerType,
        writingAxis
      );

      queryContext = {
        writingAxis,
        fontSize: computeDimension(styles.getPropertyValue('font-size')),
        rootFontSize: computeDimension(
          rootStyles.getPropertyValue('font-size')
        ),
        sizeFeatures,
        cqw:
          sizeFeatures.width != null
            ? sizeFeatures.width
            : parentQueryContext.cqw,
        cqh:
          sizeFeatures.height != null
            ? sizeFeatures.height
            : parentQueryContext.cqh,
      };

      const containerNames = computeContainerNames(
        styles.getPropertyValue(CUSTOM_PROPERTY_NAME)
      );

      const computeQueryState = (
        conditions: Record<string, QueryContainerState>,
        query: ContainerQueryDescriptor
      ) => {
        let state = conditions[query.uid];
        if (!state) {
          let res = hasAllQueryNames(containerNames, query)
            ? evaluateContainerCondition(query.condition, queryContext)
            : null;

          if (res == null) {
            const parentResult = parentConditions[query.uid];
            res = parentResult ? parentResult.condition : null;
          }

          conditions[query.uid] = state = {
            condition: res,
            container:
              res === true &&
              (query.parent
                ? computeQueryState(conditions, query.parent).condition === true
                : true),
          };
        }

        return state;
      };

      conditions = {};
      for (const queryDescriptors of getQueryDescriptors()) {
        for (const query of queryDescriptors) {
          computeQueryState(conditions, query);
        }
      }
    }
  }

  return {
    context: {
      conditions,
      queryContext,
    },
    parentQueryContext,
  };
}
