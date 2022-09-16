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
  evaluateContainerCondition,
  ContainerType,
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
  DATA_ATTRIBUTE_CHILD,
  DATA_ATTRIBUTE_SELF,
  INTERNAL_KEYWORD_PREFIX,
  PER_RUN_UID,
} from './constants.js';
import {ContainerQueryDescriptor, transpileStyleSheet} from './transform.js';
import {isContainerStandaloneKeyword} from './parser.js';

interface PhysicalSize {
  width: number;
  height: number;
}

const enum QueryContainerFlags {
  None = 0,

  /**
   * Whether the container's condition evaluated to true.
   */
  Condition = 1 << 0,

  /**
   * Whether the container's rules should be applied.
   *
   * Note: this is subtly different from `condition`, as it
   * takes into account any parent containers and conditions too.
   */
  Container = 1 << 1,
}

const enum DisplayFlags {
  // On if the `display` property is anything but `none`
  Enabled = 1 << 0,

  // On if the `display` property is valid for size containment.
  // https://drafts.csswg.org/css-contain-2/#containment-size
  EligibleForSizeContainment = 1 << 1,
}

interface LayoutState {
  conditions: Map<string, QueryContainerFlags>;
  context: TreeContext;
  displayFlags: DisplayFlags;
  isQueryContainer: boolean;
  queryDescriptors: QueryDescriptorArray;
}

type QueryDescriptorArray = Iterable<ContainerQueryDescriptor>;

const INSTANCE_SYMBOL: unique symbol = Symbol('CQ_INSTANCE');
const SUPPORTS_SMALL_VIEWPORT_UNITS = CSS.supports('width: 1svh');
const VERTICAL_WRITING_MODES = new Set([
  'vertical-lr',
  'vertical-rl',
  'sideways-rl',
  'sideways-lr',
  'tb',
  'tb-lr',
  'tb-rl',
]);

const WIDTH_BORDER_BOX_PROPERTIES: string[] = [
  'padding-left',
  'padding-right',
  'border-left-width',
  'border-right-width',
];

const HEIGHT_BORDER_BOX_PROPERTIES: string[] = [
  'padding-top',
  'padding-bottom',
  'border-top-width',
  'border-bottom-width',
];

/**
 * For matching:
 *
 * display: [ table | ruby ]
 * display: [ block | inline | ... ] [ table | ruby ]
 * display: table-[ row | cell | ... ]
 * display: ruby-[ base | text | ... ]
 * display: inline-table
 *
 * https://drafts.csswg.org/css-display-3/#the-display-properties
 */
const TABLE_OR_RUBY_DISPLAY_TYPE = /(\w*(\s|-))?(table|ruby)(-\w*)?/;

if (IS_WPT_BUILD) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).CQ_SYMBOL = INSTANCE_SYMBOL;
}

interface ViewportChangeContext {
  viewportChanged(size: PhysicalSize): void;
}

interface StyleSheetContext {
  registerStyleSheet(options: {
    source: string;
    url?: URL;
    signal?: AbortSignal;
  }): Promise<StyleSheetInstance>;
}

interface StyleSheetInstance {
  source: string;
  dispose(): void;
  refresh(): void;
}

interface ElementLayoutData {
  containerType: ContainerType;
  containerNames: Set<string>;
  writingAxis: WritingAxis;
  displayFlags: DisplayFlags;
}

interface ElementSizeData {
  width: number;
  height: number;
  fontSize: number;
}

interface LayoutStateProvider {
  (): LayoutState;
}

interface DependencyReader {
  <T>(reader: () => T): T;
}

export function initializePolyfill() {
  interface Instance {
    state: LayoutStateProvider;

    connect(): void;
    disconnect(): void;
    update(): void;
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

  const computeQueryDescriptors = createMemoizedValue(read => {
    const allQueryDescriptors: ContainerQueryDescriptor[] = [];
    const length = read(() => document.styleSheets.length);

    for (let i = 0; i < length; i++) {
      const ownerNode = document.styleSheets[i].ownerNode;
      if (ownerNode instanceof Element) {
        const queryDescriptors = read(() => queryDescriptorMap.get(ownerNode));
        if (queryDescriptors) {
          for (const queryDescriptor of queryDescriptors) {
            allQueryDescriptors.push(queryDescriptor);
          }
        }
      }
    }
    return allQueryDescriptors;
  });

  const dummyElement = document.createElement(`cq-polyfill-${PER_RUN_UID}`);
  const globalStyleElement = document.createElement('style');
  const mutationObserver = new MutationObserver(mutations => {
    for (const entry of mutations) {
      for (const node of entry.removedNodes) {
        const instance = getInstance(node);
        // Note: We'll recurse into the nodes during the disconnect.
        instance?.disconnect();
      }

      if (
        entry.type === 'attributes' &&
        entry.attributeName &&
        entry.target instanceof Element &&
        entry.target.getAttribute(entry.attributeName) === entry.oldValue
      ) {
        continue;
      }

      scheduleUpdate();
    }
  });
  mutationObserver.observe(documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
  });

  const resizeObserver = new ResizeObserver(() => {
    frameCache.clear();
    getOrCreateInstance(documentElement).update();
  });

  const rootController = new NodeController(documentElement);
  const queryDescriptorMap: Map<Node, QueryDescriptorArray> = new Map();
  async function registerStyleSheet(
    node: Node,
    {
      source,
      url,
      signal,
    }: {
      source: string;
      url?: URL;
      signal?: AbortSignal;
    }
  ) {
    const result = transpileStyleSheet(
      source,
      url ? url.toString() : undefined
    );
    let dispose = () => {
      /* noop */
    };

    if (!signal?.aborted) {
      queryDescriptorMap.set(node, result.descriptors);
      scheduleUpdate();

      dispose = () => {
        queryDescriptorMap.delete(node);
        scheduleUpdate();
      };
    }

    return {
      source: result.source,
      dispose,
      refresh() {
        scheduleUpdate();
      },
    };
  }

  const fallbackContainerUnits: {cqw: number | null; cqh: number | null} = {
    cqw: null,
    cqh: null,
  };
  function viewportChanged({width, height}: PhysicalSize) {
    fallbackContainerUnits.cqw = width;
    fallbackContainerUnits.cqh = height;
  }

  function updateAttributes(node: Node, state: LayoutState, attribute: string) {
    if (node instanceof Element && state) {
      const {conditions, queryDescriptors} = state;
      let attributes = '';

      for (const query of queryDescriptors) {
        if (query.selector != null) {
          const result = conditions.get(query.uid);
          const isValidCondition =
            result != null &&
            (result & QueryContainerFlags.Container) ===
              QueryContainerFlags.Container;
          if (isValidCondition && node.matches(query.selector)) {
            if (attributes.length > 0) {
              attributes += ' ';
            }
            attributes += query.uid;
          }
        }
      }

      if (attributes.length > 0) {
        node.setAttribute(attribute, attributes);
      } else {
        node.removeAttribute(attribute);
      }
    }
  }

  function scheduleUpdate() {
    resizeObserver.unobserve(documentElement);
    resizeObserver.observe(documentElement);
  }

  const frameCache = new Map<() => unknown, unknown>();
  function createFrameCached<T>(compute: () => T): () => T {
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let value = frameCache.get(compute) as any;
      if (value == null) {
        value = compute();
        frameCache.set(compute, value);
      }
      return value;
    };
  }

  function getOrCreateInstance(node: Node): Instance {
    let instance = getInstance(node);
    if (!instance) {
      let innerController: NodeController<Node>;
      let parentState: LayoutStateProvider | null = null;
      let parentController: Instance | null = null;
      let state: LayoutStateProvider;
      let alwaysObserveSize = false;

      if (node === documentElement) {
        innerController = rootController;

        const styles = window.getComputedStyle(documentElement);
        state = createFrameCached(
          createMemoizedValue(read => {
            const readProperty = (name: string) =>
              read(() => styles.getPropertyValue(name));
            const layoutData = computeLayoutData(readProperty);
            const sizeData = computeSizeData(readProperty);

            return {
              conditions: new Map(),
              context: {
                ...fallbackContainerUnits,
                fontSize: sizeData.fontSize,
                rootFontSize: sizeData.fontSize,
                writingAxis: layoutData.writingAxis,
              },
              displayFlags: layoutData.displayFlags,
              isQueryContainer: false,
              queryDescriptors: read(() => computeQueryDescriptors()),
            };
          })
        );
      } else {
        const parentNode = node.parentNode;
        parentController = parentNode ? getInstance(parentNode) : null;

        if (!parentController) {
          throw new Error('Expected node to have parent');
        }

        parentState = parentController.state;
        state =
          node instanceof Element
            ? createFrameCached(
                createMemoizedValue(read => {
                  const styles = window.getComputedStyle(node);
                  return computeLayoutState(
                    styles,
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    read(() => parentState!()),
                    read
                  );
                })
              )
            : parentState;

        if (node === dummyElement) {
          alwaysObserveSize = true;
          innerController = new DummyElementController(dummyElement, {
            viewportChanged,
          });
        } else if (node === globalStyleElement) {
          innerController = new GlobalStyleElementController(
            globalStyleElement
          );
        } else if (node instanceof HTMLLinkElement) {
          innerController = new LinkElementController(node, {
            registerStyleSheet: options =>
              registerStyleSheet(node, {
                ...options,
              }),
          });
        } else if (node instanceof HTMLStyleElement) {
          innerController = new StyleElementController(node, {
            registerStyleSheet: options =>
              registerStyleSheet(node, {
                ...options,
              }),
          });
        } else {
          innerController = new NodeController(node);
        }
      }

      const inlineStyles =
        node instanceof HTMLElement || node instanceof SVGElement
          ? node.style
          : null;
      let isObservingSize = false;
      let prevLayoutState: LayoutState | null = null;

      instance = {
        state,

        connect() {
          for (const child of node.childNodes) {
            // Ensure all children are created and connected first.
            getOrCreateInstance(child);
          }
          innerController.connected();
          scheduleUpdate();
        },

        disconnect() {
          if (node instanceof Element) {
            resizeObserver.unobserve(node);
            node.removeAttribute(DATA_ATTRIBUTE_SELF);
            node.removeAttribute(DATA_ATTRIBUTE_CHILD);
          }
          if (inlineStyles) {
            inlineStyles.removeProperty(CUSTOM_UNIT_VARIABLE_CQI);
            inlineStyles.removeProperty(CUSTOM_UNIT_VARIABLE_CQB);
            inlineStyles.removeProperty(CUSTOM_UNIT_VARIABLE_CQW);
            inlineStyles.removeProperty(CUSTOM_UNIT_VARIABLE_CQH);
          }
          for (const child of node.childNodes) {
            const instance = getInstance(child);
            instance?.disconnect();
          }
          innerController.disconnected();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (node as any)[INSTANCE_SYMBOL];
        },

        update() {
          const currentState = state();
          if (currentState !== prevLayoutState) {
            prevLayoutState = currentState;
            const currentParentState = parentState ? parentState() : null;
            if (currentParentState) {
              updateAttributes(node, currentParentState, DATA_ATTRIBUTE_CHILD);
            }
            updateAttributes(node, currentState, DATA_ATTRIBUTE_SELF);

            if (node instanceof Element) {
              const shouldObserveSize =
                alwaysObserveSize || currentState.isQueryContainer;
              if (shouldObserveSize && !isObservingSize) {
                resizeObserver.observe(node);
                isObservingSize = true;
              } else if (!shouldObserveSize && isObservingSize) {
                resizeObserver.unobserve(node);
                isObservingSize = false;
              }
            }

            if (inlineStyles) {
              const context = currentState.context;
              const writingAxis = context.writingAxis;

              let cqi: string | null = null;
              let cqb: string | null = null;
              let cqw: string | null = null;
              let cqh: string | null = null;

              if (
                !currentParentState ||
                writingAxis !== currentParentState.context.writingAxis ||
                currentState.isQueryContainer
              ) {
                cqi = `var(${
                  writingAxis === WritingAxis.Horizontal
                    ? CUSTOM_UNIT_VARIABLE_CQW
                    : CUSTOM_UNIT_VARIABLE_CQH
                })`;
                cqb = `var(${
                  writingAxis === WritingAxis.Vertical
                    ? CUSTOM_UNIT_VARIABLE_CQW
                    : CUSTOM_UNIT_VARIABLE_CQH
                })`;
              }

              if (!parentState || currentState.isQueryContainer) {
                if (context.cqw) {
                  cqw = context.cqw + 'px';
                }
                if (context.cqh) {
                  cqh = context.cqh + 'px';
                }
              }

              setProperty(inlineStyles, CUSTOM_UNIT_VARIABLE_CQI, cqi);
              setProperty(inlineStyles, CUSTOM_UNIT_VARIABLE_CQB, cqb);
              setProperty(inlineStyles, CUSTOM_UNIT_VARIABLE_CQW, cqw);
              setProperty(inlineStyles, CUSTOM_UNIT_VARIABLE_CQH, cqh);
            }
            innerController.updated();
          }

          for (const child of node.childNodes) {
            getOrCreateInstance(child).update();
          }
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any)[INSTANCE_SYMBOL] = instance;
      instance.connect();
    }
    return instance;
  }

  documentElement.prepend(globalStyleElement, dummyElement);
  getOrCreateInstance(documentElement);
}

class NodeController<T extends Node> {
  protected node: T;

  constructor(node: T) {
    this.node = node;
  }

  connected() {
    // Handler implemented by subclasses
  }

  disconnected() {
    // Handler implemented by subclasses
  }

  updated() {
    // Handler implemented by subclasses
  }
}

class LinkElementController extends NodeController<HTMLLinkElement> {
  private context: StyleSheetContext;
  private controller: AbortController | null = null;
  private styleSheet: StyleSheetInstance | null = null;

  constructor(node: HTMLLinkElement, context: StyleSheetContext) {
    super(node);
    this.context = context;
  }

  connected(): void {
    const node = this.node;
    if (node.rel === 'stylesheet') {
      const url = new URL(node.href, document.baseURI);
      if (url.origin === location.origin) {
        this.controller = tryAbortableFunction(async signal => {
          const response = await fetch(url.toString(), {signal});
          const source = await response.text();

          const styleSheet = (this.styleSheet =
            await this.context.registerStyleSheet({source, url, signal}));
          const blob = new Blob([styleSheet.source], {
            type: 'text/css',
          });

          /**
           * Even though it's a data URL, it may take several frames
           * before the stylesheet is loaded. Additionally, the `onload`
           * event isn't triggered on elements that have already loaded.
           *
           * Therefore, we use a dummy image to detect the right time
           * to refresh.
           */
          const img = new Image();
          img.onload = img.onerror = styleSheet.refresh;
          img.src = node.href = URL.createObjectURL(blob);
        });
      }
    }
  }

  disconnected(): void {
    this.controller?.abort();
    this.controller = null;

    this.styleSheet?.dispose();
    this.styleSheet = null;
  }
}

class StyleElementController extends NodeController<HTMLStyleElement> {
  private context: StyleSheetContext;
  private controller: AbortController | null = null;
  private styleSheet: StyleSheetInstance | null = null;

  constructor(node: HTMLStyleElement, context: StyleSheetContext) {
    super(node);
    this.context = context;
  }

  connected(): void {
    this.controller = tryAbortableFunction(async signal => {
      const node = this.node;
      const styleSheet = (this.styleSheet =
        await this.context.registerStyleSheet({
          source: node.innerHTML,
          signal,
        }));
      node.innerHTML = styleSheet.source;
      styleSheet.refresh();
    });
  }

  disconnected(): void {
    this.controller?.abort();
    this.controller = null;

    this.styleSheet?.dispose();
    this.styleSheet = null;
  }
}

class GlobalStyleElementController extends NodeController<HTMLStyleElement> {
  connected(): void {
    const style = `* { ${CUSTOM_PROPERTY_TYPE}: cq-normal; ${CUSTOM_PROPERTY_NAME}: cq-none; }`;
    this.node.innerHTML =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typeof (window as any).CSSLayerBlockRule === 'undefined'
        ? style
        : `@layer cq-polyfill-${PER_RUN_UID} { ${style} }`;
  }
}

class DummyElementController extends NodeController<HTMLElement> {
  private context: ViewportChangeContext;
  private styles: CSSStyleDeclaration;

  constructor(node: HTMLElement, context: ViewportChangeContext) {
    super(node);
    this.context = context;
    this.styles = window.getComputedStyle(node);
  }

  connected(): void {
    this.node.style.cssText =
      'position: fixed; top: 0; left: 0; visibility: hidden; ' +
      (SUPPORTS_SMALL_VIEWPORT_UNITS
        ? 'width: 1svw; height: 1svh;'
        : 'width: 1%; height: 1%;');
  }

  updated(): void {
    const sizeData = computeSizeData(name =>
      this.styles.getPropertyValue(name)
    );
    this.context.viewportChanged({
      width: sizeData.width,
      height: sizeData.height,
    });
  }
}

function tryAbortableFunction(fn: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  fn(controller.signal).catch(err => {
    if (!(err instanceof DOMException && err.message === 'AbortError')) {
      throw err;
    }
  });

  return controller;
}

function computeSizeFeatures(
  layoutData: ElementLayoutData,
  sizeData: ElementSizeData
) {
  type Axis = {value?: number};
  const horizontalAxis: Axis = {
    value: sizeData.width,
  };
  const verticalAxis: Axis = {
    value: sizeData.height,
  };

  let inlineAxis = horizontalAxis;
  let blockAxis = verticalAxis;

  if (layoutData.writingAxis === WritingAxis.Vertical) {
    const tmp = inlineAxis;
    inlineAxis = blockAxis;
    blockAxis = tmp;
  }

  if (
    (layoutData.containerType & ContainerType.BlockSize) !==
    ContainerType.BlockSize
  ) {
    blockAxis.value = undefined;
  }

  return {
    width: horizontalAxis.value,
    height: verticalAxis.value,
    inlineSize: inlineAxis.value,
    blockSize: blockAxis.value,
  };
}

function computeContainerType(containerType: string): ContainerType {
  let type = ContainerType.None;
  if (containerType.length === 0) {
    return type;
  }

  if (containerType.startsWith(INTERNAL_KEYWORD_PREFIX)) {
    containerType = containerType.substring(INTERNAL_KEYWORD_PREFIX.length);
    if (
      containerType === 'normal' ||
      isContainerStandaloneKeyword(containerType)
    ) {
      return type;
    }
  }

  const parts = containerType.split(' ');
  for (const part of parts) {
    switch (part) {
      case 'size':
        type = type | (ContainerType.InlineSize | ContainerType.BlockSize);
        break;

      case 'inline-size':
        type = type | ContainerType.InlineSize;
        break;

      default:
        return ContainerType.None;
    }
  }
  return type;
}

function computeDisplayFlags(displayType: string): DisplayFlags {
  let flags = 0;
  if (displayType !== 'none') {
    flags |= DisplayFlags.Enabled;

    if (
      displayType !== 'contents' &&
      displayType !== 'inline' &&
      !TABLE_OR_RUBY_DISPLAY_TYPE.test(displayType)
    ) {
      flags |= DisplayFlags.EligibleForSizeContainment;
    }
  }

  return flags;
}

function computeContainerNames(containerNames: string) {
  if (containerNames.startsWith(INTERNAL_KEYWORD_PREFIX)) {
    containerNames = containerNames.substring(INTERNAL_KEYWORD_PREFIX.length);
    if (
      containerNames === 'none' ||
      isContainerStandaloneKeyword(containerNames)
    ) {
      return new Set([]);
    }
  }

  return new Set(containerNames.length === 0 ? [] : containerNames.split(' '));
}

function computeWritingAxis(writingMode: string) {
  return VERTICAL_WRITING_MODES.has(writingMode)
    ? WritingAxis.Vertical
    : WritingAxis.Horizontal;
}

function computeDimension(read: (name: string) => string, name: string) {
  return parseFloat(read(name));
}

function computeDimensionSum(
  read: (name: string) => string,
  names: ReadonlyArray<string>
) {
  return names.reduce((value, name) => value + computeDimension(read, name), 0);
}

function computeLayoutState(
  styles: CSSStyleDeclaration,
  parentState: LayoutState,
  read: DependencyReader
): LayoutState {
  const {
    context: parentContext,
    conditions: parentConditions,
    queryDescriptors,
  } = parentState;

  const readProperty = (name: string) =>
    read(() => styles.getPropertyValue(name));
  const layoutData = computeLayoutData(readProperty);
  const context: TreeContext = {
    ...parentContext,
    writingAxis: layoutData.writingAxis,
  };

  let conditions = parentConditions;
  let isQueryContainer = false;
  let displayFlags = layoutData.displayFlags;
  if ((parentState.displayFlags & DisplayFlags.Enabled) === 0) {
    displayFlags = 0;
  }

  const {containerType, containerNames} = layoutData;
  if (containerType > 0) {
    const isValidContainer =
      containerType > 0 &&
      (displayFlags & DisplayFlags.EligibleForSizeContainment) ===
        DisplayFlags.EligibleForSizeContainment;

    conditions = new Map();
    isQueryContainer = true;

    if (isValidContainer) {
      const sizeData = computeSizeData(readProperty);
      context.fontSize = sizeData.fontSize;

      const sizeFeatures = computeSizeFeatures(layoutData, sizeData);
      const queryContext = {
        sizeFeatures,
        treeContext: context,
      };

      const computeQueryCondition = (query: ContainerQueryDescriptor) => {
        const {rule} = query;
        const name = rule.name;
        const result =
          name == null || containerNames.has(name)
            ? evaluateContainerCondition(rule, queryContext)
            : null;

        if (result == null) {
          const condition = parentConditions.get(query.uid) ?? 0;
          return (
            (condition && QueryContainerFlags.Condition) ===
            QueryContainerFlags.Condition
          );
        }

        return result === true;
      };

      const computeQueryState = (
        conditions: Map<string, QueryContainerFlags>,
        query: ContainerQueryDescriptor
      ): QueryContainerFlags => {
        let state = conditions.get(query.uid);
        if (state == null) {
          const condition = computeQueryCondition(query);
          const container =
            condition === true &&
            (query.parent == null ||
              (computeQueryState(conditions, query.parent) &
                QueryContainerFlags.Condition) ===
                QueryContainerFlags.Condition);

          state =
            (condition ? QueryContainerFlags.Condition : 0) |
            (container ? QueryContainerFlags.Container : 0);
          conditions.set(query.uid, state);
        }

        return state;
      };

      for (const query of queryDescriptors) {
        computeQueryState(conditions, query);
      }

      context.cqw =
        sizeFeatures.width != null
          ? sizeFeatures.width / 100
          : parentContext.cqw;
      context.cqh =
        sizeFeatures.height != null
          ? sizeFeatures.height / 100
          : parentContext.cqh;
    }
  }

  return {
    conditions,
    context,
    displayFlags,
    isQueryContainer,
    queryDescriptors,
  };
}

function computeSizeData(read: (name: string) => string): ElementSizeData {
  const isBorderBox = read('box-sizing') === 'border-box';

  let widthOffset = 0;
  let heightOffset = 0;
  if (isBorderBox) {
    widthOffset = computeDimensionSum(read, WIDTH_BORDER_BOX_PROPERTIES);
    heightOffset = computeDimensionSum(read, HEIGHT_BORDER_BOX_PROPERTIES);
  }

  return {
    fontSize: computeDimension(read, 'font-size'),
    width: computeDimension(read, 'width') - widthOffset,
    height: computeDimension(read, 'height') - heightOffset,
  };
}

function computeLayoutData(read: (name: string) => string): ElementLayoutData {
  return {
    containerType: computeContainerType(read(CUSTOM_PROPERTY_TYPE).trim()),
    containerNames: computeContainerNames(read(CUSTOM_PROPERTY_NAME).trim()),
    writingAxis: computeWritingAxis(read('writing-mode').trim()),
    displayFlags: computeDisplayFlags(read('display').trim()),
  };
}

function createMemoizedValue<T>(compute: (read: DependencyReader) => T) {
  interface Dependency<T> {
    0: T;
    1: () => T;
  }

  const dependencies: Array<Dependency<unknown>> = [];

  function read<T>(reader: () => T) {
    const value = reader();
    dependencies.push([value, reader]);
    return value;
  }

  let previousValue: T | null = null;
  return () => {
    let dirty = false;
    for (const dependency of dependencies) {
      dirty = dependency[1]() !== dependency[0];
      if (dirty) {
        break;
      }
    }

    if (previousValue == null || dirty) {
      dependencies.length = 0;
      previousValue = compute(read);
    }

    return previousValue;
  };
}

function setProperty(
  styles: CSSStyleDeclaration,
  name: string,
  value: string | null
) {
  if (value != null) {
    if (value != styles.getPropertyValue(name)) {
      styles.setProperty(name, value);
    }
  } else {
    styles.removeProperty(name);
  }
}
