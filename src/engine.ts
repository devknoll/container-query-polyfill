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

const enum WritingAxis {
  Horizontal = 0,
  Vertical,
}

interface TreeContext {
  writingAxis: WritingAxis | null;
  conditions: Record<string, boolean>;
}

interface ElementInstance {
  beforeLayout(context: TreeContext | null): void;
  afterLayout(entry: ResizeObserverEntry): void;
  dispose(): void;
}

let QUERY_DESCRIPTORS: ReadonlyArray<ContainerQueryDescriptor> = [];

const INSTANCE_SYMBOL: unique symbol = Symbol();
const QUERY_CONTAINER_ELEMENTS: Set<Element> = new Set();
const SUPPORTS_SMALL_VIEWPORT_UNITS = CSS.supports('width: 1svh');

const documentElement = document.documentElement;
const rootEl = document.createElement(`cq-polyfill-${PER_RUN_UID}`);
const rootStyles = window.getComputedStyle(rootEl);

rootEl.style.cssText =
  'position: fixed; top: 0; left: 0; right: 0; bottom: 0; visibility: hidden; font-size: 1rem; transition: font-size 1e-8ms;';
documentElement.appendChild(rootEl);

function getOrCreateInstance(node: Node): ElementInstance | null {
  if (!(node instanceof HTMLElement)) {
    return null;
  }

  let instance = getElementInstance(node);
  if (!instance) {
    if (node === rootEl) {
      instance = {
        afterLayout(entry) {
          documentElement.style.setProperty(
            CUSTOM_UNIT_VARIABLE_CQW,
            SUPPORTS_SMALL_VIEWPORT_UNITS
              ? '1svw'
              : entry.contentRect.width + 'px'
          );
          documentElement.style.setProperty(
            CUSTOM_UNIT_VARIABLE_CQH,
            SUPPORTS_SMALL_VIEWPORT_UNITS
              ? '1svh'
              : entry.contentRect.height + 'px'
          );
        },

        beforeLayout() {
          scheduleUpdate(node);
        },

        dispose() {
          disposeImpl(node);
        },
      };
    } else if (node instanceof HTMLHeadElement) {
      instance = {
        afterLayout() {
          // Noop
        },

        beforeLayout(context) {
          // <head> won't usually be rendered, so we schedule its
          // children here instead.
          scheduleChildrenImpl(node, context);
        },

        dispose() {
          disposeImpl(node);
        },
      };
    } else if (node instanceof HTMLLinkElement) {
      if (node.rel === 'stylesheet') {
        const srcUrl = new URL(node.href, document.baseURI);
        if (srcUrl.origin === location.origin) {
          fetch(srcUrl.toString())
            .then(r => r.text())
            .then(src => {
              const res = transpileStyleSheet(src, srcUrl.toString());
              QUERY_DESCRIPTORS = [...QUERY_DESCRIPTORS, ...res[1]];
              const blob = new Blob([res[0]], {type: 'text/css'});

              const img = new Image();
              img.onload = img.onerror = () => {
                scheduleUpdate(documentElement);
              };
              img.src = node.href = URL.createObjectURL(blob);
            });
        }
      }

      instance = {
        beforeLayout() {
          // NOOP
        },

        afterLayout() {
          // NOOP
        },

        dispose() {
          disposeImpl(node);
        },
      };
    } else if (node instanceof HTMLStyleElement) {
      const originalSrc = node.innerHTML;
      if (originalSrc.length > 0) {
        const res = transpileStyleSheet(originalSrc);
        QUERY_DESCRIPTORS = [...QUERY_DESCRIPTORS, ...res[1]];
        node.innerHTML = res[0];
        scheduleUpdate(documentElement);
      }

      instance = {
        beforeLayout() {
          // NOOP
        },

        afterLayout() {
          // NOOP
        },

        dispose() {
          disposeImpl(node);
        },
      };
    } else {
      const styles = window.getComputedStyle(node);
      const style = node.style;

      let parentContext: TreeContext | null = null;

      instance = {
        beforeLayout(context) {
          parentContext = context;
          const attributes: string[] = [];

          if (parentContext) {
            const conditions = parentContext.conditions;
            for (const query of QUERY_DESCRIPTORS) {
              const uid = query.uid;
              const result = conditions[uid];
              if (result === true && node.matches(query.selector)) {
                attributes.push(uid);
              }
            }
          }

          if (attributes.length === 0) {
            node.removeAttribute(DATA_ATTRIBUTE_NAME);
          } else {
            node.setAttribute(DATA_ATTRIBUTE_NAME, attributes.join(' '));
          }

          scheduleUpdate(node);
        },

        afterLayout(entry) {
          const treeContext = computeLocalTreeContext(
            styles,
            parentContext,
            entry,
            QUERY_DESCRIPTORS
          );
          const writingAxis = treeContext.context.writingAxis;
          if (writingAxis !== treeContext.parentWritingAxis) {
            style.setProperty(
              CUSTOM_UNIT_VARIABLE_CQI,
              `var(${
                writingAxis === WritingAxis.Horizontal
                  ? CUSTOM_UNIT_VARIABLE_CQW
                  : CUSTOM_UNIT_VARIABLE_CQH
              })`
            );
            style.setProperty(
              CUSTOM_UNIT_VARIABLE_CQB,
              `var(${
                writingAxis === WritingAxis.Vertical
                  ? CUSTOM_UNIT_VARIABLE_CQW
                  : CUSTOM_UNIT_VARIABLE_CQH
              })`
            );
          } else {
            style.removeProperty(CUSTOM_UNIT_VARIABLE_CQI);
            style.removeProperty(CUSTOM_UNIT_VARIABLE_CQB);
          }

          const queryContext = treeContext.queryContext;
          if (queryContext) {
            QUERY_CONTAINER_ELEMENTS.add(node);
            const sizeFeatures = queryContext.sizeFeatures;

            if (sizeFeatures.width != null) {
              style.setProperty(
                CUSTOM_UNIT_VARIABLE_CQW,
                sizeFeatures.width + 'px'
              );
            }
            if (sizeFeatures.height != null) {
              style.setProperty(
                CUSTOM_UNIT_VARIABLE_CQH,
                sizeFeatures.height + 'px'
              );
            }
          } else {
            QUERY_CONTAINER_ELEMENTS.delete(node);
            style.removeProperty(CUSTOM_UNIT_VARIABLE_CQW);
            style.removeProperty(CUSTOM_UNIT_VARIABLE_CQH);
          }

          // We may have new children, or their order may have changed, so we always
          // need to update them.
          scheduleChildrenImpl(node, treeContext.context);
        },

        dispose() {
          QUERY_CONTAINER_ELEMENTS.delete(node);
          RO.unobserve(node);
          disposeImpl(node);
        },
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node as any)[INSTANCE_SYMBOL] = instance;
  }

  return instance;
}

function getElementInstance(node: Node): ElementInstance | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (node as any)[INSTANCE_SYMBOL] || null;
}

function disposeImpl(node: HTMLElement) {
  for (const child of node.children) {
    const childInstance = getElementInstance(child);
    if (childInstance) {
      childInstance.dispose();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (node as any)[INSTANCE_SYMBOL];
}

function scheduleChildrenImpl(node: HTMLElement, context: TreeContext | null) {
  for (const child of node.children) {
    const childInstance = getOrCreateInstance(child);
    if (childInstance) {
      childInstance.beforeLayout(context);
    }
  }
}

function scheduleUpdate(el: Element) {
  /**
   * The ResizeObserver spec guarantees that an entry will be added
   * when an element starts being observed. We use this guarantee to
   * "schedule" an update for an element.
   *
   * This will ensure that:
   *
   *   1.) We will get a ResizeObserverEntry for el, even if it was
   *       not actually resized.
   *
   *   2.) We can perform our updates after all of our parents,
   *       according to the ResizeObserver processing model.
   */
  RO.unobserve(el);
  RO.observe(el);
}

let hasLayoutStarted = false;
const RO = new ResizeObserver(entries => {
  if (!hasLayoutStarted) {
    hasLayoutStarted = true;
    requestAnimationFrame(() => {
      hasLayoutStarted = false;
    });
  }

  for (const entry of entries) {
    const instance = getOrCreateInstance(entry.target);
    if (instance) {
      instance.afterLayout(entry);
    }
  }
});

const MO = new MutationObserver(entries => {
  for (const entry of entries) {
    if (entry.type === 'attributes' && hasLayoutStarted) {
      /**
       * Once layout has started, any attribute changes are either:
       *
       *   a.) generated by the polyfill itself (most likely)
       *   b.) too late to be applied
       *
       * So we don't schedule updates here, as that could cause us
       * to either do unnecessary work in the best case, or generate
       * resize loop errors in the worst case.
       */
      continue;
    }

    for (const node of entry.removedNodes) {
      // Note: We don't want to recurse into the nodes here. Instead,
      // we'll do that as part of the update, if necessary.
      const instance = getElementInstance(node);
      if (instance) {
        instance.dispose();
      }
    }

    // Note: We don't want to recurse into the nodes here. Instead,
    // we'll do that as part of the update, if necessary.
    if (entry.target instanceof Element) {
      scheduleUpdate(entry.target);
    }
  }
});
MO.observe(documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeOldValue: true,
});
scheduleUpdate(documentElement);

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
    ? ContainerType.None
    : (parseInt(containerType) as ContainerType);
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

function computeSizeFeatures(
  entry: ResizeObserverEntry,
  containerType: ContainerType,
  writingAxis: WritingAxis
) {
  const contentRect = entry.contentRect;
  const sizeFeatures = {
    width:
      containerType === ContainerType.InlineSize &&
      writingAxis === WritingAxis.Vertical
        ? undefined
        : contentRect.width,
    height:
      containerType === ContainerType.InlineSize &&
      writingAxis === WritingAxis.Horizontal
        ? undefined
        : contentRect.height,
    inlineSize:
      writingAxis === WritingAxis.Horizontal
        ? contentRect.width
        : contentRect.height,
    blockSize:
      containerType === ContainerType.InlineSize
        ? undefined
        : writingAxis === WritingAxis.Vertical
        ? contentRect.width
        : contentRect.height,
  };
  return sizeFeatures;
}

function computeLocalTreeContext(
  styles: CSSStyleDeclaration,
  context: TreeContext | null,
  entry: ResizeObserverEntry,
  queryDescriptors: ReadonlyArray<ContainerQueryDescriptor>
) {
  const writingAxis = computeWritingAxis(
    styles.getPropertyValue('writing-mode')
  );
  const containerType = computeContainerType(
    styles.getPropertyValue(CUSTOM_PROPERTY_TYPE)
  );

  let conditions: Record<string, boolean> = context ? context.conditions : {};
  let queryContext: QueryContext | null = null;

  if (containerType) {
    queryContext = {
      fontSize: computeDimension(styles.getPropertyValue('font-size')),
      rootFontSize: computeDimension(rootStyles.getPropertyValue('font-size')),
      sizeFeatures: computeSizeFeatures(entry, containerType, writingAxis),
    };

    const containerNames = computeContainerNames(
      styles.getPropertyValue(CUSTOM_PROPERTY_NAME)
    );
    conditions = {...conditions};

    for (const query of queryDescriptors) {
      if (hasAllQueryNames(containerNames, query)) {
        conditions[query.uid] = evaluateContainerCondition(
          query.condition,
          queryContext
        );
      }
    }
  }

  return {
    context: {
      conditions,
      writingAxis,
    },
    queryContext,
    parentWritingAxis: context ? context.writingAxis : null,
  };
}
